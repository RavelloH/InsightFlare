// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { COMPARISON_MEMBERSHIP_CHILD_OUTPUTS } from "@/lib/edge/analytics/engine/comparison-membership-dependency-plan";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { crossBreakdownPageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  COST_FILTER,
  COST_TIME,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import { SEED_SITE_ID } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { buildComparisonDimensionRollupPlan } from "@/lib/edge/analytics/providers/d1/internal/comparison-dimension-source";
import { snapshotPageVisitQualificationPlan } from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { projectWholeOriginalMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";
import {
  advanceWholeOriginalEventTrend,
  associateWholeOriginalCompletion,
  bindTeamExactWholeOriginalReader,
  bindWholeFilterReader,
  bindWholeOriginalComparisonChild,
  bindWholeOriginalEventDetailReader,
  bindWholeOriginalOverview,
  bindWholeOriginalReader,
  createWholeFilterReaderDependency,
  wholeFilterReaderDependencyFromQuery,
  wholeOriginalTeamSitesQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const hooks = vi.hoisted(() => ({
  referrerPlan: undefined as undefined | ((plan: unknown) => unknown),
  wholeDescription: undefined as undefined | ((value: unknown) => unknown),
  eventDescription: undefined as undefined | ((value: unknown) => unknown),
}));

vi.mock(
  import("@/lib/edge/analytics/engine/referrer-report-plan"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      buildReferrerSummaryPlan: (
        ...args: Parameters<typeof actual.buildReferrerSummaryPlan>
      ) => {
        const plan = actual.buildReferrerSummaryPlan(...args);
        return hooks.referrerPlan
          ? (hooks.referrerPlan(plan) as typeof plan)
          : plan;
      },
    };
  },
);
vi.mock(
  import("@/lib/edge/analytics/engine/whole-filter-reader-catalog"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      describeWholeFilterReader: (
        ...args: Parameters<typeof actual.describeWholeFilterReader>
      ) => {
        const description = actual.describeWholeFilterReader(...args);
        return hooks.wholeDescription
          ? (hooks.wholeDescription(description) as typeof description)
          : description;
      },
    };
  },
);
vi.mock(
  import("@/lib/edge/analytics/engine/event-membership-reader-contract"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      describeEventMembershipReader: (
        ...args: Parameters<typeof actual.describeEventMembershipReader>
      ) => {
        const description = actual.describeEventMembershipReader(...args);
        return hooks.eventDescription
          ? (hooks.eventDescription(description) as typeof description)
          : description;
      },
    };
  },
);

beforeEach(() => {
  hooks.referrerPlan = undefined;
  hooks.wholeDescription = undefined;
  hooks.eventDescription = undefined;
});

const consumer = {
  kind: "referrers-summary" as const,
  configuration: { topN: 10 },
};

function referrersFixture() {
  const query = prepareScopedQuery("referrers", {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: COST_TIME,
    scopePreference: "session",
    filters: parseFilterDsl(COST_FILTER, analyticsFilterRegistry),
    variant: "summary",
    topN: 10,
  } as unknown as QueryInput) as unknown as { filters: FilterDocument };
  const metadata = scopedFilterMetadata(query.filters);
  if (!metadata) throw new Error("expected-scoped-referrers-fixture");
  const input = {
    siteId: SEED_SITE_ID,
    consumer,
    readerQueryTime: COST_TIME as QueryTime,
    filters: query.filters,
    queryTime: COST_TIME as QueryTime,
    scopePlan: metadata.plan as ScopedFilterPlan,
    matches: [{ siteId: SEED_SITE_ID, kind: "entity" as const, id: "ses0" }],
    requestSnapshot: "snapshot",
  };
  return { input, dependency: createWholeFilterReaderDependency(input) };
}

it("ignores a non-object query when looking up a reader dependency", () => {
  for (const value of [undefined, null, 7, "query"])
    expect(
      wholeFilterReaderDependencyFromQuery(value, "referrers-summary"),
    ).toBeUndefined();
});

it("rejects malformed or foreign match rows while projecting the entity relation", () => {
  const { input } = referrersFixture();
  expect(() =>
    createWholeFilterReaderDependency({
      ...input,
      matches: [undefined as never],
    }),
  ).toThrow("qualification_execution_match_invalid");
  expect(() =>
    createWholeFilterReaderDependency({
      ...input,
      matches: [{ siteId: "other-site", kind: "entity", id: "ses0" }],
    }),
  ).toThrow("qualification_execution_entity_identity_invalid");
  expect(() =>
    createWholeFilterReaderDependency({
      ...input,
      matches: [{ siteId: SEED_SITE_ID, kind: "entity", id: 7 as never }],
    }),
  ).toThrow("qualification_execution_entity_identity_invalid");
  // Non-entity kinds are skipped rather than rejected, and contribute no row.
  expect(
    createWholeFilterReaderDependency({
      ...input,
      matches: [
        { siteId: "other-site", kind: "visit", id: "v" },
        { siteId: SEED_SITE_ID, kind: "event", id: "e" },
      ],
    }).description.consumer,
  ).toEqual(consumer);
});

it("refuses a reader consumer outside the closed catalog", () => {
  const { input } = referrersFixture();
  expect(() =>
    createWholeFilterReaderDependency({
      ...input,
      consumer: {
        kind: "referrers-summary",
        configuration: { topN: -1 },
      },
    }),
  ).toThrow("whole_filter_reader_consumer_invalid");
});

it("rejects a copied consumer key which matches the description but not the retained one", () => {
  const { input, dependency } = referrersFixture();
  expect(() =>
    bindWholeFilterReader({
      dependency: {
        ...dependency,
        consumerKey: { ...(dependency.consumerKey as object), topN: 11 },
      },
      siteId: SEED_SITE_ID,
      consumer,
    }),
  ).toThrow("qualification_execution_plan_snapshot_mismatch");
  // The untouched dependency still binds exactly once.
  expect(
    bindWholeFilterReader({ dependency, siteId: SEED_SITE_ID, consumer }).plan
      .outputs,
  ).toHaveLength(2);
  void input;
});

it("rejects a canonical plan whose outputs differ from the catalog description", () => {
  const { dependency } = referrersFixture();
  hooks.referrerPlan = (plan) => {
    const typed = plan as { outputs: unknown[] };
    return { ...typed, outputs: typed.outputs.slice(0, 1) };
  };
  expect(() =>
    bindWholeFilterReader({ dependency, siteId: SEED_SITE_ID, consumer }),
  ).toThrow("whole_filter_reader_output_mismatch");
});

it("rejects a canonical plan whose Source count differs from the catalog description", () => {
  // Hook both creation and binding, so the copied-description check passes and
  // only the plan-versus-description Source proof can refuse.
  hooks.wholeDescription = (description) => {
    const typed = description as {
      outputs: { sources: unknown[] }[];
    };
    return {
      ...typed,
      outputs: typed.outputs.map((output) => ({
        ...output,
        sources: [...output.sources, output.sources[0]],
      })),
    };
  };
  const { dependency } = referrersFixture();
  expect(() =>
    bindWholeFilterReader({ dependency, siteId: SEED_SITE_ID, consumer }),
  ).toThrow("whole_filter_reader_sources_mismatch");
});

it("fails closed for original consumers which were never associated or have another kind", () => {
  const owner = {};
  expect(() =>
    bindWholeOriginalOverview({
      owner,
      kind: "aggregate",
      siteId: SEED_SITE_ID,
      filters: { version: 1, root: null } as unknown as FilterDocument,
      readerQueryTime: COST_TIME,
    }),
  ).toThrow("whole_filter_reader_consumer_mismatch");
  expect(() =>
    advanceWholeOriginalEventTrend(owner, { kind: "series", rows: [] }),
  ).toThrow("whole_filter_reader_consumer_mismatch");
  expect(
    wholeOriginalTeamSitesQualificationFromQuery({} as never),
  ).toBeUndefined();
  expect(
    bindTeamExactWholeOriginalReader({
      owner,
      siteId: SEED_SITE_ID,
      filters: { version: 1, root: null } as unknown as FilterDocument,
      readerQueryTime: COST_TIME,
      selection: undefined as never,
      dimension: "browser",
      limit: 0,
      sortBy: "views",
      sortDirection: "desc",
    }),
  ).toBeUndefined();
});

function wholeOriginalFixture(
  kind: "event-summary" | "event-trend",
  mode: "entity" | "observation" = "entity",
) {
  const request = prepareScopedQuery("event-summary", {
    context: siteQueryContext(SEED_SITE_ID, "api-v1"),
    time: COST_TIME,
    scopePreference: mode === "entity" ? "session" : "event",
    filters: parseFilterDsl(
      'page.path eq "/qualifier"',
      analyticsFilterRegistry,
    ),
  } as unknown as QueryInput) as unknown as { filters: FilterDocument };
  const metadata = scopedFilterMetadata(request.filters);
  if (!metadata) throw new Error("expected-scoped-fixture");
  const projection = projectWholeOriginalMembership({
    siteIds: [SEED_SITE_ID],
    mode,
    matches: [{ siteId: SEED_SITE_ID, kind: "entity", id: "ses0" }],
  });
  const owner = {};
  const consumerValue =
    kind === "event-trend"
      ? {
          kind,
          configuration: { limit: 5, interval: "day" as const },
          stage: { kind: "series" as const },
        }
      : { kind };
  associateWholeOriginalCompletion(owner, { kind } as never, projection, {
    filters: request.filters,
    metadata,
  });
  return {
    owner,
    projection,
    consumer: consumerValue,
    filters: request.filters,
    metadata,
    bindInput: {
      owner,
      consumer: consumerValue,
      siteId: SEED_SITE_ID,
      filters: request.filters,
      queryTime: metadata.time,
      scopePlan: metadata.plan,
    },
  };
}

it("binds the canonical event summary reader, then rejects a changed consumer kind", () => {
  const f = wholeOriginalFixture("event-summary");
  const bound = bindWholeOriginalReader(f.bindInput as never);
  expect(bound && "plan" in bound && bound.plan.outputs.length).toBeGreaterThan(
    0,
  );
  expect(() =>
    bindWholeOriginalReader({
      ...f.bindInput,
      consumer: { kind: "event-types", configuration: {} },
    } as never),
  ).toThrow("whole_filter_reader_consumer_mismatch");
});

it("rejects an event reader whose catalog output set or Source role changed", () => {
  const outputsChanged = wholeOriginalFixture("event-summary");
  hooks.eventDescription = (description) => ({
    ...(description as { outputs: { outputId: string }[] }),
    outputs: (description as { outputs: { outputId: string }[] }).outputs.map(
      (output) => ({ ...output, outputId: "not-a-plan-output" }),
    ),
  });
  expect(() =>
    bindWholeOriginalReader(outputsChanged.bindInput as never),
  ).toThrow("whole_filter_reader_output_mismatch");
  const sourcesChanged = wholeOriginalFixture("event-summary");
  hooks.eventDescription = (description) => ({
    ...(description as { outputs: { sources: unknown[] }[] }),
    outputs: (
      description as { outputs: { sources: { entity: string }[] }[] }
    ).outputs.map((output) => ({
      ...output,
      sources: [...output.sources, output.sources[0]!],
    })),
  });
  expect(() =>
    bindWholeOriginalReader(sourcesChanged.bindInput as never),
  ).toThrow("whole_filter_reader_sources_mismatch");
  hooks.eventDescription = () => ({ outputs: [] });
  expect(() =>
    bindWholeOriginalReader(
      wholeOriginalFixture("event-summary").bindInput as never,
    ),
  ).toThrow("whole_filter_reader_consumer_invalid");
});

it("requires the completed projection to own the role the reader consumes", () => {
  const f = wholeOriginalFixture("event-summary");
  const owner = {};
  associateWholeOriginalCompletion(
    owner,
    { kind: "event-summary" },
    { ...f.projection, relations: {} },
    { filters: f.filters, metadata: f.metadata },
  );
  expect(() =>
    bindWholeOriginalReader({ ...f.bindInput, owner } as never),
  ).toThrow("prepared_membership_role_missing");
});

it("rejects event trend stage advances outside the bound stage order", () => {
  const f = wholeOriginalFixture("event-trend");
  // Nothing has been bound yet, so neither result kind may advance the stage.
  expect(() =>
    advanceWholeOriginalEventTrend(f.owner, { kind: "series", rows: [] }),
  ).toThrow("event_trend_whole_reader_stage_mismatch");
  expect(() =>
    advanceWholeOriginalEventTrend(f.owner, { kind: "points", rows: [] }),
  ).toThrow("event_trend_whole_reader_stage_mismatch");
});

it("rejects a team exact reader whose request context is not the associated one", () => {
  const f = wholeOriginalFixture("event-summary");
  const owner = {
    context: {
      subject: { kind: "site" },
      policy: { audience: "private-dashboard" },
    },
  };
  associateWholeOriginalCompletion(
    owner,
    {
      kind: "team-exact-dimension",
      readers: { teamId: "team", siteIds: [SEED_SITE_ID] },
    } as never,
    f.projection,
    { filters: f.filters, metadata: f.metadata },
  );
  expect(() =>
    bindTeamExactWholeOriginalReader({
      owner,
      siteId: SEED_SITE_ID,
      filters: f.filters,
      readerQueryTime: COST_TIME,
      selection: crossBreakdownPageDimensionSelection("browser")!,
      dimension: "browser",
      limit: 0,
      excludeEmpty: true,
      sortBy: "views",
      sortDirection: "desc",
    }),
  ).toThrow("team_exact_whole_original_context_mismatch");
});

const detailConfiguration = {
  eventName: "qualifier",
  interval: "day" as const,
  includeBreakdowns: true,
  includeContext: false,
};

function detailFixture(
  options: {
    kind?: "event-type-detail" | "event-summary";
    qualificationTime?: QueryTime | undefined;
    relations?: boolean;
    projectedSite?: string;
  } = {},
) {
  const f = wholeOriginalFixture("event-summary");
  const owner = {};
  associateWholeOriginalCompletion(
    owner,
    { kind: options.kind ?? "event-type-detail" } as never,
    options.relations === false
      ? { ...f.projection, relations: {} }
      : options.projectedSite
        ? { ...f.projection, siteIds: [options.projectedSite] }
        : f.projection,
    {
      filters: f.filters,
      metadata: f.metadata,
      qualificationTime:
        "qualificationTime" in options ? options.qualificationTime : COST_TIME,
    },
  );
  const bind = (
    child: "overview" | "trend" | "context" = "overview",
    configuration = detailConfiguration,
    overrides: Record<string, unknown> = {},
  ) =>
    bindWholeOriginalEventDetailReader({
      membership: {
        kind: "whole-original-event-type-detail",
        owner,
        configuration,
      },
      child,
      siteId: SEED_SITE_ID,
      filters: f.filters,
      queryTime: f.metadata.time,
      readerQueryTime: f.metadata.time,
      scopePlan: f.metadata.plan,
      ...overrides,
    });
  return { f, owner, bind };
}

it("binds each event detail child once and keeps one configuration for all children", () => {
  const { bind } = detailFixture();
  expect(bind("overview")?.plan.outputs.length).toBeGreaterThan(0);
  expect(() => bind("overview")).toThrow(
    "event_type_detail_whole_reader_reused",
  );
  expect(() =>
    bind("trend", { ...detailConfiguration, eventName: "other" }),
  ).toThrow("whole_filter_reader_consumer_mismatch");
  expect(bind("trend")?.plan.outputs.length).toBeGreaterThan(0);
});

it("rejects event detail binding for a foreign consumer kind or request context", () => {
  expect(() => detailFixture({ kind: "event-summary" }).bind()).toThrow(
    "whole_filter_reader_consumer_mismatch",
  );
  expect(() => detailFixture({ projectedSite: "other-site" }).bind()).toThrow(
    "qualification_execution_plan_snapshot_mismatch",
  );
  expect(() => detailFixture({ qualificationTime: undefined }).bind()).toThrow(
    "qualification_execution_plan_snapshot_mismatch",
  );
  expect(() => detailFixture({ relations: false }).bind()).toThrow(
    "prepared_membership_role_missing",
  );
});

it("rejects an event detail child whose catalog outputs or Sources changed", () => {
  hooks.eventDescription = (description) => ({
    ...(description as object),
    outputs: [],
  });
  expect(() => detailFixture().bind()).toThrow(
    "whole_filter_reader_consumer_invalid",
  );
  hooks.eventDescription = (description) => ({
    ...(description as { outputs: { outputId: string }[] }),
    outputs: (description as { outputs: { outputId: string }[] }).outputs.map(
      (output) => ({ ...output, outputId: "not-a-plan-output" }),
    ),
  });
  expect(() => detailFixture().bind()).toThrow(
    "whole_filter_reader_output_mismatch",
  );
  hooks.eventDescription = (description) => ({
    ...(description as object),
    outputs: (description as { outputs: { sources: unknown[] }[] }).outputs.map(
      (output) => ({
        ...output,
        sources: [...output.sources, output.sources[0]],
      }),
    ),
  });
  expect(() => detailFixture().bind()).toThrow(
    "whole_filter_reader_sources_mismatch",
  );
});

function overviewBind(
  options: { projectedSite?: string; relations?: boolean } = {},
) {
  const f = wholeOriginalFixture("event-summary");
  const owner = {};
  associateWholeOriginalCompletion(
    owner,
    { kind: "overview" },
    options.relations === false
      ? { ...f.projection, relations: {} }
      : options.projectedSite
        ? { ...f.projection, siteIds: [options.projectedSite] }
        : f.projection,
    { filters: f.filters, metadata: f.metadata },
  );
  return () =>
    bindWholeOriginalOverview({
      owner,
      kind: "aggregate",
      siteId: SEED_SITE_ID,
      filters: f.filters,
      readerQueryTime: f.metadata.time,
    });
}

it("binds the overview aggregate once and refuses a foreign projection or missing role", () => {
  const bind = overviewBind();
  expect(bind().plan.outputs.map((output) => output.id)).toEqual([
    "overview-aggregate",
  ]);
  expect(() => overviewBind({ projectedSite: "other-site" })()).toThrow(
    "qualification_execution_plan_snapshot_mismatch",
  );
  expect(() => overviewBind({ relations: false })()).toThrow(
    "prepared_membership_role_missing",
  );
});

function comparisonBind(
  options: { projectedSite?: string; relations?: boolean } = {},
) {
  const f = wholeOriginalFixture("event-summary");
  const owner = {};
  associateWholeOriginalCompletion(
    owner,
    { kind: "comparison-page", side: "current", tab: "client.browser" },
    options.relations === false
      ? { ...f.projection, relations: {} }
      : options.projectedSite
        ? { ...f.projection, siteIds: [options.projectedSite] }
        : f.projection,
    { filters: f.filters, metadata: f.metadata },
  );
  const window = {
    startMs: COST_TIME.range.startMs,
    endExclusiveMs: COST_TIME.range.endExclusiveMs,
    nowMs: COST_TIME.capturedAtMs,
    timeZone: "UTC",
  } as never;
  const plan = snapshotPageVisitQualificationPlan(
    buildComparisonDimensionRollupPlan({
      siteId: SEED_SITE_ID,
      window,
      filters: f.filters,
      selection: PAGE_DIMENSION_SELECTIONS.browser,
      entityDependency: true,
      qualificationSemantics: "whole-original",
      outputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS.current,
    }),
  );
  return () =>
    bindWholeOriginalComparisonChild({
      owner,
      side: "current",
      tab: "client.browser",
      siteId: SEED_SITE_ID,
      window,
      filters: f.filters,
      plan,
    });
}

it("binds a comparison child once its exact canonical plan matches, else fails closed", () => {
  expect(comparisonBind()()).toBeDefined();
  expect(() => comparisonBind({ projectedSite: "other-site" })()).toThrow(
    "qualification_execution_plan_snapshot_mismatch",
  );
  expect(() => comparisonBind({ relations: false })()).toThrow(
    "prepared_membership_role_missing",
  );
});
