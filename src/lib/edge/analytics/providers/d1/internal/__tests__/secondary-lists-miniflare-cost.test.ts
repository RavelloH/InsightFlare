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
  errorEvidence,
  observeStatementAttempts,
} from "./remote-d1/cost-guards";
import {
  observeCostDatabase,
  seedFingerprint,
  summarizeCost,
} from "./remote-d1/referrers-cost-harness";
import {
  executeSecondaryCostScenario,
  SECONDARY_COST_SCENARIOS,
} from "./remote-d1/secondary-cost-scenarios";
import { buildDataStatements, buildSiteStatements } from "./remote-d1/seed";

const require = createRequire(import.meta.url);
const requestedScenario = process.env.C01_SECONDARY_SCENARIO;
const scenarios = requestedScenario
  ? SECONDARY_COST_SCENARIOS.filter(
      (scenario) => scenario.name === requestedScenario,
    )
  : SECONDARY_COST_SCENARIOS;
if (scenarios.length === 0)
  throw new Error(`c01_secondary_scenario_unknown:${requestedScenario}`);

describe("New secondary list baselines on real local Miniflare", () => {
  it("compares selected paginated provider DTOs at 2k/10k and records genuine statement costs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "secondary-list-cost-"));
    const configPath = join(directory, "wrangler.toml");
    writeFileSync(
      configPath,
      'name="secondary-list-cost"\ncompatibility_date="2026-03-01"\n[[d1_databases]]\nbinding="DB"\ndatabase_name="secondary_list_cost"\ndatabase_id="local-test"\n',
    );
    const report: Record<string, unknown>[] = [];
    const smallerReads = new Map<string, number>();
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
          local.exec("PRAGMA query_only=ON");
          for (const sql of [
            ...unstable_splitSqlQuery(
              readFileSync(resolve("docs/schema.sql"), "utf8"),
            ),
            ...seed,
          ])
            await platform.env.DB.prepare(sql).run();
          for (const scenario of scenarios) {
            const attempts = observeStatementAttempts(platform.env.DB);
            const measured = observeCostDatabase(attempts.database);
            const row: Record<string, unknown> = {
              engine: "local-miniflare",
              nodeVersion: process.version,
              wranglerVersion: require("wrangler/package.json").version,
              seedFingerprint: seedFingerprint(visits),
              visits,
              scenario: scenario.name,
              status: "running",
              baseline: {
                status: "new-baseline",
                reason:
                  "No historical fixed read-cost budget exists for these secondary lists; the 2k/10k growth guard is calibrated from actual provider runs",
              },
              statementDetail: measured.observations,
              statementAttempts: attempts.attempts,
            };
            report.push(row);
            try {
              const reference = await executeSecondaryCostScenario(
                {
                  DB: createSqliteD1Database(local),
                  MAIN_SECRET: "c01-secret",
                } as Env,
                scenario,
              );
              row.reference = {
                engine: "local-node-sqlite",
                sqliteVersion: process.versions.sqlite,
                ...reference,
              };
              const execution = await executeSecondaryCostScenario(
                {
                  ...platform.env,
                  DB: measured.database,
                  MAIN_SECRET: "c01-secret",
                },
                scenario,
              );
              const cost = summarizeCost(measured.observations, true);
              const smallerRowsRead = smallerReads.get(scenario.name);
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
              Object.assign(row, execution, cost, {
                growthBudget,
                observedGrowth: growthBudget.actualGrowth,
              });
              expect(execution.value, scenario.name).toEqual(reference.value);
              expect(execution.actualStrategies, scenario.name).toEqual(
                reference.actualStrategies,
              );
              expect(execution.coreCalls, scenario.name).toBe(0);
              expect(execution.value, scenario.name).toMatchObject({
                pagination: { limit: 20 },
              });
              expect(cost.rowsRead, scenario.name).toBeGreaterThan(0);
              expect(cost.rowsWritten, scenario.name).toBe(0);
              expect(cost.maxParameters, scenario.name).toBeLessThanOrEqual(
                100,
              );
              expect(cost.maxSqlBytes, scenario.name).toBeLessThanOrEqual(
                100000,
              );
              if (visits === 2000)
                smallerReads.set(scenario.name, cost.rowsRead!);
              else {
                expect(smallerRowsRead, scenario.name).toBeGreaterThan(0);
                expect(
                  cost.rowsRead,
                  `${scenario.name}: ${JSON.stringify(growthBudget)}`,
                ).toBeLessThanOrEqual(smallerRowsRead! * 7);
              }
              row.status = "passed";
            } catch (error) {
              row.status = "failed";
              row.error = errorEvidence(error);
              throw error;
            }
          }
        } finally {
          local.close();
          await platform.dispose();
        }
      }
      expect(report).toHaveLength(scenarios.length * 2);
    } finally {
      const path = resolve(
        process.env.C01_SECONDARY_REPORT_PATH ??
          ".tmp/c01-local-secondary-lists-new-baseline.json",
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(report, null, 2));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 300000);
});
