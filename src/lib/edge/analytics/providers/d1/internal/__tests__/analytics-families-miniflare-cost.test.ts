// @vitest-environment node
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

import {
  ANALYTICS_COST_SCENARIOS,
  executeAnalyticsCostScenario,
} from "./remote-d1/analytics-cost-scenarios";
import {
  assertC01AnalyticsFixtureBudget,
  assertC01AnalyticsFixtureGrowth,
  type C01FixtureMeasurement,
} from "./remote-d1/analytics-fixture-cost-budgets";
import {
  COST_TIME,
  observeCostDatabase,
  seedFingerprint,
  summarizeCost,
} from "./remote-d1/referrers-cost-harness";
import { buildDataStatements, buildSiteStatements } from "./remote-d1/seed";

const require = createRequire(import.meta.url);
describe("Pages, Overview and Events real-engine local Miniflare costs", () => {
  it("compares complete DTOs to native SQLite and measures every provider statement at 2k/10k", async () => {
    const directory = mkdtempSync(join(tmpdir(), "analytics-cost-"));
    const configPath = join(directory, "wrangler.toml");
    writeFileSync(
      configPath,
      'name = "analytics-cost-test"\ncompatibility_date = "2026-03-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "analytics_cost_test"\ndatabase_id = "local-test"\n',
    );
    const report: Record<string, unknown>[] = [];
    const smallerMeasurements = new Map<string, C01FixtureMeasurement>();
    try {
      for (const visits of [2000, 10000]) {
        const local = createMigratedDatabase();
        const platform = await getPlatformProxy<Env>({
          configPath,
          envFiles: [],
          persist: false,
          remoteBindings: false,
        });
        try {
          const seed = [
            ...buildSiteStatements(),
            ...buildDataStatements({ visits }),
          ];
          for (const sql of seed) local.exec(sql);
          for (const sql of [
            ...unstable_splitSqlQuery(
              readFileSync(resolve("docs/schema.sql"), "utf8"),
            ),
            ...seed,
          ])
            await platform.env.DB.prepare(sql).run();
          for (const scenario of ANALYTICS_COST_SCENARIOS) {
            const referenceDatabase = observeCostDatabase(
              createSqliteD1Database(local),
            );
            const reference = await executeAnalyticsCostScenario(
              {
                DB: referenceDatabase.database,
                MAIN_SECRET: "c01-secret",
              } as Env,
              scenario,
            );
            const measured = observeCostDatabase(platform.env.DB);
            const execution = await executeAnalyticsCostScenario(
              {
                ...platform.env,
                DB: measured.database,
                MAIN_SECRET: "c01-secret",
              },
              scenario,
            );
            const cost = summarizeCost(measured.observations, true);
            const measurement: C01FixtureMeasurement = {
              engine: "local-miniflare",
              visits,
              seedFingerprint: seedFingerprint(visits),
              scenario,
              time: COST_TIME,
              cost,
            };
            const smallerMeasurement = smallerMeasurements.get(scenario.name);
            const smallerRowsRead = smallerMeasurement?.cost.rowsRead as
              number | undefined;
            const growthBudget = {
              status: visits === 2000 ? "baseline" : "checked",
              smallerVisits: 2000,
              largerVisits: 10000,
              smallerRowsRead: smallerRowsRead ?? cost.rowsRead,
              largerRowsRead: visits === 10000 ? cost.rowsRead : null,
              maxGrowth: 7,
              actualGrowth:
                visits === 10000 && smallerRowsRead !== undefined
                  ? cost.rowsRead! / smallerRowsRead
                  : null,
            };
            report.push({
              engine: "local-miniflare",
              nodeVersion: process.version,
              wranglerVersion: require("wrangler/package.json").version,
              seedFingerprint: seedFingerprint(visits),
              visits,
              ...execution,
              ...cost,
              growthBudget,
              time: COST_TIME,
              statementDetail: measured.observations,
              reference: {
                engine: "local-node-sqlite",
                sqliteVersion: process.versions.sqlite,
                ...reference,
                ...summarizeCost(referenceDatabase.observations),
              },
            });
            expect(execution.value, scenario.name).toEqual(reference.value);
            expect(execution.actualStrategies, scenario.name).toEqual(
              reference.actualStrategies,
            );
            expect(cost.rowsRead, scenario.name).toBeGreaterThan(0);
            expect(cost.rowsWritten, scenario.name).toBe(0);
            expect(cost.maxParameters, scenario.name).toBeLessThanOrEqual(100);
            expect(cost.maxSqlBytes, scenario.name).toBeLessThanOrEqual(100000);
            const row = report[report.length - 1]!;
            row.absoluteBudget = assertC01AnalyticsFixtureBudget(measurement);
            if (visits === 2000)
              smallerMeasurements.set(scenario.name, measurement);
            else {
              expect(smallerRowsRead, scenario.name).toBeGreaterThan(0);
              row.growthBudget = {
                ...growthBudget,
                ...assertC01AnalyticsFixtureGrowth(
                  smallerMeasurement!,
                  measurement,
                ),
              };
              expect(
                cost.rowsRead,
                `${scenario.name}: ${JSON.stringify(growthBudget)}`,
              ).toBeLessThanOrEqual(smallerRowsRead! * 7);
            }
          }
        } finally {
          local.close();
          await platform.dispose();
        }
      }
      expect(report).toHaveLength(ANALYTICS_COST_SCENARIOS.length * 2);
    } finally {
      const reportPath = resolve(
        process.env.C01_LOCAL_FAMILIES_REPORT_PATH ??
          ".tmp/c01-local-analytics-families.json",
      );
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 300000);
});
