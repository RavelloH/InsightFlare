// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as sequenceSupport from "@/lib/edge/analytics/engine/advanced-filter-sequence-support";
import * as sequenceSql from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-sequence-query";
import * as stagedRuntime from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

import { COST_TIME } from "./remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_SITE_ID,
} from "./remote-d1/seed";

afterEach(() => vi.restoreAllMocks());

describe("Seq strategy through the authorized provider", () => {
  it.each(["session", "visitor"] as const)(
    "%s executes SQL membership and preserves the complete Core DTO",
    async (scope) => {
      const db = createMigratedDatabase();
      try {
        for (const statement of [
          ...buildSiteStatements(),
          ...buildDataStatements({ visits: 48 }),
        ])
          db.exec(statement);
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const env = { DB: createSqliteD1Database(db, trace) } as Env;
        const end =
          COST_TIME.range.endExclusiveMs - COST_TIME.range.startMs - 1;
        const filters = parseFilterDsl(
          `sequence([window(page { page.path eq "/qualifier" },@range.start,[0ms,${end}ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,${end}ms])]) exists`,
          analyticsFilterRegistry,
        );
        const execute = async () => {
          const diagnostics = createD1ReadDiagnostics();
          const provider = createD1SiteProviderRegistry({
            env,
            siteId: SEED_SITE_ID,
            diagnostics,
          }).resolve("referrers")!;
          const query = {
            ...prepareScopedQuery("referrers", {
              context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
              filters,
              scopePreference: scope,
              time: COST_TIME,
            } as QueryInput),
            variant: "summary",
            topN: 10,
          };
          return {
            value: (await provider.execute(query as never)).value,
            diagnostics,
          };
        };
        const evaluate = vi.spyOn(core, "evaluateFilterDocument");
        const sql = vi.spyOn(sequenceSql, "tryEvaluateSequenceSql");
        const stage = vi.spyOn(stagedRuntime, "executeAnalyticsLogicalStage");
        const actual = await execute();
        expect(sql).not.toHaveBeenCalled();
        expect(stage).toHaveBeenCalledTimes(1);
        const input = stage.mock.calls[0]![0];
        expect(input.kind).toBe(
          "whole-original-completion-at-original-checkpoint",
        );
        const commands = input.invocation.observedSqlCommands();
        expect(commands).toHaveLength(2);
        expect(
          commands.map((command) => {
            const query =
              command.kind === "count-combined" ||
              command.kind === "count-payload-combined"
                ? command.query.query
                : command.query;
            return { sql: query.sql, params: query.bindings };
          }),
        ).toEqual(
          trace.preparedSql
            .slice(0, 2)
            .map((sql, index) => ({ sql, params: trace.bindings[index] })),
        );
        expect(evaluate).not.toHaveBeenCalled();
        expect(actual.diagnostics.advancedFilterExecution).toMatchObject({
          strategy: "sql-membership",
          reason: "whole-tree-sequence-membership-supported",
        });

        const proof = vi
          .spyOn(sequenceSupport, "classifyTwoStepSequence")
          .mockReturnValue({
            kind: "unsupported",
            code: "forced_sequence_core_oracle",
            path: "root",
            reason: "Independent Core oracle.",
          });
        const reference = await execute();
        proof.mockRestore();
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(actual.value).toEqual(reference.value);

        // A real storage-class refusal exercises the active command interpreter.
        // Mocking tryEvaluateSequenceSql no longer reaches this staged route.
        db.exec(
          "UPDATE visits SET started_at=started_at+0.25,last_activity_at=last_activity_at+0.25",
        );
        expect(
          db
            .prepare(
              "SELECT DISTINCT typeof(started_at) AS storage FROM visits",
            )
            .all(),
        ).toEqual([{ storage: "real" }]);
        const fallback = await execute();
        expect(evaluate).toHaveBeenCalledTimes(2);
        const fallbackProof = vi
          .spyOn(sequenceSupport, "classifyTwoStepSequence")
          .mockReturnValue({
            kind: "unsupported",
            code: "forced_sequence_core_oracle",
            path: "root",
            reason:
              "Independent Core oracle for the same REAL-storage fixture.",
          });
        const fallbackReference = await execute();
        fallbackProof.mockRestore();
        expect(evaluate).toHaveBeenCalledTimes(3);
        expect(fallback.value).toEqual(fallbackReference.value);
        expect(stage).toHaveBeenCalledTimes(4);
        expect(sql).not.toHaveBeenCalled();
        expect(
          fallback.diagnostics.advancedFilterExecutionHistory?.map(
            ({ strategy, reason }) => ({ strategy, reason }),
          ),
        ).toEqual([
          {
            strategy: "sql-membership",
            reason: "whole-tree-sequence-membership-supported",
          },
          {
            strategy: "bounded-core",
            reason: "sql-runtime-sequence_storage_compatibility",
          },
        ]);
      } finally {
        db.close();
      }
    },
  );
});
