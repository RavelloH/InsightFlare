// @vitest-environment node
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
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import * as dimensions from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import type { D1ExecutionOptions } from "@/lib/edge/analytics/providers/d1/internal/execution-options";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";
import * as pages from "@/lib/edge/analytics/providers/d1/internal/pages";
import { qualificationRequestOwnDataSnapshot } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import * as referrers from "@/lib/edge/analytics/providers/d1/internal/referrers";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

const cells = [
  {
    key: "pages-with-tabs",
    operation: "pages",
    fields: {
      variant: "list",
      includeTabs: true,
      includeDetails: true,
      page: { limit: 2, cursor: null },
    },
    reader: "combined",
    outputs: 6,
  },
  {
    key: "page-tabs",
    operation: "pages",
    fields: { variant: "tabs", includeDetails: false, limit: 2 },
    reader: "tabs",
    outputs: 5,
  },
  {
    key: "boundary-top",
    operation: "dimension",
    fields: { mode: "breakdown", dimension: "session.entryPath", limit: 2 },
    reader: "boundary",
    outputs: 1,
  },
  {
    key: "referrers-page",
    operation: "referrers",
    fields: {
      variant: "list",
      includeFullUrl: false,
      limit: 2,
      page: { limit: 2, cursor: null },
      sort: "visitors",
      direction: "asc",
    },
    reader: "referrers",
    outputs: 1,
  },
] as const;
type Cell = (typeof cells)[number];
type Scope = "session" | "visitor";
const fixture = buildJourneyEventFieldsCostFixture(24);
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function execute(
  cell: Cell,
  scope: Scope,
  options: { api?: boolean; refsControl?: boolean; coreError?: boolean } = {},
) {
  const database = createMigratedDatabase();
  for (const sql of fixture.seed) database.exec(sql);
  const changes = database.prepare("SELECT total_changes() AS n").get();
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "remaining-page-program-wiring",
  } as unknown as Env;
  const query = prepareScopedQuery(cell.operation, {
    ...cell.fields,
    context: siteQueryContext(
      SEED_SITE_ID,
      options.api ? "api-v1" : "private-dashboard",
    ),
    time,
    scopePreference: scope,
    filters: parseFilterDsl(
      'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"',
      analyticsFilterRegistry,
    ),
  });
  const before = qualificationRequestOwnDataSnapshot(query);
  const metadata = scopedFilterMetadata(query.filters);
  const controller = new AbortController();
  const sentinel = new Error(`original_Core_sentinel:${cell.key}`);
  const actualEvaluate = evaluator.evaluateFilterDocument;
  const core = vi
    .spyOn(evaluator, "evaluateFilterDocument")
    .mockImplementation((...args: Parameters<typeof actualEvaluate>) => {
      if (options.coreError) {
        controller.abort();
        throw sentinel;
      }
      return actualEvaluate(...args);
    });
  const programs: D1LogicalProgramExecution[] = [];
  const actualWhole =
    D1LogicalProgramExecution.prototype.executeWholeAtOriginalCheckpoint;
  vi.spyOn(
    D1LogicalProgramExecution.prototype,
    "executeWholeAtOriginalCheckpoint",
  ).mockImplementation(function (this: D1LogicalProgramExecution, invocation) {
    programs.push(this);
    return actualWhole.call(this, invocation);
  });
  const actualBind = whole.bindWholeOriginalReader;
  const binder = vi
    .spyOn(whole, "bindWholeOriginalReader")
    .mockImplementation((input) => {
      // The control retains the very same real producer and canonical binder,
      // omitting only this new execution transport so the original refs branch
      // supplies its report. It provides no fabricated rows or completion.
      return actualBind(
        options.refsControl ? { ...input, execution: undefined } : input,
      );
    });
  const native = !options.api && !options.refsControl;
  const expectedReaderArity = options.api
    ? undefined
    : ({ combined: 11, tabs: 8, boundary: 11, referrers: 15 } as const)[
        cell.reader
      ];
  const actualCombined = pages.queryPagesWithTabsFromD1;
  const combined = vi
    .spyOn(pages, "queryPagesWithTabsFromD1")
    .mockImplementation((...args: Parameters<typeof actualCombined>) => {
      expect(args).toHaveLength(expectedReaderArity ?? (options.api ? 8 : 10));
      expect(args[10]?.program).toBe(options.api ? undefined : programs[0]);
      return actualCombined(...args);
    });
  const actualTabs = pages.queryPageTabsAggregate;
  const tabs = vi
    .spyOn(pages, "queryPageTabsAggregate")
    .mockImplementation((...args: Parameters<typeof actualTabs>) => {
      expect(args).toHaveLength(expectedReaderArity ?? (options.api ? 5 : 7));
      expect(args[7]?.program).toBe(options.api ? undefined : programs[0]);
      return actualTabs(...args);
    });
  const actualBoundary = dimensions.querySessionBoundaryDimensionFromD1;
  const boundary = vi
    .spyOn(dimensions, "querySessionBoundaryDimensionFromD1")
    .mockImplementation((...args: Parameters<typeof actualBoundary>) => {
      expect(args).toHaveLength(expectedReaderArity ?? 11);
      expect(args[10]?.execution?.program).toBe(
        options.api ? undefined : programs[0],
      );
      return actualBoundary(...args);
    });
  const actualReferrers = referrers.queryReferrersPageFromD1;
  const referrer = vi
    .spyOn(referrers, "queryReferrersPageFromD1")
    .mockImplementation((...args: Parameters<typeof actualReferrers>) => {
      expect(args).toHaveLength(expectedReaderArity ?? (options.api ? 12 : 14));
      expect(args[14]?.program).toBe(options.api ? undefined : programs[0]);
      return actualReferrers(...args);
    });
  function observe(
    plan: ValidatedLogicalPlan,
    execution: D1ExecutionOptions | undefined,
  ) {
    const imported = plan.nodes.filter(
      (node) => node.kind === "analysis-result" && node.execution === "program",
    );
    if (!native) {
      expect(execution?.program).toBeUndefined();
      expect(imported).toHaveLength(0);
      return;
    }
    const program = programs[0];
    if (!program) throw new Error("actual_completed_program_missing");
    expect(execution?.program).toBe(program);
    expect(program.completedWholeOutputs).toHaveLength(1);
    const producer = program.completedWholeOutputs[0]!;
    expect(producer.plan.outputs).toContain(producer.output);
    expect(imported).toHaveLength(1);
    const importedProducer = imported[0];
    if (importedProducer?.kind !== "analysis-result") {
      throw new Error("actual_program_analysis_result_missing");
    }
    expect(importedProducer.childPlan).toBe(producer.plan);
    expect(importedProducer.outputId).toBe(producer.output.id);
    expect(plan.context.subject).toEqual(producer.plan.context.subject);
    expect(plan.context.scope.logicalScope).toBe(scope);
    const sources = plan.nodes.filter((node) => node.kind === "source");
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.entity).toBe("page");
      expect(source.selection?.qualificationDependencyRefs).toBeUndefined();
      expect(source.selection?.preparedMembership).toBeUndefined();
      expect(source.membershipInputs).toHaveLength(1);
      expect(source.membershipInputs?.[0]?.role).toBe("entity");
    }
  }
  const actualSingle = reports.queryAnalyticsReportOutputRowsFromD1;
  const single = vi
    .spyOn(reports, "queryAnalyticsReportOutputRowsFromD1")
    .mockImplementation((...args: Parameters<typeof actualSingle>) => {
      expect(args).toHaveLength(native ? 7 : 6);
      if (native) expect(args[5]).toBeUndefined();
      observe(args[1], args[6]);
      return actualSingle(...args);
    });
  const actualSet = reports.queryAnalyticsReportOutputSetRowsFromD1;
  const set = vi
    .spyOn(reports, "queryAnalyticsReportOutputSetRowsFromD1")
    .mockImplementation((...args: Parameters<typeof actualSet>) => {
      expect(args).toHaveLength(native ? 6 : 5);
      if (native) expect(args[4]).toBeUndefined();
      expect(args[2].outputIds).toHaveLength(cell.outputs);
      observe(args[1], args[5]);
      return actualSet(...args);
    });
  const fetch = vi.fn(() => {
    throw new Error("unexpected_network");
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
    }).resolve(cell.operation);
    if (!provider) throw new Error("actual_provider_missing");
    const pending = provider.execute(query, { signal: controller.signal });
    let result: unknown;
    if (options.coreError) {
      await expect(pending).rejects.toBe(sentinel);
      expect(controller.signal.aborted).toBe(true);
      expect(programs).toHaveLength(1);
      expect(programs[0]?.completedWholeOutputs).toEqual([]);
      expect(binder).not.toHaveBeenCalled();
      expect(single).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    } else {
      result = await pending;
      expect(programs).toHaveLength(options.api ? 0 : 1);
      const selected = { combined, tabs, boundary, referrers: referrer }[
        cell.reader
      ];
      expect(selected).toHaveBeenCalledTimes(1);
      expect(single.mock.calls.length + set.mock.calls.length).toBe(1);
      if (native) {
        const program = programs[0]!;
        expect(program.stages).toHaveLength(2);
        expect(program.stages[1]?.outputs).toHaveLength(cell.outputs);
        expect(program.stages[1]?.dependencies).toHaveLength(1);
        expect(program.stages[1]?.dependencies[0]?.output).toBe(
          program.completedWholeOutputs[0]?.output,
        );
        expect(program.physicalFrames).toHaveLength(1);
      }
    }
    expect(core).toHaveBeenCalledTimes(1);
    expect(qualificationRequestOwnDataSnapshot(query)).toBe(before);
    expect(scopedFilterMetadata(query.filters)).toBe(metadata);
    expect(trace.bindings).toHaveLength(trace.preparedSql.length);
    expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(
      changes,
    );
    expect(fetch).not.toHaveBeenCalled();
    return {
      result,
      sql: trace.preparedSql.map((sql, index) => ({
        sql,
        bindings: trace.bindings[index],
      })),
    };
  } finally {
    database.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}

it.each(
  cells.flatMap((cell) =>
    (["session", "visitor"] as const).map((scope) => ({ cell, scope })),
  ),
)(
  "$cell.key $scope preserves the complete DTO and ordered SQL with an actual Program producer",
  async ({ cell, scope }) => {
    const control = await execute(cell, scope, { refsControl: true });
    const actual = await execute(cell, scope);
    expect(actual.result).toEqual(control.result);
    expect(actual.sql).toEqual(control.sql);
    // The API path keeps its old arity and never receives a Program. Its
    // executionInputs may legitimately be absent; that is not an admission proof.
    const apiControl = await execute(cell, scope, {
      api: true,
      refsControl: true,
    });
    const api = await execute(cell, scope, { api: true });
    expect(api.result).toEqual(apiControl.result);
    expect(api.sql).toEqual(apiControl.sql);
  },
);

it.each(cells)(
  "$key retains the original Core error object before every remaining reader",
  async (cell) => {
    await execute(cell, "session", { coreError: true });
  },
);
