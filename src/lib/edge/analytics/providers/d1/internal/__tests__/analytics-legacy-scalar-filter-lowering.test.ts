import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  filter,
  param,
  project,
  scan,
} from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { schema } from "@/lib/db/schema";
import type { LegacyScalarFilterContext } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scalar-filter-lowering";
import {
  LegacyScalarFilterLoweringError,
  lowerLegacyScalarFilterCondition,
  lowerLegacyScalarFilterDocument,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scalar-filter-lowering";
import {
  compileFilterDocument,
  type FilterSqlBinding,
} from "@/lib/edge/analytics/providers/d1/internal/filter-compiler";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  type FilterOperator,
  type FilterValue,
  normalizeFilterDocument,
} from "@/lib/filter-contract";

const VISIT_TEXT_COLUMNS = [
  "pathname",
  "title",
  "hostname",
  "query_string",
  "hash_fragment",
  "referrer_url",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device_type",
  "language",
  "country",
  "region",
  "city",
  "continent",
  "timezone",
  "as_organization",
  "user_id",
  "user_name",
] as const;

const FIXTURE_FACTS = {
  "fact.session_duration_ms": 420,
  "fact.session_views": 2,
  "fact.session_events": 3,
  "fact.session_bounce": 1,
  "fact.visitor_sessions": 4,
  "fact.visitor_views": 5,
  "fact.visitor_events": 6,
} as const;

const visitSource = scan(schema.visits);
const LOWERING_CONTEXT: LegacyScalarFilterContext = {
  visitColumns: visitSource.columns,
  eventName: param("purchase"),
  facts: Object.fromEntries(
    Object.entries(FIXTURE_FACTS).map(([strategy, value]) => [
      strategy,
      strategy === "fact.session_bounce" ? param(value === 1) : param(value),
    ]),
  ),
};

let fixtureDatabase: DatabaseSync;

function withDatabase<T>(
  run: (db: DatabaseSync) => T | Promise<T>,
): Promise<T> {
  return Promise.resolve(run(fixtureDatabase));
}

function rawDocument(root: unknown): FilterDocument {
  return { version: 1, root } as FilterDocument;
}

/** Validate each public input, but preserve its original shape for both compilers. */
function validDocument(root: unknown): FilterDocument {
  const input = rawDocument(root);
  const normalized = normalizeFilterDocument(input, analyticsFilterRegistry);
  expect(normalized.root).not.toBeNull();
  return input;
}

function fieldCondition(
  field: string,
  operator: FilterOperator,
  value?: FilterValue | readonly FilterValue[],
) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator,
    ...(value === undefined ? {} : { value }),
  } as const;
}

function insertVisit(
  db: DatabaseSync,
  visitId: string,
  sitePk: number,
  overrides: Readonly<Record<string, string | number | null>> = {},
): void {
  db.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, site_pk
    ) VALUES (?, 'legacy-scalar-site', ?, ?, 'complete', 100, 100, '', '', ?)`,
  ).run(visitId, `visitor-${visitId}`, `session-${visitId}`, sitePk);

  const values: Record<string, string | number | null> = {
    ...Object.fromEntries(VISIT_TEXT_COLUMNS.map((column) => [column, ""])),
    duration_ms: null,
    perf_ttfb_ms: null,
    perf_fcp_ms: null,
    perf_lcp_ms: null,
    perf_cls: null,
    perf_inp_ms: null,
    screen_width: null,
    screen_height: null,
    is_eu: 0,
    ...overrides,
  };
  const assignments = Object.keys(values)
    .map((column) => `${column} = ?`)
    .join(", ");
  db.prepare(`UPDATE visits SET ${assignments} WHERE visit_id = ?`).run(
    ...Object.values(values),
    visitId,
  );
}

function seedFixture(db: DatabaseSync): void {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
    "legacy-scalar-site",
  );
  const { site_pk: sitePk } = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get("legacy-scalar-site") as { site_pk: number };

  const scalarText = Object.fromEntries(
    VISIT_TEXT_COLUMNS.map((column) => [column, " needle "]),
  );
  insertVisit(db, "scalar-match", sitePk, {
    ...scalarText,
    pathname: "/needle",
    title: "needle",
    hostname: "needle",
    referrer_host: "google.com",
    utm_source: "tagged",
    utm_medium: "",
    utm_campaign: "",
    browser: "Google Chrome",
    os: "Linux",
    os_version: "6.8",
    duration_ms: 42,
    perf_ttfb_ms: 42,
    perf_fcp_ms: 42,
    perf_lcp_ms: 42,
    perf_cls: 42,
    perf_inp_ms: 42,
    screen_width: 42,
    screen_height: 42,
    is_eu: 1,
  });
  insertVisit(db, "direct-referrer", sitePk, {
    pathname: "/direct",
    referrer_host: "",
    referrer_url: "",
  });
  insertVisit(db, "raw-null-text", sitePk, { user_id: null, user_name: null });
  insertVisit(db, "nbsp-text", sitePk, {
    ...Object.fromEntries(
      VISIT_TEXT_COLUMNS.map((column) => [column, "\u00a0needle\u00a0"]),
    ),
    pathname: "\u00a0needle\u00a0",
    referrer_host: "",
    os: "",
    os_version: "15",
    browser: "Safari",
    screen_width: 720,
    screen_height: null,
  });
  insertVisit(db, "punctuation-text", sitePk, {
    ...Object.fromEntries(
      VISIT_TEXT_COLUMNS.map((column) => [
        column,
        "'quote % underscore_ back\\slash",
      ]),
    ),
    pathname: "'quote % underscore_ back\\slash",
    referrer_host: "",
    os: "iOS",
    os_version: "",
    browser: "Google Chrome",
    screen_width: null,
    screen_height: null,
  });
  insertVisit(db, "nul-text", sitePk, {
    pathname: "before\u0000needle-after",
    title: "before\u0000needle-after",
    referrer_host: "",
    os: "",
    os_version: "",
    browser: "",
  });
  insertVisit(db, "vector-alpha", sitePk, {
    pathname: "/vector-alpha",
    title: "alpha needle",
    referrer_host: "",
  });
  insertVisit(db, "vector-beta", sitePk, {
    pathname: "/vector-beta",
    title: "beta needle",
    referrer_host: "",
  });
  insertVisit(db, "vector-end-alpha", sitePk, {
    pathname: "/vector-end-alpha",
    title: "ending alpha",
    referrer_host: "",
  });
  insertVisit(db, "vector-end-beta", sitePk, {
    pathname: "/vector-end-beta",
    title: "ending beta",
    referrer_host: "",
  });
  insertVisit(db, "vector-other", sitePk, {
    pathname: "/vector-other",
    title: "unrelated title",
    referrer_host: "",
  });
  insertVisit(db, "unsafe-real", sitePk, {
    pathname: "/unsafe-real",
    title: "unsafe-real",
    perf_lcp_ms: 1000000000000000100,
    referrer_host: "",
  });
  insertVisit(db, "weak-real-text", sitePk, {
    pathname: "/weak-real-text",
    title: "weak-real-text",
    perf_lcp_ms: "not-a-number",
    referrer_host: "",
  });
  insertVisit(db, "is-eu-two", sitePk, {
    pathname: "/is-eu-two",
    title: "is-eu-two",
    is_eu: 2,
    referrer_host: "",
  });
  for (const value of [0, 1, 2]) {
    insertVisit(db, `numeric-${value}`, sitePk, {
      pathname: `/numeric-${value}`,
      title: `numeric-${value}`,
      duration_ms: value,
      perf_lcp_ms: value,
      perf_ttfb_ms: value,
      perf_fcp_ms: value,
      perf_cls: value,
      perf_inp_ms: value,
      screen_width: value,
      screen_height: value,
      referrer_host: "",
    });
  }
  insertVisit(db, "surrogate-replacement", sitePk, {
    pathname: "/surrogate",
    title: "\uFFFD",
    referrer_host: "",
  });
  insertVisit(db, "unicode-text", sitePk, {
    pathname: "/café/世界",
    title: "café 世界 😀",
    referrer_host: "",
  });
  insertVisit(db, "case-folded-text", sitePk, {
    hostname: " MiXeD.Example.COM ",
    referrer_host: " WWW.Google.COM ",
    referrer_url: " HTTPS://Example.COM/Path ",
    region: " MiXeD ",
    city: " MiXeD ",
  });
}

async function loweredIds(
  db: DatabaseSync,
  document: FilterDocument,
  context: LegacyScalarFilterContext = LOWERING_CONTEXT,
): Promise<string[]> {
  const predicate = lowerLegacyScalarFilterDocument(document, context);
  if (!predicate) throw new Error("Expected a non-null filter root.");
  const filtered = filter(visitSource, predicate);
  const selected = project(filtered, {
    visit_id: filtered.columns.visit_id,
  });
  const rows = await createD1DatabaseClient(createSqliteD1Database(db)).all(
    compileD1Query(selected),
  );
  return rows.results
    .map((row) => row.visit_id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

function legacyIds(db: DatabaseSync, document: FilterDocument): string[] {
  const compiled = compileFilterDocument(document, {
    alias: "visit_source",
    sessionSource: "visit_source",
    eventAlias: "event_source",
  });
  const relation = `(
    SELECT visits.*,
      ${FIXTURE_FACTS["fact.session_duration_ms"]} AS session_duration_ms,
      ${FIXTURE_FACTS["fact.session_views"]} AS session_views,
      ${FIXTURE_FACTS["fact.session_events"]} AS session_events,
      ${FIXTURE_FACTS["fact.session_bounce"]} AS session_bounce,
      ${FIXTURE_FACTS["fact.visitor_sessions"]} AS visitor_sessions,
      ${FIXTURE_FACTS["fact.visitor_views"]} AS visitor_views,
      ${FIXTURE_FACTS["fact.visitor_events"]} AS visitor_events
    FROM visits
  ) AS visit_source`;
  const rows = db
    .prepare(
      `SELECT visit_source.visit_id
       FROM ${relation}
       CROSS JOIN (SELECT 'purchase' AS event_name) AS event_source
       ${compiled.clause}
       ORDER BY visit_source.visit_id`,
    )
    .all(...(compiled.bindings as readonly FilterSqlBinding[])) as Array<{
    visit_id: string;
  }>;
  return rows.map((row) => row.visit_id).sort();
}

async function expectDifferential(
  db: DatabaseSync,
  document: FilterDocument,
): Promise<string[]> {
  const oldIds = legacyIds(db, document);
  const newIds = await loweredIds(db, document);
  expect(newIds).toEqual(oldIds);
  return oldIds;
}

function scalarOperand(fieldId: string): FilterValue {
  const field = analyticsFilterRegistry.get(fieldId);
  if (!field) throw new Error(`Unknown test field ${fieldId}.`);
  if (field.valueKind === "number") {
    if (field.compilerStrategy.startsWith("fact."))
      return FIXTURE_FACTS[
        field.compilerStrategy as keyof typeof FIXTURE_FACTS
      ];
    return 42;
  }
  if (field.valueKind === "boolean") return true;
  switch (field.compilerStrategy) {
    case "event.name":
      return "purchase";
    case "derived.trafficChannel":
      return "campaign";
    case "derived.browserEngine":
      return "Blink";
    case "derived.osVersion":
      return "Linux 6.8";
    case "derived.screenSize":
      return "42x42";
    default:
      return "needle";
  }
}

function scalarConditionValue(
  fieldId: string,
  operator: FilterOperator,
): FilterValue | readonly FilterValue[] | undefined {
  if (
    [
      "exists",
      "notExists",
      "isNull",
      "notNull",
      "isEmpty",
      "notEmpty",
    ].includes(operator)
  )
    return undefined;
  const value = scalarOperand(fieldId);
  if (operator === "in" || operator === "notIn") {
    const alternate = typeof value === "number" ? value + 1 : `${value}-other`;
    return [value, alternate];
  }
  if (operator === "between") {
    if (typeof value !== "number") throw new Error("Expected numeric field.");
    return [value - 1, value + 1];
  }
  return value;
}

const DIFFERENTIAL_CASES = [...analyticsFilterRegistry.values()]
  .filter(
    (field) =>
      field.profile !== "session-boundary" && field.valueKind !== "json-scalar",
  )
  .flatMap((field) =>
    [...field.operators].map((operator) => ({
      field: field.id,
      operator,
      document: validDocument(
        fieldCondition(
          field.id,
          operator,
          scalarConditionValue(field.id, operator),
        ),
      ),
    })),
  );

describe("legacy scalar filter Generic predicate compatibility", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = createMigratedDatabase();
    seedFixture(db);
    fixtureDatabase = db;
  });

  afterAll(() => db.close());

  it("returns undefined only for a normalized null root", () => {
    const empty: FilterDocument = { version: 1, root: null };
    expect(
      normalizeFilterDocument(empty, analyticsFilterRegistry).root,
    ).toBeNull();
    expect(lowerLegacyScalarFilterDocument(empty, LOWERING_CONTEXT)).toBe(
      undefined,
    );
  });

  it.each(DIFFERENTIAL_CASES)(
    "matches legacy row IDs for $field $operator",
    async ({ document }) => {
      await expectDifferential(db, document);
    },
  );

  it("matches nested AND/OR/NOT and heterogeneous field groups", async () => {
    const document = validDocument({
      kind: "and",
      children: [
        {
          kind: "or",
          children: [
            fieldCondition("page.path", "contains", "/vector"),
            fieldCondition("event.name", "eq", "purchase"),
            fieldCondition("performance.lcpMs", "gt", 50),
          ],
        },
        {
          kind: "not",
          child: fieldCondition("page.title", "eq", "unrelated title"),
        },
      ],
    });
    await expectDifferential(db, document);
  });

  it("preserves raw numeric 0/1/2 equality, ordering, ranges and sets", async () => {
    for (const root of [
      fieldCondition("page.durationMs", "eq", 0),
      fieldCondition("page.durationMs", "eq", 1),
      fieldCondition("page.durationMs", "eq", 2),
      fieldCondition("performance.lcpMs", "gt", 0),
      fieldCondition("performance.lcpMs", "between", [0, 2]),
      fieldCondition("performance.lcpMs", "in", [0, 1, 2]),
      fieldCondition("performance.lcpMs", "notIn", [0, 1, 2]),
    ]) {
      await expectDifferential(db, validDocument(root));
    }
  });

  it("lowers an already-normalized scalar leaf against a typed Generic value", async () => {
    const document = validDocument(
      fieldCondition("page.path", "contains", "needle"),
    );
    const normalized = normalizeFilterDocument(
      document,
      analyticsFilterRegistry,
    );
    if (normalized.root?.kind !== "condition")
      throw new Error("Expected one normalized filter leaf.");

    const predicate = lowerLegacyScalarFilterCondition(
      normalized.root,
      visitSource.columns.pathname,
    );
    const filtered = filter(visitSource, predicate);
    const selected = project(filtered, {
      visit_id: filtered.columns.visit_id,
    });
    const rows = await createD1DatabaseClient(createSqliteD1Database(db)).all(
      compileD1Query(selected),
    );
    expect(rows.results.map((row) => row.visit_id).sort()).toEqual(
      legacyIds(db, document),
    );
  });

  it("normalizes public eq-OR values to native IN2 and keeps eight values on JSON", async () => {
    const two = validDocument({
      kind: "or",
      children: [
        fieldCondition("page.title", "eq", " needle "),
        fieldCondition("page.title", "eq", "unrelated title"),
      ],
    });
    const twoNormalized = normalizeFilterDocument(two, analyticsFilterRegistry);
    expect(twoNormalized.root).toMatchObject({
      kind: "condition",
      operator: "in",
      value: ["needle", "unrelated title"],
    });
    const twoLegacy = compileFilterDocument(two);
    expect(twoLegacy.clause).not.toContain("json_each");
    expect(twoLegacy.bindings).toEqual(["needle", "unrelated title"]);
    expect(await expectDifferential(db, two)).toContain("scalar-match");

    const sevenValues = [
      "needle",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ];
    const seven = validDocument({
      kind: "or",
      children: sevenValues.map((value) =>
        fieldCondition("page.title", "eq", value),
      ),
    });
    const sevenLegacy = compileFilterDocument(seven);
    expect(sevenLegacy.clause).not.toContain("json_each");
    expect(sevenLegacy.bindings).toHaveLength(7);
    expect(await expectDifferential(db, seven)).toContain("scalar-match");

    const eightValues = [
      "needle",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
    ];
    const eight = validDocument({
      kind: "or",
      children: eightValues.map((value) =>
        fieldCondition("page.title", "eq", value),
      ),
    });
    const eightNormalized = normalizeFilterDocument(
      eight,
      analyticsFilterRegistry,
    ).root;
    expect(eightNormalized).toMatchObject({
      kind: "condition",
      operator: "in",
    });
    if (
      eightNormalized?.kind !== "condition" ||
      !Array.isArray(eightNormalized.value)
    )
      throw new Error("Expected canonical public IN8.");
    expect(new Set(eightNormalized.value)).toEqual(new Set(eightValues));
    const eightLegacy = compileFilterDocument(eight);
    expect(eightLegacy.clause).toContain("json_each(?)");
    expect(await expectDifferential(db, eight)).toContain("scalar-match");
  });

  it("keeps native and JSON set codecs at the legacy seven/eight boundary", async () => {
    for (const field of ["page.title", "performance.lcpMs"] as const) {
      for (const operator of ["in", "notIn"] as const) {
        for (const count of [7, 8] as const) {
          const base = field === "performance.lcpMs" ? 40 : "set-value";
          const values = Array.from({ length: count }, (_, index) =>
            typeof base === "number" ? base + index : `${base}-${index}`,
          );
          const document = validDocument(
            fieldCondition(field, operator, values),
          );
          const legacy = compileFilterDocument(document);
          expect(legacy.clause.includes("json_each(?)")).toBe(count === 8);
          await expectDifferential(db, document);
        }
      }
    }
  });

  it("preserves the reachable same-field text-vector OR lowering", async () => {
    for (const operator of ["contains", "startsWith", "endsWith"] as const) {
      const document = validDocument({
        kind: "or",
        children: [
          fieldCondition("page.title", operator, "alpha"),
          fieldCondition("page.title", operator, "beta"),
        ],
      });
      const legacy = compileFilterDocument(document);
      expect(legacy.clause).toContain("json_each(?)");
      expect(legacy.bindings).toHaveLength(1);
      await expectDifferential(db, document);
    }
  });

  it("covers direct-referrer sentinel, case folding, Unicode, U+0020/NBSP, NUL, quotes and LIKE metacharacters", async () => {
    await withDatabase(async (db) => {
      const cases = [
        fieldCondition("referrer.domain", "eq", "__direct__"),
        fieldCondition("referrer.domain", "neq", "__direct__"),
        fieldCondition("referrer.domain", "in", ["__direct__", "google.com"]),
        fieldCondition("referrer.domain", "notIn", [
          "__direct__",
          "google.com",
        ]),
        fieldCondition("page.hostname", "eq", "mixed.example.com"),
        fieldCondition("referrer.domain", "eq", "www.google.com"),
        fieldCondition("referrer.url", "eq", "https://example.com/path"),
        fieldCondition("geo.region", "eq", "mixed"),
        fieldCondition("geo.city", "eq", "mixed"),
        fieldCondition("page.path", "eq", "\u00a0needle\u00a0"),
        fieldCondition("page.path", "contains", "needle"),
        fieldCondition("page.path", "contains", "%_\\"),
        fieldCondition(
          "page.title",
          "contains",
          "quote % underscore_ back\\slash",
        ),
        fieldCondition("page.path", "contains", "\u0000needle"),
        fieldCondition("page.title", "eq", "\uFFFD"),
        fieldCondition("page.title", "eq", "café 世界 😀"),
        fieldCondition("page.title", "contains", "世界 😀"),
      ];
      for (const root of cases) {
        await expectDifferential(db, validDocument(root));
      }
      for (const root of [
        fieldCondition("geo.isEU", "eq", false),
        fieldCondition("performance.lcpMs", "eq", 0),
        fieldCondition("performance.lcpMs", "eq", 1),
        fieldCondition("performance.lcpMs", "eq", 2),
        fieldCondition("performance.lcpMs", "gte", 1),
      ]) {
        await expectDifferential(db, validDocument(root));
      }
      expect(
        await expectDifferential(
          db,
          validDocument(fieldCondition("referrer.domain", "eq", "__direct__")),
        ),
      ).toContain("direct-referrer");
    });
  });

  it("pins unsafe REAL numeric scalar/native-set versus JSON-set behavior with fixed SQL", async () => {
    await withDatabase(async (db) => {
      const unsafe = 1000000000000000100;
      const scalar = db
        .prepare(
          "SELECT visit_id FROM visits WHERE perf_lcp_ms = ? ORDER BY visit_id",
        )
        .all(unsafe) as Array<{ visit_id: string }>;
      expect(scalar.map((row) => row.visit_id)).toEqual(["unsafe-real"]);

      const seven = [unsafe, 101, 102, 103, 104, 105, 106];
      const nativeSeven = db
        .prepare(
          `SELECT visit_id FROM visits
           WHERE perf_lcp_ms IN (?, ?, ?, ?, ?, ?, ?)
           ORDER BY visit_id`,
        )
        .all(...seven) as Array<{ visit_id: string }>;
      expect(nativeSeven.map((row) => row.visit_id)).toEqual(["unsafe-real"]);

      const publicSeven = validDocument({
        kind: "or",
        children: seven.map((value) =>
          fieldCondition("performance.lcpMs", "eq", value),
        ),
      });
      expect(
        normalizeFilterDocument(publicSeven, analyticsFilterRegistry).root,
      ).toMatchObject({ kind: "condition", operator: "in" });
      expect(compileFilterDocument(publicSeven).clause).not.toContain(
        "json_each",
      );
      expect(await expectDifferential(db, publicSeven)).toContain(
        "unsafe-real",
      );

      const eight = [...seven, 107];
      const jsonEight = db
        .prepare(
          `SELECT visit_id FROM visits
           WHERE perf_lcp_ms IN (SELECT value FROM json_each(?))
           ORDER BY visit_id`,
        )
        .all(JSON.stringify(eight)) as Array<{ visit_id: string }>;
      expect(jsonEight.map((row) => row.visit_id)).toEqual([]);
      const publicEight = validDocument({
        kind: "or",
        children: eight.map((value) =>
          fieldCondition("performance.lcpMs", "eq", value),
        ),
      });
      expect(
        normalizeFilterDocument(publicEight, analyticsFilterRegistry).root,
      ).toMatchObject({ kind: "condition", operator: "in" });
      expect(compileFilterDocument(publicEight).clause).toContain("json_each");
      expect(await expectDifferential(db, publicEight)).not.toContain(
        "unsafe-real",
      );

      const publicTwo = validDocument({
        kind: "or",
        children: [
          fieldCondition("performance.lcpMs", "eq", unsafe),
          fieldCondition("performance.lcpMs", "eq", 777),
        ],
      });
      expect(
        normalizeFilterDocument(publicTwo, analyticsFilterRegistry).root,
      ).toMatchObject({ kind: "condition", operator: "in" });
      const fixedPublicTwo = db
        .prepare(
          "SELECT visit_id FROM visits WHERE perf_lcp_ms IN (?, ?) ORDER BY visit_id",
        )
        .all(unsafe, 777) as Array<{ visit_id: string }>;
      expect(fixedPublicTwo.map((row) => row.visit_id)).toEqual([
        "unsafe-real",
      ]);
      expect(compileFilterDocument(publicTwo).clause).not.toContain(
        "json_each",
      );
      expect(await expectDifferential(db, publicTwo)).toContain("unsafe-real");
    });
  });

  it("pins native-binding versus JSON decoding for isolated high and low surrogates", async () => {
    await withDatabase(async (db) => {
      const high = "\uD800";
      const low = "\uDC00";
      const nativeHigh = db
        .prepare("SELECT visit_id FROM visits WHERE title = ?")
        .all(high) as Array<{ visit_id: string }>;
      const nativeLow = db
        .prepare("SELECT visit_id FROM visits WHERE title = ?")
        .all(low) as Array<{ visit_id: string }>;
      expect(nativeHigh.map((row) => row.visit_id)).toEqual([
        "surrogate-replacement",
      ]);
      expect(nativeLow.map((row) => row.visit_id)).toEqual([
        "surrogate-replacement",
      ]);

      const jsonHigh = db
        .prepare(
          `SELECT visit_id FROM visits
           WHERE title IN (SELECT value FROM json_each(?))`,
        )
        .all(
          JSON.stringify([high, "a", "b", "c", "d", "e", "f", "g"]),
        ) as Array<{
        visit_id: string;
      }>;
      const jsonLow = db
        .prepare(
          `SELECT visit_id FROM visits
           WHERE title IN (SELECT value FROM json_each(?))`,
        )
        .all(
          JSON.stringify([low, "a", "b", "c", "d", "e", "f", "g"]),
        ) as Array<{
        visit_id: string;
      }>;
      expect(jsonHigh.map((row) => row.visit_id)).toEqual([]);
      expect(jsonLow.map((row) => row.visit_id)).toEqual([]);

      for (const surrogate of [high, low]) {
        const publicTwo = validDocument({
          kind: "or",
          children: [
            fieldCondition("page.title", "eq", surrogate),
            fieldCondition("page.title", "eq", "other"),
          ],
        });
        const normalizedTwo = normalizeFilterDocument(
          publicTwo,
          analyticsFilterRegistry,
        ).root;
        expect(normalizedTwo).toMatchObject({
          kind: "condition",
          operator: "in",
        });
        const fixedNativeTwo = db
          .prepare(
            "SELECT visit_id FROM visits WHERE title IN (?, ?) ORDER BY visit_id",
          )
          .all(surrogate, "other") as Array<{ visit_id: string }>;
        expect(fixedNativeTwo.map((row) => row.visit_id)).toContain(
          "surrogate-replacement",
        );
        expect(compileFilterDocument(publicTwo).clause).not.toContain(
          "json_each",
        );
        expect(await expectDifferential(db, publicTwo)).toContain(
          "surrogate-replacement",
        );

        const publicEight = validDocument({
          kind: "or",
          children: [surrogate, "a", "b", "c", "d", "e", "f", "g"].map(
            (value) => fieldCondition("page.title", "eq", value),
          ),
        });
        const fixedJsonEight = db
          .prepare(
            `SELECT visit_id FROM visits
             WHERE title IN (SELECT value FROM json_each(?))`,
          )
          .all(
            JSON.stringify([surrogate, "a", "b", "c", "d", "e", "f", "g"]),
          ) as Array<{ visit_id: string }>;
        expect(fixedJsonEight.map((row) => row.visit_id)).toEqual([]);
        expect(await expectDifferential(db, publicEight)).not.toContain(
          "surrogate-replacement",
        );
      }
    });
  });

  it("keeps derived traffic, browser engine, OS version and screen size precedence and NULL behavior", async () => {
    await withDatabase(async (db) => {
      for (const [field, operator, value] of [
        ["traffic.channel", "eq", "campaign"],
        ["traffic.channel", "eq", "direct"],
        ["client.browserEngine", "eq", "Blink"],
        ["client.browserEngine", "eq", "WebKit"],
        ["client.browserEngine", "eq", ""],
        ["client.osVersion", "eq", "Linux 6.8"],
        ["client.osVersion", "eq", "15"],
        ["client.osVersion", "eq", "iOS"],
        ["client.screenSize", "eq", "42x42"],
        ["client.screenSize", "eq", ""],
        ["client.screenSize", "notEmpty", undefined],
      ] as const) {
        const document = validDocument(fieldCondition(field, operator, value));
        await expectDifferential(db, document);
      }

      const nullTrafficDependencies = validDocument({
        kind: "or",
        children: [
          fieldCondition("traffic.channel", "eq", "campaign"),
          fieldCondition("traffic.channel", "eq", "direct"),
        ],
      });
      await expectDifferential(db, nullTrafficDependencies);
    });
  });

  it("throws a located lowering error for missing dependencies, non-scalar targets, boundaries and payload", () => {
    const contextWithoutPath: LegacyScalarFilterContext = {
      ...LOWERING_CONTEXT,
      visitColumns: {},
    };
    const pathDocument = validDocument(
      fieldCondition("page.path", "eq", "needle"),
    );
    const captureFailure = (run: () => unknown) => {
      let failure: unknown;
      try {
        run();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LegacyScalarFilterLoweringError);
      const loweringError = failure as LegacyScalarFilterLoweringError;
      expect(loweringError.location).toEqual(expect.any(String));
      expect(loweringError.location.length).toBeGreaterThan(0);
      return loweringError;
    };

    expect(
      captureFailure(() =>
        lowerLegacyScalarFilterDocument(pathDocument, contextWithoutPath),
      ).code,
    ).toBe("missing_dependency");

    const factsOnly = validDocument(fieldCondition("session.views", "eq", 2));
    const contextWithoutFacts: LegacyScalarFilterContext = {
      ...LOWERING_CONTEXT,
      facts: undefined,
    };
    expect(
      captureFailure(() =>
        lowerLegacyScalarFilterDocument(factsOnly, contextWithoutFacts),
      ).code,
    ).toBe("missing_dependency");

    const eventNameOnly = validDocument(
      fieldCondition("event.name", "eq", "purchase"),
    );
    const contextWithoutEventName: LegacyScalarFilterContext = {
      ...LOWERING_CONTEXT,
      eventName: undefined,
    };
    expect(
      captureFailure(() =>
        lowerLegacyScalarFilterDocument(eventNameOnly, contextWithoutEventName),
      ).code,
    ).toBe("missing_dependency");

    const wrongTarget = validDocument({
      kind: "condition",
      target: { kind: "entity-root", entity: "event" },
      operator: "exists",
    });
    const boundary = validDocument(
      fieldCondition("session.entryPath", "eq", "/"),
    );
    const payload = validDocument({
      kind: "condition",
      target: { kind: "event-payload", path: "/sku" },
      operator: "eq",
      value: "A-1",
    });
    for (const document of [wrongTarget, boundary, payload]) {
      expect(
        captureFailure(() =>
          lowerLegacyScalarFilterDocument(document, LOWERING_CONTEXT),
        ).location,
      ).toContain("root");
    }
    const nonFieldLeafFailure = captureFailure(() =>
      lowerLegacyScalarFilterCondition(wrongTarget.root as never, param("x")),
    );
    expect(nonFieldLeafFailure.code).toBe("unsupported_target");
    expect(nonFieldLeafFailure.location).toBe("condition.target.target");

    const normalizedPath = normalizeFilterDocument(
      pathDocument,
      analyticsFilterRegistry,
    ).root;
    if (normalizedPath?.kind !== "condition")
      throw new Error("Expected normalized path condition.");
    const invalidExpressionFailure = captureFailure(() =>
      lowerLegacyScalarFilterCondition(normalizedPath, param(1)),
    );
    expect(invalidExpressionFailure.code).toBe("invalid_expression");
    expect(invalidExpressionFailure.location).toContain("page.path");

    const captureLeafFailure = (
      condition: unknown,
      expression: Parameters<
        typeof lowerLegacyScalarFilterCondition
      >[1] = visitSource.columns.pathname,
    ) =>
      captureFailure(() =>
        lowerLegacyScalarFilterCondition(condition as never, expression),
      );
    expect(
      captureLeafFailure(fieldCondition("missing.field", "eq", "x")).code,
    ).toBe("unsupported_target");
    expect(
      captureLeafFailure(fieldCondition("event.payload", "eq", "x")).code,
    ).toBe("unsupported_target");

    const wrongPathContext: LegacyScalarFilterContext = {
      ...LOWERING_CONTEXT,
      visitColumns: {
        ...LOWERING_CONTEXT.visitColumns,
        pathname: param(1),
      },
    };
    expect(
      captureFailure(() =>
        lowerLegacyScalarFilterDocument(pathDocument, wrongPathContext),
      ).code,
    ).toBe("unsupported_strategy");

    const missingScreenContext: LegacyScalarFilterContext = {
      ...LOWERING_CONTEXT,
      visitColumns: { pathname: visitSource.columns.pathname },
    };
    expect(
      captureFailure(() =>
        lowerLegacyScalarFilterDocument(
          validDocument(fieldCondition("client.screenSize", "eq", "1x1")),
          missingScreenContext,
        ),
      ).code,
    ).toBe("missing_dependency");

    const invalidConditions: Array<
      [unknown, Parameters<typeof lowerLegacyScalarFilterCondition>[1]?]
    > = [
      [fieldCondition("page.path", "eq")],
      [{ ...fieldCondition("page.path", "eq", "x"), value: null }],
      [fieldCondition("geo.isEU", "eq", "true"), visitSource.columns.is_eu],
      [fieldCondition("page.path", "in", [])],
      [fieldCondition("page.path", "between", [1, 2])],
      [fieldCondition("page.path", "contains", 1)],
      [fieldCondition("page.path", "eq", 1)],
      [{ ...fieldCondition("page.path", "eq", "x"), operator: "unknown" }],
      [
        fieldCondition("performance.lcpMs", "eq", Number.POSITIVE_INFINITY),
        visitSource.columns.perf_lcp_ms,
      ],
    ];
    for (const [invalidCondition, expression] of invalidConditions) {
      expect(captureLeafFailure(invalidCondition, expression).code).toBe(
        "unsupported_value",
      );
    }
  });
});
