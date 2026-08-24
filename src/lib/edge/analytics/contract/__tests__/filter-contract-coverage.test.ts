import { describe, expect, it, vi } from "vitest";

import type {
  FilterFieldDefinition,
  FilterFieldRegistry,
  QueryOperation,
} from "@/lib/edge/analytics/contract";
import {
  analyticsFilterOperators,
  analyticsFilterRegistry,
  applyFiltersToUrl,
  assertFilterAudience,
  compileFilterDocument,
  createTimeRange,
  executeOverview,
  executePages,
  executeReferrers,
  executeTrend,
  FilterAdapterError,
  filterExpressionFingerprint,
  isReportingTimeZone,
  normalizeFilterDocument,
  normalizeReportingTimeZone,
  operatorsForValueKind,
  parseFilterParams,
  parseFilterUrlForAudience,
  serializeFilterQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";

const field = (fieldId: string, operator: string, value?: unknown) => ({
  kind: "condition",
  target: { kind: "field", field: fieldId },
  operator,
  ...(value === undefined ? {} : { value }),
});

const payload = (path: string, operator: string, value?: unknown) => ({
  kind: "condition",
  target: { kind: "event-payload", path },
  operator,
  ...(value === undefined ? {} : { value }),
});

const document = (root: unknown) =>
  normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);

describe("query contract boundary coverage", () => {
  it("covers registry views and value-kind operator inventory", () => {
    expect(analyticsFilterRegistry.size).toBeGreaterThan(0);
    expect([...analyticsFilterRegistry.keys()]).toHaveLength(
      analyticsFilterRegistry.size,
    );
    expect([...analyticsFilterRegistry.entries()]).toHaveLength(
      analyticsFilterRegistry.size,
    );
    expect([...analyticsFilterRegistry.values()]).toHaveLength(
      analyticsFilterRegistry.size,
    );
    const sample = analyticsFilterRegistry.get("page.path")!;
    expect(sample.operators.size).toBeGreaterThan(0);
    expect([...sample.operators.keys()]).toHaveLength(sample.operators.size);
    expect([...sample.operators.values()]).toHaveLength(sample.operators.size);
    expect(sample.operators.has("eq")).toBe(true);
    sample.operators.forEach(() => undefined);
    expect(operatorsForValueKind("boolean").has("eq")).toBe(true);
    expect(operatorsForValueKind("datetime").has("between")).toBe(true);
    expect(analyticsFilterOperators("missing.field")).toBeUndefined();
  });

  it("supports URL inputs, query helpers, and strictness controls", () => {
    const source = document(field("page.path", "eq", "/docs"));
    expect(serializeFilterQuery(source, analyticsFilterRegistry)).toBe(
      "filter%5Bpage.path%5D=%2Fdocs",
    );
    const url = applyFiltersToUrl(
      "https://example.test/report?keep=1&filter%5Bpage.path%5D=%2Fold",
      source,
      analyticsFilterRegistry,
    );
    expect(url.searchParams.get("keep")).toBe("1");
    expect(url.searchParams.get("filter[page.path]")).toBe("/docs");
    expect(
      parseFilterParams(
        new URL("https://example.test/?filter[page.path]=/docs"),
        analyticsFilterRegistry,
      ).root,
    ).toMatchObject({ operator: "eq", value: "/docs" });
    expect(
      parseFilterParams(
        "other=1&filter[page.path]=/docs",
        analyticsFilterRegistry,
        { strictFilterKeys: false },
      ).root,
    ).toMatchObject({ operator: "eq" });
    expect(filterExpressionFingerprint(source.root!)).toContain("page.path");
    for (const audience of [
      "private-dashboard",
      "public-share",
      "api-v1",
    ] as const) {
      expect(
        parseFilterUrlForAudience(audience, "filter[page.path]=/docs"),
      ).toMatchObject({ version: 1 });
    }
  });

  it("rejects malformed codec values and logic paths", () => {
    const booleanRegistry: FilterFieldRegistry = new Map([
      [
        "flag.enabled",
        {
          id: "flag.enabled",
          valueKind: "boolean",
          operators: new Set(["eq"]),
          audiences: new Set(["private-dashboard"]),
        },
      ],
    ]);
    expect(() =>
      parseFilterParams("filter[flag.enabled]=maybe", booleanRegistry),
    ).toThrow(/true or false/i);
    expect(() =>
      parseFilterParams(
        "filter[event.payload][/score]=between:1",
        analyticsFilterRegistry,
      ),
    ).toThrow(/exactly two/i);
    expect(
      parseFilterParams("filter[page.path]=in:", analyticsFilterRegistry),
    ).toMatchObject({ root: { operator: "eq", value: "" } });
    expect(() =>
      parseFilterParams("filter[page.path][or]=/docs", analyticsFilterRegistry),
    ).toThrow(/branch/i);
    expect(() =>
      parseFilterParams(
        "filter[page.path][not.bad]=/docs",
        analyticsFilterRegistry,
      ),
    ).toThrow(/Invalid logic token/i);
    expect(
      parseFilterParams("filter[page.path]=c:", analyticsFilterRegistry).root,
    ).toMatchObject({ operator: "contains", value: "" });
    expect(() =>
      parseFilterParams(
        "filter[event.payload][/value]=json:{bad}",
        analyticsFilterRegistry,
      ),
    ).toThrow(/JSON scalars/i);
    expect(() =>
      parseFilterParams(
        "filter[geo.country]=in:US,JP",
        analyticsFilterRegistry,
        {
          limits: { maxSetValues: 1 },
        },
      ),
    ).toThrow(/invalid number/i);
    expect(() =>
      parseFilterParams(
        "filter[page.path]=x".repeat(1),
        analyticsFilterRegistry,
        {
          limits: { maxValueLength: 0 },
        },
      ),
    ).toThrow(/positive|value/i);
    const aliases = [
      "eq:x",
      "ne:x",
      "neq:x",
      "in:x,y",
      "nin:x,y",
      "c:x",
      "sw:x",
      "startsWith:x",
      "ew:x",
      "endsWith:x",
      "ex",
      "nex",
      "null",
      "nnull",
      "empty",
      "nempty",
    ];
    for (const value of aliases) {
      expect(
        parseFilterParams(`filter[page.path]=${value}`, analyticsFilterRegistry)
          .root,
      ).toBeTruthy();
    }
    expect(
      parseFilterParams(
        "filter[event.payload][/n]=json:1&filter[event.payload][/b]=json:false",
        analyticsFilterRegistry,
      ).root,
    ).toBeTruthy();
    expect(
      parseFilterParams(
        new URLSearchParams([
          ["filter[event.payload][/null]", "in:json:null"],
          ["filter[event.payload][/text]", 'in:json:"text"'],
        ]),
        analyticsFilterRegistry,
      ).root,
    ).toBeTruthy();
    expect(
      parseFilterParams(
        "filter[page.path][or:1.0.not:2]=/docs&filter[page.path][or:1.1]=/blog",
        analyticsFilterRegistry,
      ).root,
    ).toMatchObject({ kind: "or" });
    expect(
      parseFilterParams(
        "filter[page.path][or:1.0]=/docs&filter[page.path][or:1.0]=/docs2&filter[page.path][not:2]=/x&filter[page.path][not:2]=/y",
        analyticsFilterRegistry,
      ).root,
    ).toBeTruthy();
    expect(() =>
      parseFilterParams(
        "filter[page.path]=/a&filter[page.title]=/b",
        analyticsFilterRegistry,
        { limits: { maxConditions: 1 } },
      ),
    ).toThrow(/condition limit/i);
    const serializedValues = [
      document(payload("/bool", "eq", true)),
      document(payload("/number", "eq", 3)),
      document(payload("/text", "eq", "x")),
    ];
    for (const value of serializedValues) {
      expect(serializeFilterQuery(value, analyticsFilterRegistry)).toContain(
        "filter%5Bevent.payload%5D",
      );
    }
    for (const operator of [
      "exists",
      "notExists",
      "isNull",
      "notNull",
      "isEmpty",
      "notEmpty",
    ] as const) {
      expect(
        serializeFilterQuery(
          document(field("page.path", operator)),
          analyticsFilterRegistry,
        ),
      ).toContain("filter%5Bpage.path%5D");
    }
  });

  it("compiles scalar, set, range, null, empty, and derived predicates", () => {
    const directOperators = [
      ["eq", "x"],
      ["neq", "x"],
      ["contains", "x"],
      ["startsWith", "x"],
      ["endsWith", "x"],
      ["in", ["x", "y"]],
      ["notIn", ["x", "y"]],
      ["exists"],
      ["notExists"],
      ["isNull"],
      ["notNull"],
      ["isEmpty"],
      ["notEmpty"],
    ] as const;
    for (const [operator, value] of directOperators) {
      const result = compileFilterDocument(
        document(field("page.path", operator, value)),
        { alias: "vs" },
      );
      expect(result.clause).toContain("WHERE");
    }
    for (const [operator, value] of [
      ["gt", 1],
      ["gte", 1],
      ["lt", 2],
      ["lte", 2],
      ["between", [1, 2]],
    ] as const) {
      const result = compileFilterDocument(
        document(payload("/score", operator, value)),
        { alias: "vs", eventAlias: "es" },
      );
      expect(result.clause).toContain("EXISTS");
    }
    const payloadCases = [
      ["eq", "x"],
      ["neq", "x"],
      ["in", ["x", "y"]],
      ["notIn", ["x", "y"]],
      ["contains", "x"],
      ["startsWith", "x"],
      ["endsWith", "x"],
      ["isNull"],
      ["notNull"],
      ["isEmpty"],
      ["notEmpty"],
      ["exists"],
      ["notExists"],
    ] as const;
    for (const [operator, value] of payloadCases) {
      const result = compileFilterDocument(
        document(payload("/value", operator, value)),
        { alias: "vs", eventAlias: "es" },
      );
      expect(result.clause).toContain(
        operator === "notExists" ? "NOT" : "EXISTS",
      );
    }
    expect(
      compileFilterDocument(
        document(field("session.exitPath", "eq", "/checkout")),
        { alias: "vs", sessionSource: "edges", eventAlias: "es" },
      ).clause,
    ).toContain("exit_rank");
    for (const fieldId of [
      "event.name",
      "client.browserEngine",
      "client.osVersion",
      "client.screenSize",
    ]) {
      expect(
        compileFilterDocument(document(field(fieldId, "eq", "x")), {
          alias: "vs",
          eventAlias: "es",
        }).clause,
      ).toContain("WHERE");
    }
    expect(
      compileFilterDocument(
        document(field("referrer.domain", "neq", "__direct__")),
        { alias: "vs" },
      ).clause,
    ).toContain("!= ''");
    expect(compileFilterDocument({ version: 1, root: null }).clause).toBe("");
  });

  it("handles custom typed fields and rejects invalid canonical values", () => {
    const all = new Set(["private-dashboard", "api-v1"] as const);
    const definition = (
      id: string,
      valueKind: FilterFieldDefinition["valueKind"],
      canonicalize?: FilterFieldDefinition["canonicalize"],
    ): FilterFieldDefinition => ({
      id,
      valueKind,
      operators:
        valueKind === "boolean"
          ? new Set(["eq", "neq"])
          : new Set(["eq", "between", "in"]),
      audiences: all,
      canonicalize,
    });
    const registry: FilterFieldRegistry = new Map([
      ["metric.number", definition("metric.number", "number")],
      ["metric.boolean", definition("metric.boolean", "boolean")],
      ["metric.date", definition("metric.date", "date")],
      ["metric.datetime", definition("metric.datetime", "datetime")],
      ["metric.json", definition("metric.json", "json-scalar")],
      ["metric.bad", definition("metric.bad", "string", () => 1)],
    ]);
    expect(
      parseFilterParams("filter[metric.number]=12", registry).root,
    ).toMatchObject({ value: 12 });
    expect(
      parseFilterParams("filter[metric.boolean]=true", registry).root,
    ).toMatchObject({ value: true });
    expect(
      parseFilterParams("filter[metric.date]=2026-08-18", registry).root,
    ).toMatchObject({ value: "2026-08-18" });
    expect(
      parseFilterParams(
        "filter[metric.datetime]=2026-08-18T01:02:03Z",
        registry,
      ).root,
    ).toMatchObject({ value: "2026-08-18T01:02:03.000Z" });
    expect(
      normalizeFilterDocument(
        { version: 1, root: field("metric.date", "eq", "2026-08-18") },
        registry,
      ).root,
    ).toMatchObject({ value: "2026-08-18" });
    expect(
      normalizeFilterDocument(
        {
          version: 1,
          root: field("metric.datetime", "eq", "2026-08-18T01:02:03+08:00"),
        },
        registry,
      ).root,
    ).toMatchObject({ value: "2026-08-17T17:02:03.000Z" });
    expect(
      normalizeFilterDocument(
        { version: 1, root: field("metric.boolean", "eq", true) },
        registry,
      ).root,
    ).toMatchObject({ value: true });
    expect(
      normalizeFilterDocument(
        { version: 1, root: field("metric.json", "eq", "value") },
        registry,
      ).root,
    ).toMatchObject({ value: "value" });
    expect(() =>
      normalizeFilterDocument(
        { version: 1, root: field("metric.date", "eq", "2026-02-30") },
        registry,
      ),
    ).toThrow(/real ISO/i);
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: field("metric.datetime", "eq", "2026-08-18T01:02"),
        },
        registry,
      ),
    ).toThrow(/RFC 3339/i);
    expect(() =>
      normalizeFilterDocument(
        { version: 1, root: field("metric.date", "eq", "2026/08/18") },
        registry,
      ),
    ).toThrow(/ISO calendar/i);
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: field("metric.datetime", "eq", "2026-13-18T01:02:03Z"),
        },
        registry,
      ),
    ).toThrow(/real RFC/i);
    expect(() =>
      normalizeFilterDocument(
        { version: 1, root: field("metric.boolean", "eq", "true") },
        registry,
      ),
    ).toThrow(/boolean/i);
    expect(() =>
      normalizeFilterDocument(
        { version: 1, root: field("metric.bad", "eq", "x") },
        registry,
      ),
    ).toThrow(/canonicalization/i);
  });

  it("validates expression shape, limits, ranges, and audience traversal", () => {
    const custom: FilterFieldRegistry = new Map([
      [
        "metric.number",
        {
          id: "metric.number",
          valueKind: "number",
          operators: new Set(["eq", "between", "in"]),
          audiences: new Set(["private-dashboard"]),
          singletonSetEquivalent: true,
        },
      ],
    ]);
    const invalid = (root: unknown, limits = {}) =>
      normalizeFilterDocument({ version: 1, root }, custom, limits);
    expect(() => invalid({ kind: "not" })).toThrow(/child/i);
    expect(() =>
      invalid({
        kind: "condition",
        target: { kind: "other" },
        operator: "eq",
        value: 1,
      }),
    ).toThrow(/Unknown filter target/i);
    expect(() =>
      invalid({
        kind: "condition",
        target: { kind: "field", field: "bad field" },
        operator: "eq",
        value: 1,
      }),
    ).toThrow(/stable dot/i);
    expect(() =>
      invalid({
        kind: "condition",
        target: { kind: "event-payload", path: "/" },
        operator: "eq",
        value: 1,
      }),
    ).toThrow(/not registered/i);
    expect(() => invalid({ kind: "xor", children: [] })).toThrow(/Unknown/i);
    expect(() => invalid({ kind: "and", children: [] })).toThrow(/at least/i);
    expect(() => invalid({ kind: "condition" })).toThrow(/target/i);
    expect(() => invalid(field("metric.number", "eq"))).toThrow(
      /requires a value/i,
    );
    expect(() => invalid(field("metric.number", "eq", [1, 2]))).toThrow(
      /Scalar/i,
    );
    expect(() => invalid(field("metric.number", "eq", null))).toThrow(
      /isNull/i,
    );
    expect(() => invalid(field("metric.number", "between", [1, null]))).toThrow(
      /numeric/i,
    );
    expect(() => invalid(field("metric.number", "between", [1, 0]))).toThrow(
      /ordered/i,
    );
    expect(() => invalid(field("metric.number", "between", 1))).toThrow(
      /exactly two/i,
    );
    expect(() => invalid(field("metric.number", "in", []))).toThrow(
      /non-empty/i,
    );
    expect(() =>
      invalid(field("metric.number", "in", [1, 2]), { maxSetValues: 1 }),
    ).toThrow(/set-value/i);
    expect(() =>
      invalid(field("metric.number", "eq", 1), { maxConditions: 0 }),
    ).toThrow(/positive/i);
    expect(() =>
      invalid(field("metric.number", "eq", 1), {
        maxConditions: 1,
        maxDepth: 1,
      }),
    ).not.toThrow();
    expect(() =>
      invalid(
        {
          kind: "not",
          child: { kind: "not", child: field("metric.number", "eq", 1) },
        },
        { maxDepth: 1 },
      ),
    ).toThrow(/depth/i);
    expect(() => invalid({ kind: "field", field: "metric.number" })).toThrow(
      /expression/i,
    );
    expect(() => invalid(field("metric.number", "wat", 1))).toThrow(
      /operator/i,
    );
    expect(() =>
      invalid(
        {
          kind: "and",
          children: [
            {
              kind: "and",
              children: [field("metric.number", "eq", 1)],
            },
          ],
        },
        { maxGroups: 2 },
      ),
    ).not.toThrow();
    expect(() =>
      invalid(
        { kind: "and", children: [field("metric.number", "eq", 1)] },
        { maxGroups: 0 },
      ),
    ).toThrow(/positive/i);
    const jsonRegistry: FilterFieldRegistry = new Map([
      [
        "metric.json",
        {
          id: "metric.json",
          valueKind: "json-scalar",
          operators: new Set(["between"]),
          audiences: new Set(["private-dashboard"]),
        },
      ],
    ]);
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: field("metric.json", "between", [true, true]),
        },
        jsonRegistry,
      ),
    ).toThrow(/ordered type/i);
    expect(() =>
      normalizeFilterDocument(
        {
          version: 1,
          root: field("metric.json", "between", [1, "2"]),
        },
        jsonRegistry,
      ),
    ).toThrow(/ordered type/i);
    const privateDoc = normalizeFilterDocument(
      { version: 1, root: field("metric.number", "eq", 1) },
      custom,
    );
    expect(() =>
      assertFilterAudience(privateDoc, custom, "public-share"),
    ).toThrow(/allowed/i);
    expect(filterExpressionFingerprint(privateDoc.root!)).toContain(
      "metric.number",
    );
  });

  it("covers denied overview and trend execution paths", async () => {
    const time = {
      range: { startMs: 0, endExclusiveMs: 1 },
      reportingTimeZone: "UTC",
      capturedAtMs: 1,
    } as never;
    const context = siteQueryContext("site-1", "private-dashboard");
    const deniedContext = {
      ...context,
      policy: {
        ...context.policy,
        allowedOperations: new Set<QueryOperation>(),
      },
    };
    const reader = {
      readOverview: vi.fn(),
      readTrend: vi.fn(),
    };
    await expect(
      executeOverview(reader, { context: deniedContext, time }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "capability-denied", capability: "overview" },
    });
    await expect(
      executeTrend(reader, { context: deniedContext, time, interval: "hour" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "capability-denied", capability: "trend" },
    });
    expect(reader.readOverview).not.toHaveBeenCalled();
    expect(reader.readTrend).not.toHaveBeenCalled();
    expect(isReportingTimeZone("UTC")).toBe(true);
    expect(isReportingTimeZone("not/a-zone")).toBe(false);
  });

  it("returns a single-source overview without optional branches", async () => {
    const time = {
      range: { startMs: 0, endExclusiveMs: 1 },
      reportingTimeZone: "UTC",
      capturedAtMs: 1,
    } as never;
    const reader = {
      readOverview: vi.fn().mockResolvedValue({
        value: {
          views: 1,
          sessions: 1,
          visitors: 1,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
        },
        source: "raw",
        approximateVisitors: false,
      }),
      readTrend: vi.fn(),
    };
    await expect(
      executeOverview(reader, {
        context: siteQueryContext("site-1", "private-dashboard"),
        time,
      }),
    ).resolves.toMatchObject({ ok: true, meta: { source: "raw" } });
  });

  it("rejects non-integral time ranges and invalid timezone fallbacks", () => {
    expect(() => createTimeRange(0.5, 2)).toThrow(/safe integer/i);
    expect(normalizeReportingTimeZone("bad/zone", "also/bad")).toBe("UTC");
    expect(new FilterAdapterError("api-v1", "invalid").message).toBe(
      "Invalid filter input.",
    );
  });

  it("executes pages and referrers without optional detail gates", async () => {
    const time = {
      range: { startMs: 0, endExclusiveMs: 1 },
      reportingTimeZone: "UTC",
      capturedAtMs: 1,
    } as never;
    const reader = {
      readPages: vi.fn().mockResolvedValue({ value: [], source: "raw" }),
      readReferrers: vi.fn().mockResolvedValue({ value: [], source: "raw" }),
    };
    const context = siteQueryContext("site-1", "private-dashboard");
    await expect(
      executePages(reader, { context, time, limit: 10, includeDetails: false }),
    ).resolves.toMatchObject({ ok: true, data: { items: [] } });
    await expect(
      executeReferrers(reader, {
        context,
        time,
        limit: 10,
        includeFullUrl: false,
      }),
    ).resolves.toMatchObject({ ok: true, data: { items: [] } });
  });
});
