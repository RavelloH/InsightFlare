// @vitest-environment node
import { expect, it, vi } from "vitest";

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
import * as cards from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as stagedRuntime from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import * as channels from "@/lib/edge/analytics/providers/d1/internal/channels";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as dimensions from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";
import { D1WholeProgramPhysicalFrame } from "@/lib/edge/analytics/providers/d1/internal/logical-program-physical-frame";
import * as preparations from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as pages from "@/lib/edge/analytics/providers/d1/internal/pages";
import { qualificationRequestOwnDataSnapshot } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

type Family = "channels" | "pages" | "dimension";
type Scope = "session" | "visitor";
const fixture = buildJourneyEventFieldsCostFixture(24);
const whole =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);

function field(value: unknown, key: PropertyKey): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function requestFor(
  registry: ReturnType<typeof createD1SiteProviderRegistry>,
  family: Family,
  scope: Scope,
  cursor: string | null,
  signal: AbortSignal,
) {
  const common = {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time,
    filters: parseFilterDsl(whole, analyticsFilterRegistry),
    scopePreference: scope,
  };
  if (family === "channels") {
    const query = prepareScopedQuery("channels", {
      ...common,
      mode: "list" as const,
      limit: 2,
    });
    const provider = registry.resolve("channels");
    if (!provider) throw new Error("missing_channels_provider");
    return { query, execute: () => provider.execute(query, { signal }) };
  }
  if (family === "pages") {
    const query = prepareScopedQuery("pages", {
      ...common,
      variant: "list" as const,
      includeDetails: false,
      page: { limit: 1, cursor },
    });
    const provider = registry.resolve("pages");
    if (!provider) throw new Error("missing_pages_provider");
    return { query, execute: () => provider.execute(query, { signal }) };
  }
  const query = prepareScopedQuery("dimension", {
    ...common,
    mode: "breakdown" as const,
    dimension: "page.path",
    page: { limit: 1, cursor },
  });
  const provider = registry.resolve("dimension");
  if (!provider) throw new Error("missing_dimension_provider");
  return { query, execute: () => provider.execute(query, { signal }) };
}

async function executePrivateProgram(
  family: Family,
  scope: Scope,
  options: {
    foreignProgram?: D1LogicalProgramExecution;
    coreError?: boolean;
  } = {},
) {
  const database = createMigratedDatabase();
  for (const sql of fixture.seed) database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "private-program-runtime",
  } as unknown as Env;
  const diagnostics = createD1ReadDiagnostics();
  const controller = new AbortController();
  const marker = new Error("private_program_original_core_error");
  const actualCore = evaluator.evaluateFilterDocument;
  const actualRows = reports.queryAnalyticsReportOutputRowsFromD1;
  const actualChannels = channels.queryChannelAggregate;
  const actualPages = pages.queryPagesPageFromD1;
  const actualDimension = dimensions.queryDimensionPageFromD1;
  const actualWhole =
    D1LogicalProgramExecution.prototype.executeWholeAtOriginalCheckpoint;
  const programs: D1LogicalProgramExecution[] = [];
  const executingPrograms: D1LogicalProgramExecution[] = [];
  const events: string[] = [];
  let foreignProbe: Promise<void> | undefined;
  let forbiddenFetches = 0;
  const register = vi.spyOn(bridge, "registerPreparedMembership");
  const resolve = vi.spyOn(bridge, "resolvePreparedMembership");
  const createPreparation = vi.spyOn(
    preparations,
    "createPageVisitQualificationPreparation",
  );
  const refsBind = vi.spyOn(
    preparations,
    "bindPageVisitQualificationPreparation",
  );
  const programBind = vi.spyOn(
    D1LogicalProgramExecution.prototype,
    "bindWholeOriginalPageConsumer",
  );
  const wholeExecution = vi
    .spyOn(
      D1LogicalProgramExecution.prototype,
      "executeWholeAtOriginalCheckpoint",
    )
    .mockImplementation(function (this: D1LogicalProgramExecution, invocation) {
      executingPrograms.push(this);
      return actualWhole.call(this, invocation);
    });
  const core = vi
    .spyOn(evaluator, "evaluateFilterDocument")
    .mockImplementation((...args: Parameters<typeof actualCore>) => {
      events.push("Core");
      if (options.coreError) {
        controller.abort();
        throw marker;
      }
      return actualCore(...args);
    });
  function observeReader(
    args: readonly unknown[],
    arity: number,
    ownerIndex: number,
    executionIndex: number,
  ) {
    expect(args).toHaveLength(arity);
    expect(args[0]).toBe(env);
    const capturedOwner =
      family === "dimension"
        ? field(args[ownerIndex], "owner")
        : args[ownerIndex];
    expect(capturedOwner).toBeDefined();
    expect(args[3]).toBe(field(capturedOwner, "filters"));
    expect(field(args[executionIndex], "program")).toBeInstanceOf(
      D1LogicalProgramExecution,
    );
    expect(
      args[family === "channels" ? 5 : family === "pages" ? 8 : 10],
    ).toBeUndefined();
  }
  const channelReader = vi
    .spyOn(channels, "queryChannelAggregate")
    .mockImplementation((...args: Parameters<typeof actualChannels>) => {
      observeReader(args, 8, 6, 7);
      if (options.foreignProgram) {
        const foreignArgs: Parameters<typeof actualChannels> = [...args];
        foreignArgs[7] = { ...args[7], program: options.foreignProgram };
        const beforeSql = trace.preparedSql.length;
        const beforePreparations = createPreparation.mock.calls.length;
        const beforeBindings = programBind.mock.calls.length;
        const beforeDiagnostics = JSON.stringify(diagnostics);
        // A real second request supplies this donor. The failed probe must not
        // consume the original owner's one binding before the valid call below.
        const pending = actualChannels(...foreignArgs);
        expect(trace.preparedSql).toHaveLength(beforeSql);
        expect(createPreparation).toHaveBeenCalledTimes(beforePreparations);
        expect(programBind).toHaveBeenCalledTimes(beforeBindings);
        expect(JSON.stringify(diagnostics)).toBe(beforeDiagnostics);
        foreignProbe = pending.then(
          () => {
            throw new Error("foreign_program_unexpectedly_accepted");
          },
          (error: unknown) => {
            expect(field(error, "message")).toBe(
              "qualification_execution_program_producer_mismatch",
            );
          },
        );
      }
      return actualChannels(...args);
    });
  const pageReader = vi
    .spyOn(pages, "queryPagesPageFromD1")
    .mockImplementation((...args: Parameters<typeof actualPages>) => {
      observeReader(args, 11, 9, 10);
      return actualPages(...args);
    });
  const dimensionReader = vi
    .spyOn(dimensions, "queryDimensionPageFromD1")
    .mockImplementation((...args: Parameters<typeof actualDimension>) => {
      observeReader(args, 14, 11, 13);
      return actualDimension(...args);
    });
  const rows = vi
    .spyOn(reports, "queryAnalyticsReportOutputRowsFromD1")
    .mockImplementation((...args: Parameters<typeof actualRows>) => {
      expect(args).toHaveLength(7);
      expect(args[5]).toBeUndefined();
      const program = args[6]?.program;
      expect(program).toBeInstanceOf(D1LogicalProgramExecution);
      if (!program) throw new Error("expected_actual_program");
      expect(executingPrograms).toContain(program);
      programs.push(program);
      expect(program.completedWholeOutputs).toHaveLength(1);
      const producer = program.completedWholeOutputs[0];
      if (!producer) throw new Error("expected_actual_completed_producer");
      expect(producer.plan.outputs).toContain(producer.output);
      const imports = args[1].nodes.filter(
        (node) => node.kind === "analysis-result",
      );
      expect(imports).toHaveLength(1);
      expect(imports[0]?.execution).toBe("program");
      expect(imports[0]?.childPlan).toBe(producer.plan);
      expect(imports[0]?.outputId).toBe(producer.output.id);
      const sources = args[1].nodes.filter((node) => node.kind === "source");
      expect(sources).toHaveLength(1);
      expect(sources[0]?.entity).toBe("page");
      const selection = sources[0]?.selection;
      if (!selection) throw new Error("expected_actual_source_selection");
      expect(selection.qualificationDependencyRefs).toBeUndefined();
      const edges = sources[0]?.membershipInputs;
      expect(edges).toHaveLength(1);
      expect(edges?.[0]?.role).toBe("entity");
      const distinct = args[1].nodes.find(
        (node) => node.id === edges?.[0]?.input,
      );
      expect(distinct?.kind).toBe("distinct");
      const projection = args[1].nodes.find(
        (node) => node.id === field(distinct, "input"),
      );
      expect(projection?.kind).toBe("project");
      const roleFilter = args[1].nodes.find(
        (node) => node.id === field(projection, "input"),
      );
      expect(roleFilter?.kind).toBe("filter");
      expect(field(roleFilter, "input")).toBe(imports[0]?.id);
      expect(args[1].context.subject).toEqual(producer.plan.context.subject);
      expect(args[1].context.scope.logicalScope).toBe(scope);
      return actualRows(...args);
    });
  vi.stubGlobal("fetch", () => {
    forbiddenFetches += 1;
    throw new Error("private_program_network_forbidden");
  });
  try {
    const registry = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
      diagnostics,
    });
    const changesBefore = database.prepare("SELECT total_changes() AS n").get();
    let cursor: string | null = options.coreError
      ? "malformed-cursor-after-Core"
      : null;
    const pagesToRead = family === "channels" || options.coreError ? 1 : 2;
    for (let page = 0; page < pagesToRead; page += 1) {
      const request = requestFor(
        registry,
        family,
        scope,
        cursor,
        controller.signal,
      );
      const before = qualificationRequestOwnDataSnapshot(request.query);
      const metadata = scopedFilterMetadata(request.query.filters);
      const sqlBefore = trace.preparedSql.length;
      const pending = request.execute();
      events.push("returned");
      if (options.coreError) {
        await expect(pending).rejects.toBe(marker);
        expect(controller.signal.aborted).toBe(true);
        expect(events).toEqual(["returned", "Core"]);
        expect(rows).not.toHaveBeenCalled();
        expect(channelReader).not.toHaveBeenCalled();
        expect(pageReader).not.toHaveBeenCalled();
        expect(dimensionReader).not.toHaveBeenCalled();
        expect(createPreparation).not.toHaveBeenCalled();
        expect(executingPrograms).toHaveLength(1);
        expect(executingPrograms[0]?.completedWholeOutputs).toEqual([]);
      } else {
        const response = await pending;
        if (foreignProbe) await foreignProbe;
        expect(controller.signal.aborted).toBe(false);
        const value = field(response, "value");
        const items = field(value, "items");
        expect(Array.isArray(items)).toBe(true);
        expect(Array.isArray(items) && items.length).toBeGreaterThan(0);
        expect(trace.preparedSql.length).toBeGreaterThan(sqlBefore);
        if (family !== "channels") {
          const next = field(field(value, "pagination"), "nextCursor");
          expect(typeof next).toBe("string");
          if (typeof next !== "string" || !next)
            throw new Error("expected_real_page_cursor");
          cursor = next;
        }
        const program = programs.at(-1);
        expect(program?.stages).toHaveLength(2);
        expect(program?.physicalFrames).toHaveLength(1);
        expect(program?.stages[1]?.dependencies).toHaveLength(1);
        expect(program?.stages[1]?.dependencies[0]?.output).toBe(
          program?.completedWholeOutputs[0]?.output,
        );
      }
      expect(qualificationRequestOwnDataSnapshot(request.query)).toBe(before);
      expect(scopedFilterMetadata(request.query.filters)).toBe(metadata);
    }
    expect(core).toHaveBeenCalledTimes(pagesToRead);
    expect(wholeExecution).toHaveBeenCalledTimes(pagesToRead);
    expect(register).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(refsBind).not.toHaveBeenCalled();
    expect(createPreparation).not.toHaveBeenCalled();
    expect(programBind).toHaveBeenCalledTimes(
      options.coreError ? 0 : pagesToRead,
    );
    expect(trace.bindings).toHaveLength(trace.preparedSql.length);
    expect(trace.preparedSql.every((sql) => sql.length > 0)).toBe(true);
    expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(
      changesBefore,
    );
    expect(forbiddenFetches).toBe(0);
    return programs.at(-1);
  } finally {
    rows.mockRestore();
    dimensionReader.mockRestore();
    pageReader.mockRestore();
    channelReader.mockRestore();
    core.mockRestore();
    wholeExecution.mockRestore();
    programBind.mockRestore();
    refsBind.mockRestore();
    createPreparation.mockRestore();
    register.mockRestore();
    resolve.mockRestore();
    vi.unstubAllGlobals();
    database.close();
  }
}

it("consumes the private Channels Session completion through its actual Program Source", async () => {
  await executePrivateProgram("channels", "session");
});
it("consumes the private Channels Visitor completion through its actual Program Source", async () => {
  await executePrivateProgram("channels", "visitor");
});
it("consumes private Pages Session completion and its real second-page cursor", async () => {
  await executePrivateProgram("pages", "session");
});
it("consumes private Pages Visitor completion and its real second-page cursor", async () => {
  await executePrivateProgram("pages", "visitor");
});
it("consumes private dimension Session completion and its real second-page cursor", async () => {
  await executePrivateProgram("dimension", "session");
});
it("consumes private dimension Visitor completion and its real second-page cursor", async () => {
  await executePrivateProgram("dimension", "visitor");
});
it("rejects another real same-site Program without consuming the original owner's binding", async () => {
  const donor = await executePrivateProgram("channels", "session");
  if (!donor) throw new Error("expected_actual_donor_program");
  await executePrivateProgram("channels", "session", { foreignProgram: donor });
});
it("preserves the original Core error and abort before malformed page cursor validation", async () => {
  await executePrivateProgram("pages", "session", { coreError: true });
});

it("keeps the real Program producer's original await checkpoint before canonical construction and synchronous preparation", async () => {
  const database = createMigratedDatabase();
  for (const sql of fixture.seed) database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "private-program-checkpoint",
  } as unknown as Env;
  const query = prepareScopedQuery("event-summary", {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time,
    filters: parseFilterDsl(whole, analyticsFilterRegistry),
    scopePreference: "session",
  });
  const events: string[] = [];
  const programs: D1LogicalProgramExecution[] = [];
  const actualWhole =
    D1LogicalProgramExecution.prototype.executeWholeAtOriginalCheckpoint;
  const actualFrame =
    D1WholeProgramPhysicalFrame.prototype.executeAtOriginalCheckpoint;
  type Matches = Awaited<ReturnType<typeof actualFrame>>;
  let release!: (matches: Matches) => void;
  const pending = new Promise<Matches>((resolve) => {
    release = resolve;
  });
  const physicalRun: { producer?: ReturnType<typeof actualFrame> } = {};
  const wholeExecution = vi
    .spyOn(
      D1LogicalProgramExecution.prototype,
      "executeWholeAtOriginalCheckpoint",
    )
    .mockImplementation(function (this: D1LogicalProgramExecution, invocation) {
      programs.push(this);
      return actualWhole.call(this, invocation);
    });
  const physical = vi.spyOn(
    D1WholeProgramPhysicalFrame.prototype,
    "executeAtOriginalCheckpoint",
  );
  const stage = vi.spyOn(stagedRuntime, "executeAnalyticsLogicalStage");
  const register = vi.spyOn(bridge, "registerPreparedMembership");
  const resolve = vi.spyOn(bridge, "resolvePreparedMembership");
  const core = vi.spyOn(evaluator, "evaluateFilterDocument");
  const originalBuilder = cards.buildEventSummaryCardsPlan;
  const originalPreparation =
    preparations.createPageVisitQualificationPreparation;
  const builder = vi.spyOn(cards, "buildEventSummaryCardsPlan");
  const preparation = vi.spyOn(
    preparations,
    "createPageVisitQualificationPreparation",
  );
  let forbiddenFetches = 0;
  vi.stubGlobal("fetch", () => {
    forbiddenFetches++;
    throw new Error("private_checkpoint_network_forbidden");
  });
  try {
    const registry = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
    });
    const before = qualificationRequestOwnDataSnapshot(query);
    const changesBefore = database.prepare("SELECT total_changes() AS n").get();
    // First exercise this exact Program path with its real SQLite producer.
    const baseline = await registry.resolve("event-summary")!.execute(query);
    expect(field(field(baseline, "value"), "summary")).toEqual({
      events: 6,
      eventTypes: 2,
      sessions: 3,
      visitors: 3,
      avgEventsPerSession: 2,
    });
    expect(wholeExecution).toHaveBeenCalledTimes(1);
    expect(physical).toHaveBeenCalledTimes(1);
    expect(stage).not.toHaveBeenCalled();
    expect(programs[0]?.completedWholeOutputs).toHaveLength(1);
    expect(core).toHaveBeenCalledTimes(1);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(trace.preparedSql).toHaveLength(3);
    const baselineSql = [...trace.preparedSql];
    const baselineParams = trace.bindings.map((params) => [...params]);
    trace.preparedSql.length = 0;
    trace.bindings.length = 0;
    builder.mockClear();
    preparation.mockClear();
    physical.mockImplementation(function (this: D1WholeProgramPhysicalFrame) {
      events.push("executor");
      // Run the true invocation to its own physical terminal. Only the Promise
      // observed at the original await is held; no rows/completion are supplied
      // by the test, and this observer adds no async/then/await wrapper.
      physicalRun.producer = actualFrame.call(this);
      return pending;
    });
    builder.mockImplementation(
      (...args: Parameters<typeof originalBuilder>) => {
        events.push("canonical-builder");
        return originalBuilder(...args);
      },
    );
    preparation.mockImplementation(
      (...args: Parameters<typeof originalPreparation>) => {
        events.push("create-preparation");
        return originalPreparation(...args);
      },
    );
    const result = registry.resolve("event-summary")!.execute(query);
    events.push("returned");
    for (let n = 0; !events.includes("executor") && n < 30; n++)
      await Promise.resolve();
    expect(events).toEqual(["returned", "executor"]);
    const actualProducer = physicalRun.producer;
    if (!actualProducer) throw new Error("expected_real_physical_producer");
    // Test-side observation only: finish real SQLite while the original await
    // still sees the controlled pending Promise. This is not a producer wrapper.
    const actualMatches = await actualProducer;
    expect(actualMatches.length).toBeGreaterThan(0);
    expect(programs[1]).not.toBe(programs[0]);
    expect(programs[1]?.completedWholeOutputs).toEqual([]);
    expect(builder).not.toHaveBeenCalled();
    expect(preparation).not.toHaveBeenCalled();
    expect(trace.preparedSql).toHaveLength(2);
    events.push("release");
    release(actualMatches);
    const pulse = (n: number) =>
      queueMicrotask(() => {
        events.push("reaction-" + n);
        if (n < 12) pulse(n + 1);
      });
    pulse(1);
    const controlled = await result;
    events.push("resolved");
    expect(events).toEqual([
      "returned",
      "executor",
      "release",
      "reaction-1",
      "reaction-2",
      "canonical-builder",
      "create-preparation",
      ...Array.from({ length: 10 }, (_, n) => "reaction-" + (n + 3)),
      "resolved",
    ]);
    expect(controlled).toEqual(baseline);
    expect(trace.preparedSql).toEqual(baselineSql);
    expect(trace.bindings).toEqual(baselineParams);
    expect(core).toHaveBeenCalledTimes(2);
    expect(wholeExecution).toHaveBeenCalledTimes(2);
    expect(physical).toHaveBeenCalledTimes(2);
    expect(stage).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(programs[1]?.completedWholeOutputs).toHaveLength(1);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(qualificationRequestOwnDataSnapshot(query)).toBe(before);
    expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(
      changesBefore,
    );
    expect(forbiddenFetches).toBe(0);
  } finally {
    preparation.mockRestore();
    builder.mockRestore();
    core.mockRestore();
    resolve.mockRestore();
    register.mockRestore();
    stage.mockRestore();
    physical.mockRestore();
    wholeExecution.mockRestore();
    vi.unstubAllGlobals();
    database.close();
  }
});
