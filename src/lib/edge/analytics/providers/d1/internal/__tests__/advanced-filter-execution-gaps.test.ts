import { describe, expect, it } from "vitest";

import {
  createQueryTime,
  prepareScopedQuery,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  d1AdvancedFilterMiddleware,
  deferredComparisonPageQualificationFromQuery,
  deferredCrossDimensionQualificationFromQuery,
  deferredEventQualificationFromQuery,
  deferredOverviewTrendQualificationFromQuery,
  deferredPerformanceSummaryQualificationFromQuery,
  deferredRadarQualificationFromQuery,
  deferredShareTrendQualificationFromQuery,
  isCanonicalPrivateChannelListWholeFilterRequest,
  isCanonicalPrivateChannelOverviewWholeFilterRequest,
  isCanonicalPrivatePageDimensionWholeFilterRequest,
  isDeferredCrossDimensionQualificationRequest,
  isDeferredPerformanceSummaryQualificationRequest,
  isDeferredRadarQualificationRequest,
  isDeferredShareTrendQualificationRequest,
  matchesPerformanceSummaryQualificationConfiguration,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE = "gap-site";
const OTHER_SITE = "gap-other-site";
const TIME = createQueryTime(120, 130, "UTC", 500);
const MISMATCHED_TIME = createQueryTime(121, 130, "UTC", 500);
const FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';

/** Any D1 access means a guard that should have rejected first did not. */
const noDatabaseEnv = {
  DB: {
    prepare() {
      throw new Error("unexpected_database_access");
    },
  },
  MAIN_SECRET: "gap-secret",
} as unknown as Env;

type Scope = "event" | "session" | "visitor";
type Request = Record<string, unknown>;

function buildQuery(
  operation: string,
  extra: Request = {},
  scope: Scope = "event",
): Request {
  const prepared = prepareScopedQuery(
    operation as never,
    {
      context: siteQueryContext(SITE, "private-dashboard"),
      time: TIME,
      filters: parseFilterDsl(FILTER, analyticsFilterRegistry),
      scopePreference: scope,
    } as never,
  ) as unknown as Request;
  return { ...prepared, ...extra };
}

async function middleware(
  operation: string,
  input: unknown,
  expectedSiteId: string | undefined = SITE,
): Promise<unknown> {
  return d1AdvancedFilterMiddleware(noDatabaseEnv, undefined, expectedSiteId)(
    operation as never,
    input as never,
    async (value) => value,
  );
}

async function expectInvalidInput(
  operation: string,
  input: unknown,
  path: string,
  code: string,
  expectedSiteId: string | undefined = SITE,
): Promise<void> {
  await expect(
    middleware(operation, input, expectedSiteId),
  ).rejects.toMatchObject({
    domainError: { kind: "invalid-input", issues: [{ path, code }] },
  });
}

function withAccessorFilters(request: Request): Request {
  const filters = request.filters;
  const copy = { ...request };
  Object.defineProperty(copy, "filters", {
    enumerable: true,
    configurable: true,
    get: () => filters,
  });
  return copy;
}

function withHiddenFilters(request: Request): Request {
  const filters = request.filters;
  const copy = { ...request };
  Object.defineProperty(copy, "filters", {
    enumerable: false,
    configurable: true,
    value: filters,
  });
  return copy;
}

/** Reads the same data until one chosen key is read through the get trap. */
function withShiftingGetTrap(request: Request, key: string): Request {
  const target = { ...request, [key]: "first-read" };
  return new Proxy(target, {
    get(t, property, receiver) {
      return property === key
        ? "second-read"
        : Reflect.get(t, property, receiver);
    },
  });
}

describe("advanced filter execution request guards", () => {
  const candidateCases: ReadonlyArray<{
    readonly name: string;
    readonly operation: string;
    readonly extra: Request;
    readonly timeCode: string;
    readonly accessorCode?: string;
  }> = [
    {
      name: "channel list",
      operation: "channels",
      extra: { mode: "list" },
      timeCode: "channel_list_request_context_mismatch",
      accessorCode: "channel_list_request_context_mismatch",
    },
    {
      name: "channel overview",
      operation: "channels",
      extra: { mode: "overview-tab", tab: "source.channel" },
      timeCode: "channel_overview_request_context_mismatch",
      accessorCode: "channel_overview_request_context_mismatch",
    },
    {
      name: "pages tabs",
      operation: "pages",
      extra: { variant: "tabs" },
      timeCode: "pages_tabs_request_context_mismatch",
    },
    {
      name: "geo points",
      operation: "geo-points",
      extra: {},
      timeCode: "geo_points_request_context_mismatch",
    },
    {
      name: "technology radar",
      operation: "radar",
      extra: { variant: "browser" },
      timeCode: "radar_qualification_request_changed",
    },
    {
      name: "technology cross dimension",
      operation: "cross-dimension",
      extra: { variant: "browser" },
      timeCode: "cross_dimension_qualification_request_changed",
    },
    {
      name: "performance summary",
      operation: "performance",
      extra: { mode: "summary" },
      timeCode: "performance_qualification_request_context_mismatch",
    },
    {
      name: "referrers",
      operation: "referrers",
      extra: {},
      timeCode: "referrers_request_context_mismatch",
      accessorCode: "referrers_request_context_mismatch",
    },
    {
      name: "session boundary dimension",
      operation: "dimension",
      extra: { mode: "breakdown", dimension: "session.entryPath" },
      timeCode: "session_boundary_dimension_request_context_mismatch",
      accessorCode: "session_boundary_dimension_request_context_mismatch",
    },
    {
      name: "session boundary overview page",
      operation: "dimension",
      extra: { mode: "overview-tab", tab: "page.entry" },
      timeCode: "session_boundary_overview_page_request_context_mismatch",
      accessorCode: "session_boundary_overview_page_request_context_mismatch",
    },
  ];

  it.each(candidateCases)(
    "rejects an Event candidate whose request time differs from the filter metadata ($name)",
    async ({ operation, extra, timeCode }) => {
      const mismatched = {
        ...buildQuery(operation, extra),
        time: MISMATCHED_TIME as QueryTime,
      };
      await expectInvalidInput(operation, mismatched, "time", timeCode);
    },
  );

  it.each(candidateCases.filter((entry) => entry.accessorCode !== undefined))(
    "rejects non-data Event candidate filters before any D1 read ($name)",
    async ({ operation, extra, accessorCode }) => {
      const base = buildQuery(operation, extra);
      await expectInvalidInput(
        operation,
        withAccessorFilters(base),
        "query",
        accessorCode!,
      );
      await expectInvalidInput(
        operation,
        withHiddenFilters(base),
        "query",
        accessorCode!,
      );
    },
  );

  it("rejects non-data Event types filters before any D1 read", async () => {
    const base = buildQuery("event-types");
    for (const request of [withAccessorFilters(base), withHiddenFilters(base)])
      await expectInvalidInput(
        "event-types",
        request,
        "query",
        "event_types_qualification_request_context_mismatch",
      );
  });

  it("rejects an event.name dimension request with accessor fields", async () => {
    const base = buildQuery("dimension", {
      mode: "breakdown",
      dimension: "event.name",
    });
    await expectInvalidInput(
      "dimension",
      withAccessorFilters(base),
      "query",
      "event_name_dimension_request_own_data_required",
    );
  });

  it.each([
    ["retention", "retention", { granularity: "week" }, "session"],
    ["sessions", "sessions", {}, "session"],
    [
      "visitor sessions",
      "visitor-sessions",
      { visitorId: "visitor" },
      "session",
    ],
    ["visitors", "visitors", {}, "visitor"],
  ] as const)(
    "rejects a %s request for a different expected site",
    async (_name, operation, extra, scope) => {
      const request = buildQuery(operation, extra, scope);
      const code = {
        retention: "retention_qualification_request_context_mismatch",
        sessions: "session_list_qualification_request_context_mismatch",
        "visitor-sessions":
          "session_list_qualification_request_context_mismatch",
        visitors: "visitor_list_qualification_request_context_mismatch",
      }[operation];
      await expectInvalidInput(operation, request, "siteId", code, OTHER_SITE);
    },
  );

  it.each([
    [
      "overview",
      "overview",
      {},
      "session",
      "overview_trend_request_context_mismatch",
    ],
    [
      "trend",
      "trend",
      { interval: "day" },
      "session",
      "overview_trend_request_context_mismatch",
    ],
    [
      "share trend",
      "share-trend",
      { variant: "browser", interval: "day" },
      "session",
      "share_trend_request_context_mismatch",
    ],
    [
      "pages dashboard",
      "pages-dashboard",
      { interval: "day" },
      "session",
      "pages_dashboard_request_context_mismatch",
    ],
    [
      "geo points",
      "geo-points",
      {},
      "session",
      "geo_points_request_context_mismatch",
    ],
    [
      "filter values",
      "filter-values",
      { field: "page.path" },
      "session",
      "filter_values_request_context_mismatch",
    ],
    [
      "visitor events",
      "visitor-events",
      { visitorId: "visitor" },
      "session",
      "journey_event_page_qualification_request_context_mismatch",
    ],
    [
      "session events",
      "session-events",
      { sessionId: "session" },
      "session",
      "journey_event_page_qualification_request_context_mismatch",
    ],
  ] as const)(
    "rejects a %s request for a different expected site",
    async (_name, operation, extra, scope, code) => {
      await expectInvalidInput(
        operation,
        buildQuery(operation, extra, scope),
        "siteId",
        code,
        OTHER_SITE,
      );
    },
  );

  describe.each([
    ["event-fields", "event_fields_qualification_request_context_mismatch"],
    [
      "event-field-values",
      "event_field_values_qualification_request_context_mismatch",
    ],
  ] as const)("%s Event candidate context", (operation, code) => {
    const base = (): Request => buildQuery(operation);

    it("rejects a subject that differs from the filter metadata", async () => {
      await expectInvalidInput(
        operation,
        {
          ...base(),
          context: siteQueryContext(OTHER_SITE, "private-dashboard"),
        },
        "query",
        code,
        undefined,
      );
    });

    it("rejects a request time that differs from the filter metadata", async () => {
      await expectInvalidInput(
        operation,
        { ...base(), time: MISMATCHED_TIME },
        "time",
        code,
      );
    });

    it("rejects a scope plan that differs from the filter metadata", async () => {
      const request = base();
      await expectInvalidInput(
        operation,
        {
          ...request,
          scopePlan: { ...(request.scopePlan as object), scope: "session" },
        },
        "scopePlan",
        code,
      );
    });
  });

  it("forwards a Performance request whose mode is not a data property", async () => {
    const request = buildQuery("performance", { mode: "summary" }, "session");
    const accessorMode = Object.defineProperty({ ...request }, "mode", {
      enumerable: true,
      get: () => "summary",
    });
    const forwarded = await middleware("performance", accessorMode);
    expect(Object.getOwnPropertySymbols(forwarded as object)).toHaveLength(0);
    const unknownMode = await middleware("performance", {
      ...request,
      mode: "unknown",
    });
    expect(unknownMode).toMatchObject({ mode: "unknown" });
    expect(Object.getOwnPropertySymbols(unknownMode as object)).toHaveLength(0);
  });

  it("rejects mutated request data between the raw and forwarded copies", async () => {
    await expectInvalidInput(
      "event-trend",
      withShiftingGetTrap(buildQuery("event-trend", {}, "session"), "probe"),
      "query",
      "event_trend_qualification_request_context_mismatch",
    );
    await expectInvalidInput(
      "event-context",
      withShiftingGetTrap(buildQuery("event-context", {}, "session"), "probe"),
      "query",
      "event_context_qualification_request_context_mismatch",
    );
    await expectInvalidInput(
      "event-type-detail",
      withShiftingGetTrap(
        buildQuery("event-type-detail", {}, "session"),
        "probe",
      ),
      "query",
      "event_type_detail_qualification_request_context_mismatch",
    );
    await expectInvalidInput(
      "pages",
      withShiftingGetTrap(buildQuery("pages"), "probe"),
      "query",
      "page_qualification_request_context_mismatch",
    );
  });
});

describe("advanced filter execution untrusted brand lookups", () => {
  it("ignores values that cannot carry a qualification brand", () => {
    const lookups: ReadonlyArray<(input: unknown) => unknown> = [
      deferredShareTrendQualificationFromQuery,
      deferredCrossDimensionQualificationFromQuery,
      deferredRadarQualificationFromQuery,
      deferredPerformanceSummaryQualificationFromQuery as (
        input: unknown,
      ) => unknown,
      deferredOverviewTrendQualificationFromQuery,
    ];
    for (const lookup of lookups) {
      expect(lookup(null)).toBeUndefined();
      expect(lookup("text")).toBeUndefined();
      expect(lookup({})).toBeUndefined();
    }
    expect(
      deferredEventQualificationFromQuery(null, "event-summary"),
    ).toBeUndefined();
    expect(
      deferredEventQualificationFromQuery({}, "event-summary"),
    ).toBeUndefined();
  });

  it("does not recognise unbranded objects as deferred requests", () => {
    for (const check of [
      isDeferredShareTrendQualificationRequest,
      isDeferredCrossDimensionQualificationRequest,
      isDeferredRadarQualificationRequest,
      isDeferredPerformanceSummaryQualificationRequest,
    ]) {
      expect(check(undefined)).toBe(false);
      expect(check({})).toBe(false);
    }
  });
});

describe("advanced filter execution canonical request predicates", () => {
  it("requires the private dashboard audience for page dimension requests", () => {
    expect(
      isCanonicalPrivatePageDimensionWholeFilterRequest({
        mode: "breakdown",
        audience: "api-v1",
        dimension: "page.path",
        selection: null,
        excludeEmpty: false,
      }),
    ).toBe(false);
    expect(
      isCanonicalPrivatePageDimensionWholeFilterRequest({
        mode: "unknown",
        audience: "private-dashboard",
        selection: null,
        excludeEmpty: false,
      }),
    ).toBe(false);
    expect(
      isCanonicalPrivatePageDimensionWholeFilterRequest({
        mode: "overview-tab",
        audience: "private-dashboard",
        tab: "no.such.tab",
        selection: null,
        excludeEmpty: false,
      }),
    ).toBe(false);
  });

  it("matches only canonical channel requests", () => {
    expect(
      isCanonicalPrivateChannelListWholeFilterRequest({
        mode: "list",
        audience: "private-dashboard",
      }),
    ).toBe(true);
    expect(
      isCanonicalPrivateChannelListWholeFilterRequest({
        mode: "list",
        audience: "public-share",
      }),
    ).toBe(false);
    expect(
      isCanonicalPrivateChannelOverviewWholeFilterRequest({
        mode: "overview-tab",
        audience: "private-dashboard",
        tab: "source.channel",
        family: "page",
        selection: null,
        excludeEmpty: true,
      }),
    ).toBe(false);
  });
});

describe("advanced filter execution comparison request proof", () => {
  function plainDimensionRequest(): Request {
    const prepared = prepareScopedQuery(
      "dimension" as never,
      {
        context: siteQueryContext(SITE, "private-dashboard"),
        time: TIME,
        filters: parseFilterDsl('page.path neq "/x"', analyticsFilterRegistry),
        scopePreference: "session",
      } as never,
    ) as unknown as Request;
    return { ...prepared, mode: "overview-tab", tab: "page.path" };
  }
  const baseRequest = plainDimensionRequest();
  const side = { filters: baseRequest.filters, time: baseRequest.time };
  const comparison = {
    current: side,
    reference: side,
    metric: "views",
    sortBy: "change",
    direction: "desc",
  };
  const fullRequest: Request = {
    ...baseRequest,
    current: side,
    reference: side,
    comparison,
  };
  const ghostKeyProxy = <T extends object>(target: T): T =>
    new Proxy(target, {
      ownKeys: (t) => [...Reflect.ownKeys(t), "ghost"],
      getOwnPropertyDescriptor: (t, key) =>
        key === "ghost" ? undefined : Reflect.getOwnPropertyDescriptor(t, key),
    });
  const withAccessor = (target: object, key: string, value: unknown): Request =>
    Object.defineProperty({ ...target }, key, {
      enumerable: true,
      configurable: true,
      get: () => value,
    }) as unknown as Request;

  const unsafeRequests: ReadonlyArray<readonly [string, () => unknown]> = [
    [
      "an inherited prototype",
      () => Object.assign(Object.create({ a: 1 }), fullRequest),
    ],
    ["a non-data limit", () => withAccessor(fullRequest, "limit", 5)],
    ["a non-data search", () => withAccessor(fullRequest, "search", "s")],
    ["a descriptor-less key", () => ghostKeyProxy({ ...fullRequest })],
    [
      "a non-data hidden symbol",
      () =>
        Object.defineProperty({ ...fullRequest }, Symbol("hidden"), {
          enumerable: false,
          get: () => 1,
        }),
    ],
    [
      "a non-data comparison control",
      () => ({
        ...fullRequest,
        comparison: withAccessor(comparison, "metric", "views"),
      }),
    ],
    [
      "a function comparison",
      () => ({
        ...fullRequest,
        comparison: Object.assign(() => 1, comparison),
      }),
    ],
    ["an array comparison", () => ({ ...fullRequest, comparison: [1] })],
    [
      "a comparison with a prototype",
      () => ({
        ...fullRequest,
        comparison: Object.assign(Object.create({ x: 1 }), comparison),
      }),
    ],
    [
      "a comparison with descriptor-less keys",
      () => ({ ...fullRequest, comparison: ghostKeyProxy({ ...comparison }) }),
    ],
    ["a function current side", () => ({ ...fullRequest, current: () => 1 })],
    [
      "a non-data current side",
      () => ({
        ...fullRequest,
        current: withAccessor(side, "time", baseRequest.time),
      }),
    ],
  ];

  it.each(unsafeRequests)(
    "rejects comparison state with %s before any D1 read",
    async (_name, factory) => {
      await expectInvalidInput(
        "dimension",
        factory(),
        "comparison",
        "comparison_request_own_data_required",
      );
    },
  );

  const unqualifiedRequests: ReadonlyArray<readonly [string, () => unknown]> = [
    ["the full canonical request", () => fullRequest],
    ["an unknown extra field", () => ({ ...fullRequest, foo: 1 })],
    [
      "an enumerable symbol field",
      () => ({ ...fullRequest, [Symbol("extra")]: 1 }),
    ],
    [
      "a hidden data symbol",
      () =>
        Object.defineProperty({ ...fullRequest }, Symbol("hidden"), {
          enumerable: false,
          value: 1,
        }),
    ],
    [
      "an unknown comparison control",
      () => ({ ...fullRequest, comparison: { ...comparison, zzz: 1 } }),
    ],
    ["a null reference side", () => ({ ...fullRequest, reference: null })],
    ["a primitive current side", () => ({ ...fullRequest, current: "x" })],
    [
      "a current side without a time",
      () => ({ ...fullRequest, current: { filters: baseRequest.filters } }),
    ],
    [
      "a nested side that differs from the top-level side",
      () => ({
        ...fullRequest,
        comparison: {
          ...comparison,
          current: {
            filters: baseRequest.filters,
            time: createQueryTime(1, 2, "UTC", 5),
          },
        },
      }),
    ],
  ];

  it.each(unqualifiedRequests)(
    "forwards %s without a comparison qualification",
    async (_name, factory) => {
      const result = await middleware("dimension", factory());
      expect(result).toBeTypeOf("object");
      expect(
        deferredComparisonPageQualificationFromQuery(result),
      ).toBeUndefined();
    },
  );

  it("fails on requests that are not objects", async () => {
    await expect(middleware("dimension", "text")).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(middleware("dimension", null)).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe("advanced filter execution performance configuration matching", () => {
  type Frozen = Parameters<
    typeof matchesPerformanceSummaryQualificationConfiguration
  >[1];
  const frozen = (value: object): Frozen => Object.freeze(value) as Frozen;
  const summary = frozen({ mode: "summary" });
  const timeseries = frozen({ mode: "timeseries", interval: "day" });
  const breakdown = frozen({
    mode: "breakdown",
    dimension: "page.path",
    metric: "lcp",
    limitPresent: true,
    limitValue: 10,
  });
  const dashboard = frozen({
    mode: "dashboard",
    interval: "day",
    routeLimitPresent: true,
    routeLimitValue: 5,
  });
  const nonDataMode = Object.defineProperty({}, "mode", {
    enumerable: true,
    get: () => "summary",
  });

  it("accepts identical frozen configurations", () => {
    for (const configuration of [summary, timeseries, breakdown, dashboard])
      expect(
        matchesPerformanceSummaryQualificationConfiguration(
          { ...configuration },
          configuration,
        ),
      ).toBe(true);
  });

  it("refuses configurations that were not frozen", () => {
    expect(
      matchesPerformanceSummaryQualificationConfiguration(
        { mode: "summary" },
        { mode: "summary" },
      ),
    ).toBe(false);
  });

  it.each([
    ["null", null],
    ["a primitive", "summary"],
    ["an array", ["summary"]],
    [
      "an object with a foreign prototype",
      Object.assign(Object.create({ a: 1 }), { mode: "summary" }),
    ],
    ["a non-data mode", nonDataMode],
    ["a non-string mode", { mode: 1 }],
    ["an unknown mode", { mode: "other" }],
    ["a summary with extra keys", { mode: "summary", extra: 1 }],
    [
      "a timeseries with a missing interval",
      { mode: "timeseries", other: "day" },
    ],
    [
      "a timeseries with an invalid interval",
      { mode: "timeseries", interval: "decade" },
    ],
    [
      "a timeseries with a different interval",
      { mode: "timeseries", interval: "hour" },
    ],
    [
      "a breakdown with a missing key",
      {
        mode: "breakdown",
        dimension: "page.path",
        metric: "lcp",
        limitPresent: true,
        other: 1,
      },
    ],
    [
      "a breakdown with an unknown dimension",
      {
        mode: "breakdown",
        dimension: "bogus",
        metric: "lcp",
        limitPresent: true,
        limitValue: 10,
      },
    ],
    [
      "a breakdown with an unknown metric",
      {
        mode: "breakdown",
        dimension: "page.path",
        metric: "bogus",
        limitPresent: true,
        limitValue: 10,
      },
    ],
    [
      "a breakdown with a non-boolean limit flag",
      {
        mode: "breakdown",
        dimension: "page.path",
        metric: "lcp",
        limitPresent: "yes",
        limitValue: 10,
      },
    ],
    [
      "a breakdown with a non-numeric limit",
      {
        mode: "breakdown",
        dimension: "page.path",
        metric: "lcp",
        limitPresent: true,
        limitValue: "10",
      },
    ],
    [
      "a breakdown with an absent flag but a limit",
      {
        mode: "breakdown",
        dimension: "page.path",
        metric: "lcp",
        limitPresent: false,
        limitValue: 10,
      },
    ],
    [
      "a breakdown with a different limit",
      {
        mode: "breakdown",
        dimension: "page.path",
        metric: "lcp",
        limitPresent: true,
        limitValue: 11,
      },
    ],
    [
      "a dashboard with a missing key",
      { mode: "dashboard", interval: "day", routeLimitPresent: true, other: 1 },
    ],
    [
      "a dashboard with an invalid interval",
      {
        mode: "dashboard",
        interval: "decade",
        routeLimitPresent: true,
        routeLimitValue: 5,
      },
    ],
    [
      "a dashboard with a non-boolean limit flag",
      {
        mode: "dashboard",
        interval: "day",
        routeLimitPresent: 1,
        routeLimitValue: 5,
      },
    ],
    [
      "a dashboard with a non-numeric limit",
      {
        mode: "dashboard",
        interval: "day",
        routeLimitPresent: true,
        routeLimitValue: "5",
      },
    ],
    [
      "a dashboard with an absent flag but a limit",
      {
        mode: "dashboard",
        interval: "day",
        routeLimitPresent: false,
        routeLimitValue: 5,
      },
    ],
    [
      "a dashboard with a different limit",
      {
        mode: "dashboard",
        interval: "day",
        routeLimitPresent: true,
        routeLimitValue: 6,
      },
    ],
  ])("does not match %s", (_name, requested) => {
    for (const configuration of [summary, timeseries, breakdown, dashboard])
      expect(
        matchesPerformanceSummaryQualificationConfiguration(
          requested,
          configuration,
        ),
      ).toBe(false);
  });

  it("does not match a frozen configuration that is not a known shape", () => {
    expect(
      matchesPerformanceSummaryQualificationConfiguration(
        { mode: "summary" },
        frozen({ mode: "unknown" }),
      ),
    ).toBe(false);
  });
});
