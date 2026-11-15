// @vitest-environment node
import { createHash } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
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
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";
import * as preparations from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { qualificationRequestOwnDataSnapshot } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as referrers from "@/lib/edge/analytics/providers/d1/internal/referrers";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

const payload = 'first(event.payload("/amount")) gt 0';
const sequence =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const outputIds = ["referrer-summary", "referrer-top-sources"];
const selection = {
  outputIds,
  fields: [
    "rowType",
    "referrer",
    "totalViews",
    "directViews",
    "externalViews",
    "uniqueDomains",
    "uniqueLinks",
    "views",
  ],
  orderBy: [
    { field: "rowType", direction: "asc", nulls: "first" },
    { field: "views", direction: "desc", nulls: "last" },
    { field: "referrer", direction: "asc", nulls: "first" },
  ],
};
const payloadDto = {
  value: {
    totalViews: 11,
    directViews: 3,
    externalViews: 8,
    uniqueDomains: 4,
    uniqueLinks: 8,
    truncated: true,
    topSources: [
      { referrer: "github.com", views: 3 },
      { referrer: "duckduckgo.com", views: 2 },
    ],
  },
  source: "raw",
};
const sequenceDto = {
  value: {
    totalViews: 26,
    directViews: 7,
    externalViews: 19,
    uniqueDomains: 8,
    uniqueLinks: 19,
    truncated: true,
    topSources: [
      { referrer: "duckduckgo.com", views: 3 },
      { referrer: "github.com", views: 3 },
    ],
  },
  source: "raw",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function executeSummary(
  scope: "session" | "visitor",
  audience: "private-dashboard" | "api-v1",
  coreError = false,
) {
  vi.stubGlobal("fetch", () => {
    throw new Error("network_forbidden");
  });
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "w207-local-secret",
  } as Env;
  const diagnostics = createD1ReadDiagnostics();
  const time = createQueryTime(
    SEED_BASE_MS,
    SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
    "UTC",
    SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
  );
  const query = prepareScopedQuery("referrers", {
    context: siteQueryContext(SEED_SITE_ID, audience),
    time,
    scopePreference: scope,
    filters: parseFilterDsl(
      scope === "session" ? payload : sequence,
      analyticsFilterRegistry,
    ),
    variant: "summary" as const,
    topN: 2,
    limit: 2,
    includeFullUrl: false,
  });
  const before = qualificationRequestOwnDataSnapshot(query);
  const metadata = scopedFilterMetadata(query.filters);
  const changes = database.prepare("SELECT total_changes() AS n").get();
  const controller = new AbortController();
  const sentinel = new Error("original_Core_sentinel");
  const actualCore = evaluator.evaluateFilterDocument;
  const core = vi
    .spyOn(evaluator, "evaluateFilterDocument")
    .mockImplementation((...args: Parameters<typeof actualCore>) => {
      if (coreError) {
        controller.abort();
        throw sentinel;
      }
      return actualCore(...args);
    });
  const registered = vi.spyOn(bridge, "registerPreparedMembership");
  const resolved = vi.spyOn(bridge, "resolvePreparedMembership");
  const minted = vi.spyOn(
    preparations,
    "createPageVisitQualificationPreparation",
  );
  const boundRefs = vi.spyOn(
    preparations,
    "bindPageVisitQualificationPreparation",
  );
  const boundProgram = vi.spyOn(
    D1LogicalProgramExecution.prototype,
    "bindWholeOriginalPageConsumer",
  );
  const programs: D1LogicalProgramExecution[] = [];
  const actualWhole =
    D1LogicalProgramExecution.prototype.executeWholeAtOriginalCheckpoint;
  const whole = vi
    .spyOn(
      D1LogicalProgramExecution.prototype,
      "executeWholeAtOriginalCheckpoint",
    )
    .mockImplementation(function (this: D1LogicalProgramExecution, invocation) {
      programs.push(this);
      return actualWhole.call(this, invocation);
    });
  const actualReader = referrers.queryReferrerSummaryFromD1;
  const reader = vi
    .spyOn(referrers, "queryReferrerSummaryFromD1")
    .mockImplementation((...args: Parameters<typeof actualReader>) => {
      expect(args).toHaveLength(audience === "private-dashboard" ? 10 : 9);
      expect(args.slice(0, 6)).toEqual([
        env,
        SEED_SITE_ID,
        expect.any(Object),
        expect.any(Object),
        2,
        diagnostics,
      ]);
      expect(args[6]).toBeUndefined();
      expect(args[7]).toBeUndefined();
      expect(args[8]).toBeDefined();
      expect(args[3]).toBe(Reflect.get(args[8]!, "filters"));
      if (audience === "private-dashboard")
        expect(args[9]?.program).toBe(programs[0]);
      else expect(args[9]).toBeUndefined();
      return actualReader(...args);
    });
  const actualSet = reports.queryAnalyticsReportOutputSetRowsFromD1;
  const report = vi
    .spyOn(reports, "queryAnalyticsReportOutputSetRowsFromD1")
    .mockImplementation((...args: Parameters<typeof actualSet>) => {
      expect(args).toHaveLength(audience === "private-dashboard" ? 6 : 5);
      expect(args[2]).toEqual(selection);
      expect(args[1].outputs.map((output) => output.id)).toEqual(outputIds);
      if (audience === "private-dashboard") {
        expect(args[4]).toBeUndefined();
        expect(args[5]?.program).toBe(programs[0]);
        const producer = programs[0]?.completedWholeOutputs[0];
        if (!producer) throw new Error("actual_completed_producer_missing");
        expect(programs[0]?.completedWholeOutputs).toHaveLength(1);
        const imported = args[1].nodes.filter(
          (node) => node.kind === "analysis-result",
        );
        expect(imported).toHaveLength(1);
        expect(imported[0]?.execution).toBe("program");
        expect(imported[0]?.childPlan).toBe(producer.plan);
        expect(imported[0]?.outputId).toBe(producer.output.id);
        const sources = args[1].nodes.filter((node) => node.kind === "source");
        expect(sources).toHaveLength(1);
        expect(sources[0]?.entity).toBe("page");
        expect(
          sources[0]?.selection?.qualificationDependencyRefs,
        ).toBeUndefined();
        expect(sources[0]?.membershipInputs).toHaveLength(1);
        expect(sources[0]?.membershipInputs?.[0]?.role).toBe("entity");
        expect(args[1].context.subject).toEqual(producer.plan.context.subject);
        expect(args[1].context.scope.logicalScope).toBe(scope);
      } else {
        expect(args[4]).toBeDefined();
        expect(args[5]).toBeUndefined();
      }
      return actualSet(...args);
    });
  try {
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve("referrers");
    if (!provider) throw new Error("actual_referrers_provider_missing");
    const pending = provider.execute(query, { signal: controller.signal });
    if (coreError) {
      await expect(pending).rejects.toBe(sentinel);
      expect(controller.signal.aborted).toBe(true);
      expect(reader).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(minted).not.toHaveBeenCalled();
      expect(boundProgram).not.toHaveBeenCalled();
      expect(programs).toHaveLength(1);
      expect(programs[0]?.completedWholeOutputs).toEqual([]);
    } else {
      expect(await pending).toEqual(
        scope === "session" ? payloadDto : sequenceDto,
      );
      expect(reader).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(1);
      if (audience === "private-dashboard") {
        expect(minted).not.toHaveBeenCalled();
        const nativeInput = boundProgram.mock.calls[0]?.[0];
        expect(nativeInput?.siteId).toBe(SEED_SITE_ID);
        expect(nativeInput?.scopePlan?.scope).toBe(scope);
        for (const field of [
          "preparation",
          "relation",
          "relations",
          "maxBindings",
          "maxSourcesPerRole",
        ])
          expect(Object.hasOwn(nativeInput ?? {}, field)).toBe(false);
      } else {
        expect(minted).toHaveBeenCalledTimes(1);
        expect(minted.mock.calls[0]?.[0]).toMatchObject({
          maxBindings: 1,
          maxSourcesPerRole: 1,
          qualificationSemantics: "whole-original",
        });
      }
      expect(boundProgram).toHaveBeenCalledTimes(
        audience === "private-dashboard" ? 1 : 0,
      );
      expect(boundRefs).toHaveBeenCalledTimes(
        audience === "private-dashboard" ? 0 : 1,
      );
      expect(trace.preparedSql).toHaveLength(scope === "session" ? 4 : 3);
      if (audience === "private-dashboard") {
        const program = programs[0];
        if (!program) throw new Error("actual_program_missing");
        expect(program.stages).toHaveLength(2);
        const stage = program.stages[1];
        expect(stage?.outputs.map((output) => output.id)).toEqual(outputIds);
        expect(stage?.dependencies).toHaveLength(1);
        expect(stage?.dependencies[0]?.output).toBe(
          program.completedWholeOutputs[0]?.output,
        );
        expect(program.physicalFrames).toHaveLength(1);
        const frame = program.physicalFrames[0];
        if (!frame || !("outputs" in frame))
          throw new Error("actual_output_set_frame_missing");
        expect(frame.stage).toBe(stage);
        expect(frame.outputs).toBe(stage?.outputs);
        expect(frame.command.kind).toBe("logical-output-set-sql");
        expect(frame.command.plan).toBe(stage?.plan);
        expect(frame.command.outputs).toBe(stage?.outputs);
        expect(frame.execution.command).toBe(frame.command);
        // UNION rows have no per-output partition contract and confer no
        // single-output completed-result authority.
        for (const output of frame.outputs)
          expect(() =>
            frame.execution.completedFor(frame.command.plan, output.id),
          ).toThrow("logical_program_sql_output_not_completed");
        const executed = frame.execution.executedQuery;
        if (!executed) throw new Error("actual_output_set_query_missing");
        expect(executed.sql).toBe(trace.preparedSql.at(-1));
        expect(executed.bindings ?? []).toEqual(trace.bindings.at(-1));
      } else {
        expect(programs).toHaveLength(0);
        // Existing measured API control; no Program or permission widening.
        expect(
          createHash("sha256")
            .update(
              JSON.stringify(
                trace.preparedSql.map((sql, index) => ({
                  sql,
                  params: trace.bindings[index],
                })),
              ),
            )
            .digest("hex"),
        ).toBe(
          "2ec503236f4dc3e61c00eafdfdfc9c9503b96a1e3c99eb9d731689d0c7717ea7",
        );
      }
    }
    expect(core).toHaveBeenCalledTimes(1);
    expect(whole).toHaveBeenCalledTimes(
      audience === "private-dashboard" ? 1 : 0,
    );
    expect(registered).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
    expect(qualificationRequestOwnDataSnapshot(query)).toBe(before);
    expect(scopedFilterMetadata(query.filters)).toBe(metadata);
    expect(trace.bindings).toHaveLength(trace.preparedSql.length);
    expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(
      changes,
    );
  } finally {
    database.close();
  }
}

// Success DTOs come from the existing real-registry 24-visit Referrers fixture.
// These tests observe the current route; they do not fabricate an old fallback oracle.
it("executes private Session Referrers summary and top sources as one real Program output set", async () => {
  await executeSummary("session", "private-dashboard");
});
it("executes private Visitor Referrers summary and top sources through the same actual producer", async () => {
  await executeSummary("visitor", "private-dashboard");
});
it("keeps the existing API summary reference path and its complete ordered SQL binding fingerprint", async () => {
  await executeSummary("session", "api-v1");
});
it("preserves the original Core rejection identity and abort before multi-output construction", async () => {
  await executeSummary("session", "private-dashboard", true);
});
