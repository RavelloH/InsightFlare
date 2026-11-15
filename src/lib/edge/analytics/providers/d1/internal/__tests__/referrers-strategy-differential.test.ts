// @vitest-environment node
import type { SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

import {
  COST_STRATEGIES,
  executeCostStrategy,
  observeCostDatabase,
  seedFingerprint,
  summarizeCost,
} from "./remote-d1/referrers-cost-harness";
import { buildDataStatements, buildSiteStatements } from "./remote-d1/seed";

describe("Referrers same-query strategy differential", () => {
  it.each(["session", "visitor"] as const)(
    "compares the full %s summary on identical inputs",
    async (scope) => {
      const local = createMigratedDatabase();
      try {
        for (const sql of [
          ...buildSiteStatements(),
          ...buildDataStatements({ visits: 160 }),
        ])
          local.exec(sql);
        const values: unknown[] = [];
        for (const strategy of COST_STRATEGIES) {
          const observed = observeCostDatabase(createSqliteD1Database(local));
          const result = await executeCostStrategy(
            { DB: observed.database, MAIN_SECRET: "c01-secret" } as Env,
            scope,
            strategy,
          );
          expect(observed.observations.length).toBeGreaterThan(0);
          expect(result.coreCalls).toBe(strategy === "core" ? 1 : 0);
          expect(result.diagnostics.advancedFilterExecution?.strategy).toBe(
            strategy === "fused"
              ? "sql-report-fusion"
              : strategy === "core"
                ? "bounded-core"
                : "sql-membership",
          );
          if (strategy === "core")
            expect(result.diagnostics.advancedFilterExecution?.reason).toBe(
              "forced_core_oracle",
            );
          expect(summarizeCost(observed.observations)).toMatchObject({
            metadataStatus: "unsupported",
            rowsRead: null,
            sqlDurationMs: null,
          });
          if (strategy === "fused") {
            const reportSql = observed.observations.find((row) =>
              row.sql.includes("AS MATERIALIZED"),
            );
            expect(reportSql).toBeDefined();
            // The real compiled engine query must build a key lookup once.
            const trace = {
              preparedSql: [] as string[],
              bindings: [] as SQLInputValue[][],
            };
            await executeCostStrategy(
              {
                DB: createSqliteD1Database(local, trace),
                MAIN_SECRET: "c01-secret",
              } as Env,
              scope,
              strategy,
            );
            const index = trace.preparedSql.findIndex((sql) =>
              sql.includes("AS MATERIALIZED"),
            );
            const plan = local
              .prepare(`EXPLAIN QUERY PLAN ${trace.preparedSql[index]}`)
              .all(...(trace.bindings[index] ?? []));
            expect(
              plan.some((row) => String(row.detail).includes("LIST SUBQUERY")),
            ).toBe(true);
            const countRelations = new Set(
              plan
                .filter((row) => /^MATERIALIZE /u.test(String(row.detail)))
                .map((row) => String(row.detail).slice(12)),
            );
            for (const correlated of plan.filter((row) =>
              String(row.detail).includes("CORRELATED SCALAR SUBQUERY"),
            )) {
              const children = plan.filter(
                (row) => row.parent === correlated.id,
              );
              expect(
                children.some((row) =>
                  countRelations.has(String(row.detail).replace(/^SCAN /u, "")),
                ),
              ).toBe(false);
            }
          }
          values.push(result.value);
        }
        expect(values[0]).toEqual(values[1]);
        expect(values[0]).toEqual(values[2]);
        expect(values[0]).toMatchObject({
          totalViews: expect.any(Number),
          topSources: expect.any(Array),
        });
        expect(seedFingerprint(160)).toBe(seedFingerprint(160));
        expect(seedFingerprint(161)).not.toBe(seedFingerprint(160));
      } finally {
        local.close();
      }
    },
  );
});
