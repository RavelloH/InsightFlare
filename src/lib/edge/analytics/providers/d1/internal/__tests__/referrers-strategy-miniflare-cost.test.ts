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
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

import type { Env } from "@/lib/edge/types";

import {
  COST_STRATEGIES,
  executeCostStrategy,
  observeCostDatabase,
  seedFingerprint,
  summarizeCost,
} from "./remote-d1/referrers-cost-harness";
import { buildDataStatements, buildSiteStatements } from "./remote-d1/seed";

const require = createRequire(import.meta.url);
describe("Referrers identical-query growth in local Miniflare D1", () => {
  it("preserves full DTOs across forced strategies and bounds 2k/10k growth and records the 20k activity cap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "referrers-cost-"));
    const configPath = join(directory, "wrangler.toml");
    writeFileSync(
      configPath,
      'name = "referrers-cost-test"\ncompatibility_date = "2026-03-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "referrers_cost_test"\ndatabase_id = "local-test"\n',
    );
    const report: Record<string, unknown>[] = [];
    try {
      for (const visits of [2000, 10000, 20000]) {
        const platform = await getPlatformProxy<Env>({
          configPath,
          envFiles: [],
          persist: false,
          remoteBindings: false,
        });
        try {
          for (const sql of [
            ...unstable_splitSqlQuery(
              readFileSync(resolve("docs/schema.sql"), "utf8"),
            ),
            ...buildSiteStatements(),
            ...buildDataStatements({ visits }),
          ])
            await platform.env.DB.prepare(sql).run();
          for (const scope of ["session", "visitor"] as const) {
            const values: unknown[] = [];
            for (const strategy of COST_STRATEGIES) {
              const observed = observeCostDatabase(platform.env.DB);
              if (visits === 20000) {
                const started = performance.now();
                await expect(
                  executeCostStrategy(
                    {
                      ...platform.env,
                      DB: observed.database,
                      MAIN_SECRET: "c01-secret",
                    },
                    scope,
                    strategy,
                  ),
                ).rejects.toMatchObject({
                  domainError: {
                    kind: "invalid-input",
                    issues: [
                      {
                        path: "filters",
                        code: "filter_activity_limit_exceeded",
                      },
                    ],
                  },
                });
                report.push({
                  engine: "local-miniflare",
                  nodeVersion: process.version,
                  wranglerVersion: require("wrangler/package.json").version,
                  seedFingerprint: seedFingerprint(visits),
                  visits,
                  scope,
                  strategy,
                  status: "activity-limit-exceeded",
                  elapsedMs: Number((performance.now() - started).toFixed(3)),
                  ...summarizeCost(observed.observations, true),
                  statementDetail: observed.observations,
                });
                continue;
              }
              const result = await executeCostStrategy(
                {
                  ...platform.env,
                  DB: observed.database,
                  MAIN_SECRET: "c01-secret",
                },
                scope,
                strategy,
              );
              values.push(result.value);
              const cost = summarizeCost(observed.observations, true);
              report.push({
                engine: "local-miniflare",
                nodeVersion: process.version,
                wranglerVersion: require("wrangler/package.json").version,
                seedFingerprint: seedFingerprint(visits),
                visits,
                ...result,
                ...cost,
                statementDetail: observed.observations,
              });
              expect(cost.rowsRead).toBeGreaterThan(0);
              expect(cost.maxParameters).toBeLessThanOrEqual(100);
              expect(cost.maxSqlBytes).toBeLessThanOrEqual(100000);
            }
            expect(values[0]).toEqual(values[1]);
            expect(values[0]).toEqual(values[2]);
          }
        } finally {
          await platform.dispose();
        }
      }
      for (const scope of ["session", "visitor"])
        for (const strategy of COST_STRATEGIES) {
          const rows = report.filter(
            (row) =>
              row.scope === scope &&
              row.strategy === strategy &&
              row.status !== "activity-limit-exceeded",
          );
          // Allow 40% headroom over each input growth step, counting every statement.
          for (let index = 1; index < rows.length; index += 1) {
            const inputGrowth =
              Number(rows[index]?.visits) / Number(rows[index - 1]?.visits);
            expect(Number(rows[index]?.rowsRead)).toBeLessThanOrEqual(
              Number(rows[index - 1]?.rowsRead) * inputGrowth * 1.4,
            );
          }
        }
    } finally {
      mkdirSync(resolve(".tmp"), { recursive: true });
      writeFileSync(
        resolve(".tmp/c01-local-referrers-growth.json"),
        JSON.stringify(report, null, 2),
      );
      // Only the exact directory returned by mkdtemp is removed.
      rmSync(directory, { recursive: true, force: true });
    }
  }, 300000);
});
