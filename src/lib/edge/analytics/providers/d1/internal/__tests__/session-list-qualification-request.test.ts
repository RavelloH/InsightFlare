import { describe, expect, it } from "vitest";

import {
  assertSessionListQualificationRequest,
  attachSessionListQualificationToQuery,
  deferredSessionListQualificationFromQuery,
  type DeferredSessionListQualificationInput,
  sessionListQualificationConfigurationFromQuery,
  sessionListQualificationConfigurationsEqual,
} from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";

type Rec = Record<string, unknown>;

const TIME = {
  range: { startMs: 1000, endExclusiveMs: 2000 },
  reportingTimeZone: "UTC",
  capturedAtMs: 3000,
};

function privateQuery(overrides: Rec = {}): Rec {
  return {
    context: {
      subject: { kind: "site", siteId: "s1" },
      policy: { audience: "private-dashboard" },
    },
    time: TIME,
    filters: { clauses: [] },
    scopePlan: { scope: "session" },
    scopePreference: "session",
    ...overrides,
  };
}

function apiQuery(overrides: Rec = {}): Rec {
  return privateQuery({
    context: {
      subject: { kind: "site", siteId: "s1" },
      policy: { audience: "api-v1" },
    },
    siteId: "s1",
    startMs: 1000,
    endExclusiveMs: 2000,
    timeZone: "UTC",
    timeRange: { kind: "custom" },
    ...overrides,
  });
}

const parse = (value: unknown) =>
  sessionListQualificationConfigurationFromQuery(value);

const accessor = (target: Rec, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    get: () => value,
    enumerable: true,
    configurable: true,
  });

describe("sessionListQualificationConfigurationFromQuery", () => {
  it("applies the Sessions route defaults", () => {
    const configuration = parse(privateQuery());
    expect(configuration).toEqual({
      operation: "sessions",
      sort: { field: "startedAt", direction: "desc" },
      search: undefined,
      page: { limit: 80, cursor: null },
      audience: "private-dashboard",
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration?.page)).toBe(true);
  });

  it("reads page, flat limit and cursor, search, and sort", () => {
    expect(
      parse(
        privateQuery({
          page: { limit: 5, cursor: "c1" },
          search: "abc",
          sort: { key: "views", direction: "asc" },
        }),
      ),
    ).toMatchObject({
      page: { limit: 5, cursor: "c1" },
      search: "abc",
      sort: { field: "views", direction: "asc" },
    });
    expect(parse(privateQuery({ limit: 7, cursor: "c2" }))).toMatchObject({
      page: { limit: 7, cursor: "c2" },
    });
    expect(
      parse(privateQuery({ page: { limit: null, cursor: null }, limit: 9 })),
    ).toMatchObject({ page: { limit: 9, cursor: null } });
    expect(parse(privateQuery({ page: null, search: "" }))).toMatchObject({
      search: undefined,
    });
    expect(parse(privateQuery({ sort: { key: "durationMs" } }))).toMatchObject({
      sort: { field: "durationMs", direction: "desc" },
    });
    expect(parse(privateQuery({ sort: { direction: "asc" } }))).toMatchObject({
      sort: { field: "startedAt", direction: "asc" },
    });
    expect(parse(privateQuery({ sort: undefined }))).toBeDefined();
    expect(parse(privateQuery({ limit: null, cursor: null }))).toBeDefined();
  });

  it("rejects non-own-data roots", () => {
    expect(parse(null)).toBeUndefined();
    expect(parse([])).toBeUndefined();
    expect(parse(privateQuery({ unknownKey: 1 }))).toBeUndefined();
    expect(parse(privateQuery({ bad: Number.NaN }))).toBeUndefined();
    expect(parse(accessor(privateQuery(), "search", "x"))).toBeUndefined();
    const withSymbol = privateQuery();
    Object.defineProperty(withSymbol, Symbol("hidden"), {
      value: 1,
      enumerable: false,
    });
    expect(parse(withSymbol)).toBeDefined();
  });

  it("rejects missing required request parts", () => {
    for (const key of ["time", "filters", "scopePlan"]) {
      const query = privateQuery();
      Reflect.deleteProperty(query, key);
      expect(parse(query)).toBeUndefined();
    }
    expect(parse(privateQuery({ scopePlan: undefined }))).toBeUndefined();
    expect(parse(privateQuery({ search: 4 }))).toBeUndefined();
    expect(parse(privateQuery({ page: "x" }))).toBeUndefined();
    expect(parse(privateQuery({ page: { limit: 0 } }))).toBeUndefined();
    expect(parse(privateQuery({ page: { limit: 1.5 } }))).toBeUndefined();
    expect(parse(privateQuery({ page: { limit: "1" } }))).toBeUndefined();
    expect(parse(privateQuery({ page: { cursor: 5 } }))).toBeUndefined();
    expect(parse(privateQuery({ page: { extra: 1 } }))).toBeUndefined();
    expect(parse(privateQuery({ limit: 0 }))).toBeUndefined();
    expect(parse(privateQuery({ limit: "5" }))).toBeUndefined();
    expect(parse(privateQuery({ cursor: 5 }))).toBeUndefined();
    expect(
      parse(privateQuery({ page: accessor({ limit: 1 }, "cursor", "c") })),
    ).toBeUndefined();
    for (const key of [
      "current",
      "reference",
      "comparison",
      "mode",
      "visitorId",
      "sessionId",
      "goalId",
      "funnelId",
    ])
      expect(parse(privateQuery({ [key]: "x" }))).toBeUndefined();
  });

  it("rejects invalid sort definitions", () => {
    for (const sort of [
      "views",
      { key: "bogus" },
      { key: 3 },
      { key: "views", direction: "up" },
      { key: "views", extra: 1 },
      { field: "views" },
      accessor({}, "key", "views"),
    ])
      expect(parse(privateQuery({ sort }))).toBeUndefined();
    for (const key of ["startedAt", "durationMs", "views"])
      expect(parse(privateQuery({ sort: { key } }))).toBeDefined();
  });

  it("rejects invalid context shapes", () => {
    const withContext = (context: unknown) => privateQuery({ context });
    const good = {
      subject: { kind: "site", siteId: "s1" },
      policy: { audience: "private-dashboard" },
    };
    expect(parse(withContext(null))).toBeUndefined();
    expect(parse(withContext({ ...good, extra: 1 }))).toBeUndefined();
    expect(parse(withContext({ policy: good.policy }))).toBeUndefined();
    expect(
      parse(withContext({ ...good, subject: { kind: "team", siteId: "s1" } })),
    ).toBeUndefined();
    expect(
      parse(withContext({ ...good, subject: { kind: "site", siteId: 1 } })),
    ).toBeUndefined();
    expect(
      parse(
        withContext({ ...good, subject: { kind: "site", siteId: "s", x: 1 } }),
      ),
    ).toBeUndefined();
    expect(
      parse(withContext({ ...good, policy: { audience: "public-share" } })),
    ).toBeUndefined();
    expect(
      parse(
        withContext({ ...good, policy: accessor({}, "audience", "api-v1") }),
      ),
    ).toBeUndefined();
    expect(
      parse(withContext({ ...good, subject: accessor({}, "kind", "site") })),
    ).toBeUndefined();
    expect(
      parse(
        withContext(accessor({ policy: good.policy }, "subject", good.subject)),
      ),
    ).toBeUndefined();
    const hiddenSymbol = { ...good };
    Object.defineProperty(hiddenSymbol, Symbol("hidden"), {
      value: 1,
      enumerable: false,
    });
    expect(parse(withContext(hiddenSymbol))).toBeUndefined();
    const visibleSymbol = { ...good, [Symbol("visible")]: 1 };
    expect(parse(withContext(visibleSymbol))).toBeUndefined();
    const accessorSymbol = { ...good };
    Object.defineProperty(accessorSymbol, Symbol("hidden"), {
      get: () => 1,
      enumerable: false,
    });
    expect(parse(withContext(accessorSymbol))).toBeUndefined();
  });

  it("parses goal and funnel analysis contexts", () => {
    expect(
      parse(privateQuery({ analysisContext: { type: "goal", goalId: "g" } })),
    ).toMatchObject({ analysisContext: { type: "goal", goalId: "g" } });
    expect(
      parse(
        privateQuery({
          analysisContext: { type: "funnel", funnelId: "f", stepId: "s" },
        }),
      ),
    ).toMatchObject({
      analysisContext: { type: "funnel", funnelId: "f", stepId: "s" },
    });
    expect(
      parse(
        privateQuery({
          scopePlan: { scope: "session" },
          analysisContext: {
            type: "funnel",
            funnelId: "f",
            stepId: "s",
            outcome: "dropoff",
          },
        }),
      ),
    ).toMatchObject({ analysisContext: { outcome: "dropoff" } });
    expect(parse(privateQuery({ analysisContext: undefined }))).toBeDefined();
  });

  it("rejects invalid analysis contexts", () => {
    const funnel = { type: "funnel", funnelId: "f", stepId: "s" };
    for (const analysisContext of [
      { type: "other" },
      "text",
      { type: "goal" },
      { type: "goal", goalId: "" },
      { type: "goal", goalId: 1 },
      { type: "goal", goalId: "g", extra: 1 },
      { ...funnel, funnelId: "" },
      { ...funnel, stepId: "" },
      { ...funnel, outcome: "other" },
      { ...funnel, extra: 1 },
      accessor({}, "type", "goal"),
    ])
      expect(parse(privateQuery({ analysisContext }))).toBeUndefined();
    expect(
      parse(
        privateQuery({
          scopePlan: { scope: "event" },
          analysisContext: funnel,
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(privateQuery({ scopePlan: {}, analysisContext: funnel })),
    ).toBeUndefined();
    expect(
      parse(
        apiQuery({ scopePlan: { scope: "session" }, analysisContext: funnel }),
      ),
    ).toBeUndefined();
    expect(
      parse(accessor(privateQuery(), "analysisContext", {})),
    ).toBeUndefined();
  });

  it("accepts api-v1 requests with matching route fields and flat sort", () => {
    expect(
      parse(apiQuery({ sort: { field: "durationMs", direction: "asc" } })),
    ).toMatchObject({
      audience: "api-v1",
      sort: { field: "durationMs", direction: "asc" },
    });
    expect(parse(apiQuery({ scope: "session", filter: "x" }))).toMatchObject({
      audience: "api-v1",
    });
    expect(parse(apiQuery({ scope: undefined }))).toBeDefined();
    expect(parse(apiQuery({ sort: { key: "views" } }))).toBeUndefined();
  });

  it("rejects api-v1 requests whose route fields disagree", () => {
    const withoutKey = (key: string) => {
      const query = apiQuery();
      Reflect.deleteProperty(query, key);
      return query;
    };
    for (const key of [
      "siteId",
      "startMs",
      "endExclusiveMs",
      "timeZone",
      "timeRange",
      "scopePreference",
    ])
      expect(parse(withoutKey(key))).toBeUndefined();
    expect(parse(apiQuery({ siteId: "other" }))).toBeUndefined();
    expect(parse(apiQuery({ startMs: 1.5 }))).toBeUndefined();
    expect(parse(apiQuery({ startMs: 999 }))).toBeUndefined();
    expect(parse(apiQuery({ endExclusiveMs: 1999 }))).toBeUndefined();
    expect(parse(apiQuery({ endExclusiveMs: "2000" }))).toBeUndefined();
    expect(parse(apiQuery({ timeZone: "Asia/Tokyo" }))).toBeUndefined();
    expect(parse(apiQuery({ timeZone: 3 }))).toBeUndefined();
    expect(parse(apiQuery({ timeRange: [] }))).toBeUndefined();
    expect(parse(apiQuery({ scopePreference: "bogus" }))).toBeUndefined();
    expect(parse(apiQuery({ scope: "visitor" }))).toBeUndefined();
    expect(parse(apiQuery({ time: { ...TIME, range: "x" } }))).toBeUndefined();
  });

  it("rejects route-only fields on private-dashboard requests", () => {
    for (const key of [
      "filter",
      "timeRange",
      "scope",
      "siteId",
      "startMs",
      "endExclusiveMs",
      "timeZone",
    ])
      expect(parse(privateQuery({ [key]: "x" }))).toBeUndefined();
    expect(parse(privateQuery({ scope: undefined }))).toBeUndefined();
  });
});

describe("sessionListQualificationConfigurationsEqual", () => {
  it("compares every configuration facet", () => {
    const base = parse(privateQuery())!;
    expect(sessionListQualificationConfigurationsEqual(base, base)).toBe(true);
    const goal = parse(
      privateQuery({ analysisContext: { type: "goal", goalId: "g" } }),
    )!;
    const goal2 = parse(
      privateQuery({ analysisContext: { type: "goal", goalId: "g2" } }),
    )!;
    const funnel = parse(
      privateQuery({
        analysisContext: { type: "funnel", funnelId: "f", stepId: "s" },
      }),
    )!;
    const funnelOutcome = parse(
      privateQuery({
        analysisContext: {
          type: "funnel",
          funnelId: "f",
          stepId: "s",
          outcome: "converted",
        },
      }),
    )!;
    const eq = sessionListQualificationConfigurationsEqual;
    expect(eq(goal, goal)).toBe(true);
    expect(eq(goal, goal2)).toBe(false);
    expect(eq(goal, funnel)).toBe(false);
    expect(eq(funnel, funnel)).toBe(true);
    expect(eq(funnel, funnelOutcome)).toBe(false);
    expect(eq(base, goal)).toBe(false);
    expect(eq(goal, base)).toBe(false);
    const mismatchedKinds = {
      ...goal,
      analysisContext: { type: "bogus" },
    } as never;
    expect(eq(mismatchedKinds, mismatchedKinds)).toBe(false);
    for (const override of [
      { sort: { field: "views", direction: "desc" } },
      { sort: { field: "startedAt", direction: "asc" } },
      { search: "q" },
      { page: { limit: 1, cursor: null } },
      { page: { limit: 80, cursor: "c" } },
      { audience: "api-v1" },
    ])
      expect(eq(base, { ...base, ...override } as never)).toBe(false);
  });
});

describe("session list qualification branding", () => {
  const qualificationFor = (
    query: Rec,
    configuration: NonNullable<ReturnType<typeof parse>>,
    siteId = "s1",
  ) =>
    ({
      operation: "sessions",
      siteId,
      requestTime: query.time,
      metadata: { plan: query.scopePlan },
      sessionListRequest: configuration,
    }) as unknown as DeferredSessionListQualificationInput;

  const attached = (overrides: Rec = {}) => {
    const query = privateQuery(overrides);
    const configuration = parse(query)!;
    attachSessionListQualificationToQuery(
      query as never,
      qualificationFor(query, configuration),
      configuration,
    );
    return { query, configuration };
  };

  it("round-trips a trusted request", () => {
    const { query, configuration } = attached({ page: { limit: 3 } });
    const deferred = deferredSessionListQualificationFromQuery(query);
    expect(deferred?.configuration).toBe(configuration);
    expect(Object.isFrozen(deferred)).toBe(true);
    expect(assertSessionListQualificationRequest(deferred, query)).toBe(
      deferred,
    );
  });

  it("refuses to attach inconsistent requests", () => {
    const query = privateQuery();
    const configuration = parse(query)!;
    expect(() =>
      attachSessionListQualificationToQuery(
        privateQuery({ unknownKey: 1 }) as never,
        qualificationFor(query, configuration),
        configuration,
      ),
    ).toThrow("session_list_qualification_request_configuration_changed");
    expect(() =>
      attachSessionListQualificationToQuery(
        query as never,
        qualificationFor(query, configuration),
        { ...configuration, search: "other" },
      ),
    ).toThrow("session_list_qualification_request_configuration_changed");
  });

  it("rejects absent and forged brands", () => {
    expect(
      deferredSessionListQualificationFromQuery(undefined),
    ).toBeUndefined();
    expect(deferredSessionListQualificationFromQuery("x")).toBeUndefined();
    expect(deferredSessionListQualificationFromQuery({})).toBeUndefined();
    const { query } = attached();
    const symbol = Object.getOwnPropertySymbols(query)[0]!;
    const brand = Object.getOwnPropertyDescriptor(query, symbol)!.value;
    const untrusted = "session_list_qualification_request_untrusted";
    const copy = privateQuery();
    Object.defineProperty(copy, symbol, { value: brand });
    expect(() => deferredSessionListQualificationFromQuery(copy)).toThrow(
      untrusted,
    );
    const enumerable = privateQuery();
    Object.defineProperty(enumerable, symbol, {
      value: brand,
      enumerable: true,
    });
    expect(() => deferredSessionListQualificationFromQuery(enumerable)).toThrow(
      untrusted,
    );
    const getter = privateQuery();
    Object.defineProperty(getter, symbol, { get: () => brand });
    expect(() => deferredSessionListQualificationFromQuery(getter)).toThrow(
      untrusted,
    );
    for (const value of [undefined, "forged", { forged: true }]) {
      const forged = privateQuery();
      Object.defineProperty(forged, symbol, { value });
      expect(() => deferredSessionListQualificationFromQuery(forged)).toThrow(
        untrusted,
      );
    }
    expect(() =>
      deferredSessionListQualificationFromQuery(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("boom");
            },
          },
        ),
      ),
    ).toThrow(untrusted);
  });

  it("detects request tampering after attachment", () => {
    const changed = "session_list_qualification_request_changed";
    const mutate = (change: (query: Rec) => void) => {
      const { query } = attached();
      change(query);
      expect(() => deferredSessionListQualificationFromQuery(query)).toThrow(
        changed,
      );
    };
    mutate((query) => {
      query.search = "tampered";
    });
    mutate((query) => {
      query.unknownKey = 1;
    });
    mutate((query) => {
      query.limit = 5;
    });
    mutate((query) => {
      (query.time as Rec) = { ...TIME, capturedAtMs: 1 };
    });
    mutate((query) => {
      (query.scopePlan as Rec) = { scope: "visitor", extra: 1 };
    });
    mutate((query) => {
      query.context = {
        subject: { kind: "site", siteId: "other" },
        policy: { audience: "private-dashboard" },
      };
    });
    mutate((query) => {
      delete query.filters;
    });
  });

  it("detects qualifications that disagree with the request", () => {
    const changed = "session_list_qualification_request_changed";
    const build = (mutate: (qualification: Rec, configuration: Rec) => Rec) => {
      const query = privateQuery();
      const configuration = parse(query)!;
      const qualification = qualificationFor(
        query,
        configuration,
      ) as unknown as Rec;
      attachSessionListQualificationToQuery(
        query as never,
        mutate(qualification, configuration as unknown as Rec) as never,
        configuration,
      );
      expect(() => deferredSessionListQualificationFromQuery(query)).toThrow(
        changed,
      );
    };
    build((qualification) => ({ ...qualification, requestTime: undefined }));
    build((qualification) => ({
      ...qualification,
      sessionListRequest: undefined,
    }));
    build((qualification, configuration) => ({
      ...qualification,
      sessionListRequest: { ...configuration, search: "x" },
    }));
    build((qualification) => ({ ...qualification, siteId: "other" }));
    build((qualification) => ({
      ...qualification,
      requestTime: { ...TIME, capturedAtMs: 9 },
    }));
    build((qualification) => ({
      ...qualification,
      metadata: { plan: { scope: "visitor" } },
    }));
  });

  it("asserts that a request is the trusted brand for its own query", () => {
    const { query } = attached();
    const deferred = deferredSessionListQualificationFromQuery(query)!;
    expect(() => assertSessionListQualificationRequest(null, query)).toThrow(
      "session_list_qualification_request_untrusted",
    );
    expect(() =>
      assertSessionListQualificationRequest({ ...deferred }, query),
    ).toThrow("session_list_qualification_request_untrusted");
    expect(() =>
      assertSessionListQualificationRequest(deferred, { ...query }),
    ).toThrow("session_list_qualification_request_changed");
    expect(() =>
      assertSessionListQualificationRequest(deferred, "other"),
    ).toThrow("session_list_qualification_request_changed");
  });

  it("detects a mismatching api-v1 audience", () => {
    const query = apiQuery();
    const configuration = parse(query)!;
    attachSessionListQualificationToQuery(
      query as never,
      qualificationFor(query, configuration),
      configuration,
    );
    expect(
      deferredSessionListQualificationFromQuery(query)?.configuration.audience,
    ).toBe("api-v1");
    (query.context as { policy: Rec }).policy = {
      audience: "private-dashboard",
    };
    expect(() => deferredSessionListQualificationFromQuery(query)).toThrow(
      "session_list_qualification_request_changed",
    );
  });
});

describe("visitor-sessions list requests", () => {
  const visitorSessions = (overrides: Rec = {}) =>
    privateQuery({ visitorId: "v1", ...overrides });
  const parseVisitorSessions = (value: unknown) =>
    sessionListQualificationConfigurationFromQuery(value, "visitor-sessions");

  it("defaults to a 100-row page for the requested visitor", () => {
    expect(parseVisitorSessions(visitorSessions())).toEqual({
      operation: "visitor-sessions",
      visitorId: "v1",
      sort: { field: "startedAt", direction: "desc" },
      search: undefined,
      page: { limit: 100, cursor: null },
      audience: "private-dashboard",
    });
    expect(
      parseVisitorSessions(
        visitorSessions({ page: { limit: 7, cursor: "c" } }),
      ),
    ).toMatchObject({ page: { limit: 7, cursor: "c" } });
  });

  it("requires a visitor id and rejects list-only fields", () => {
    expect(parseVisitorSessions(privateQuery())).toBeUndefined();
    expect(
      parseVisitorSessions(privateQuery({ visitorId: "" })),
    ).toBeUndefined();
    expect(
      parseVisitorSessions(privateQuery({ visitorId: 5 })),
    ).toBeUndefined();
    for (const key of ["search", "limit", "cursor", "sort"])
      expect(
        parseVisitorSessions(
          visitorSessions({
            [key]:
              key === "sort" ? { key: "views" } : key === "limit" ? 5 : "x",
          }),
        ),
      ).toBeUndefined();
    expect(
      parseVisitorSessions(
        visitorSessions({
          analysisContext: { type: "goal", goalId: "g" },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseVisitorSessions(
        visitorSessions({
          context: {
            subject: { kind: "site", siteId: "s1" },
            policy: { audience: "api-v1" },
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("does not accept a visitor id on the plain sessions operation", () => {
    expect(parse(visitorSessions())).toBeUndefined();
  });

  it("brands and compares visitor-sessions configurations", () => {
    const query = visitorSessions();
    const configuration = parseVisitorSessions(query)!;
    const qualification = {
      operation: "visitor-sessions",
      siteId: "s1",
      requestTime: query.time,
      metadata: { plan: query.scopePlan },
      sessionListRequest: configuration,
    } as unknown as DeferredSessionListQualificationInput;
    attachSessionListQualificationToQuery(
      query as never,
      qualification,
      configuration,
    );
    const deferred = deferredSessionListQualificationFromQuery(query);
    expect(deferred?.operation).toBe("visitor-sessions");
    expect(deferred?.configuration.visitorId).toBe("v1");
    expect(
      sessionListQualificationConfigurationsEqual(configuration, {
        ...configuration,
        visitorId: "v2",
      }),
    ).toBe(false);
    expect(
      sessionListQualificationConfigurationsEqual(configuration, {
        ...configuration,
        operation: "sessions",
      }),
    ).toBe(false);
    query.visitorId = "v2";
    expect(() => deferredSessionListQualificationFromQuery(query)).toThrow(
      "session_list_qualification_request_changed",
    );
  });
});
