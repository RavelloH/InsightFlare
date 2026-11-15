// @vitest-environment node
import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import type { SqliteD1Trace } from "@/lib/db/__tests__/sqlite-d1";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type { QueryTime } from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as stagedRuntime from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as oldWhole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const narrow =
  'sequence([window(page { page.path neq "/excluded" },@range.start,[0ms,604799999ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,604799999ms])]) exists';
const cases = [
  {
    kind: "sequence-sql",
    dsl: narrow,
    coreCalls: 0,
    sqlCount: 3,
    strategy: "sql-membership",
    reason: "whole-tree-sequence-membership-supported",
    fingerprints: {
      session:
        "0040d564b9388422854c7884cc19a5206cafc9165b7316b396cd1e4ece575751",
      visitor:
        "4c21e038ee4b45ad63d0f1ffe72110de180930eee5c9ad049f03932d22ec7933",
    },
  },
  {
    kind: "sequence-runtime-refusal",
    dsl: narrow,
    coreCalls: 1,
    sqlCount: 4,
    strategy: "bounded-core",
    reason: "sql-runtime-sequence_storage_compatibility",
    fingerprints: {
      session:
        "23c2208d11c51aab428ea6e77f56d5f4a85897084456a33ece1135826bfd396c",
      visitor:
        "1110527369b63d32e9a0d4847001fdfb865b159fecb9688280606f6bc18e2ad4",
    },
  },
  {
    kind: "payload-core",
    dsl: 'first(event.payload("/amount")) gt 0',
    coreCalls: 1,
    sqlCount: 4,
    strategy: "bounded-core",
    reason: "count_sql_requires_numeric_target",
    fingerprints: {
      session:
        "f888604020d234c73ae56b81d1ca3f3e2a4130d8a134fa7640fbbc6211d05606",
      visitor:
        "8fe02f27230b03b7ba4bda160eff1932bc823055dc32f448bba3724c1cdd3156",
    },
  },
  {
    kind: "full-history-count",
    dsl: 'count(event { event.name eq "qualifier" }) gt 0',
    coreCalls: 0,
    sqlCount: 4,
    strategy: "sql-membership",
    reason: "independent-membership-time-domains",
    fingerprints: {
      session:
        "217ce1276ec557f7e4db0aadf1eb189c0c64919ff04c1d12a429ae50f6396eba",
      visitor:
        "d11141fc6414a2081e9b5f2e1db91631e51228eb41524dbd6b434633f1a36d8d",
    },
  },
] as const;

function expectedSummary(scope: "session" | "visitor") {
  const visitor = scope === "visitor";
  const events = visitor ? 10 : 9;
  const sessions = visitor ? 6 : 5;
  const single = (label: string) => ({
    label,
    views: 1,
    sessions: 1,
    visitors: 1,
  });
  return {
    value: {
      summary: {
        events,
        eventTypes: 2,
        sessions,
        visitors: 3,
        avgEventsPerSession: events / sessions,
      },
      cards: {
        event: {
          name: [
            { label: "qualifier", views: 6, sessions: 5, visitors: 3 },
            {
              label: "other",
              views: visitor ? 4 : 3,
              sessions: visitor ? 4 : 3,
              visitors: 3,
            },
          ],
        },
        page: {
          path: [
            { label: "/qualifier", views: 6, sessions: 5, visitors: 3 },
            single("/"),
            single("/blog/c"),
            ...(visitor ? [single("/docs/guide")] : []),
            single("/pricing"),
          ],
          title: [],
          hostname: [
            {
              label: "c01.example.invalid",
              views: events,
              sessions,
              visitors: 3,
            },
          ],
        },
      },
    },
  };
}

for (const scope of ["session", "visitor"] as const) {
  for (const sample of cases) {
    it(`${scope}/${sample.kind}: evaluates the original whole completion through logical stages`, async () => {
      const database = createMigratedDatabase();
      for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
        database.exec(sql);
      if (sample.kind === "sequence-runtime-refusal") {
        database.exec(
          "UPDATE visits SET started_at=started_at+0.25,last_activity_at=last_activity_at+0.25",
        );
        expect(
          database
            .prepare(
              "SELECT DISTINCT typeof(started_at) AS storage FROM visits",
            )
            .all(),
        ).toEqual([{ storage: "real" }]);
      }
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const diagnostics = createD1ReadDiagnostics();
      const execution = vi.spyOn(stagedRuntime, "executeAnalyticsLogicalStage");
      const whole = vi.spyOn(oldWhole, "evaluateWholeFilterMembership");
      const registered = vi.spyOn(bridge, "registerPreparedMembership");
      const resolved = vi.spyOn(bridge, "resolvePreparedMembership");
      const evaluator = vi.spyOn(core, "evaluateFilterDocument");
      const totalBefore = database
        .prepare("SELECT total_changes() AS writes")
        .get();
      try {
        const baseTime = createQueryTime(
          SEED_BASE_MS,
          SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
          "UTC",
          SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
        );
        const base = prepareScopedQuery("event-summary", {
          context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
          time: baseTime,
          scopePreference: scope,
          filters: parseFilterDsl(sample.dsl, analyticsFilterRegistry),
        });
        const time: QueryTime =
          sample.kind === "full-history-count"
            ? { ...baseTime, fullHistory: true }
            : sample.kind === "payload-core"
              ? {
                  ...baseTime,
                  filterRange: undefined,
                  filterRangeEmpty: undefined,
                  readRange: undefined,
                  fullHistory: undefined,
                  paginationBinding: undefined,
                }
              : baseTime;
        if (sample.kind === "payload-core") {
          expect(Object.hasOwn(time, "readRange")).toBe(true);
          expect(time.readRange).toBeUndefined();
        }
        const metadata = scopedFilterMetadata(base.filters);
        if (!metadata)
          throw new Error("whole_completion_test_expected_scoped_metadata");
        const request = {
          ...base,
          time,
          filters: attachScopedFilterMetadata(base.filters, {
            ...metadata,
            time,
          }),
        };
        // Keep this suite on the original logical-staged adapter contract.
        // Use the same real providers and AFE middleware, omitting only the D1
        // Program dispatcher. Actual Program execution has separate regressions.
        const registry = createD1SiteProviderRegistry({
          env: {
            DB: createSqliteD1Database(database, trace),
            MAIN_SECRET: "whole-completion-local-only",
          } as Env,
          siteId: SEED_SITE_ID,
          diagnostics,
        });
        const provider = AnalyticsProviderRegistry.prototype.resolve.call(
          registry,
          "event-summary",
        );
        if (!provider)
          throw new Error("whole_completion_test_expected_summary_provider");
        expect(await provider.execute(request)).toEqual(expectedSummary(scope));
        expect(execution).toHaveBeenCalledTimes(1);
        expect(whole).not.toHaveBeenCalled();
        expect(registered).not.toHaveBeenCalled();
        expect(resolved).not.toHaveBeenCalled();
        expect(evaluator).toHaveBeenCalledTimes(sample.coreCalls);
        expect(diagnostics.advancedFilterExecution).toMatchObject({
          strategy: sample.strategy,
          reason: sample.reason,
        });
        expect(diagnostics.rowsReadAvailable).toBe(false);
        const input = execution.mock.calls[0]?.[0];
        if (
          !input ||
          input.kind !== "whole-original-completion-at-original-checkpoint"
        )
          throw new Error("whole_completion_test_expected_raw_stage_entry");
        const stages = input.invocation.observedSemanticStages();
        expect(stages).toHaveLength(1 + sample.coreCalls);
        const producer = stages[0]?.nodes.find(
          (node) => node.kind === "whole-filter-membership",
        );
        if (!producer || producer.kind !== "whole-filter-membership")
          throw new Error("whole_completion_test_expected_membership_node");
        expect(producer).toMatchObject({
          profile: "whole-original-completion-single-site-entity-v1",
          executionScope: scope,
          coverageSource: "read",
        });
        expect(Object.getOwnPropertySymbols(producer.filters)).toEqual([]);
        expect(stages[0]?.context.subject).toEqual({
          origin: "site",
          siteIds: [SEED_SITE_ID],
        });
        const commands = input.invocation.observedSqlCommands();
        expect(commands).toHaveLength(sample.sqlCount - 1);
        const qualificationSql = commands.map((command) => {
          const query =
            command.kind === "count-combined" ||
            command.kind === "count-payload-combined"
              ? command.query.query
              : command.query;
          return { sql: query.sql, params: query.bindings };
        });
        expect(trace.preparedSql).toHaveLength(sample.sqlCount);
        expect(trace.bindings).toHaveLength(sample.sqlCount);
        const actualSql = trace.preparedSql.map((sql, index) => ({
          sql,
          params: trace.bindings[index],
        }));
        expect(qualificationSql).toEqual(actualSql.slice(0, -1));
        // Fixed old-provider SQL+parameter identities accompany the full DTO.
        // There is no switch that fabricates an old route by dropping completion.
        expect(
          createHash("sha256").update(JSON.stringify(actualSql)).digest("hex"),
        ).toBe(sample.fingerprints[scope]);
        expect(
          database.prepare("SELECT total_changes() AS writes").get(),
        ).toEqual(totalBefore);
      } finally {
        execution.mockRestore();
        whole.mockRestore();
        registered.mockRestore();
        resolved.mockRestore();
        evaluator.mockRestore();
        database.close();
      }
    });
  }
}
