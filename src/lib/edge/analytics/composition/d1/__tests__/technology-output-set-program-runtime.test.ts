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
import { BROWSER_VERSION_BREAKDOWN_OUTPUT } from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS } from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import { TECHNOLOGY_RADAR_OUTPUTS } from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import { TECHNOLOGY_SHARE_TREND_OUTPUTS } from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { D1ExecutionOptions } from "@/lib/edge/analytics/providers/d1/internal/execution-options";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";
import { D1SqlProgramPhysicalFrame } from "@/lib/edge/analytics/providers/d1/internal/logical-program-physical-frame";
import { qualificationRequestOwnDataSnapshot } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

const payload = 'first(event.payload("/amount")) gt 0';
const sequence =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const singleTrendOutputs = Object.values(TECHNOLOGY_SHARE_TREND_OUTPUTS.single);
const scenarios = [
  {
    key: "browser-version",
    operation: "radar",
    query: { variant: "version", browserLimit: 3, versionLimit: 3 },
    outputIds: [BROWSER_VERSION_BREAKDOWN_OUTPUT],
    single: true,
  },
  {
    key: "browser-radar",
    operation: "radar",
    query: { variant: "browser" },
    outputIds: [TECHNOLOGY_RADAR_OUTPUTS.browser],
    single: true,
  },
  {
    key: "referrer-radar",
    operation: "radar",
    query: { variant: "referrer", limit: 3 },
    outputIds: [TECHNOLOGY_RADAR_OUTPUTS.referrer],
    single: true,
  },
  {
    key: "browser-share",
    operation: "share-trend",
    query: { variant: "browser", interval: "day", limit: 3 },
    outputIds: singleTrendOutputs,
    single: false,
  },
  {
    key: "engine-share",
    operation: "share-trend",
    query: { variant: "browser-engine", interval: "day", limit: 3 },
    outputIds: singleTrendOutputs,
    single: false,
  },
  {
    key: "client-share",
    operation: "share-trend",
    query: {
      variant: "client",
      dimension: "operatingSystem",
      interval: "day",
      limit: 3,
    },
    outputIds: singleTrendOutputs,
    single: false,
  },
  {
    key: "utm-share",
    operation: "share-trend",
    query: { variant: "utm", dimension: "source", interval: "day", limit: 3 },
    outputIds: singleTrendOutputs,
    single: false,
  },
  {
    key: "referrer-share",
    operation: "share-trend",
    query: { variant: "referrer", interval: "day", limit: 3 },
    outputIds: singleTrendOutputs,
    single: false,
  },
  {
    key: "referrer-channel",
    operation: "share-trend",
    query: { variant: "referrer-channel", interval: "day", limit: 3 },
    outputIds: [
      ...Object.values(TECHNOLOGY_SHARE_TREND_OUTPUTS.source),
      ...Object.values(TECHNOLOGY_SHARE_TREND_OUTPUTS.channel),
    ],
    single: false,
  },
  {
    key: "client-cross",
    operation: "cross-dimension",
    query: {
      variant: "generic",
      primaryDimension: "browser",
      secondaryDimension: "operatingSystem",
      primaryLimit: 3,
      secondaryLimit: 3,
    },
    outputIds: Object.values(TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS),
    single: false,
  },
] as const;
type Scenario = (typeof scenarios)[number];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function executeTechnology(
  scenario: Scenario,
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
  database.exec(
    "UPDATE visits SET browser_version = '123.0', utm_source = 'w215-fixture'",
  );
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "w215-local-secret",
  } as Env;
  const diagnostics = createD1ReadDiagnostics();
  const time = createQueryTime(
    SEED_BASE_MS,
    SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
    "UTC",
    SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
  );
  const query = prepareScopedQuery(scenario.operation, {
    context: siteQueryContext(SEED_SITE_ID, audience),
    time,
    scopePreference: scope,
    filters: parseFilterDsl(
      scope === "session" ? payload : sequence,
      analyticsFilterRegistry,
    ),
    ...scenario.query,
  });
  const requestBefore = qualificationRequestOwnDataSnapshot(query);
  const metadata = scopedFilterMetadata(query.filters);
  const changesBefore = database.prepare("SELECT total_changes() AS n").get();
  const controller = new AbortController();
  const sentinel = new Error("original_technology_Core_sentinel");
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
  const programs: D1LogicalProgramExecution[] = [];
  const sqlFrames: D1SqlProgramPhysicalFrame[] = [];
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
  const actualSql =
    D1SqlProgramPhysicalFrame.prototype.executeAtOriginalReportAwait;
  vi.spyOn(
    D1SqlProgramPhysicalFrame.prototype,
    "executeAtOriginalReportAwait",
  ).mockImplementation(function (
    this: D1SqlProgramPhysicalFrame,
    ...args: Parameters<typeof actualSql>
  ) {
    sqlFrames.push(this);
    return actualSql.apply(this, args);
  });
  function observeReport(
    plan: ValidatedLogicalPlan,
    execution: D1ExecutionOptions | undefined,
  ) {
    expect(plan.outputs.map((output) => output.id)).toEqual(scenario.outputIds);
    if (audience === "private-dashboard") {
      expect(execution?.program).toBe(programs[0]);
      const producer = programs[0]?.completedWholeOutputs[0];
      if (!producer) throw new Error("actual_technology_producer_missing");
      expect(programs[0]?.completedWholeOutputs).toHaveLength(1);
      const imported = plan.nodes.filter(
        (node) => node.kind === "analysis-result",
      );
      expect(imported).toHaveLength(1);
      expect(imported[0]?.execution).toBe("program");
      expect(imported[0]?.childPlan).toBe(producer.plan);
      expect(imported[0]?.outputId).toBe(producer.output.id);
      const sources = plan.nodes.filter((node) => node.kind === "source");
      expect(sources).toHaveLength(1);
      expect(sources[0]?.entity).toBe("page");
      expect(
        sources[0]?.selection?.qualificationDependencyRefs,
      ).toBeUndefined();
      expect(sources[0]?.membershipInputs).toHaveLength(1);
      expect(sources[0]?.membershipInputs?.[0]?.role).toBe("entity");
      expect(plan.context.subject).toEqual(producer.plan.context.subject);
      expect(plan.context.scope.logicalScope).toBe(scope);
    } else {
      expect(execution).toBeUndefined();
      expect(plan.nodes.some((node) => node.kind === "analysis-result")).toBe(
        false,
      );
    }
  }
  const actualSingle = reports.queryAnalyticsReportOutputRowsFromD1;
  const single = vi
    .spyOn(reports, "queryAnalyticsReportOutputRowsFromD1")
    .mockImplementation((...args: Parameters<typeof actualSingle>) => {
      expect(args).toHaveLength(audience === "private-dashboard" ? 7 : 6);
      expect(args[2]).toBe(scenario.outputIds[0]);
      if (audience === "private-dashboard") expect(args[5]).toBeUndefined();
      observeReport(args[1], args[6]);
      return actualSingle(...args);
    });
  const actualSet = reports.queryAnalyticsReportOutputSetRowsFromD1;
  const multi = vi
    .spyOn(reports, "queryAnalyticsReportOutputSetRowsFromD1")
    .mockImplementation((...args: Parameters<typeof actualSet>) => {
      expect(args).toHaveLength(audience === "private-dashboard" ? 6 : 5);
      expect(args[2].outputIds).toEqual(scenario.outputIds);
      if (audience === "private-dashboard") expect(args[4]).toBeUndefined();
      observeReport(args[1], args[5]);
      return actualSet(...args);
    });
  try {
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve(scenario.operation);
    if (!provider) throw new Error("actual_technology_provider_missing");
    const pending = provider.execute(query, { signal: controller.signal });
    if (coreError) {
      await expect(pending).rejects.toBe(sentinel);
      expect(controller.signal.aborted).toBe(true);
      expect(single).not.toHaveBeenCalled();
      expect(multi).not.toHaveBeenCalled();
      expect(sqlFrames).toEqual([]);
      expect(programs).toHaveLength(1);
      expect(programs[0]?.completedWholeOutputs).toEqual([]);
      expect(core).toHaveBeenCalledTimes(1);
      expect(whole).toHaveBeenCalledTimes(1);
      expect(registered).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
      expect(qualificationRequestOwnDataSnapshot(query)).toBe(requestBefore);
      expect(scopedFilterMetadata(query.filters)).toBe(metadata);
      expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(
        changesBefore,
      );
      return undefined;
    }
    const dto = await pending;
    expect(JSON.stringify(dto)).toMatch(/"visitors":[1-9]/);
    expect(single).toHaveBeenCalledTimes(scenario.single ? 1 : 0);
    expect(multi).toHaveBeenCalledTimes(scenario.single ? 0 : 1);
    expect(core).toHaveBeenCalledTimes(1);
    expect(whole).toHaveBeenCalledTimes(
      audience === "private-dashboard" ? 1 : 0,
    );
    if (audience === "private-dashboard") {
      expect(registered).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
    }
    expect(qualificationRequestOwnDataSnapshot(query)).toBe(requestBefore);
    expect(scopedFilterMetadata(query.filters)).toBe(metadata);
    expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(
      changesBefore,
    );
    if (audience === "private-dashboard") {
      const program = programs[0];
      if (!program) throw new Error("actual_technology_program_missing");
      expect(program.stages).toHaveLength(2);
      const stage = program.stages[1];
      expect(stage?.outputs.map((output) => output.id)).toEqual(
        scenario.outputIds,
      );
      expect(stage?.dependencies).toHaveLength(1);
      expect(stage?.dependencies[0]?.output).toBe(
        program.completedWholeOutputs[0]?.output,
      );
      expect(program.physicalFrames).toHaveLength(1);
      expect(sqlFrames).toHaveLength(1);
      const frame = sqlFrames[0];
      if (!frame) throw new Error("actual_technology_SQL_frame_missing");
      expect(frame.command.plan).toBe(stage?.plan);
      expect(frame.command.kind).toBe(
        scenario.single ? "logical-sql" : "logical-output-set-sql",
      );
      const executed = frame.executedQuery;
      if (!executed) throw new Error("actual_technology_SQL_query_missing");
      expect(executed.sql).toBe(trace.preparedSql.at(-1));
      expect(executed.bindings ?? []).toEqual(trace.bindings.at(-1));
      if (frame.command.kind === "logical-output-set-sql") {
        expect(frame.command.outputs).toBe(stage?.outputs);
        for (const output of frame.command.outputs)
          expect(() =>
            frame.completedFor(frame.command.plan, output.id),
          ).toThrow("logical_program_sql_output_not_completed");
      }
    } else {
      expect(programs).toEqual([]);
      expect(sqlFrames).toEqual([]);
    }
    return {
      dto,
      sql: trace.preparedSql.map((sql, index) => ({
        sql,
        params: trace.bindings[index],
      })),
    };
  } finally {
    database.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}

// Compare DTOs across actual registry audiences on the same small fixture.
// Ordered SQL/parameters are retained below for same-audience old/new golden evidence.
// The API compatibility reader retains its existing prepared-membership bridge.
it.each(scenarios)(
  "executes Session Technology $key through its actual Program and preserves the existing API DTO",
  async (scenario) => {
    const program = await executeTechnology(
      scenario,
      "session",
      "private-dashboard",
    );
    const api = await executeTechnology(scenario, "session", "api-v1");
    if (!program || !api)
      throw new Error("actual_technology_success_result_missing");
    expect(program.dto).toEqual(api.dto);
  },
);
it.each([scenarios[8], scenarios[9]])(
  "executes Visitor Technology $key through the actual Seq producer with unchanged API DTO",
  async (scenario) => {
    const program = await executeTechnology(
      scenario,
      "visitor",
      "private-dashboard",
    );
    const api = await executeTechnology(scenario, "visitor", "api-v1");
    if (!program || !api)
      throw new Error("actual_technology_success_result_missing");
    expect(program.dto).toEqual(api.dto);
  },
);
it("preserves the original Technology Core rejection identity and abort before report dispatch", async () => {
  await executeTechnology(scenarios[9], "session", "private-dashboard", true);
});
