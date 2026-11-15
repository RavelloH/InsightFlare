// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

import type { C01FixtureMeasurement } from "./remote-d1/analytics-fixture-cost-budgets";
import {
  errorEvidence,
  observeStatementAttempts,
} from "./remote-d1/cost-guards";
import {
  assertJourneyEventFieldsCostBudget,
  assertJourneyEventFieldsCostGrowth,
} from "./remote-d1/journey-event-fields-cost-budgets";
import { buildJourneyEventFieldsCostFixture } from "./remote-d1/journey-event-fields-cost-fixture";
import {
  assertPositiveJourneyEventFieldsDto,
  executeJourneyEventFieldsCostScenario,
  JOURNEY_EVENT_FIELDS_COST_SCENARIOS,
} from "./remote-d1/journey-event-fields-cost-scenarios";
import {
  COST_TIME,
  observeCostDatabase,
  summarizeCost,
} from "./remote-d1/referrers-cost-harness";

const require = createRequire(import.meta.url);
describe("Retention, Funnel and Event fields independent real-engine cost fixture", () => {
  it("checks all 18 complete DTOs, all statement metadata, zero writes and nine 2k/10k growth budgets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "c01-journey-fields-"));
    const configPath = join(directory, "wrangler.toml");
    writeFileSync(
      configPath,
      'name="c01-journey-fields-cost"\ncompatibility_date="2026-03-01"\n[[d1_databases]]\nbinding="DB"\ndatabase_name="c01_journey_fields_local"\ndatabase_id="local-test"\n',
    );
    const report: Record<string, unknown>[] = [];
    const smaller = new Map<string, C01FixtureMeasurement>();
    try {
      for (const visits of [2000, 10000]) {
        const fixture = buildJourneyEventFieldsCostFixture(visits);
        const native = createMigratedDatabase();
        const platform = await getPlatformProxy<Env>({
          configPath,
          envFiles: [],
          persist: false,
          remoteBindings: false,
        });
        try {
          for (const sql of fixture.seed) native.exec(sql);
          native.exec("PRAGMA query_only=ON");
          for (const sql of [
            ...unstable_splitSqlQuery(fixture.schemaSql),
            ...fixture.seed,
          ])
            await platform.env.DB.prepare(sql).run();
          for (const scenario of JOURNEY_EVENT_FIELDS_COST_SCENARIOS) {
            const attempts = observeStatementAttempts(platform.env.DB);
            const measured = observeCostDatabase(attempts.database);
            const referenceDatabase = observeCostDatabase(
              createSqliteD1Database(native),
            );
            const row: Record<string, unknown> = {
              status: "running",
              engine: "local-miniflare",
              baseline: "new independent local fixture; no remote baseline",
              nodeVersion: process.version,
              sqliteVersion: process.versions.sqlite,
              wranglerVersion: require("wrangler/package.json").version,
              visits,
              seedFingerprint: fixture.fingerprint,
              time: COST_TIME,
              scenario: scenario.name,
              operation: scenario.operation,
              parameters: scenario.parameters,
              scope: scenario.scope,
              filterDsl: scenario.filterDsl ?? null,
            };
            report.push(row);
            try {
              const reference = await executeJourneyEventFieldsCostScenario(
                {
                  DB: referenceDatabase.database,
                  MAIN_SECRET: "c01-secret",
                } as Env,
                scenario,
              );
              row.reference = {
                ...reference,
                ...summarizeCost(referenceDatabase.observations),
              };
              const actual = await executeJourneyEventFieldsCostScenario(
                {
                  ...platform.env,
                  DB: measured.database,
                  MAIN_SECRET: "c01-secret",
                },
                scenario,
              );
              const cost = summarizeCost(measured.observations, true);
              Object.assign(row, actual, cost);
              expect(actual.value, scenario.name).toEqual(reference.value);
              expect(actual.actualStrategies, scenario.name).toEqual(
                reference.actualStrategies,
              );
              assertPositiveJourneyEventFieldsDto(scenario, actual.value);
              expect(cost.maxParameters).toBeLessThanOrEqual(100);
              expect(cost.maxSqlBytes).toBeLessThanOrEqual(100000);
              const measurement: C01FixtureMeasurement = {
                engine: "local-miniflare",
                visits,
                seedFingerprint: fixture.fingerprint,
                scenario,
                time: COST_TIME,
                cost,
              };
              row.absoluteBudget =
                assertJourneyEventFieldsCostBudget(measurement);
              if (visits === 2000) smaller.set(scenario.name, measurement);
              else {
                const baseline = smaller.get(scenario.name);
                if (!baseline)
                  throw new Error(
                    `c01_next_missing_smaller_measurement:${scenario.name}`,
                  );
                row.growthBudget = assertJourneyEventFieldsCostGrowth(
                  baseline,
                  measurement,
                );
              }
              row.status = "passed";
            } catch (error) {
              row.status = "failed";
              row.error = errorEvidence(error);
              throw error;
            } finally {
              row.statementDetail = measured.observations;
              row.statementAttempts = attempts.attempts;
              row.knownCost = summarizeCost(measured.observations);
            }
          }
        } finally {
          native.close();
          await platform.dispose();
        }
      }
      expect(report).toHaveLength(
        JOURNEY_EVENT_FIELDS_COST_SCENARIOS.length * 2,
      );
    } finally {
      const reportPath = resolve(
        process.env.C01_NEXT_FAMILIES_REPORT_PATH ??
          ".tmp/c01-local-journey-event-fields.json",
      );
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 300000);
});
