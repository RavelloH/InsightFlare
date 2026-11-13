import { describe, expect, it } from "vitest";

import {
  attachPagesDashboardQualificationToQuery,
  deferredPagesDashboardQualificationFromQuery,
  type DeferredPagesDashboardQualificationInput,
  pagesDashboardOwnDataSnapshotsEqual,
  pagesDashboardQualificationConfigurationFromQuery,
  pagesDashboardQualificationConfigurationsEqual,
  qualificationRequestOwnDataSnapshot,
} from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";

type Rec = Record<string, unknown>;

function baseQuery(overrides: Rec = {}): Rec {
  return {
    interval: "day",
    time: { range: { startMs: 1, endExclusiveMs: 2 } },
    filters: { clauses: [] },
    scopePlan: { kind: "plan" },
    context: {
      subject: { kind: "site", siteId: "site-1" },
      policy: { audience: "private-dashboard" },
    },
    ...overrides,
  };
}

const parse = (value: unknown) =>
  pagesDashboardQualificationConfigurationFromQuery(value);

const accessor = (target: Rec, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    get: () => value,
    enumerable: true,
    configurable: true,
  });

describe("pagesDashboardQualificationConfigurationFromQuery", () => {
  it("applies defaults for the minimal request", () => {
    expect(parse(baseQuery())).toEqual({
      interval: "day",
      limit: 12,
      cursorText: null,
      search: undefined,
      sort: "views",
      direction: "desc",
      audience: "private-dashboard",
    });
    expect(Object.isFrozen(parse(baseQuery()))).toBe(true);
  });

  it("reads page, sort, and search", () => {
    expect(
      parse(
        baseQuery({
          interval: "week",
          page: { limit: 0, cursor: "abc" },
          sort: { key: "bounceRate", direction: "asc" },
          search: "docs",
        }),
      ),
    ).toMatchObject({
      interval: "week",
      limit: 0,
      cursorText: "abc",
      search: "docs",
      sort: "bounceRate",
      direction: "asc",
    });
    expect(
      parse(baseQuery({ page: { limit: 3, cursor: null } })),
    ).toMatchObject({ limit: 3, cursorText: null });
    expect(parse(baseQuery({ page: { limit: 3 } }))).toMatchObject({
      cursorText: null,
    });
    expect(parse(baseQuery({ page: null, sort: undefined }))).toMatchObject({
      limit: 12,
      sort: "views",
    });
  });

  it("rejects non-object and structurally invalid roots", () => {
    expect(parse(null)).toBeUndefined();
    expect(parse("query")).toBeUndefined();
    expect(parse({})).toBeUndefined();
    for (const key of [
      "interval",
      "page",
      "search",
      "sort",
      "comparison",
      "current",
      "reference",
      "context",
      "time",
      "filters",
      "scopePlan",
    ])
      expect(parse(accessor(baseQuery(), key, "x"))).toBeUndefined();
    const { time: _time, ...withoutTime } = baseQuery();
    void _time;
    expect(parse(withoutTime)).toBeUndefined();
    const { filters: _filters, ...withoutFilters } = baseQuery();
    void _filters;
    expect(parse(withoutFilters)).toBeUndefined();
    const { scopePlan: _scope, ...withoutScope } = baseQuery();
    void _scope;
    expect(parse(withoutScope)).toBeUndefined();
    expect(parse(baseQuery({ scopePlan: undefined }))).toBeUndefined();
  });

  it("treats a throwing descriptor trap as invalid data", () => {
    expect(
      parse(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("boom");
            },
          },
        ),
      ),
    ).toBeUndefined();
  });

  it("rejects comparison, current, and reference windows", () => {
    expect(parse(baseQuery({ comparison: {} }))).toBeUndefined();
    expect(parse(baseQuery({ current: {} }))).toBeUndefined();
    expect(parse(baseQuery({ reference: {} }))).toBeUndefined();
    expect(parse(baseQuery({ comparison: undefined }))).toBeDefined();
  });

  it("rejects invalid interval and search", () => {
    expect(parse(baseQuery({ interval: "year" }))).toBeUndefined();
    expect(parse(baseQuery({ interval: 1 }))).toBeUndefined();
    expect(parse(baseQuery({ search: 5 }))).toBeUndefined();
    expect(parse(baseQuery({ search: undefined }))).toBeDefined();
  });

  it("rejects invalid context shapes", () => {
    const context = (value: unknown) => baseQuery({ context: value });
    expect(parse(context(null))).toBeUndefined();
    expect(parse(context([]))).toBeUndefined();
    expect(
      parse(context({ subject: { kind: "site", siteId: "s" } })),
    ).toBeUndefined();
    expect(
      parse(
        context({
          subject: { kind: "site", siteId: "s" },
          policy: { audience: "private-dashboard" },
          extra: 1,
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context({
          subject: { kind: "team", siteId: "s" },
          policy: { audience: "private-dashboard" },
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context({
          subject: { kind: "site", siteId: 1 },
          policy: { audience: "private-dashboard" },
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context({
          subject: { kind: "site", siteId: "s" },
          policy: { audience: "public-share" },
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context({
          subject: { kind: "site", siteId: "s", extra: 1 },
          policy: { audience: "private-dashboard" },
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context({
          subject: accessor({}, "kind", "site"),
          policy: { audience: "private-dashboard" },
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context({
          subject: { kind: "site", siteId: "s" },
          policy: accessor({}, "audience", "private-dashboard"),
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context(
          accessor({ policy: { audience: "private-dashboard" } }, "subject", {
            kind: "site",
            siteId: "s",
          }),
        ),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context({
          subject: { kind: "site", siteId: "s" },
          policy: { audience: "private-dashboard" },
          [Symbol("x")]: 1,
        }),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context(
          new Proxy(
            {},
            {
              ownKeys() {
                throw new Error("boom");
              },
            },
          ),
        ),
      ),
    ).toBeUndefined();
    expect(
      parse(
        context(
          new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error("boom");
              },
            },
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it("rejects invalid page shapes", () => {
    for (const page of [
      "x",
      [],
      { limit: 1.5 },
      { limit: -1 },
      { limit: Number.MAX_SAFE_INTEGER },
      { cursor: "c" },
      { limit: 1, cursor: 2 },
      { limit: 1, extra: true },
      accessor({}, "limit", 1),
    ])
      expect(parse(baseQuery({ page }))).toBeUndefined();
    expect(
      parse(baseQuery({ page: accessor({ limit: 1 }, "cursor", "c") })),
    ).toBeUndefined();
  });

  it("rejects invalid sort shapes", () => {
    for (const sort of [
      "views",
      { key: "views" },
      { direction: "asc" },
      { key: "nope", direction: "asc" },
      { key: 1, direction: "asc" },
      { key: "views", direction: "up" },
      { key: "views", direction: "asc", extra: 1 },
      accessor({ direction: "asc" }, "key", "views"),
      accessor({ key: "views" }, "direction", "asc"),
    ])
      expect(parse(baseQuery({ sort }))).toBeUndefined();
    for (const key of [
      "views",
      "visitors",
      "sessions",
      "bounceRate",
      "pagesPerSession",
      "avgDurationMs",
    ])
      expect(
        parse(baseQuery({ sort: { key, direction: "asc" } })),
      ).toMatchObject({ sort: key });
  });
});

describe("pages dashboard snapshots", () => {
  it("compares configurations field by field", () => {
    const left = parse(baseQuery())!;
    expect(pagesDashboardQualificationConfigurationsEqual(left, left)).toBe(
      true,
    );
    for (const override of [
      { interval: "hour" },
      { limit: 1 },
      { cursorText: "c" },
      { search: "q" },
      { sort: "visitors" },
      { direction: "asc" },
      { audience: "public-share" },
    ])
      expect(
        pagesDashboardQualificationConfigurationsEqual(left, {
          ...left,
          ...override,
        } as never),
      ).toBe(false);
  });

  it("serializes request snapshots deterministically", () => {
    const first = qualificationRequestOwnDataSnapshot(baseQuery());
    expect(first).toBeTypeOf("string");
    const reordered = Object.fromEntries(Object.entries(baseQuery()).reverse());
    expect(qualificationRequestOwnDataSnapshot(reordered)).toBe(first);
    expect(
      qualificationRequestOwnDataSnapshot(baseQuery({ extra: undefined })),
    ).toBeTypeOf("string");
    expect(
      qualificationRequestOwnDataSnapshot(
        baseQuery({ list: [1, "a", null, true, { b: 1 }] }),
      ),
    ).toContain('"list":[1,"a",null,true,{"b":1}]');
    expect(
      qualificationRequestOwnDataSnapshot(baseQuery({ filters: null })),
    ).toContain('"filters":null');
    expect(
      qualificationRequestOwnDataSnapshot(baseQuery({ filters: undefined })),
    ).toBeTypeOf("string");
  });

  it("allows hidden symbol metadata on the root only when non-enumerable data", () => {
    const hidden = baseQuery();
    Object.defineProperty(hidden, Symbol("hidden"), {
      value: 1,
      enumerable: false,
    });
    expect(qualificationRequestOwnDataSnapshot(hidden)).toBeTypeOf("string");
    const visible = baseQuery();
    Object.defineProperty(visible, Symbol("visible"), {
      value: 1,
      enumerable: true,
    });
    expect(qualificationRequestOwnDataSnapshot(visible)).toBeUndefined();
    const hiddenAccessor = baseQuery();
    Object.defineProperty(hiddenAccessor, Symbol("hidden"), {
      get: () => 1,
      enumerable: false,
    });
    expect(qualificationRequestOwnDataSnapshot(hiddenAccessor)).toBeUndefined();
  });

  it("rejects request roots that are not plain own data", () => {
    expect(qualificationRequestOwnDataSnapshot(null)).toBeUndefined();
    expect(qualificationRequestOwnDataSnapshot([])).toBeUndefined();
    expect(qualificationRequestOwnDataSnapshot(new Map())).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(accessor({}, "interval", "day")),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(
        Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
      ),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("boom");
            },
          },
        ),
      ),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(
        new Proxy(
          { a: 1 },
          {
            ownKeys() {
              return ["a"];
            },
            getOwnPropertyDescriptor() {
              return undefined;
            },
          },
        ),
      ),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(baseQuery({ bad: Number.NaN })),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(baseQuery({ bad: 1n })),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(baseQuery({ bad: () => 1 })),
    ).toBeUndefined();
  });

  it("snapshots nested own data and rejects exotic values", () => {
    const equal = pagesDashboardOwnDataSnapshotsEqual;
    expect(equal({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(equal({ a: 1 }, { a: 2 })).toBe(false);
    expect(equal(undefined, undefined)).toBe(true);
    expect(equal(null, null)).toBe(true);
    expect(equal({ a: undefined }, { a: undefined })).toBe(true);
    expect(equal(Number.NaN, 1)).toBe(false);
    expect(equal(1, Number.POSITIVE_INFINITY)).toBe(false);
    expect(equal(1n, 1n)).toBe(false);
    expect(equal(new Set(["b", "a"]), ["a", "b"])).toBe(true);
    expect(equal(new Set([1]), new Set([1]))).toBe(false);
    const subclassed = new (class extends Set<string> {})(["a"]);
    expect(equal(subclassed, ["a"])).toBe(false);
    const decorated = new Set(["a"]);
    (decorated as unknown as Rec).extra = 1;
    expect(equal(decorated, ["a"])).toBe(false);
    expect(equal(new Date(0), new Date(0))).toBe(false);
    const cyclic: Rec = {};
    cyclic.self = cyclic;
    expect(equal(cyclic, cyclic)).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 45; i += 1) deep = [deep];
    expect(equal(deep, deep)).toBe(false);
    expect(equal(new Array(20_001).fill(0), [])).toBe(false);
    expect(equal(new Array(2), new Array(2))).toBe(false);
    const extraArray = [1] as unknown[] & { extra?: number };
    extraArray.extra = 1;
    expect(equal(extraArray, [1])).toBe(false);
    const accessorArray = [0];
    Object.defineProperty(accessorArray, 0, {
      get: () => 1,
      enumerable: true,
    });
    expect(equal(accessorArray, [1])).toBe(false);
    expect(equal([Number.NaN], [Number.NaN])).toBe(false);
    expect(equal(accessor({}, "a", 1), { a: 1 })).toBe(false);
    expect(equal({ [Symbol("s")]: 1 }, {})).toBe(false);
    expect(equal({ a: Number.NaN }, { a: 1 })).toBe(false);
    expect(
      equal(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("boom");
            },
          },
        ),
        {},
      ),
    ).toBe(false);
    expect(
      equal(
        new Proxy(
          { a: 1 },
          {
            ownKeys() {
              return ["a"];
            },
            getOwnPropertyDescriptor() {
              return undefined;
            },
          },
        ),
        { a: 1 },
      ),
    ).toBe(false);
  });

  it("snapshots policy sets in set and frozen set-like forms", () => {
    const equal = pagesDashboardOwnDataSnapshotsEqual;
    const policyEqual = (left: unknown, right: unknown) =>
      equal(
        { a: { b: { allowedOperations: left } } },
        { a: { b: { allowedOperations: right } } },
      );
    expect(policyEqual(new Set(["x", "y"]), new Set(["y", "x"]))).toBe(true);
    expect(policyEqual(new Set([1]), new Set([1]))).toBe(false);
    expect(
      policyEqual(new (class extends Set<string> {})(["x"]), new Set(["x"])),
    ).toBe(false);
    const decorated = new Set(["x"]);
    (decorated as unknown as Rec).extra = 1;
    expect(policyEqual(decorated, new Set(["x"]))).toBe(false);
    expect(policyEqual("not a set", "not a set")).toBe(false);
    expect(policyEqual([], [])).toBe(false);

    const setLike = (
      entries: unknown[],
      tweak: (target: Rec) => void = () => {},
    ) => {
      const target: Rec = {
        get size() {
          return entries.length;
        },
        has: () => true,
        entries: () => [],
        keys: () => [],
        values: () => [],
        forEach: (callback: (entry: unknown) => void) =>
          entries.forEach((entry) => callback(entry)),
        [Symbol.iterator]: () => entries[Symbol.iterator](),
      };
      tweak(target);
      return Object.freeze(target);
    };
    expect(policyEqual(setLike(["b", "a"]), new Set(["a", "b"]))).toBe(true);
    expect(policyEqual(setLike([1]), new Set(["a"]))).toBe(false);
    expect(policyEqual(setLike(["a", "a"]), new Set(["a"]))).toBe(false);
    const unfrozen = setLike(["a"]);
    expect(policyEqual({ ...unfrozen, size: 1 }, new Set(["a"]))).toBe(false);
    expect(
      policyEqual(
        setLike(["a"], (target) => {
          delete target.has;
        }),
        new Set(["a"]),
      ),
    ).toBe(false);
    expect(
      policyEqual(
        setLike(["a"], (target) => {
          Object.defineProperty(target, "size", { value: 1, enumerable: true });
        }),
        new Set(["a"]),
      ),
    ).toBe(false);
    expect(
      policyEqual(
        setLike(["a"], (target) => {
          target.forEach = "nope";
        }),
        new Set(["a"]),
      ),
    ).toBe(false);
    expect(
      policyEqual(
        setLike(["a"], (target) => {
          Reflect.set(target, Symbol.iterator, "nope");
        }),
        new Set(["a"]),
      ),
    ).toBe(false);
    expect(
      policyEqual(
        setLike(["a"], (target) => {
          target.keys = "nope";
        }),
        new Set(["a"]),
      ),
    ).toBe(false);
    expect(
      policyEqual(
        setLike(["a"], (target) => {
          target.extra = 1;
        }),
        new Set(["a"]),
      ),
    ).toBe(false);
    expect(
      policyEqual(
        setLike(["a"], (target) => {
          target.forEach = () => {
            throw new Error("boom");
          };
        }),
        new Set(["a"]),
      ),
    ).toBe(false);
  });

  it("snapshots filter documents including scoped metadata symbols", () => {
    const withFilters = (filters: unknown) => baseQuery({ filters });
    expect(
      qualificationRequestOwnDataSnapshot(withFilters({ clauses: [1, 2] })),
    ).toBeTypeOf("string");
    const metadata = (
      name: string,
      enumerable = false,
      value: unknown = {},
    ) => {
      const filters: Rec = { clauses: [] };
      Object.defineProperty(filters, Symbol(name), { value, enumerable });
      return filters;
    };
    expect(
      qualificationRequestOwnDataSnapshot(
        withFilters(metadata("insightflare.scoped-filter-metadata")),
      ),
    ).toContain("$internalSymbols");
    expect(
      qualificationRequestOwnDataSnapshot(
        withFilters(
          metadata("insightflare.filter-scope-preference", false, "session"),
        ),
      ),
    ).toBeTypeOf("string");
    expect(
      qualificationRequestOwnDataSnapshot(
        withFilters(metadata("insightflare.unknown")),
      ),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(
        withFilters(metadata("insightflare.scoped-filter-metadata", true)),
      ),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(
        withFilters(
          metadata("insightflare.scoped-filter-metadata", false, Number.NaN),
        ),
      ),
    ).toBeUndefined();
    const noDescription = { clauses: [] } as Rec;
    Object.defineProperty(noDescription, Symbol(), {
      value: 1,
      enumerable: false,
    });
    expect(
      qualificationRequestOwnDataSnapshot(withFilters(noDescription)),
    ).toBeUndefined();
    const accessorSymbol = { clauses: [] } as Rec;
    Object.defineProperty(
      accessorSymbol,
      Symbol("insightflare.scoped-filter-metadata"),
      {
        get: () => 1,
      },
    );
    expect(
      qualificationRequestOwnDataSnapshot(withFilters(accessorSymbol)),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(withFilters("text")),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(withFilters([])),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(
        withFilters(
          Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
        ),
      ),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(withFilters({ clauses: Number.NaN })),
    ).toBeUndefined();
    expect(
      qualificationRequestOwnDataSnapshot(
        withFilters(
          new Proxy(
            {},
            {
              ownKeys() {
                throw new Error("boom");
              },
            },
          ),
        ),
      ),
    ).toBeUndefined();
    const duplicateSymbols = { clauses: [] } as Rec;
    const sharedA = Symbol("insightflare.scoped-filter-metadata");
    const sharedB = Symbol("insightflare.scoped-filter-metadata");
    Object.defineProperty(duplicateSymbols, sharedA, { value: 1 });
    Object.defineProperty(duplicateSymbols, sharedB, { value: 2 });
    expect(
      qualificationRequestOwnDataSnapshot(withFilters(duplicateSymbols)),
    ).toBeUndefined();
  });
});

describe("pages dashboard branding", () => {
  const qualificationFor = (
    configuration: NonNullable<ReturnType<typeof parse>>,
  ) =>
    ({
      operation: "pages-dashboard",
      pagesDashboardRequest: configuration,
    }) as unknown as DeferredPagesDashboardQualificationInput;

  it("attaches a non-enumerable brand that round-trips", () => {
    const query = baseQuery({ page: { limit: 4 } });
    const configuration = parse(query)!;
    attachPagesDashboardQualificationToQuery(
      query as never,
      qualificationFor(configuration),
      configuration,
    );
    expect(Object.keys(query)).not.toContain("brand");
    const deferred = deferredPagesDashboardQualificationFromQuery(query);
    expect(deferred?.operation).toBe("pages-dashboard");
    expect(deferred?.configuration).toBe(configuration);
    expect(Object.isFrozen(deferred)).toBe(true);
    expect(deferredPagesDashboardQualificationFromQuery(query)).toBe(deferred);
  });

  it("refuses to attach inconsistent requests", () => {
    const query = baseQuery();
    const configuration = parse(query)!;
    expect(() =>
      attachPagesDashboardQualificationToQuery(
        baseQuery({ interval: "bogus" }) as never,
        qualificationFor(configuration),
        configuration,
      ),
    ).toThrow("pages_dashboard_qualification_request_configuration_invalid");
    expect(() =>
      attachPagesDashboardQualificationToQuery(
        query as never,
        qualificationFor(configuration),
        { ...configuration, limit: 99 },
      ),
    ).toThrow("pages_dashboard_qualification_request_configuration_changed");
    const unsnapshotable = baseQuery({ extra: Number.NaN });
    expect(() =>
      attachPagesDashboardQualificationToQuery(
        unsnapshotable as never,
        qualificationFor(configuration),
        configuration,
      ),
    ).toThrow("pages_dashboard_qualification_request_snapshot_invalid");
  });

  it("returns undefined for unbranded values and rejects forged brands", () => {
    expect(deferredPagesDashboardQualificationFromQuery(null)).toBeUndefined();
    expect(deferredPagesDashboardQualificationFromQuery("x")).toBeUndefined();
    expect(deferredPagesDashboardQualificationFromQuery({})).toBeUndefined();

    const trusted = baseQuery();
    const configuration = parse(trusted)!;
    attachPagesDashboardQualificationToQuery(
      trusted as never,
      qualificationFor(configuration),
      configuration,
    );
    const brandSymbol = Object.getOwnPropertySymbols(trusted)[0]!;
    const brand = Object.getOwnPropertyDescriptor(trusted, brandSymbol)!.value;

    const copiedBrand = baseQuery();
    Object.defineProperty(copiedBrand, brandSymbol, { value: brand });
    expect(() =>
      deferredPagesDashboardQualificationFromQuery(copiedBrand),
    ).toThrow("pages_dashboard_qualification_request_untrusted");

    const enumerableBrand = baseQuery();
    Object.defineProperty(enumerableBrand, brandSymbol, {
      value: brand,
      enumerable: true,
    });
    expect(() =>
      deferredPagesDashboardQualificationFromQuery(enumerableBrand),
    ).toThrow("pages_dashboard_qualification_request_untrusted");

    const accessorBrand = baseQuery();
    Object.defineProperty(accessorBrand, brandSymbol, { get: () => brand });
    expect(() =>
      deferredPagesDashboardQualificationFromQuery(accessorBrand),
    ).toThrow("pages_dashboard_qualification_request_untrusted");

    for (const value of [undefined, "forged", { forged: true }]) {
      const forged = baseQuery();
      Object.defineProperty(forged, brandSymbol, { value });
      expect(() =>
        deferredPagesDashboardQualificationFromQuery(forged),
      ).toThrow("pages_dashboard_qualification_request_untrusted");
    }

    const throwing = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    expect(() =>
      deferredPagesDashboardQualificationFromQuery(throwing),
    ).toThrow("pages_dashboard_qualification_request_untrusted");
  });

  it("detects post-attach tampering", () => {
    const make = () => {
      const query = baseQuery({ page: { limit: 4 } });
      const configuration = parse(query)!;
      attachPagesDashboardQualificationToQuery(
        query as never,
        qualificationFor(configuration),
        configuration,
      );
      return query;
    };
    const changed = "pages_dashboard_qualification_request_changed";
    const interval = make();
    interval.interval = "hour";
    expect(() =>
      deferredPagesDashboardQualificationFromQuery(interval),
    ).toThrow(changed);
    const invalid = make();
    invalid.interval = "bogus";
    expect(() => deferredPagesDashboardQualificationFromQuery(invalid)).toThrow(
      changed,
    );
    const snapshot = make();
    (snapshot.time as Rec).extra = 1;
    expect(() =>
      deferredPagesDashboardQualificationFromQuery(snapshot),
    ).toThrow(changed);
    const unsnapshotable = make();
    unsnapshotable.extra = Number.NaN;
    expect(() =>
      deferredPagesDashboardQualificationFromQuery(unsnapshotable),
    ).toThrow(changed);
  });

  it("detects a qualification whose own configuration disagrees", () => {
    const query = baseQuery();
    const configuration = parse(query)!;
    attachPagesDashboardQualificationToQuery(
      query as never,
      qualificationFor({ ...configuration, limit: 7 }),
      configuration,
    );
    expect(() => deferredPagesDashboardQualificationFromQuery(query)).toThrow(
      "pages_dashboard_qualification_request_changed",
    );
    const wrongOperation = baseQuery();
    attachPagesDashboardQualificationToQuery(
      wrongOperation as never,
      {
        operation: "other",
        pagesDashboardRequest: configuration,
      } as unknown as DeferredPagesDashboardQualificationInput,
      configuration,
    );
    expect(() =>
      deferredPagesDashboardQualificationFromQuery(wrongOperation),
    ).toThrow("pages_dashboard_qualification_request_changed");
  });
});
