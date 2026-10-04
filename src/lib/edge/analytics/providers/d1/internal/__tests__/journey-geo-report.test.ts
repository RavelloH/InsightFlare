import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
} from "@/lib/analytics/geo-location";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type {
  GeoPointAggregate,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryGeoPointsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-geo-queries";
import { mapGeoPointRow } from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE = "wave52-geo-site";
const OTHER_SITE = "wave52-geo-other-site";
const WINDOW: QueryWindow = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 500,
  timeZone: "UTC",
};
const OPERATION = "site_journeys.geo_points";

interface Site {
  readonly id: string;
  readonly pk: number;
}

interface GeoFixture {
  readonly id: string;
  readonly site: Site;
  readonly session: string;
  readonly visitor: string;
  readonly time: number;
  readonly latitude?: number | string | null;
  readonly longitude?: number | string | null;
  readonly country?: string | null;
  readonly region?: string | null;
  readonly regionCode?: string | null;
  readonly city?: string | null;
}

let db: DatabaseSync;
let site: Site;
let otherSite: Site;

function addSite(database: DatabaseSync, id: string): Site {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: Number(row.site_pk) };
}

function addVisit(database: DatabaseSync, fixture: GeoFixture): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, latitude, longitude,
        country, region, region_code, city
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, '/geo', 'wave52.test', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      fixture.site.id,
      fixture.site.pk,
      fixture.visitor,
      fixture.session,
      fixture.time,
      fixture.time,
      fixture.latitude ?? null,
      fixture.longitude ?? null,
      fixture.country === undefined ? "" : fixture.country,
      fixture.region === undefined ? "" : fixture.region,
      fixture.regionCode === undefined ? "" : fixture.regionCode,
      fixture.city === undefined ? "" : fixture.city,
    );
}

function sqliteEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

function filters(
  conditions: readonly { readonly field: string; readonly value: string }[],
): FilterDocument {
  const root =
    conditions.length === 0
      ? null
      : conditions.length === 1
        ? {
            kind: "condition" as const,
            target: {
              kind: "field" as const,
              field: conditions[0]!.field,
            },
            operator: "eq" as const,
            value: conditions[0]!.value,
          }
        : {
            kind: "and" as const,
            children: conditions.map(({ field, value }) => ({
              kind: "condition" as const,
              target: { kind: "field" as const, field },
              operator: "eq" as const,
              value,
            })),
          };
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function legacyAggregate(
  document: FilterDocument,
  limit: number,
  window: QueryWindow = WINDOW,
  identityFilter?: {
    readonly column: "visit_id" | "session_id" | "visitor_id";
    readonly ids: readonly string[];
  },
): GeoPointAggregate {
  const filter = buildVisitFilterSql(document, "v", { window });
  const filterPredicate = filter.clause.replace(/^WHERE\s+/iu, "");
  const where = [
    "v.site_pk = ?",
    "v.started_at >= ?",
    "v.started_at < ?",
    ...(filter.clause ? [filterPredicate] : []),
    ...(identityFilter
      ? identityFilter.ids.length > 0
        ? [
            `v.${identityFilter.column} IN (${identityFilter.ids.map(() => "?").join(", ")})`,
          ]
        : ["0"]
      : []),
  ].join(" AND ");
  const sourceBindings = [
    site.pk,
    window.startMs,
    window.endExclusiveMs,
    ...filter.bindings,
    ...(identityFilter?.ids ?? []),
  ];
  const points = db
    .prepare(
      `SELECT
         ROUND(v.latitude, 3) AS latitude,
         ROUND(v.longitude, 3) AS longitude,
         MAX(v.started_at) AS timestampMs,
         v.country AS country,
         v.region AS region,
         v.region_code AS regionCode,
         v.city AS city,
         COUNT(*) AS pointCount
       FROM visits v
       WHERE ${where}
         AND v.latitude IS NOT NULL
         AND v.longitude IS NOT NULL
         AND ABS(v.latitude) <= 90
         AND ABS(v.longitude) <= 180
       GROUP BY ROUND(v.latitude, 3), ROUND(v.longitude, 3),
         v.country, v.region, v.region_code, v.city
       ORDER BY timestampMs DESC
       LIMIT ?`,
    )
    .all(...sourceBindings, limit) as Record<string, unknown>[];
  const aggregateSql = (whereClause: string) =>
    `COUNT(*) AS views,
     COUNT(DISTINCT CASE WHEN v.session_id != '' THEN v.session_id ELSE NULL END) AS sessions,
     COUNT(DISTINCT CASE WHEN v.visitor_id != '' THEN v.visitor_id ELSE NULL END) AS visitors
     FROM visits v WHERE ${where} ${whereClause}`;
  const conditions =
    document.root?.kind === "and"
      ? document.root.children
      : [document.root].filter(Boolean);
  const valueFor = (field: string) => {
    const condition = conditions.find(
      (item) =>
        item?.kind === "condition" &&
        item.target.kind === "field" &&
        item.target.field === field &&
        item.operator === "eq" &&
        typeof item.value === "string",
    );
    return condition?.kind === "condition" &&
      typeof condition.value === "string"
      ? condition.value
      : undefined;
  };
  const country = valueFor("geo.country");
  const regionCode = valueFor("geo.region");

  if (!country) {
    const rows = db
      .prepare(
        `SELECT v.country AS country, ${aggregateSql("")}
         GROUP BY v.country
         ORDER BY views DESC, sessions DESC, country ASC
         LIMIT 300`,
      )
      .all(...sourceBindings) as Record<string, unknown>[];
    return {
      points: points.map(mapGeoPointRow),
      countryCounts: rows.map((row) => ({
        country: String(row.country ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      })),
      regionCounts: [],
      cityCounts: [],
    };
  }
  if (!regionCode) {
    const rows = db
      .prepare(
        `SELECT v.country AS country, v.region_code AS regionCode,
                v.region AS region, ${aggregateSql("AND TRIM(COALESCE(v.country, '')) != '' AND (TRIM(COALESCE(v.region_code, '')) != '' OR TRIM(COALESCE(v.region, '')) != '')")}
         GROUP BY v.country, v.region_code, v.region
         ORDER BY views DESC, sessions DESC, region ASC, regionCode ASC
         LIMIT 400`,
      )
      .all(...sourceBindings) as Record<string, unknown>[];
    return {
      points: points.map(mapGeoPointRow),
      countryCounts: [],
      regionCounts: rows
        .map((row) => {
          const normalizedCountry = String(row.country ?? "")
            .trim()
            .toUpperCase();
          const region = String(row.regionCode ?? "")
            .trim()
            .toUpperCase();
          const regionName = String(row.region ?? "").trim() || region;
          const value = buildRegionLocationValue(
            normalizedCountry,
            region || regionName,
            regionName || region,
          );
          return value
            ? {
                value,
                label: regionName || region,
                views: Number(row.views ?? 0),
                sessions: Number(row.sessions ?? 0),
                visitors: Number(row.visitors ?? 0),
              }
            : null;
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
      cityCounts: [],
    };
  }
  const rows = db
    .prepare(
      `SELECT v.country AS country, v.region_code AS regionCode,
              v.region AS region, v.city AS city, ${aggregateSql("AND TRIM(COALESCE(v.country, '')) != '' AND TRIM(COALESCE(v.city, '')) != ''")}
       GROUP BY v.country, v.region_code, v.region, v.city
       ORDER BY views DESC, sessions DESC, city ASC
       LIMIT 600`,
    )
    .all(...sourceBindings) as Record<string, unknown>[];
  return {
    points: points.map(mapGeoPointRow),
    countryCounts: [],
    regionCounts: [],
    cityCounts: rows
      .map((row) => {
        const normalizedCountry = String(row.country ?? "")
          .trim()
          .toUpperCase();
        const region = String(row.regionCode ?? "")
          .trim()
          .toUpperCase();
        const regionName = String(row.region ?? "").trim() || region;
        const city = String(row.city ?? "").trim();
        const value = buildLocalityLocationValue(
          normalizedCountry,
          region || null,
          regionName || null,
          city,
        );
        return value && city
          ? {
              value,
              label: city,
              views: Number(row.views ?? 0),
              sessions: Number(row.sessions ?? 0),
              visitors: Number(row.visitors ?? 0),
            }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row)),
  };
}

function sortedPoints(points: GeoPointAggregate["points"]) {
  return [...points].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function addFixtureData(database: DatabaseSync): void {
  const rows: Omit<GeoFixture, "site">[] = [
    {
      id: "geo-sf-1",
      session: "s1",
      visitor: "v1",
      time: 110,
      latitude: 1.2345,
      longitude: -2.3455,
      country: "US",
      region: "California",
      regionCode: "CA",
      city: "San Francisco",
    },
    {
      id: "geo-sf-2",
      session: "s1",
      visitor: "v1",
      time: 120,
      latitude: 1.2345,
      longitude: -2.3455,
      country: "US",
      region: "California",
      regionCode: "CA",
      city: "San Francisco",
    },
    {
      id: "geo-negative-half",
      session: "s2",
      visitor: "v2",
      time: 125,
      latitude: -1.2345,
      longitude: -2.3455,
      country: "US",
      region: "California",
      regionCode: "CA",
      city: "San Francisco",
    },
    {
      id: "geo-boundary",
      session: "s3",
      visitor: "v3",
      time: 126,
      latitude: 0,
      longitude: 180,
      country: "US",
      region: "California",
      regionCode: "CA",
      city: "Boundary",
    },
    {
      id: "geo-out-of-range",
      session: "s4",
      visitor: "v4",
      time: 127,
      latitude: 91,
      longitude: 0,
      country: "US",
      region: "California",
      regionCode: "CA",
      city: "Outlier",
    },
    {
      id: "geo-null-coordinate",
      session: "",
      visitor: "",
      time: 128,
      latitude: null,
      longitude: 1,
      country: "US",
      region: "California",
      regionCode: "CA",
      city: "No coordinates",
    },
    {
      id: "geo-west-fallback",
      session: "s5",
      visitor: "v5",
      time: 129,
      latitude: 45,
      longitude: 90,
      country: "US",
      region: "West",
      regionCode: "",
      city: "Twin",
    },
    {
      id: "geo-ny-fallback",
      session: "s6",
      visitor: "v6",
      time: 130,
      latitude: -90,
      longitude: -180,
      country: "US",
      region: "",
      regionCode: "NY",
      city: "Albany",
    },
    {
      id: "geo-north-boundary",
      session: "s6b",
      visitor: "v6b",
      time: 138,
      latitude: 90,
      longitude: -180,
      country: "US",
      region: "",
      regionCode: "NY",
      city: "Syracuse",
    },
    {
      id: "geo-longitude-out-of-range",
      session: "s4b",
      visitor: "v4b",
      time: 139,
      latitude: 1,
      longitude: 181,
      country: "US",
      region: "California",
      regionCode: "CA",
      city: "Longitude outlier",
    },
    {
      id: "geo-tab-whitespace",
      session: "s7",
      visitor: "v7",
      time: 131,
      latitude: 2,
      longitude: 3,
      country: " \t ",
      region: " \t ",
      regionCode: "",
      city: "\t",
    },
    {
      id: "geo-nbsp",
      session: "s8",
      visitor: "v8",
      time: 132,
      latitude: 4,
      longitude: 5,
      country: "\u00a0",
      region: "North",
      regionCode: "N",
      city: "\u00a0",
    },
    {
      id: "geo-empty-country",
      session: "",
      visitor: "",
      time: 133,
      latitude: 6,
      longitude: 7,
      country: "",
      region: "",
      regionCode: "",
      city: "",
    },
    {
      id: "geo-lowercase",
      session: "s9",
      visitor: "v9",
      time: 134,
      latitude: 8,
      longitude: 9,
      country: "us",
      region: "california",
      regionCode: "ca",
      city: "San Francisco",
    },
    {
      id: "geo-canada-a",
      session: "c1",
      visitor: "cv1",
      time: 135,
      latitude: 10,
      longitude: 11,
      country: "CA",
      region: "Ontario",
      regionCode: "ON",
      city: "Toronto",
    },
    {
      id: "geo-canada-b",
      session: "c1",
      visitor: "cv1",
      time: 136,
      latitude: 10.1,
      longitude: 11.1,
      country: "CA",
      region: "Ontario",
      regionCode: "ON",
      city: "Toronto",
    },
  ];
  for (const row of rows) addVisit(database, { ...row, site });
  addVisit(database, {
    id: "geo-other-site",
    site: otherSite,
    session: "foreign",
    visitor: "foreign",
    time: 112,
    latitude: 1.23451,
    longitude: -2.34551,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
  });
  addVisit(database, {
    id: "geo-before-window",
    site,
    session: "s1",
    visitor: "v1",
    time: 99,
    latitude: 1.23451,
    longitude: -2.34551,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
  });
  addVisit(database, {
    id: "geo-at-window-end",
    site,
    session: "s1",
    visitor: "v1",
    time: 200,
    latitude: 1.23451,
    longitude: -2.34551,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
  });
}

function prepareFilters(
  document: FilterDocument,
  scopePreference: "event" | "session" | "visitor",
): { readonly filters: FilterDocument; readonly scopePlan: ScopedFilterPlan } {
  const prepared = prepareScopedQuery("geo-points", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: createQueryTime(90, 210, "UTC", WINDOW.nowMs),
    filters: document,
    scopePreference,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("wave52_prepared_page_scope_missing");
  return { filters: prepared.filters, scopePlan: prepared.scopePlan };
}

function attachAdvancedMatches(
  prepared: {
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  },
  advancedMatches: NonNullable<ScopedFilterPlan["advancedMatches"]>,
): FilterDocument {
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave52_prepared_metadata_missing");
  const plan = { ...prepared.scopePlan, advancedMatches };
  return attachScopedFilterMetadata(prepared.filters, { ...metadata, plan });
}

beforeAll(() => {
  db = createMigratedDatabase();
  site = addSite(db, SITE);
  otherSite = addSite(db, OTHER_SITE);
  addFixtureData(db);
});

afterAll(() => db.close());

describe("Journey Geo Page report D1 migration", () => {
  it("matches legacy SQLite points and each selected summary rollup", async () => {
    const cases = [
      { filters: filters([]), summary: "country" },
      {
        filters: filters([{ field: "geo.country", value: "US" }]),
        summary: "region",
      },
      {
        filters: filters([
          { field: "geo.country", value: "US" },
          { field: "geo.region", value: "California" },
        ]),
        summary: "city",
      },
    ] as const;
    for (const { filters: document, summary } of cases) {
      const expected = legacyAggregate(document, 500);
      const actual = await queryGeoPointsFromD1(
        sqliteEnv(db),
        SITE,
        WINDOW,
        document,
        500,
      );
      expect(sortedPoints(actual.points)).toEqual(
        sortedPoints(expected.points),
      );
      expect(actual.points.map((point) => point.timestampMs)).toEqual(
        [...actual.points.map((point) => point.timestampMs)].sort(
          (left, right) => right - left,
        ),
      );
      expect(actual.countryCounts).toEqual(expected.countryCounts);
      expect(actual.regionCounts).toEqual(expected.regionCounts);
      expect(actual.cityCounts).toEqual(expected.cityCounts);
      expect(actual[`${summary}Counts`]).toHaveLength(
        expected[`${summary}Counts`].length,
      );
    }
  });

  it("keeps nested filter branch detection shallow and still reads both outputs", async () => {
    const country = {
      kind: "condition" as const,
      target: { kind: "field" as const, field: "geo.country" },
      operator: "eq" as const,
      value: "US",
    };
    const nested = normalizeFilterDocument(
      { version: 1, root: { kind: "not", child: country } },
      analyticsFilterRegistry,
    );
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const actual = await queryGeoPointsFromD1(
      sqliteEnv(db, trace),
      SITE,
      WINDOW,
      nested,
      20,
    );
    expect(actual.countryCounts.length).toBeGreaterThan(0);
    expect(actual.regionCounts).toEqual([]);
    expect(actual.cityCounts).toEqual([]);
    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.bindings[0]).toContain(20);
  });

  it("keeps zero and negative limits compatible while running the selected summary", async () => {
    for (const limit of [0, 1, -1]) {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const actual = await queryGeoPointsFromD1(
        sqliteEnv(db, trace),
        SITE,
        WINDOW,
        filters([]),
        limit,
      );
      const expected = legacyAggregate(filters([]), limit);
      expect(sortedPoints(actual.points)).toEqual(
        sortedPoints(expected.points),
      );
      expect(actual.countryCounts).toEqual(expected.countryCounts);
      expect(trace.preparedSql).toHaveLength(2);
      if (limit === 0) {
        expect(trace.bindings[0]).toContain(0);
        expect(actual.points).toEqual([]);
      } else {
        expect(trace.bindings[0]).not.toContain(-1);
        expect(actual.points.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses the actual reader window for prepared Page scopes", async () => {
    const document = filters([{ field: "geo.country", value: "US" }]);
    const prepared = prepareFilters(document, "event");
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const diagnostics = createD1ReadDiagnostics();
    const actual = await runWithInvocationLogger(logger, () =>
      runWithD1Operation(OPERATION, () =>
        queryGeoPointsFromD1(
          instrumentEnv(sqliteEnv(db, trace), logger),
          SITE,
          WINDOW,
          prepared.filters,
          500,
          diagnostics,
        ),
      ),
    );
    const expected = legacyAggregate(prepared.filters, 500, WINDOW);
    expect(sortedPoints(actual.points)).toEqual(sortedPoints(expected.points));
    expect(actual.regionCounts).toEqual(expected.regionCounts);
    expect(trace.preparedSql).toHaveLength(2);
    const record = await logger.emitWhenComplete();
    const observations = record.logs.filter((entry) =>
      entry.message.startsWith("db.query.v1.all.success"),
    );
    expect(observations).toHaveLength(2);
    for (const [index, sql] of trace.preparedSql.entries()) {
      const sqlBytes = new TextEncoder().encode(sql).byteLength;
      const bindings = trace.bindings[index]!.length;
      expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(observations[index]!.data).toMatchObject({
        tag: OPERATION,
        operation: "all",
        status: "success",
        sqlBytes,
        bindings,
        physicalPlanHash: expect.stringMatching(/^v\d+:/u),
      });
    }
    expect(diagnostics.rowsReadAvailable).toBe(false);
  });

  it("preserves prepared Page identities and bounds a 128-identity read", async () => {
    const document = filters([{ field: "geo.country", value: "US" }]);
    const prepared = prepareFilters(document, "event");
    const pageIds = [
      "geo-sf-1",
      ...Array.from(
        { length: 127 },
        (_unused, index) => `missing-page-${index}`,
      ),
    ];
    const eventId = "missing-event-for-page-source";
    const pageScopedFilters = attachAdvancedMatches(prepared, {
      visitIds: pageIds.map((id) => ({ siteId: SITE, id })),
      eventIds: [{ siteId: SITE, id: eventId }],
    });
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const diagnostics = createD1ReadDiagnostics();
    const actual = await runWithInvocationLogger(logger, () =>
      runWithD1Operation(OPERATION, () =>
        queryGeoPointsFromD1(
          instrumentEnv(sqliteEnv(db, trace), logger),
          SITE,
          WINDOW,
          pageScopedFilters,
          500,
          diagnostics,
        ),
      ),
    );
    const expected = legacyAggregate(document, 500, WINDOW, {
      column: "visit_id",
      ids: pageIds,
    });
    expect(sortedPoints(actual.points)).toEqual(sortedPoints(expected.points));
    expect(actual.regionCounts).toEqual(expected.regionCounts);
    expect(trace.preparedSql).toHaveLength(2);
    const record = await logger.emitWhenComplete();
    const observations = record.logs.filter((entry) =>
      entry.message.startsWith("db.query.v1.all.success"),
    );
    expect(observations).toHaveLength(2);
    for (const [index, sql] of trace.preparedSql.entries()) {
      expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(trace.bindings[index]!.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(observations[index]!.data).toMatchObject({
        tag: OPERATION,
        operation: "all",
        status: "success",
        sqlBytes: new TextEncoder().encode(sql).byteLength,
        bindings: trace.bindings[index]!.length,
        physicalPlanHash: expect.stringMatching(/^v\d+:/u),
      });
    }
    expect(diagnostics.rowsReadAvailable).toBe(false);
  });

  it("retains prepared Session and Visitor identity membership, including empty sets", async () => {
    const document = filters([{ field: "geo.country", value: "US" }]);
    for (const scope of ["session", "visitor"] as const) {
      const prepared = prepareFilters(document, scope);
      const id = scope === "session" ? "s1" : "v1";
      const scopedFilters = attachAdvancedMatches(prepared, {
        entityIds: [{ siteId: SITE, id }],
      });
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const actual = await queryGeoPointsFromD1(
        sqliteEnv(db, trace),
        SITE,
        WINDOW,
        scopedFilters,
        500,
      );
      const expected = legacyAggregate(document, 500, WINDOW, {
        column: scope === "session" ? "session_id" : "visitor_id",
        ids: [id],
      });
      expect(sortedPoints(actual.points)).toEqual(
        sortedPoints(expected.points),
      );
      expect(actual.regionCounts).toEqual(expected.regionCounts);
      expect(trace.preparedSql).toHaveLength(2);

      const emptySet = attachAdvancedMatches(prepared, { entityIds: [] });
      const emptyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const emptyActual = await queryGeoPointsFromD1(
        sqliteEnv(db, emptyTrace),
        SITE,
        WINDOW,
        emptySet,
        500,
      );
      expect(emptyActual.points).toEqual([]);
      expect(emptyActual.regionCounts).toEqual([]);
      expect(emptyTrace.preparedSql).toHaveLength(2);
    }
  });

  it("records two tagged, budget-bounded public reads for plain and 40-payload inputs", async () => {
    const plain = filters([]);
    const fortyPayload = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: Array.from({ length: 40 }, (_unused, index) => ({
            kind: "condition" as const,
            target: {
              kind: "event-payload" as const,
              path: `/field-${index}`,
            },
            operator: "eq" as const,
            value: `value-${index}`,
          })),
        },
      },
      analyticsFilterRegistry,
    );
    const fortyPageIds = [
      "geo-sf-1",
      ...Array.from(
        { length: 39 },
        (_unused, index) => `missing-payload-page-${index}`,
      ),
    ];
    const preparedPayload = prepareFilters(fortyPayload, "event");
    const preparedFortyPayload = attachAdvancedMatches(preparedPayload, {
      visitIds: fortyPageIds.map((id) => ({ siteId: SITE, id })),
      eventIds: [],
    });
    for (const [label, document] of [
      ["plain", plain],
      ["forty-payload", preparedFortyPayload],
    ] as const) {
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const logger = createInvocationLogger({
        source: "worker",
        trigger: "request",
      });
      const diagnostics = createD1ReadDiagnostics();
      const actual = await runWithInvocationLogger(logger, () =>
        runWithD1Operation(OPERATION, () =>
          queryGeoPointsFromD1(
            instrumentEnv(sqliteEnv(db, trace), logger),
            SITE,
            WINDOW,
            document,
            100,
            diagnostics,
          ),
        ),
      );
      if (label === "forty-payload") {
        const expected = legacyAggregate(plain, 100, WINDOW, {
          column: "visit_id",
          ids: fortyPageIds,
        });
        expect(sortedPoints(actual.points)).toEqual(
          sortedPoints(expected.points),
        );
        expect(actual.countryCounts).toEqual(expected.countryCounts);
      }
      const record = await logger.emitWhenComplete();
      expect(trace.preparedSql).toHaveLength(2);
      expect(trace.bindings).toHaveLength(2);
      expect(
        trace.preparedSql.map(
          (sql) => new TextEncoder().encode(sql).byteLength,
        ),
      ).toEqual(
        expect.arrayContaining([expect.any(Number), expect.any(Number)]),
      );
      for (const [index, sql] of trace.preparedSql.entries()) {
        expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(
          D1_MAX_SQL_UTF8_BYTES,
        );
        expect(trace.bindings[index]!.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      }
      const observations = record.logs.filter((entry) =>
        entry.message.startsWith("db.query.v1.all.success"),
      );
      expect(observations).toHaveLength(2);
      for (const [index, entry] of observations.entries()) {
        expect(entry.data).toMatchObject({
          tag: OPERATION,
          operation: "all",
          status: "success",
          sqlBytes: new TextEncoder().encode(trace.preparedSql[index]!)
            .byteLength,
          bindings: trace.bindings[index]!.length,
          physicalPlanHash: expect.stringMatching(/^v\d+:/u),
        });
      }
      expect(diagnostics.rowsReadAvailable).toBe(false);
      // Keep the label in assertion diagnostics when a budget regresses.
      expect(
        trace.preparedSql.map((sql) => sql.length),
        label,
      ).toHaveLength(2);
    }
  });

  it("keeps single-output arrays empty in the two-statement response", async () => {
    const country = await queryGeoPointsFromD1(
      sqliteEnv(db),
      SITE,
      WINDOW,
      filters([]),
      500,
    );
    expect(country.regionCounts).toEqual([]);
    expect(country.cityCounts).toEqual([]);
  });
});
