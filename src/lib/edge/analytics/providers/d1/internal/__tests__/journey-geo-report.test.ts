import type { DatabaseSync, SQLInputValue } from "node:sqlite";

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
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  attachScopedFilterMetadata,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import { buildJourneyGeoPointsQualificationPlan } from "@/lib/edge/analytics/engine/journey-geo-report-plan";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-filters";
import {
  buildVisitSourceCte,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import {
  classifyAdvancedCountFilter,
  classifyAdvancedEventCandidateCountFilter,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-support";
import {
  d1AdvancedFilterMiddleware,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createRegisteredComparisonAdmissionBinding } from "@/lib/edge/analytics/providers/d1/internal/comparison-domain-admission";
import type {
  GeoPointAggregate,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { compileGeoPointsQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-program";
import { executeGeoPointsQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-program";
import {
  deferredGeoPointsQualificationFromQuery,
  geoPointsLimitFromQuery,
  geoPointsQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/geo-points-qualification-request";
import { queryGeoPointsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-geo-queries";
import { mapGeoPointRow } from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeOrderingDescriptor,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
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
  readonly pathname?: string;
}

interface CapturedSqlStatement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

interface CapturedD1AllResult extends CapturedSqlStatement {
  readonly result: unknown;
}

let db: DatabaseSync;
let site: Site;
let otherSite: Site;

function addSite(database: DatabaseSync, id: string): Site {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97i-geo-team', 'Geo qualification', 'geo.test', 0)`,
    )
    .run(id);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: Number(row.site_pk) };
}

function addGeoQualificationEvent(database: DatabaseSync): void {
  const name = "wave97i-geo-qualifier";
  database
    .prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    )
    .run(SITE, name, 140, site.pk);
  const eventName = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.pk, name) as { readonly id: number };
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, 'geo-sf-1', ?, 140, 140, 1, 0, 0)`,
    )
    .run("wave97i-geo-qualifier-event", SITE, site.pk, eventName.id);
}

function withGeoQualificationEvent(run: () => Promise<void>): Promise<void> {
  const database = db;
  const sequenceTableExists = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
    )
    .get();
  const sequences = sequenceTableExists
    ? (database
        .prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN (?, ?)")
        .all("custom_event_names", "custom_events") as Array<{
        readonly name: string;
        readonly seq: number;
      }>)
    : [];
  addGeoQualificationEvent(database);
  return run().finally(() => {
    database
      .prepare(
        `DELETE FROM custom_events
         WHERE event_name_id = (
           SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?
         )`,
      )
      .run(site.pk, "wave97i-geo-qualifier");
    database
      .prepare("DELETE FROM custom_event_names WHERE site_pk = ? AND name = ?")
      .run(site.pk, "wave97i-geo-qualifier");
    if (sequenceTableExists) {
      database
        .prepare("DELETE FROM sqlite_sequence WHERE name IN (?, ?)")
        .run("custom_event_names", "custom_events");
      for (const row of sequences)
        database
          .prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)")
          .run(row.name, row.seq);
    }
  });
}

function itWithGeoQualificationEvent(
  name: string,
  run: () => Promise<void>,
): void {
  it(name, () => withGeoQualificationEvent(run));
}

function addGeoQualificationEventForVisit(
  database: DatabaseSync,
  visitId: string,
  eventId: string,
): void {
  const eventName = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.pk, "wave97i-geo-qualifier") as { readonly id: number };
  database
    .prepare(
      "INSERT INTO custom_events (" +
        "event_id, site_id, site_pk, visit_id, event_name_id, occurred_at, " +
        "received_at, sequence, node_count, value_count" +
        ") VALUES (?, ?, ?, ?, ?, 140, 140, 1, 0, 0)",
    )
    .run(eventId, SITE, site.pk, visitId, eventName.id);
}

function addVisit(database: DatabaseSync, fixture: GeoFixture): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, latitude, longitude,
        country, region, region_code, city
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'wave52.test', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      fixture.site.id,
      fixture.site.pk,
      fixture.visitor,
      fixture.session,
      fixture.time,
      fixture.time,
      fixture.pathname ?? "/geo",
      fixture.latitude ?? null,
      fixture.longitude ?? null,
      fixture.country === undefined ? "" : fixture.country,
      fixture.region === undefined ? "" : fixture.region,
      fixture.regionCode === undefined ? "" : fixture.regionCode,
      fixture.city === undefined ? "" : fixture.city,
    );
}

function captureD1AllResults(
  database: ReturnType<typeof createSqliteD1Database>,
  capture: (read: CapturedD1AllResult) => void,
): ReturnType<typeof createSqliteD1Database> {
  const basePrepare = database.prepare.bind(database);
  return new Proxy(database, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = basePrepare(sql) as object;
        let bindings: readonly unknown[] = [];
        const wrapped = new Proxy(statement, {
          get(prepared, method) {
            const value = Reflect.get(prepared, method, prepared) as unknown;
            if (method === "bind" && typeof value === "function")
              return (...args: unknown[]) => {
                bindings = [...args];
                Reflect.apply(value, prepared, args);
                return wrapped;
              };
            if (method === "all" && typeof value === "function")
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(value, prepared, args);
                capture({ sql, bindings, result });
                return result;
              };
            return typeof value === "function" ? value.bind(prepared) : value;
          },
        });
        return wrapped;
      };
    },
  });
}

function sqliteEnv(
  database: DatabaseSync,
  trace?: SqliteD1Trace,
  captureAllResult?: (read: CapturedD1AllResult) => void,
): Env {
  const sqliteDatabase = createSqliteD1Database(database, trace);
  return {
    DB: captureAllResult
      ? captureD1AllResults(sqliteDatabase, captureAllResult)
      : sqliteDatabase,
  } as unknown as Env;
}

function geoStatementClass(sql: string, compiledSql: string): string {
  if (sql === compiledSql) return "fact-envelope";
  if (
    /\b(?:FROM|JOIN)\s+["`]?sites["`]?\b/i.test(sql) &&
    !/\b(?:visits|custom_events)\b/i.test(sql)
  )
    return "site-metadata";
  if (/\b(?:visits|custom_events|custom_event_names)\b/i.test(sql))
    return "legacy-fallback-fact";
  return "other";
}

function geoStatementEvidence(trace: SqliteD1Trace, compiledSql: string) {
  return trace.preparedSql.map((sql, index) => ({
    statementClass: geoStatementClass(sql, compiledSql),
    sql,
    bindings: trace.bindings[index] ?? [],
  }));
}

function capturedRows(
  read: CapturedD1AllResult,
): readonly Record<string, unknown>[] {
  if (
    !read.result ||
    typeof read.result !== "object" ||
    Array.isArray(read.result) ||
    !("results" in read.result) ||
    !Array.isArray(read.result.results)
  )
    throw new Error("wave97dw_geo_captured_rows_invalid");
  return read.result.results.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("wave97dw_geo_captured_row_invalid");
    return row as Record<string, unknown>;
  });
}

async function writeGeoEvidence(
  name: string,
  evidence: unknown,
): Promise<void> {
  const evidenceDirectory = process.env.WAVE97DW_GEO_EVIDENCE_DIR;
  if (!evidenceDirectory) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    join(evidenceDirectory, name),
    JSON.stringify(evidence, null, 2),
    "utf8",
  );
}

function capturedSqlEnv(statements: CapturedSqlStatement[]): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => ({
          all: async () => {
            statements.push({ sql, bindings });
            return { results: [] };
          },
        }),
      }),
    },
  } as unknown as Env;
}

function addDirectPayloadEvents(database: DatabaseSync): void {
  const eventTime = WINDOW.startMs + 40;
  database
    .prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    )
    .run(SITE, "wave52-direct-payload", eventTime, site.pk);
  const eventName = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.pk, "wave52-direct-payload") as { readonly id: number };
  const paths = Array.from({ length: 40 }, (_unused, index) => {
    const path = `/field-${index}`;
    database
      .prepare(
        "INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(SITE, site.pk, path, eventTime);
    const pathRow = database
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(site.pk, path) as { readonly id: number };
    return { pathId: Number(pathRow.id), value: `value-${index}` };
  });
  const events = [
    { eventId: "wave52-direct-40-match", visitId: "geo-sf-1", pathCount: 40 },
    {
      eventId: "wave52-direct-40-partial",
      visitId: "geo-sf-2",
      pathCount: 39,
    },
  ] as const;
  const insertEvent = database.prepare(`
    INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const insertNode = database.prepare(`
    INSERT INTO custom_event_json_nodes (
      event_pk, node_id, path_id, value_type, depth
    ) VALUES (?, ?, ?, 1, 1)
  `);
  const insertValue = database.prepare(`
    INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, site_pk, event_name_id, path_id,
      occurred_at, value_type, string_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  for (const event of events) {
    insertEvent.run(
      event.eventId,
      SITE,
      site.pk,
      event.visitId,
      eventName.id,
      eventTime,
      eventTime,
      event.pathCount,
      event.pathCount,
    );
    const eventRow = database
      .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
      .get(event.eventId) as { readonly event_pk: number };
    for (const [index, path] of paths.slice(0, event.pathCount).entries()) {
      const nodeId = index + 1;
      insertNode.run(eventRow.event_pk, nodeId, path.pathId);
      insertValue.run(
        eventRow.event_pk,
        nodeId,
        SITE,
        site.pk,
        eventName.id,
        path.pathId,
        eventTime,
        path.value,
      );
    }
  }
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

function legacyParentCountryAggregate(
  document: FilterDocument,
  limit: number,
  window: QueryWindow,
  statementObserver: (statement: CapturedSqlStatement) => void,
): GeoPointAggregate {
  const filter = buildVisitFilterSql(document, "visit_source", { window });
  const coordinateClause = filter.clause ? "AND" : "WHERE";
  const pointsSql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    ROUND(latitude, 3) AS lat_bucket,
    ROUND(longitude, 3) AS lon_bucket,
    country,
    region,
    region_code AS regionCode,
    city,
    MAX(started_at) AS latest_at,
    COUNT(*) AS point_count
  FROM visit_source
  ${filter.clause}
  ${coordinateClause}
    latitude IS NOT NULL
    AND longitude IS NOT NULL
    AND ABS(latitude) <= 90
    AND ABS(longitude) <= 180
  GROUP BY lat_bucket, lon_bucket, country, region, region_code, city
)
SELECT
  lat_bucket AS latitude,
  lon_bucket AS longitude,
  latest_at AS timestampMs,
  country,
  region,
  regionCode,
  city,
  point_count AS pointCount
FROM filtered_visits
ORDER BY timestampMs DESC
LIMIT ?
`;
  const countrySql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    country,
    session_id AS sessionId,
    visitor_id AS visitorId
  FROM visit_source
  ${filter.clause}
)
SELECT
  country,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
FROM filtered_visits
GROUP BY country
ORDER BY views DESC, sessions DESC, country ASC
LIMIT 300
`;
  const sourceBindings = [
    ...visitSourceBindings(SITE, window),
    ...filter.bindings,
  ];
  const queryRows = (sql: string, bindings: readonly (string | number)[]) => {
    statementObserver({ sql, bindings });
    return db.prepare(sql).all(...bindings) as Record<string, unknown>[];
  };
  const points = queryRows(pointsSql, [...sourceBindings, limit]).map(
    mapGeoPointRow,
  );
  const countryCounts = queryRows(countrySql, sourceBindings).map((row) => ({
    country: String(row.country ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  return { points, countryCounts, regionCounts: [], cityCounts: [] };
}

function sortedPoints(points: readonly GeoPointAggregate["points"][number][]) {
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

async function forwardGeoCountQuery(input: {
  readonly scope: "event" | "session" | "visitor";
  readonly filter: string;
  readonly limit: number;
  readonly context?: QueryInput["context"];
  readonly signal?: AbortSignal;
}): Promise<QueryInput & Record<string, unknown>> {
  const context = input.context ?? siteQueryContext(SITE, "private-dashboard");
  const document = parseFilterDsl(input.filter, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("geo-points", {
    context,
    time: createQueryTime(
      WINDOW.startMs,
      WINDOW.endExclusiveMs,
      WINDOW.timeZone,
      WINDOW.nowMs,
    ),
    filters: document,
    scopePreference: input.scope,
  } as QueryInput & { readonly time: QueryTime });
  const query = {
    ...prepared,
    filters: prepared.filters ?? document,
    limit: input.limit,
  } as QueryInput & Record<string, unknown>;
  const expectedSiteId =
    context.subject.kind === "site" ? context.subject.siteId : undefined;
  return (await d1AdvancedFilterMiddleware(
    sqliteEnv(db),
    undefined,
    expectedSiteId,
  )(
    "geo-points",
    query,
    async (value) => value,
    input.signal ? { signal: input.signal } : undefined,
  )) as QueryInput & Record<string, unknown>;
}

function geoProviderQuery(
  value: unknown,
): QueryInput & { readonly time: QueryTime; readonly limit: number } {
  return value as unknown as QueryInput & {
    readonly time: QueryTime;
    readonly limit: number;
  };
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
  db.exec("PRAGMA foreign_keys = OFF");
  site = addSite(db, SITE);
  otherSite = addSite(db, OTHER_SITE);
  addFixtureData(db);
});

afterAll(() => db.close());

describe("Journey Geo Page report D1 migration", () => {
  it("captures the pre-qualification Geo registry DTO and SQL baseline", async () => {
    const cases = [
      { name: "country", document: filters([]), limit: 500 },
      {
        name: "region",
        document: filters([{ field: "geo.country", value: "US" }]),
        limit: 500,
      },
      {
        name: "city",
        document: filters([
          { field: "geo.country", value: "US" },
          { field: "geo.region", value: "California" },
        ]),
        limit: 500,
      },
      { name: "empty-points", document: filters([]), limit: 0 },
    ] as const;
    const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
    if (artifactDir) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(artifactDir, { recursive: true });
    }

    for (const item of cases) {
      const prepared = prepareScopedQuery("geo-points", {
        context: siteQueryContext(SITE, "private-dashboard"),
        time: createQueryTime(
          WINDOW.startMs,
          WINDOW.endExclusiveMs,
          WINDOW.timeZone,
          WINDOW.nowMs,
        ),
        filters: item.document,
        scopePreference: "event",
      } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
        readonly filters?: FilterDocument;
        readonly scopePlan?: ScopedFilterPlan;
        readonly time: QueryTime;
      };
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const provider = createD1SiteProviderRegistry({
        env: sqliteEnv(db, trace),
        siteId: SITE,
      }).resolve("geo-points");
      if (!provider) throw new Error("wave97i_geo_points_provider_missing");
      const result = await provider.execute({
        ...prepared,
        filters: prepared.filters ?? item.document,
        limit: item.limit,
      });
      if (item.limit === 0) expect(result.value.points).toEqual([]);
      else expect(result.value.points.length).toBeGreaterThan(0);
      expect(trace.preparedSql).toHaveLength(2);
      if (item.name === "empty-points")
        expect(result.value.countryCounts.length).toBeGreaterThan(0);
      if (artifactDir) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
          `${artifactDir}/geo-legacy-${item.name}.json`,
          JSON.stringify(
            {
              case: item.name,
              dto: result.value,
              requestCount: trace.preparedSql.length,
              requests: trace.preparedSql.map((sql, index) => ({
                sql,
                bindings: trace.bindings[index] ?? [],
              })),
            },
            null,
            2,
          ),
          "utf8",
        );
      }
    }
  });

  itWithGeoQualificationEvent(
    "compiles bounded session and visitor Geo qualification plans before routing",
    async () => {
      const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
      const evidenceCases: Array<Record<string, unknown>> = [];
      for (const scope of ["session", "visitor"] as const) {
        for (const item of [
          { level: "country" as const, geo: "" },
          { level: "region" as const, geo: ' and geo.country eq "US"' },
          {
            level: "city" as const,
            geo: ' and geo.country eq "US" and geo.region eq "California"',
          },
        ]) {
          const filters = parseFilterDsl(
            `count(event { event.name eq "wave97i-geo-qualifier" }) eq 1${item.geo}`,
            analyticsFilterRegistry,
          );
          const time = createQueryTime(
            WINDOW.startMs,
            WINDOW.endExclusiveMs,
            WINDOW.timeZone,
            WINDOW.nowMs,
          );
          const prepared = prepareScopedQuery("geo-points", {
            context: siteQueryContext(SITE, "private-dashboard"),
            time,
            filters,
            scopePreference: scope,
          } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
            readonly filters?: FilterDocument;
            readonly scopePlan?: ScopedFilterPlan;
            readonly time: QueryTime;
          };
          const query = {
            ...prepared,
            filters: prepared.filters ?? filters,
            limit: 50,
          } as QueryInput & Record<string, unknown>;
          const forwarded = await d1AdvancedFilterMiddleware(
            sqliteEnv(db),
            undefined,
            SITE,
          )("geo-points", query, async (value) => value);
          const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
          if (!deferred)
            throw new Error(
              `wave97i_geo_deferred_request_missing:${scope}:${item.level}`,
            );
          const compilation = compileGeoPointsQualificationProgram({
            deferred,
          });
          if (compilation.kind !== "compiled")
            throw new Error(
              `wave97i_geo_compile_unavailable:${scope}:${item.level}:${compilation.fallbackReason.kind}`,
            );
          const { evidence } = compilation;
          expect(evidence.groupedSummaryProof.groupKeyCount).toBe(2);
          expect(evidence.groupWidth).toBeLessThanOrEqual(16);
          expect(evidence.groupedSummaryProof.materialization).toBe(
            "materialized",
          );
          expect(evidence.groupedSummaryProof.matchingSharedRelationCount).toBe(
            1,
          );
          expect(evidence.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(evidence.bindingCount).toBeLessThanOrEqual(100);
          expect(
            evidence.outputDescriptors.map(({ outputId }) => outputId),
          ).toEqual([
            "journey-geo-points",
            `journey-geo-${item.level}-summary`,
          ]);
          expect(
            evidence.ordering.map(({ field, outputId, direction, nulls }) => ({
              field,
              outputId,
              direction,
              nulls,
            })),
          ).toEqual([
            {
              field: "rowKind",
              outputId: undefined,
              direction: "asc",
              nulls: "first",
            },
            {
              field: "outputId",
              outputId: undefined,
              direction: "asc",
              nulls: "first",
            },
            {
              field: "timestampMs",
              outputId: "journey-geo-points",
              direction: "desc",
              nulls: "last",
            },
            {
              field: "views",
              outputId: `journey-geo-${item.level}-summary`,
              direction: "desc",
              nulls: "last",
            },
            {
              field: "sessions",
              outputId: `journey-geo-${item.level}-summary`,
              direction: "desc",
              nulls: "last",
            },
            ...(item.level === "country"
              ? ["country"]
              : item.level === "region"
                ? ["region", "regionCode"]
                : ["city"]
            ).map((field) => ({
              field,
              outputId: `journey-geo-${item.level}-summary`,
              direction: "asc",
              nulls: "first",
            })),
          ]);
          evidenceCases.push({
            scope,
            summaryLevel: item.level,
            limit: 50,
            statementTag: evidence.statementTag,
            sql: evidence.sql,
            bindings: evidence.bindings,
            sqlBytes: evidence.sqlBytes,
            bindingCount: evidence.bindingCount,
            groupWidth: evidence.groupWidth,
            groupedSummaryProof: evidence.groupedSummaryProof,
            sharedRelationCount: evidence.sharedRelationCount,
            rootKind: evidence.rootKind,
            physicalPlanShape: evidence.physicalPlanShape,
            outputDescriptors: evidence.outputDescriptors,
            ordering: evidence.ordering,
            controlOutputId: evidence.controlOutputId,
            controlFields: evidence.controlFields,
            reportOutputIds: evidence.logicalPlan.outputs
              .filter((output) => output.id !== evidence.controlOutputId)
              .map((output) => output.id),
            logicalPlan: evidence.logicalPlan,
          });
        }
      }
      expect(evidenceCases).toHaveLength(6);
      if (artifactDir) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          `${artifactDir}/geo-six-config-compile-before-routing.json`,
          JSON.stringify(evidenceCases, null, 2),
          "utf8",
        );
      }
    },
  );

  itWithGeoQualificationEvent(
    "brands Geo requests to their original own-data snapshot",
    async () => {
      const document = parseFilterDsl(
        'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 and geo.country eq "US"',
        analyticsFilterRegistry,
      );
      const prepared = prepareScopedQuery("geo-points", {
        context: siteQueryContext(SITE, "private-dashboard"),
        time: createQueryTime(
          WINDOW.startMs,
          WINDOW.endExclusiveMs,
          WINDOW.timeZone,
          WINDOW.nowMs,
        ),
        filters: document,
        scopePreference: "session",
      } as QueryInput & { readonly time: QueryTime });
      const query = {
        ...prepared,
        filters: prepared.filters ?? document,
        limit: 50,
      } as QueryInput & Record<string, unknown>;
      const forwarded = await d1AdvancedFilterMiddleware(
        sqliteEnv(db),
        undefined,
        SITE,
      )("geo-points", query, async (value) => value);
      const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
      expect(deferred).toBeDefined();
      expect(
        deferredGeoPointsQualificationFromQuery({
          ...(forwarded as QueryInput & Record<string, unknown>),
        }),
      ).toBeUndefined();
      const cloneTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      await expect(
        executeGeoPointsQualificationProgram({
          env: sqliteEnv(db, cloneTrace),
          query: forwarded,
          request: { ...deferred! } as never,
        }),
      ).rejects.toThrow("geo_points_qualification_request_untrusted");
      expect(cloneTrace.preparedSql).toHaveLength(0);

      const changedConfigurationTrace: SqliteD1Trace = {
        preparedSql: [],
        bindings: [],
      };
      await expect(
        executeGeoPointsQualificationProgram({
          env: sqliteEnv(db, changedConfigurationTrace),
          query: forwarded,
          request: {
            ...deferred!,
            configuration: { ...deferred!.configuration, limit: 51 },
          } as never,
        }),
      ).rejects.toThrow("geo_points_qualification_request_untrusted");
      expect(changedConfigurationTrace.preparedSql).toHaveLength(0);

      const wrongQueryTrace: SqliteD1Trace = {
        preparedSql: [],
        bindings: [],
      };
      await expect(
        executeGeoPointsQualificationProgram({
          env: sqliteEnv(db, wrongQueryTrace),
          query: { ...(forwarded as QueryInput & Record<string, unknown>) },
          request: deferred!,
        }),
      ).rejects.toThrow("geo_points_qualification_request_changed");
      expect(wrongQueryTrace.preparedSql).toHaveLength(0);

      (forwarded as Record<string, unknown>).limit = 51;
      expect(() => deferredGeoPointsQualificationFromQuery(forwarded)).toThrow(
        "geo_points_qualification_request_changed",
      );
      const changedSnapshotTrace: SqliteD1Trace = {
        preparedSql: [],
        bindings: [],
      };
      await expect(
        executeGeoPointsQualificationProgram({
          env: sqliteEnv(db, changedSnapshotTrace),
          query: forwarded,
          request: deferred!,
        }),
      ).rejects.toThrow("geo_points_qualification_request_changed");
      expect(changedSnapshotTrace.preparedSql).toHaveLength(0);

      let getterCalled = false;
      const accessorQuery = { filters: document };
      Object.defineProperty(accessorQuery, "limit", {
        enumerable: true,
        get() {
          getterCalled = true;
          return 50;
        },
      });
      expect(
        geoPointsQualificationConfigurationFromQuery(accessorQuery),
      ).toBeUndefined();
      expect(getterCalled).toBe(false);
      expect(geoPointsLimitFromQuery({})).toBe(5000);
      expect(geoPointsLimitFromQuery({ limit: undefined })).toBe(5000);
      expect(geoPointsLimitFromQuery({ limit: 0 })).toBe(0);
      expect(geoPointsLimitFromQuery({ limit: -1 })).toBe(-1);
      expect(geoPointsLimitFromQuery({ limit: 1.5 })).toBe(1.5);
      expect(geoPointsLimitFromQuery({ limit: Number.NaN })).toBe(5000);
      expect(geoPointsLimitFromQuery({ limit: Number.POSITIVE_INFINITY })).toBe(
        5000,
      );

      let toJsonCalled = false;
      const toJsonQuery = {
        filters: document,
        limit: 50,
        toJSON() {
          toJsonCalled = true;
          return {};
        },
      };
      expect(
        geoPointsQualificationConfigurationFromQuery(toJsonQuery),
      ).toBeUndefined();
      expect(toJsonCalled).toBe(false);

      const summaryLevelFor = (source: string) =>
        geoPointsQualificationConfigurationFromQuery({
          filters: parseFilterDsl(source, analyticsFilterRegistry),
          limit: 25,
        })?.summaryLevel;
      expect(summaryLevelFor('geo.country eq "" and geo.country eq "US"')).toBe(
        "country",
      );
      expect(summaryLevelFor('geo.country eq "US" and geo.country eq ""')).toBe(
        "region",
      );
      const nestedCountry = normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "not",
            child: {
              kind: "condition",
              target: { kind: "field", field: "geo.country" },
              operator: "eq",
              value: "US",
            },
          },
        },
        analyticsFilterRegistry,
      );
      expect(
        geoPointsQualificationConfigurationFromQuery({
          filters: nestedCountry,
          limit: 25,
        })?.summaryLevel,
      ).toBe("country");
    },
  );

  itWithGeoQualificationEvent(
    "keeps empty cohorts, invalid-point summaries, blank IDs, and site boundaries",
    async () => {
      const temporaryIds = [
        "wave97i-empty-session-qualified",
        "wave97i-invalid-coordinate-qualified",
        "wave97i-cross-site-identity-collision",
      ];
      try {
        addVisit(db, {
          id: temporaryIds[0]!,
          site,
          session: "",
          visitor: "v1",
          time: 142,
          latitude: 20,
          longitude: 30,
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "San Francisco",
        });
        addVisit(db, {
          id: temporaryIds[1]!,
          site,
          session: "s1",
          visitor: "v1",
          time: 143,
          latitude: 91,
          longitude: 0,
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "San Francisco",
        });
        addVisit(db, {
          id: temporaryIds[2]!,
          site: otherSite,
          session: "s1",
          visitor: "v1",
          time: 144,
          latitude: 30,
          longitude: 40,
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "Cross-site collision",
        });

        const qualified = await forwardGeoCountQuery({
          scope: "visitor",
          filter:
            'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 and geo.country eq "US"',
          limit: 50,
        });
        const qualifiedTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const qualifiedProvider = createD1SiteProviderRegistry({
          env: sqliteEnv(db, qualifiedTrace),
          siteId: SITE,
        }).resolve("geo-points");
        if (!qualifiedProvider)
          throw new Error("wave97i_geo_points_provider_missing");
        const qualifiedResult = await qualifiedProvider.execute(
          geoProviderQuery(qualified),
        );
        const expected = legacyAggregate(
          filters([{ field: "geo.country", value: "US" }]),
          50,
          WINDOW,
          { column: "visitor_id", ids: ["v1"] },
        );
        expect(sortedPoints(qualifiedResult.value.points)).toEqual(
          sortedPoints(expected.points),
        );
        expect(qualifiedResult.value.regionCounts).toEqual(
          expected.regionCounts,
        );
        expect(qualifiedResult.value.regionCounts[0]?.views).toBe(4);
        expect(qualifiedResult.value.regionCounts[0]?.sessions).toBe(1);
        expect(
          qualifiedTrace.preparedSql.filter((sql) =>
            sql.trimStart().startsWith("WITH "),
          ),
        ).toHaveLength(1);

        const empty = await forwardGeoCountQuery({
          scope: "session",
          filter:
            'count(event { event.name eq "wave97i-no-matching-event" }) eq 1 and geo.country eq "US"',
          limit: 25,
        });
        const emptyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const emptyProvider = createD1SiteProviderRegistry({
          env: sqliteEnv(db, emptyTrace),
          siteId: SITE,
        }).resolve("geo-points");
        if (!emptyProvider)
          throw new Error("wave97i_geo_points_provider_missing");
        const emptyResult = await emptyProvider.execute(
          geoProviderQuery(empty),
        );
        expect(emptyResult.value).toEqual({
          points: [],
          countryCounts: [],
          regionCounts: [],
          cityCounts: [],
        });
        expect(
          emptyTrace.preparedSql.filter((sql) =>
            sql.trimStart().startsWith("WITH "),
          ),
        ).toHaveLength(1);
      } finally {
        db.prepare(
          `DELETE FROM visits WHERE visit_id IN (${temporaryIds.map(() => "?").join(",")})`,
        ).run(...temporaryIds);
      }
    },
  );

  itWithGeoQualificationEvent(
    "preserves the legacy finite non-integer limit failure",
    async () => {
      const filter =
        'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1';
      const forwarded = await forwardGeoCountQuery({
        scope: "session",
        filter,
        limit: 1.5,
      });
      const provider = createD1SiteProviderRegistry({
        env: sqliteEnv(db),
        siteId: SITE,
      }).resolve("geo-points");
      if (!provider) throw new Error("wave97i_geo_points_provider_missing");
      await expect(
        provider.execute(geoProviderQuery(forwarded)),
      ).rejects.toThrow("logical_builder_invalid_limit");
      await expect(
        queryGeoPointsFromD1(sqliteEnv(db), SITE, WINDOW, filters([]), 1.5),
      ).rejects.toThrow("logical_builder_invalid_limit");
    },
  );

  itWithGeoQualificationEvent(
    "leaves unsupported scope and audience requests on the legacy route",
    async () => {
      const filter =
        'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 and geo.country eq "US"';
      const cases = [
        {
          scope: "event" as const,
          context: siteQueryContext(SITE, "private-dashboard"),
        },
        {
          scope: "session" as const,
          context: siteQueryContext(SITE, "public-share"),
        },
        {
          scope: "session" as const,
          context: teamQueryContext("wave52-geo-team", "private-dashboard", [
            SITE,
          ]),
        },
        {
          scope: "visitor" as const,
          context: teamQueryContext("wave52-geo-team", "private-dashboard", [
            SITE,
            OTHER_SITE,
          ]),
        },
      ];
      for (const item of cases) {
        const forwarded = await forwardGeoCountQuery({
          scope: item.scope,
          filter,
          limit: 50,
          context: item.context,
        });
        expect(
          deferredGeoPointsQualificationFromQuery(forwarded),
        ).toBeUndefined();
      }

      const document = parseFilterDsl(filter, analyticsFilterRegistry);
      const prepared = prepareScopedQuery("geo-points", {
        context: siteQueryContext(SITE, "private-dashboard"),
        time: createQueryTime(
          WINDOW.startMs,
          WINDOW.endExclusiveMs,
          WINDOW.timeZone,
          WINDOW.nowMs,
        ),
        filters: document,
        scopePreference: "session",
      } as QueryInput & { readonly time: QueryTime });
      const metadata = scopedFilterMetadata(prepared.filters);
      if (!prepared.filters || !metadata)
        throw new Error("wave97i_geo_scope_metadata_missing");
      const fullHistoryTime = {
        ...(prepared.time as QueryTime),
        fullHistory: true,
      } as QueryTime;
      const fullHistoryFilters = attachScopedFilterMetadata(prepared.filters, {
        ...metadata,
        time: fullHistoryTime,
      });
      const fullHistoryForwarded = await d1AdvancedFilterMiddleware(
        sqliteEnv(db),
        undefined,
        SITE,
      )(
        "geo-points",
        {
          ...prepared,
          time: fullHistoryTime,
          filters: fullHistoryFilters,
          limit: 50,
        } as QueryInput & Record<string, unknown>,
        async (value) => value,
      );
      expect(
        deferredGeoPointsQualificationFromQuery(fullHistoryForwarded),
      ).toBeUndefined();
    },
  );

  itWithGeoQualificationEvent(
    "falls back once when the controls admit an invalid identity and keeps both Geo DTOs",
    async () => {
      const forwarded = await forwardGeoCountQuery({
        scope: "session",
        filter:
          'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 and geo.country eq "US"',
        limit: 50,
      });
      const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
      if (!deferred) throw new Error("wave97i_geo_deferred_request_missing");
      const compilation = compileGeoPointsQualificationProgram({ deferred });
      if (compilation.kind !== "compiled")
        throw new Error("wave97i_geo_control_plan_unavailable");
      const { evidence } = compilation;
      const rowFields = [
        "rowKind",
        "outputId",
        ...new Set(evidence.outputDescriptors.flatMap(({ fields }) => fields)),
        ...evidence.controlFields,
      ];
      const control: Record<string, unknown> = Object.fromEntries(
        rowFields.map((field) => [field, null]),
      );
      control.rowKind = "control";
      control.outputId = evidence.controlOutputId;
      control.entityKind = "session";
      control.rawCount = 1;
      control.nullActivityIdCount = 1;
      control.siteIdentityMismatchCount = 0;
      control.invalidIdentityCount = 0;
      control.duplicateIdentityCount = 0;
      for (const field of evidence.controlFields)
        if (control[field] === null) control[field] = 0;

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const baseDatabase = createSqliteD1Database(db, trace);
      let controlOverrideCount = 0;
      const controlledDatabase = {
        prepare(sql: string) {
          const statement = baseDatabase.prepare(sql) as unknown as {
            bind: (...bindings: unknown[]) => unknown;
            all: (...args: unknown[]) => Promise<D1Result<unknown>>;
          };
          const originalAll = statement.all.bind(statement);
          statement.all = async (...args) => {
            if (
              controlOverrideCount === 0 &&
              sql.trimStart().startsWith("WITH ")
            ) {
              controlOverrideCount += 1;
              return { success: true, results: [control] } as D1Result<unknown>;
            }
            return originalAll(...args);
          };
          return statement as unknown as D1Database["prepare"] extends (
            sql: string,
          ) => infer Prepared
            ? Prepared
            : never;
        },
        batch: baseDatabase.batch.bind(baseDatabase),
      } as unknown as D1Database;
      const provider = createD1SiteProviderRegistry({
        env: { DB: controlledDatabase } as Env,
        siteId: SITE,
      }).resolve("geo-points");
      if (!provider) throw new Error("wave97i_geo_points_provider_missing");
      const actual = await provider.execute(geoProviderQuery(forwarded));
      const expected = legacyAggregate(
        filters([{ field: "geo.country", value: "US" }]),
        50,
        WINDOW,
        { column: "session_id", ids: ["s1"] },
      );
      expect(controlOverrideCount).toBe(1);
      expect(sortedPoints(actual.value.points)).toEqual(
        sortedPoints(expected.points),
      );
      expect(actual.value.regionCounts).toEqual(expected.regionCounts);
      expect(actual.value.countryCounts).toEqual([]);
      expect(actual.value.cityCounts).toEqual([]);
      const fallbackReportSql = trace.preparedSql.filter((sql) =>
        sql.trimStart().startsWith("WITH "),
      );
      expect(fallbackReportSql.length).toBeGreaterThanOrEqual(2);
      const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
      if (artifactDir) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          `${artifactDir}/geo-control-fallback-after.json`,
          JSON.stringify(
            {
              source: "test-adapter-control-row-simulation",
              fallbackReason: { kind: "null-activity-id" },
              controlOverrideCount,
              reportStatementCount: fallbackReportSql.length,
              requestCount: trace.preparedSql.length,
              dto: actual.value,
              statements: trace.preparedSql.map((sql, index) => ({
                sql,
                bindings: trace.bindings[index] ?? [],
              })),
            },
            null,
            2,
          ),
          "utf8",
        );
      }
    },
  );

  itWithGeoQualificationEvent(
    "propagates Geo report errors and aborts without legacy fallback",
    async () => {
      const filter =
        'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 and geo.country eq "US"';
      const errorTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const errorBase = createSqliteD1Database(db, errorTrace);
      let reportErrorCalls = 0;
      const errorDatabase = {
        prepare(sql: string) {
          const statement = errorBase.prepare(sql) as unknown as {
            all: (...args: unknown[]) => Promise<D1Result<unknown>>;
          };
          const originalAll = statement.all.bind(statement);
          statement.all = async (...args) => {
            if (sql.trimStart().startsWith("WITH ")) {
              reportErrorCalls += 1;
              throw new Error("wave97i_geo_report_database_error");
            }
            return originalAll(...args);
          };
          return statement as unknown as D1Database["prepare"] extends (
            sql: string,
          ) => infer Prepared
            ? Prepared
            : never;
        },
        batch: errorBase.batch.bind(errorBase),
      } as unknown as D1Database;
      const errorQuery = await forwardGeoCountQuery({
        scope: "session",
        filter,
        limit: 50,
      });
      const errorProvider = createD1SiteProviderRegistry({
        env: { DB: errorDatabase } as Env,
        siteId: SITE,
      }).resolve("geo-points");
      if (!errorProvider)
        throw new Error("wave97i_geo_points_provider_missing");
      await expect(
        errorProvider.execute(geoProviderQuery(errorQuery)),
      ).rejects.toThrow("wave97i_geo_report_database_error");
      expect(reportErrorCalls).toBe(1);
      expect(
        errorTrace.preparedSql.filter((sql) =>
          sql.trimStart().startsWith("WITH "),
        ),
      ).toHaveLength(1);

      const controller = new AbortController();
      const abortQuery = await forwardGeoCountQuery({
        scope: "session",
        filter,
        limit: 50,
        signal: controller.signal,
      });
      controller.abort();
      const abortTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const abortProvider = createD1SiteProviderRegistry({
        env: sqliteEnv(db, abortTrace),
        siteId: SITE,
      }).resolve("geo-points");
      if (!abortProvider)
        throw new Error("wave97i_geo_points_provider_missing");
      await expect(
        abortProvider.execute(geoProviderQuery(abortQuery), {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(
        abortTrace.preparedSql.filter((sql) =>
          sql.trimStart().startsWith("WITH "),
        ),
      ).toHaveLength(0);
    },
  );

  itWithGeoQualificationEvent(
    "rejects malformed controls, unknown outputs, and invalid coordinates without legacy retry",
    async () => {
      const query = await forwardGeoCountQuery({
        scope: "session",
        filter: 'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1',
        limit: 20,
      });
      const deferred = deferredGeoPointsQualificationFromQuery(query);
      if (!deferred) throw new Error("wave97i_geo_deferred_request_missing");
      const compilation = compileGeoPointsQualificationProgram({ deferred });
      if (compilation.kind !== "compiled")
        throw new Error("wave97i_geo_protocol_plan_unavailable");
      const { evidence } = compilation;
      const envelopeFields = [
        "rowKind",
        "outputId",
        ...new Set(evidence.outputDescriptors.flatMap(({ fields }) => fields)),
        ...evidence.controlFields,
      ];
      const makeRow = (
        rowKind: string,
        outputId: string,
      ): Record<string, unknown> => {
        const row: Record<string, unknown> = Object.fromEntries(
          envelopeFields.map((field) => [field, null]),
        );
        row.rowKind = rowKind;
        row.outputId = outputId;
        return row;
      };
      const control = makeRow("control", evidence.controlOutputId);
      for (const field of evidence.controlFields) control[field] = 0;
      control.entityKind = "session";
      control.rawCount = 1;
      const unknownReport = makeRow("report", "unknown-geo-output");
      const invalidCoordinatePoint = makeRow("report", "journey-geo-points");
      Object.assign(invalidCoordinatePoint, {
        latitude: 1.0001,
        longitude: 4.001,
        timestampMs: 120,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "Invalid precision",
        pointCount: 1,
      });
      const cases = [
        {
          rows: [] as Record<string, unknown>[],
          error: "geo_points_qualification_control_row_invalid",
        },
        {
          rows: [control, unknownReport],
          error: "geo_points_qualification_report_output_invalid",
        },
        {
          rows: [control, invalidCoordinatePoint],
          error: "geo_points_qualification_point_shape_invalid",
        },
      ];
      const protocolEvidence: Array<Record<string, unknown>> = [];
      for (const scenario of cases) {
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const base = createSqliteD1Database(db, trace);
        let intercepted = 0;
        const database = {
          prepare(sql: string) {
            const statement = base.prepare(sql) as unknown as {
              all: (...args: unknown[]) => Promise<D1Result<unknown>>;
            };
            const originalAll = statement.all.bind(statement);
            statement.all = async (...args) => {
              if (intercepted === 0 && sql.trimStart().startsWith("WITH ")) {
                intercepted += 1;
                return {
                  success: true,
                  results: scenario.rows,
                } as D1Result<unknown>;
              }
              return originalAll(...args);
            };
            return statement as unknown as D1Database["prepare"] extends (
              sql: string,
            ) => infer Prepared
              ? Prepared
              : never;
          },
          batch: base.batch.bind(base),
        } as unknown as D1Database;
        const provider = createD1SiteProviderRegistry({
          env: { DB: database } as Env,
          siteId: SITE,
        }).resolve("geo-points");
        if (!provider) throw new Error("wave97i_geo_points_provider_missing");
        await expect(provider.execute(geoProviderQuery(query))).rejects.toThrow(
          scenario.error,
        );
        expect(intercepted).toBe(1);
        expect(
          trace.preparedSql.filter((sql) =>
            sql.trimStart().startsWith("WITH "),
          ),
        ).toHaveLength(1);
        protocolEvidence.push({
          case: scenario.error,
          interceptedReportCount: intercepted,
          sql: trace.preparedSql,
          bindings: trace.bindings,
        });
      }
      const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
      if (artifactDir) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          `${artifactDir}/geo-protocol-rejections-after.json`,
          JSON.stringify(protocolEvidence, null, 2),
          "utf8",
        );
      }
    },
  );

  itWithGeoQualificationEvent(
    "executes advanced Geo points and the selected summary in one report query",
    async () => {
      const cases = [
        { scope: "session" as const, level: "country" as const, geo: "" },
        {
          scope: "session" as const,
          level: "region" as const,
          geo: ' and geo.country eq "US"',
        },
        {
          scope: "session" as const,
          level: "city" as const,
          geo: ' and geo.country eq "US" and geo.region eq "California"',
        },
        { scope: "visitor" as const, level: "country" as const, geo: "" },
        {
          scope: "visitor" as const,
          level: "region" as const,
          geo: ' and geo.country eq "US"',
        },
        {
          scope: "visitor" as const,
          level: "city" as const,
          geo: ' and geo.country eq "US" and geo.region eq "California"',
        },
        {
          scope: "session" as const,
          level: "country" as const,
          geo: "",
          limit: 1,
        },
        {
          scope: "visitor" as const,
          level: "country" as const,
          geo: "",
          limit: -1,
        },
        {
          scope: "session" as const,
          level: "country" as const,
          geo: "",
          limit: 0,
        },
      ];
      const runtimeEvidence: Array<Record<string, unknown>> = [];
      for (const item of cases) {
        const document = parseFilterDsl(
          `count(event { event.name eq "wave97i-geo-qualifier" }) eq 1${item.geo}`,
          analyticsFilterRegistry,
        );
        const time = createQueryTime(
          WINDOW.startMs,
          WINDOW.endExclusiveMs,
          WINDOW.timeZone,
          WINDOW.nowMs,
        );
        const prepared = prepareScopedQuery("geo-points", {
          context: siteQueryContext(SITE, "private-dashboard"),
          time,
          filters: document,
          scopePreference: item.scope,
        } as QueryInput & { readonly time: QueryTime });
        const query = {
          ...prepared,
          filters: prepared.filters ?? document,
          limit: item.limit ?? 50,
        } as QueryInput & Record<string, unknown>;
        const forwarded = await d1AdvancedFilterMiddleware(
          sqliteEnv(db),
          undefined,
          SITE,
        )("geo-points", query, async (value) => value);
        const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
        expect(deferred).toBeDefined();
        const preflightExecution = await executeGeoPointsQualificationProgram({
          env: sqliteEnv(db),
          query: forwarded,
          request: deferred!,
        });
        if (preflightExecution.kind !== "executed")
          throw new Error(
            `wave97i_geo_runtime_fallback:${JSON.stringify(preflightExecution.fallbackReason)}`,
          );
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const provider = createD1SiteProviderRegistry({
          env: sqliteEnv(db, trace),
          siteId: SITE,
        }).resolve("geo-points");
        if (!provider) throw new Error("wave97i_geo_points_provider_missing");
        const actual = await provider.execute(geoProviderQuery(forwarded));
        const limit = item.limit ?? 50;
        const expected = legacyAggregate(
          filters(
            item.level === "country"
              ? []
              : item.level === "region"
                ? [{ field: "geo.country", value: "US" }]
                : [
                    { field: "geo.country", value: "US" },
                    { field: "geo.region", value: "California" },
                  ],
          ),
          limit,
          WINDOW,
          {
            column: item.scope === "session" ? "session_id" : "visitor_id",
            ids: [item.scope === "session" ? "s1" : "v1"],
          },
        );
        expect(sortedPoints(actual.value.points)).toEqual(
          sortedPoints(expected.points),
        );
        expect(
          actual.value.points.map(({ timestampMs }) => timestampMs),
        ).toEqual(
          [...actual.value.points.map(({ timestampMs }) => timestampMs)].sort(
            (left, right) => right - left,
          ),
        );
        expect(actual.value.countryCounts).toEqual(expected.countryCounts);
        expect(actual.value.regionCounts).toEqual(expected.regionCounts);
        expect(actual.value.cityCounts).toEqual(expected.cityCounts);
        const reportStatementIndexes = trace.preparedSql.flatMap(
          (sql, index) => (sql.trimStart().startsWith("WITH ") ? [index] : []),
        );
        expect(reportStatementIndexes).toHaveLength(1);
        const reportBindings = trace.bindings[reportStatementIndexes[0]!] ?? [];
        expect(reportBindings).not.toContain("s1");
        expect(reportBindings).not.toContain("v1");
        if (limit === 0) {
          expect(actual.value.points).toEqual([]);
          expect(actual.value.countryCounts.length).toBeGreaterThan(0);
        }
        runtimeEvidence.push({
          scope: item.scope,
          summaryLevel: item.level,
          limit,
          dto: actual.value,
          coverageStatementCount: trace.preparedSql.length - 1,
          reportStatementCount: reportStatementIndexes.length,
          statements: trace.preparedSql.map((sql, index) => ({
            sql,
            bindings: trace.bindings[index] ?? [],
            isReportStatement: reportStatementIndexes.includes(index),
          })),
        });
      }
      const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
      if (artifactDir) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          `${artifactDir}/geo-runtime-route-after.json`,
          JSON.stringify(runtimeEvidence, null, 2),
          "utf8",
        );
      }
    },
  );

  itWithGeoQualificationEvent(
    "matches registered Event-candidate Geo points and country summary against Core without widening an owner sibling",
    async () => {
      const siblingId = "wave97eq-geo-unmatched-sibling";
      try {
        db.prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?").run(
          "/native-only",
          "geo-sf-2",
        );
        addVisit(db, {
          id: siblingId,
          site,
          session: "s1",
          visitor: "v1",
          time: 130,
          latitude: 1.2345,
          longitude: -2.3455,
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "San Francisco",
          pathname: "/unmatched-sibling",
        });
        const filterDsl =
          'page.path neq "/unmatched-sibling" and ((count(event { event.name eq "wave97i-geo-qualifier" }) gt 0 and event.name eq "wave97i-geo-qualifier") or page.path eq "/native-only")';
        const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
        const time = createQueryTime(
          WINDOW.startMs,
          WINDOW.endExclusiveMs,
          WINDOW.timeZone,
          WINDOW.nowMs,
        );
        const prepared = prepareScopedQuery("geo-points", {
          context: siteQueryContext(SITE, "private-dashboard"),
          time,
          filters: document,
          scopePreference: "event",
        } as QueryInput & { readonly time: QueryTime });
        const query = {
          ...prepared,
          filters: prepared.filters ?? document,
          limit: 50,
        } as QueryInput & Record<string, unknown>;
        const actualTrace: SqliteD1Trace = {
          preparedSql: [],
          bindings: [],
        };
        const reads: CapturedD1AllResult[] = [];
        const env = sqliteEnv(db, actualTrace, (read) => reads.push(read));
        const forwarded = await d1AdvancedFilterMiddleware(
          env,
          undefined,
          SITE,
        )("geo-points", query, async (value) => value);
        const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
        if (!deferred) throw new Error("wave97eq_geo_event_candidate_missing");
        expect(deferred.qualification.countInput.scope).toBe("event");
        expect(
          "eventCandidateReportProjection" in deferred.qualification
            ? deferred.qualification.eventCandidateReportProjection
            : undefined,
        ).toBe("page-visits");

        const provider = createD1SiteProviderRegistry({
          env,
          siteId: SITE,
          diagnostics: createD1ReadDiagnostics(),
        }).resolve("geo-points");
        if (!provider) throw new Error("wave97eq_geo_points_provider_missing");
        const actual = await provider.execute(geoProviderQuery(query));
        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        );
        const coreTrace: SqliteD1Trace = {
          preparedSql: [],
          bindings: [],
        };
        const expected = await queryGeoPointsFromD1(
          sqliteEnv(db, coreTrace),
          SITE,
          WINDOW,
          fallbackFilters,
          50,
        );

        expect(actual.value).toEqual(expected);
        expect(
          actual.value.points.reduce(
            (total, point) => total + point.pointCount,
            0,
          ),
        ).toBe(2);
        expect(actual.value.countryCounts.length).toBeGreaterThan(0);
        expect(actual.value.regionCounts).toEqual([]);
        expect(actual.value.cityCounts).toEqual([]);
        expect(
          actualTrace.preparedSql.filter((sql) =>
            sql.trimStart().startsWith("WITH "),
          ),
        ).toHaveLength(1);
        await writeGeoEvidence("97eq-event-country-native.json", {
          actual: actual.value,
          core: expected,
          actualTrace,
          coreTrace,
          reads,
        });
      } finally {
        db.prepare("DELETE FROM visits WHERE visit_id = ?").run(siblingId);
        db.prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?").run(
          "/geo",
          "geo-sf-2",
        );
      }
    },
  );

  itWithGeoQualificationEvent(
    "keeps unregistered Event Geo predicates on complete Core fallback",
    async () => {
      const filters = parseFilterDsl(
        'geo.country eq "US" and (count(event { event.name eq "wave97i-geo-qualifier" }) gt 0 or page.path eq "/geo")',
        analyticsFilterRegistry,
      );
      expect(classifyAdvancedEventCandidateCountFilter(filters)).toMatchObject({
        kind: "unsupported",
        code: "count_sql_bare_field_requires_registered_string",
      });
      const time = createQueryTime(
        WINDOW.startMs,
        WINDOW.endExclusiveMs,
        WINDOW.timeZone,
        WINDOW.nowMs,
      );
      const query = {
        ...prepareScopedQuery("geo-points", {
          context: siteQueryContext(SITE, "private-dashboard"),
          time,
          filters,
          scopePreference: "event",
        } as QueryInput & { readonly time: QueryTime }),
        limit: 50,
      };
      const actualTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = sqliteEnv(db, actualTrace);
      const forwarded = (await d1AdvancedFilterMiddleware(env, undefined, SITE)(
        "geo-points",
        query,
        async (value) => value,
      )) as QueryInput & Record<string, unknown>;
      expect(
        deferredGeoPointsQualificationFromQuery(forwarded),
      ).toBeUndefined();
      expect(
        scopedFilterMetadata(forwarded.filters!)?.plan.advancedMatches,
      ).toBeDefined();
      expect(
        normalizeFilterDocument(forwarded.filters!, analyticsFilterRegistry),
      ).toEqual(normalizeFilterDocument(filters, analyticsFilterRegistry));
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE,
      }).resolve("geo-points");
      if (!provider)
        throw new Error("wave97eq_geo_compatibility_provider_missing");
      const actual = await provider.execute(geoProviderQuery(forwarded));
      const coreTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const expected = await queryGeoPointsFromD1(
        sqliteEnv(db, coreTrace),
        SITE,
        WINDOW,
        forwarded.filters!,
        50,
      );
      expect(actual.value).toEqual(expected);
      await writeGeoEvidence("97eq-event-geo-complete-compatibility.json", {
        actual: actual.value,
        core: expected,
        actualTrace,
        coreTrace,
        capability: classifyAdvancedEventCandidateCountFilter(filters),
      });
    },
  );

  itWithGeoQualificationEvent(
    "suppresses both Event Geo roots before complete numeric fallback",
    async () => {
      const original = db
        .prepare("SELECT duration_ms FROM visits WHERE visit_id = ?")
        .get("geo-sf-1") as { readonly duration_ms: SQLInputValue };
      db.prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?").run(
        "invalid-duration",
        "geo-sf-1",
      );
      try {
        const filters = parseFilterDsl(
          'count(page { page.durationMs gt 5 }) gt 0 and event.name eq "wave97i-geo-qualifier"',
          analyticsFilterRegistry,
        );
        const time = createQueryTime(
          WINDOW.startMs,
          WINDOW.endExclusiveMs,
          WINDOW.timeZone,
          WINDOW.nowMs,
        );
        const query = {
          ...prepareScopedQuery("geo-points", {
            context: siteQueryContext(SITE, "private-dashboard"),
            time,
            filters,
            scopePreference: "event",
          } as QueryInput & { readonly time: QueryTime }),
          limit: 50,
        };
        const actualTrace: SqliteD1Trace = { preparedSql: [], bindings: [] },
          reads: CapturedD1AllResult[] = [];
        const env = sqliteEnv(db, actualTrace, (read) => reads.push(read)),
          diagnostics = createD1ReadDiagnostics();
        const forwarded = await d1AdvancedFilterMiddleware(
          env,
          undefined,
          SITE,
        )("geo-points", query, async (value) => value);
        const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
        if (!deferred) throw new Error("wave97eq_geo_numeric_deferred_missing");
        const provider = createD1SiteProviderRegistry({
          env,
          siteId: SITE,
          diagnostics,
        }).resolve("geo-points");
        if (!provider) throw new Error("wave97eq_geo_numeric_provider_missing");
        const actual = await provider.execute(geoProviderQuery(query));
        const coreTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const coreFilters = await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        );
        const expected = await queryGeoPointsFromD1(
          sqliteEnv(db, coreTrace),
          SITE,
          WINDOW,
          coreFilters,
          50,
        );
        expect(actual.value).toEqual(expected);
        expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });
        const envelopes = reads
          .map(capturedRows)
          .filter((rows) => rows.some((row) => row.rowKind === "control"));
        expect(envelopes).toHaveLength(1);
        expect(
          envelopes[0]!.filter((row) => row.rowKind === "report"),
        ).toHaveLength(0);
        expect(
          envelopes[0]!.filter((row) => row.rowKind === "control"),
        ).toHaveLength(1);
        const nativeGuardRead = reads.find(({ sql }) =>
          sql.includes('AS "outputId"'),
        );
        expect(nativeGuardRead).toBeDefined();
        const nativeGuardSql = nativeGuardRead!.sql;
        expect(actualTrace.preparedSql).toContain(nativeGuardSql);
        const compatibilitySql = actualTrace.preparedSql.filter(
          (sql) =>
            sql !== nativeGuardSql &&
            sql.includes('AS "rowType"') &&
            sql.includes("UNION ALL"),
        );
        expect(compatibilitySql).toHaveLength(1);
        expect(compatibilitySql[0]).toContain("visit_id");
        expect(compatibilitySql[0]).not.toContain("entity_id");
        const compatibilityRead = reads.find(
          ({ sql }) => sql === compatibilitySql[0],
        );
        expect(compatibilityRead).toBeDefined();
        const compatibilityRows = capturedRows(compatibilityRead!);
        await writeGeoEvidence("97eq-event-geo-numeric-fallback.json", {
          actual: actual.value,
          core: expected,
          diagnostics,
          actualTrace,
          coreTrace,
          reads,
          nativeGuardRows: envelopes[0],
          finalCompatibilityRows: compatibilityRows,
          finalCompatibilitySql: compatibilitySql[0],
          statementCost: {
            finalCompatibilityStatements: compatibilitySql.length,
            oldCoreStatements: coreTrace.preparedSql.length,
            finalCompatibilitySqlUtf8Bytes: new TextEncoder().encode(
              compatibilitySql[0]!,
            ).byteLength,
            oldCoreSqlUtf8Bytes: coreTrace.preparedSql.reduce(
              (total, sql) => total + new TextEncoder().encode(sql).byteLength,
              0,
            ),
            rowScanCountsAvailable: false,
          },
        });
      } finally {
        db.prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?").run(
          original.duration_ms,
          "geo-sf-1",
        );
      }
    },
  );

  itWithGeoQualificationEvent(
    "accepts rounded Geo coordinates across Node binary floating point edges",
    async () => {
      const values = [1.001, 1.003, 4.001, -4.001];
      const numericEvidence = values.map((value) => ({
        value,
        scaled: value * 1000,
        legacyAccepted: Math.round(value * 1000) === value * 1000,
        decimalAccepted: Number(value.toFixed(3)) === value,
      }));
      expect(
        numericEvidence.map(({ legacyAccepted }) => legacyAccepted),
      ).toEqual([false, false, false, false]);
      expect(
        numericEvidence.map(({ decimalAccepted }) => decimalAccepted),
      ).toEqual([true, true, true, true]);
      const temporaryIds = [
        "geo-node-roundtrip-positive",
        "geo-node-roundtrip-negative",
      ];
      try {
        addVisit(db, {
          id: temporaryIds[0]!,
          site,
          session: "s1",
          visitor: "v1",
          time: 180,
          latitude: 1.001,
          longitude: 4.001,
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "Node positive",
        });
        addVisit(db, {
          id: temporaryIds[1]!,
          site,
          session: "s1",
          visitor: "v1",
          time: 181,
          latitude: 1.003,
          longitude: -4.001,
          country: "US",
          region: "California",
          regionCode: "CA",
          city: "Node negative",
        });
        const query = await forwardGeoCountQuery({
          scope: "session",
          filter: 'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1',
          limit: 50,
        });
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const provider = createD1SiteProviderRegistry({
          env: sqliteEnv(db, trace),
          siteId: SITE,
        }).resolve("geo-points");
        if (!provider) throw new Error("wave97i_geo_points_provider_missing");
        const actual = await provider.execute(geoProviderQuery(query));
        const roundedPoints = actual.value.points
          .filter(({ city }) => city.startsWith("Node "))
          .map(({ city, latitude, longitude }) => ({
            city,
            latitude,
            longitude,
          }));
        expect(roundedPoints).toEqual([
          {
            city: "Node negative",
            latitude: 1.003,
            longitude: -4.001,
          },
          {
            city: "Node positive",
            latitude: 1.001,
            longitude: 4.001,
          },
        ]);
        expect(
          trace.preparedSql.filter((sql) =>
            sql.trimStart().startsWith("WITH "),
          ),
        ).toHaveLength(1);
        const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
        if (artifactDir) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(artifactDir, { recursive: true });
          await writeFile(
            `${artifactDir}/geo-coordinate-roundtrip-node.json`,
            JSON.stringify(
              {
                node: process.version,
                numericEvidence,
                registryDto: actual.value,
                reportSql: trace.preparedSql.filter((sql) =>
                  sql.trimStart().startsWith("WITH "),
                ),
              },
              null,
              2,
            ),
            "utf8",
          );
        }
      } finally {
        db.prepare(
          `DELETE FROM visits WHERE visit_id IN (${temporaryIds.map(() => "?").join(",")})`,
        ).run(...temporaryIds);
      }
    },
  );

  itWithGeoQualificationEvent(
    "preserves both Geo report orders when SQLite reverses unordered reads",
    async () => {
      const eventId = "geo-reverse-unordered-qualifier-event";
      addGeoQualificationEventForVisit(db, "geo-canada-a", eventId);
      const cohort = { column: "session_id" as const, ids: ["s1", "c1"] };
      const results: Array<{
        readonly reverseUnorderedSelects: boolean;
        readonly dto: unknown;
        readonly reportSql: string;
      }> = [];
      try {
        for (const reverseUnorderedSelects of [false, true]) {
          db.exec(
            "PRAGMA reverse_unordered_selects = " +
              (reverseUnorderedSelects ? "ON" : "OFF"),
          );
          const query = await forwardGeoCountQuery({
            scope: "session",
            filter:
              'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1',
            limit: 50,
          });
          const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
          const provider = createD1SiteProviderRegistry({
            env: sqliteEnv(db, trace),
            siteId: SITE,
          }).resolve("geo-points");
          if (!provider) throw new Error("wave97i_geo_points_provider_missing");
          const actual = await provider.execute(geoProviderQuery(query));
          const expected = legacyAggregate(filters([]), 50, WINDOW, cohort);
          expect(actual.value).toEqual(expected);
          expect(
            actual.value.countryCounts.map(({ country }) => country),
          ).toEqual(["CA", "US"]);
          expect(
            actual.value.points.map(({ timestampMs }) => timestampMs),
          ).toEqual(
            [...actual.value.points.map(({ timestampMs }) => timestampMs)].sort(
              (left, right) => right - left,
            ),
          );
          const reportStatements = trace.preparedSql.filter((sql) =>
            sql.trimStart().startsWith("WITH "),
          );
          expect(reportStatements).toHaveLength(1);
          results.push({
            reverseUnorderedSelects,
            dto: actual.value,
            reportSql: reportStatements[0]!,
          });
        }
        expect(results[0]?.dto).toEqual(results[1]?.dto);
        const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
        if (artifactDir) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(artifactDir, { recursive: true });
          await writeFile(
            artifactDir + "/geo-ordering-reverse-unordered-selects.json",
            JSON.stringify(results, null, 2),
            "utf8",
          );
        }
      } finally {
        db.exec("PRAGMA reverse_unordered_selects = OFF");
        db.prepare("DELETE FROM custom_events WHERE event_id = ?").run(eventId);
      }
    },
  );

  it("falls back on real TEXT duration controls without exposing fused rows", async () => {
    const visitId = "geo-sf-1";
    const original = db
      .prepare(
        "SELECT duration_ms AS value, typeof(duration_ms) AS storageType FROM visits WHERE visit_id = ?",
      )
      .get(visitId) as {
      readonly value: number | string | null;
      readonly storageType: string;
    };
    try {
      db.prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?").run(
        "text-duration",
        visitId,
      );
      const stored = db
        .prepare(
          "SELECT duration_ms AS value, typeof(duration_ms) AS storageType FROM visits WHERE visit_id = ?",
        )
        .get(visitId) as {
        readonly value: string;
        readonly storageType: string;
      };
      expect(stored).toEqual({ value: "text-duration", storageType: "text" });

      const forwarded = await forwardGeoCountQuery({
        scope: "session",
        filter: "countDistinct(page.durationMs) eq 2",
        limit: 50,
      });
      const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
      if (!deferred) throw new Error("wave97i_geo_numeric_request_missing");
      const compilation = compileGeoPointsQualificationProgram({ deferred });
      if (compilation.kind !== "compiled")
        throw new Error("wave97i_geo_numeric_control_unavailable");
      expect(compilation.evidence.compatibilityFields).toContainEqual(
        expect.objectContaining({ fieldId: "page.durationMs" }),
      );

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const baseDatabase = createSqliteD1Database(db, trace);
      let fusedCalls = 0;
      let fusedRows: Record<string, unknown>[] = [];
      const database = {
        prepare(sql: string) {
          const statement = baseDatabase.prepare(sql) as unknown as {
            bind: (...bindings: unknown[]) => unknown;
            all: (...args: unknown[]) => Promise<D1Result<unknown>>;
          };
          const originalAll = statement.all.bind(statement);
          statement.all = async (...args) => {
            const result = await originalAll(...args);
            if (sql !== compilation.evidence.sql) return result;
            fusedCalls += 1;
            fusedRows = result.results as Record<string, unknown>[];
            const invalidCountOutput =
              compilation.evidence.compatibilityFields[0]?.outputName;
            const control = fusedRows.find((row) => row.rowKind === "control");
            if (
              !invalidCountOutput ||
              typeof control?.[invalidCountOutput] !== "number" ||
              control[invalidCountOutput] < 1
            )
              throw new Error(
                `wave97i_geo_numeric_guard_not_observed:${String(control?.[invalidCountOutput ?? ""])}`,
              );
            return {
              ...result,
              results: fusedRows.map((row) =>
                row.rowKind === "report"
                  ? {
                      ...row,
                      ...(row.outputId === "journey-geo-points"
                        ? { city: "fused-report-must-not-leak" }
                        : { views: 999_999 }),
                    }
                  : row,
              ),
            } as D1Result<unknown>;
          };
          return statement as unknown as D1Database["prepare"] extends (
            sql: string,
          ) => infer Prepared
            ? Prepared
            : never;
        },
        batch: baseDatabase.batch.bind(baseDatabase),
      } as unknown as D1Database;
      const provider = createD1SiteProviderRegistry({
        env: { DB: database } as Env,
        siteId: SITE,
      }).resolve("geo-points");
      if (!provider) throw new Error("wave97i_geo_points_provider_missing");
      const actual = await provider.execute(geoProviderQuery(forwarded));
      const expected = legacyAggregate(filters([]), 50, WINDOW, {
        column: "session_id",
        ids: ["s1"],
      });
      const invalidCountOutput =
        compilation.evidence.compatibilityFields[0]!.outputName;
      const legacyGeoReportStatements = trace.preparedSql.filter(
        (sql) =>
          sql !== compilation.evidence.sql &&
          sql.trimStart().startsWith("WITH ") &&
          (sql.includes('AS "latitude"') || sql.includes('AS "views"')),
      );

      expect(fusedCalls).toBe(1);
      expect(fusedRows.filter((row) => row.rowKind === "report")).toHaveLength(
        0,
      );
      expect(
        fusedRows.find((row) => row.rowKind === "control")?.[
          invalidCountOutput
        ],
      ).toBe(1);
      expect(legacyGeoReportStatements).toHaveLength(1);
      expect(
        trace.preparedSql.filter((sql) => sql === compilation.evidence.sql),
      ).toHaveLength(1);
      expect(sortedPoints(actual.value.points)).toEqual(
        sortedPoints(expected.points),
      );
      expect(actual.value.countryCounts).toEqual(expected.countryCounts);
      expect(actual.value.regionCounts).toEqual(expected.regionCounts);
      expect(actual.value.cityCounts).toEqual(expected.cityCounts);
      expect(JSON.stringify(actual.value)).not.toContain(
        "fused-report-must-not-leak",
      );
      expect(JSON.stringify(actual.value)).not.toContain("999999");

      const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
      if (artifactDir) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(artifactDir, { recursive: true });
        await writeFile(
          `${artifactDir}/geo-real-text-numeric-fallback.json`,
          JSON.stringify(
            {
              sqliteStorage: stored,
              guard: compilation.evidence.compatibilityFields,
              guardInvalidCount: fusedRows.find(
                (row) => row.rowKind === "control",
              )?.[compilation.evidence.compatibilityFields[0]!.outputName],
              fusedCalls,
              fusedReportRows: fusedRows.filter(
                (row) => row.rowKind === "report",
              ).length,
              statementCount: trace.preparedSql.length,
              fusedStatementCount: trace.preparedSql.filter(
                (sql) => sql === compilation.evidence.sql,
              ).length,
              dto: actual.value,
              expected,
            },
            null,
            2,
          ),
          "utf8",
        );
      }
    } finally {
      db.prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?").run(
        original.value,
        visitId,
      );
    }
  });

  itWithGeoQualificationEvent(
    "orders same-named envelope fields by output and preserves unscoped ordering",
    async () => {
      const temporaryVisitIds = [
        "geo-envelope-null-country",
        "geo-envelope-canada",
      ];
      try {
        addVisit(db, {
          id: temporaryVisitIds[0]!,
          site,
          session: "s1",
          visitor: "v1",
          time: 140,
          latitude: 20,
          longitude: 30,
          country: "",
          region: "",
          regionCode: "",
          city: "Null country",
        });
        addVisit(db, {
          id: temporaryVisitIds[1]!,
          site,
          session: "s1",
          visitor: "v1",
          time: 141,
          latitude: 21,
          longitude: 31,
          country: "CA",
          region: "Ontario",
          regionCode: "ON",
          city: "Toronto fixture",
        });

        const forwarded = await forwardGeoCountQuery({
          scope: "session",
          filter: 'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1',
          limit: 50,
        });
        const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
        if (!deferred) throw new Error("wave97i_geo_ordering_request_missing");
        const request = deferred.qualification;
        const plan = buildJourneyGeoPointsQualificationPlan({
          siteId: request.siteId,
          queryTime: request.requestTime,
          filters: request.filters,
          scopePlan: request.metadata.plan,
          count: request.countInput,
          limit: deferred.configuration.limit,
          level: deferred.configuration.summaryLevel,
        });
        const pointOutputId = "journey-geo-points";
        const summaryOutputId = "journey-geo-country-summary";
        const pointOutput = plan.plan.outputs.find(
          (output) => output.id === pointOutputId,
        );
        const summaryOutput = plan.plan.outputs.find(
          (output) => output.id === summaryOutputId,
        );
        const controlsOutput = plan.plan.outputs.find(
          (output) => output.id === plan.controlOutputId,
        );
        if (!pointOutput || !summaryOutput || !controlsOutput)
          throw new Error("wave97i_geo_ordering_output_missing");
        const pointFields = [
          "latitude",
          "longitude",
          "timestampMs",
          "country",
          "region",
          "regionCode",
          "city",
          "pointCount",
        ];
        const summaryFields = ["country", "views", "sessions", "visitors"];
        const reportFields = [
          ...pointFields,
          ...summaryFields.filter((field) => !pointFields.includes(field)),
        ];
        const qualification = {
          plan: plan.plan,
          primaryReportSourceRelationId: plan.primaryReportSourceRelationId,
          controlsRelationId: controlsOutput.relation,
          controlOutputId: plan.controlOutputId,
          numericCompatibilityFields: plan.numericCompatibilityFields,
          scope: plan.scope,
          reportSourceRelations: plan.reportSourceRelations,
          groupedSummaryRelationId: plan.groupedSummaryRelationId,
        };
        const compileEnvelope = (
          ordering?: readonly QualificationEnvelopeOrderingDescriptor[],
        ) =>
          compileQualificationProgramEnvelope({
            qualification,
            siteId: request.siteId,
            reports: [
              {
                output: pointOutput,
                fields: pointFields,
                rowType: "journey-geo-points",
              },
              {
                output: summaryOutput,
                fields: summaryFields,
                rowType: "journey-geo-country-summary",
              },
            ],
            controlsOutput,
            reportFields,
            controlFields: controlsOutput.fields.map(({ name }) => name),
            ...(ordering === undefined ? {} : { ordering }),
            errorPrefix: "geo_envelope_contract",
            fallbackTag: "analytics.geo_envelope_contract",
          });

        const unscopedCompilation = compileEnvelope([
          { field: "country", direction: "asc", nulls: "first" },
        ]);
        const unscopedReverseCompilation = compileEnvelope([
          { field: "country", direction: "desc", nulls: "last" },
        ]);
        if (
          unscopedCompilation.kind !== "compiled" ||
          unscopedReverseCompilation.kind !== "compiled"
        )
          throw new Error("wave97i_geo_ordering_compile_unavailable");
        expect(unscopedCompilation.evidence.bindings).toEqual(
          unscopedReverseCompilation.evidence.bindings,
        );
        expect(unscopedCompilation.evidence.ordering.at(-1)).toEqual({
          field: "country",
          outputId: undefined,
          direction: "asc",
          nulls: "first",
        });

        const scopedOrdering: QualificationEnvelopeOrderingDescriptor[] = [
          {
            field: "country",
            outputId: pointOutputId,
            direction: "desc",
            nulls: "last",
          },
          {
            field: "country",
            outputId: summaryOutputId,
            direction: "asc",
            nulls: "first",
          },
        ];
        const scopedCompilation = compileEnvelope(scopedOrdering);
        if (scopedCompilation.kind !== "compiled")
          throw new Error("wave97i_geo_scoped_ordering_unavailable");
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const rows = await queryD1CompiledAll(
          sqliteEnv(db, trace),
          scopedCompilation.query,
        );
        const countriesFor = (outputId: string) =>
          rows
            .filter(
              (row) => row.rowKind === "report" && row.outputId === outputId,
            )
            .map((row) => row.country ?? null);
        expect(countriesFor(pointOutputId)).toEqual(["US", "CA", ""]);
        expect(countriesFor(summaryOutputId)).toEqual(["", "CA", "US"]);
        const controlRow = rows.find((row) => row.rowKind === "control");
        expect(controlRow?.country).toBeNull();
        expect(
          scopedCompilation.evidence.ordering.filter(
            ({ field, outputId }) =>
              field === "country" && outputId !== undefined,
          ),
        ).toEqual([
          {
            field: "country",
            outputId: pointOutputId,
            direction: "desc",
            nulls: "last",
          },
          {
            field: "country",
            outputId: summaryOutputId,
            direction: "asc",
            nulls: "first",
          },
        ]);
        expect(scopedCompilation.evidence.sql).toMatch(/IS NULL/iu);
        expect(trace.preparedSql).toHaveLength(1);

        expect(() =>
          compileEnvelope([
            {
              field: "country",
              outputId: "not-a-report-output",
              direction: "asc",
              nulls: "first",
            },
          ]),
        ).toThrow("geo_envelope_contract_envelope_order_invalid:country");
        expect(() =>
          compileEnvelope([
            {
              field: "country",
              outputId: pointOutputId,
              direction: "asc",
              nulls: "first",
            },
            {
              field: "country",
              outputId: pointOutputId,
              direction: "desc",
              nulls: "last",
            },
          ]),
        ).toThrow("geo_envelope_contract_envelope_order_invalid:country");

        const artifactDir = process.env.WAVE97I_ARTIFACT_DIR;
        if (artifactDir) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(artifactDir, { recursive: true });
          await writeFile(
            `${artifactDir}/qualification-envelope-output-ordering.json`,
            JSON.stringify(
              {
                outputOrdering: scopedOrdering,
                pointCountries: countriesFor(pointOutputId),
                summaryCountries: countriesFor(summaryOutputId),
                controlCountryIsNull: controlRow?.country === null,
                unknownOutputRejected: true,
                duplicateScopedOrderRejected: true,
                unscopedBindingsUnchanged: true,
                unscopedOrdering: unscopedCompilation.evidence.ordering.at(-1),
                bindingCount: scopedCompilation.evidence.bindingCount,
                reportStatementCount: trace.preparedSql.length,
              },
              null,
              2,
            ),
            "utf8",
          );
        }
      } finally {
        db.prepare(
          `DELETE FROM visits WHERE visit_id IN (${temporaryVisitIds.map(() => "?").join(",")})`,
        ).run(...temporaryVisitIds);
      }
    },
  );

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

  it("matches direct 40-payload filters and records country, region, and city budgets", async () => {
    addDirectPayloadEvents(db);
    const payloadConditions = Array.from({ length: 40 }, (_unused, index) => ({
      kind: "condition" as const,
      target: {
        kind: "event-payload" as const,
        path: `/field-${index}`,
      },
      operator: "eq" as const,
      value: `value-${index}`,
    }));
    const directPayloadFilters = (
      geoConditions: readonly {
        readonly field: string;
        readonly value: string;
      }[] = [],
    ) =>
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "and",
            children: [
              ...payloadConditions,
              ...geoConditions.map(({ field, value }) => ({
                kind: "condition" as const,
                target: { kind: "field" as const, field },
                operator: "eq" as const,
                value,
              })),
            ],
          },
        },
        analyticsFilterRegistry,
      );
    const countryFilters = directPayloadFilters();
    const legacyStatements: CapturedSqlStatement[] = [];
    const expected = legacyParentCountryAggregate(
      countryFilters,
      100,
      WINDOW,
      (statement) => legacyStatements.push(statement),
    );
    expect(legacyStatements).toHaveLength(2);
    expect(expected.points).toHaveLength(1);
    expect(expected.points[0]!.pointCount).toBe(1);
    expect(expected.countryCounts).toEqual([
      { country: "US", views: 1, sessions: 1, visitors: 1 },
    ]);

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
          countryFilters,
          100,
          diagnostics,
        ),
      ),
    );
    expect(sortedPoints(actual.points)).toEqual(sortedPoints(expected.points));
    expect(actual.countryCounts).toEqual(expected.countryCounts);
    expect(actual.regionCounts).toEqual(expected.regionCounts);
    expect(actual.cityCounts).toEqual(expected.cityCounts);
    expect(actual.points[0]!.pointCount).toBe(1);
    const record = await logger.emitWhenComplete();
    const observations = record.logs.filter((entry) =>
      entry.message.startsWith("db.query.v1.all.success"),
    );
    expect(record.performance.d1Statements).toBe(2);
    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.bindings).toHaveLength(2);
    expect(observations).toHaveLength(2);
    const encodeBudget = (statement: CapturedSqlStatement) => ({
      sqlBytes: new TextEncoder().encode(statement.sql).byteLength,
      bindings: statement.bindings.length,
    });
    const legacyBudgets = legacyStatements.map(encodeBudget);
    const countryBudgets = trace.preparedSql.map((sql, index) => {
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
      return {
        sqlBytes,
        bindings,
        physicalPlanHash: observations[index]!.data?.physicalPlanHash,
      };
    });
    expect(diagnostics.rowsReadAvailable).toBe(false);

    const summaryBudgets: Array<{
      readonly level: "region" | "city";
      readonly statements: number;
      readonly reads: readonly {
        readonly sqlBytes: number;
        readonly bindings: number;
        readonly physicalPlanHash: unknown;
      }[];
      readonly compileOnly: true;
    }> = [];
    // Country is the real SQLite differential; the added geography predicates
    // only probe the exact public-reader SQL emitted for region and city.
    for (const { level, filters: scopedFilters } of [
      {
        level: "region" as const,
        filters: directPayloadFilters([{ field: "geo.country", value: "US" }]),
      },
      {
        level: "city" as const,
        filters: directPayloadFilters([
          { field: "geo.country", value: "US" },
          { field: "geo.region", value: "California" },
        ]),
      },
    ]) {
      const statements: CapturedSqlStatement[] = [];
      const compileLogger = createInvocationLogger({
        source: "worker",
        trigger: "request",
      });
      const compileDiagnostics = createD1ReadDiagnostics();
      await runWithInvocationLogger(compileLogger, () =>
        runWithD1Operation(OPERATION, () =>
          queryGeoPointsFromD1(
            instrumentEnv(capturedSqlEnv(statements), compileLogger),
            SITE,
            WINDOW,
            scopedFilters,
            100,
            compileDiagnostics,
          ),
        ),
      );
      const compileRecord = await compileLogger.emitWhenComplete();
      const compileObservations = compileRecord.logs.filter((entry) =>
        entry.message.startsWith("db.query.v1.all.success"),
      );
      expect(compileRecord.performance.d1Statements).toBe(2);
      expect(statements).toHaveLength(2);
      expect(compileObservations).toHaveLength(2);
      const reads = statements.map((statement, index) => {
        const sqlBytes = new TextEncoder().encode(statement.sql).byteLength;
        const bindings = statement.bindings.length;
        expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
        expect(compileObservations[index]!.data).toMatchObject({
          tag: OPERATION,
          operation: "all",
          status: "success",
          sqlBytes,
          bindings,
          physicalPlanHash: expect.stringMatching(/^v\d+:/u),
        });
        return {
          sqlBytes,
          bindings,
          physicalPlanHash: compileObservations[index]!.data?.physicalPlanHash,
        };
      });
      summaryBudgets.push({
        level,
        statements: compileRecord.performance.d1Statements ?? 0,
        reads,
        compileOnly: true,
      });
    }

    expect(legacyBudgets).toHaveLength(2);
    expect(countryBudgets).toHaveLength(2);
    expect(summaryBudgets.map(({ level }) => level)).toEqual([
      "region",
      "city",
    ]);
    expect(
      summaryBudgets.every(
        ({ statements, reads, compileOnly }) =>
          statements === 2 && reads.length === 2 && compileOnly,
      ),
    ).toBe(true);
  });

  it("records public-reader budgets for plain and prepared payload identity inputs", async () => {
    const plain = filters([]);
    const fortyPayloadFilters = normalizeFilterDocument(
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
    const preparedPayload = prepareFilters(fortyPayloadFilters, "event");
    const preparedFortyPayload = attachAdvancedMatches(preparedPayload, {
      visitIds: fortyPageIds.map((id) => ({ siteId: SITE, id })),
      eventIds: [],
    });
    for (const [label, document] of [
      ["plain", plain],
      ["prepared-payload-identity", preparedFortyPayload],
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
      if (label === "prepared-payload-identity") {
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

describe("97DR private Geo whole-Boolean qualification", () => {
  itWithGeoQualificationEvent(
    "97DR Geo mixed OR without Geo fields uses whole Count and matches the legacy DTO",
    async () => {
      const nativeId = "geo-97dr-native-only";
      addVisit(db, {
        id: nativeId,
        site,
        session: nativeId,
        visitor: nativeId,
        time: 142,
        latitude: 12.5,
        longitude: 13.5,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "San Diego",
      });
      db.prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?").run(
        "/native-only",
        nativeId,
      );
      try {
        const filterDsl =
          'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 or page.path eq "/native-only"';
        const filters = parseFilterDsl(filterDsl, analyticsFilterRegistry);
        const prepared = prepareScopedQuery("geo-points", {
          context: siteQueryContext(SITE, "private-dashboard"),
          time: createQueryTime(
            WINDOW.startMs,
            WINDOW.endExclusiveMs,
            WINDOW.timeZone,
            WINDOW.nowMs,
          ),
          filters,
          scopePreference: "session",
        } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
          readonly filters?: FilterDocument;
          readonly scopePlan?: ScopedFilterPlan;
          readonly time: QueryTime;
        };
        const query = {
          ...prepared,
          filters: prepared.filters ?? filters,
          limit: 50,
        } as QueryInput & Record<string, unknown>;
        const preflight = await d1AdvancedFilterMiddleware(
          sqliteEnv(db),
          undefined,
          SITE,
        )("geo-points", query, async (value) => value);
        const deferred = deferredGeoPointsQualificationFromQuery(preflight);
        expect(deferred).toBeDefined();
        if (!deferred) throw new Error("wave97dr_geo_deferred_missing");
        expect(deferred.filterMode).toBe("allow-whole-filter");
        expect(deferred.configuration.summaryLevel).toBe("country");
        expect(deferred.qualification.metadata.plan.advancedMatches).toBe(
          undefined,
        );

        const compilation = compileGeoPointsQualificationProgram({ deferred });
        expect(compilation.kind).toBe("compiled");
        if (compilation.kind !== "compiled") return;
        expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
        expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
        expect(
          compilation.evidence.outputDescriptors.map(
            ({ outputId }) => outputId,
          ),
        ).toEqual(["journey-geo-points", "journey-geo-country-summary"]);

        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        );
        const advancedMatches =
          scopedFilterMetadata(fallbackFilters)?.plan.advancedMatches;
        if (!advancedMatches)
          throw new Error("wave97dr_geo_fallback_matches_missing");
        const matchingIds =
          advancedMatches.entityIds?.map(({ id }) => id) ?? [];
        expect(matchingIds).toContain("s1");
        expect(matchingIds).toContain(nativeId);

        const legacyFilters = attachAdvancedMatches(
          prepareFilters(EMPTY_FILTER_DOCUMENT, "session"),
          advancedMatches,
        );
        const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const legacy = await queryGeoPointsFromD1(
          sqliteEnv(db, legacyTrace),
          SITE,
          WINDOW,
          legacyFilters,
          50,
        );
        const runtimeTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const provider = createD1SiteProviderRegistry({
          env: sqliteEnv(db, runtimeTrace),
          siteId: SITE,
        }).resolve("geo-points");
        if (!provider) throw new Error("wave97dr_geo_provider_missing");
        const actual = await provider.execute(query as never);
        expect(actual.value).toEqual(legacy);
        expect(
          runtimeTrace.preparedSql.filter(
            (sql) => sql === compilation.evidence.sql,
          ),
        ).toHaveLength(1);
        const evidenceDirectory = process.env.WAVE97DR_EVIDENCE_DIR;
        if (evidenceDirectory) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          await mkdir(evidenceDirectory, { recursive: true });
          await writeFile(
            join(evidenceDirectory, "geo-whole-or-country.json"),
            JSON.stringify(
              {
                operation: "geo-points",
                summaryLevel: deferred.configuration.summaryLevel,
                scope: "session",
                filterDsl,
                filterMode: deferred.filterMode,
                matchingIds,
                actualDto: actual.value,
                legacyDto: legacy,
                compiledSql: compilation.evidence.sql,
                compiledBindings: compilation.evidence.bindings,
                sqlBytes: compilation.evidence.sqlBytes,
                bindingCount: compilation.evidence.bindingCount,
                outputs: compilation.evidence.outputDescriptors,
                runtimeStatements: runtimeTrace.preparedSql.map(
                  (sql, index) => ({
                    sql,
                    bindings: runtimeTrace.bindings[index],
                  }),
                ),
                legacyStatements: legacyTrace.preparedSql.map((sql, index) => ({
                  sql,
                  bindings: legacyTrace.bindings[index],
                })),
              },
              null,
              2,
            ),
            "utf8",
          );
        }
      } finally {
        db.prepare("DELETE FROM visits WHERE visit_id = ?").run(nativeId);
      }
    },
  );

  const prefixedCases = [
    { level: "region", prefix: 'geo.country eq "US"' },
    {
      level: "city",
      prefix: 'geo.country eq "US" and geo.region eq "California"',
    },
  ] as const;

  itWithGeoQualificationEvent(
    "97DU suppresses both Geo report outputs when one candidate is outside the comparison domain",
    async () => {
      const validVisitId = "wave97du-geo-valid-owner";
      const invalidVisitId = "wave97du-geo-invalid-owner";
      const suppressionWindow: QueryWindow = {
        ...WINDOW,
        startMs: 139,
        endExclusiveMs: 141,
      };
      addVisit(db, {
        id: validVisitId,
        site,
        session: "wave97du-valid-session",
        visitor: "wave97du-valid-visitor",
        time: 140,
        latitude: 37.7,
        longitude: -122.4,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "Oakland",
      });
      addVisit(db, {
        id: invalidVisitId,
        site,
        session: "wave97du-invalid-session",
        visitor: "wave97du-invalid-visitor",
        time: 140,
        latitude: 37.8,
        longitude: -122.5,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "Oakland",
      });
      addGeoQualificationEventForVisit(
        db,
        validVisitId,
        "wave97du-valid-event",
      );
      addGeoQualificationEventForVisit(
        db,
        invalidVisitId,
        "wave97du-invalid-event",
      );
      db.prepare("UPDATE visits SET country = ? WHERE visit_id = ?").run(
        "é",
        invalidVisitId,
      );

      try {
        const filterDsl =
          'geo.country eq "US" and (count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 or page.path eq "/native-only")';
        const filters = parseFilterDsl(filterDsl, analyticsFilterRegistry);
        const prepared = prepareScopedQuery("geo-points", {
          context: siteQueryContext(SITE, "private-dashboard"),
          time: createQueryTime(
            suppressionWindow.startMs,
            suppressionWindow.endExclusiveMs,
            suppressionWindow.timeZone,
            suppressionWindow.nowMs,
          ),
          filters,
          scopePreference: "session",
        } as QueryInput & { readonly time: QueryTime });
        const query = {
          ...prepared,
          filters:
            (prepared as QueryInput & { readonly filters?: FilterDocument })
              .filters ?? filters,
          limit: 50,
        } as QueryInput & Record<string, unknown>;
        const forwarded = await d1AdvancedFilterMiddleware(
          sqliteEnv(db),
          undefined,
          SITE,
        )("geo-points", query, async (value) => value);
        const forwardedQuery = forwarded as QueryInput &
          Record<string, unknown>;
        const deferred =
          deferredGeoPointsQualificationFromQuery(forwardedQuery);
        expect(deferred).toBeDefined();
        if (!deferred) throw new Error("wave97du_geo_domain_deferred_missing");
        expect(deferred.qualification.requestTime?.range).toMatchObject({
          startMs: suppressionWindow.startMs,
          endExclusiveMs: suppressionWindow.endExclusiveMs,
        });
        const compilation = compileGeoPointsQualificationProgram({ deferred });
        expect(compilation, JSON.stringify(compilation)).toMatchObject({
          kind: "compiled",
        });
        if (compilation.kind !== "compiled") return;

        expect(compilation.evidence.outputDescriptors).toHaveLength(2);

        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        );
        const legacy = await queryGeoPointsFromD1(
          sqliteEnv(db),
          SITE,
          suppressionWindow,
          fallbackFilters,
          50,
        );
        expect(legacy.points.length).toBeGreaterThan(0);

        const runtimeTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const runtimeReads: CapturedD1AllResult[] = [];
        const runtimeDiagnostics = createD1ReadDiagnostics();
        const provider = createD1SiteProviderRegistry({
          env: sqliteEnv(db, runtimeTrace, (read) => runtimeReads.push(read)),
          siteId: SITE,
          diagnostics: runtimeDiagnostics,
        }).resolve("geo-points");
        if (!provider) throw new Error("wave97du_geo_provider_missing");
        const actual = await provider.execute(query as never);
        expect(actual.value).toEqual(legacy);
        const statements = geoStatementEvidence(
          runtimeTrace,
          compilation.evidence.sql,
        );
        expect(
          statements.filter(
            ({ statementClass }) => statementClass === "fact-envelope",
          ),
        ).toHaveLength(1);
        const compiledReads = runtimeReads.filter(
          ({ sql }) => sql === compilation.evidence.sql,
        );
        const compiledRead = compiledReads[0];
        const envelopeRows = compiledRead ? capturedRows(compiledRead) : [];
        const reportRows = envelopeRows.filter(
          (row) => row.rowKind === "report",
        );
        const controlRows = envelopeRows.filter(
          (row) => row.rowKind === "control",
        );
        const fallbackReason =
          runtimeDiagnostics.advancedCountSqlFallbackReason;
        await writeGeoEvidence("domain-suppression.json", {
          contract: "97DU domain failure suppresses report output",
          filterDsl,
          scope: "session",
          window: suppressionWindow,
          owners: [
            {
              visitId: validVisitId,
              sessionId: "wave97du-valid-session",
              visitorId: "wave97du-valid-visitor",
              eventTimeMs: 140,
              country: "US",
            },
            {
              visitId: invalidVisitId,
              sessionId: "wave97du-invalid-session",
              visitorId: "wave97du-invalid-visitor",
              eventTimeMs: 140,
              country: "é",
            },
          ],
          outsideWindowAnomaly: {
            visitId: "geo-null-coordinate",
            timeMs: 128,
            reason: "empty session and visitor are outside the request window",
          },
          compiledEvidence: compilation.evidence,
          runtimeStatements: statements,
          runtimeReads,
          compiledRows: envelopeRows,
          controlRows,
          reportRows,
          fallbackReason,
          diagnostics: { ...runtimeDiagnostics },
          actualDto: actual.value,
          legacyDto: legacy,
        });

        expect(actual.value).toEqual(legacy);
        expect(compiledReads).toHaveLength(1);
        expect(reportRows).toHaveLength(0);
        expect(controlRows).toHaveLength(1);
        expect(controlRows[0]).toMatchObject({
          invalidComparisonGeoCountryCount: expect.any(Number),
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          invalidIdentityCount: 0,
          duplicateIdentityCount: 0,
        });
        expect(
          controlRows[0]?.invalidComparisonGeoCountryCount,
        ).toBeGreaterThan(0);
        expect(fallbackReason?.kind).toBe("comparison-data-domain");
        if (!fallbackReason || fallbackReason.kind !== "comparison-data-domain")
          throw new Error("wave97dw_geo_comparison_fallback_reason_missing");
        expect(fallbackReason.fields.map(({ fieldId }) => fieldId)).toContain(
          "geo.country",
        );
        const numericCompatibilityFields =
          compilation.evidence.compatibilityFields.filter(
            ({ kind }) => kind === "numeric",
          );
        expect(
          numericCompatibilityFields.map(({ outputName }) => ({
            outputName,
            value: controlRows[0]?.[outputName],
          })),
        ).toEqual(
          numericCompatibilityFields.map(({ outputName }) => ({
            outputName,
            value: 0,
          })),
        );
      } finally {
        db.prepare("DELETE FROM visits WHERE visit_id IN (?, ?)").run(
          validVisitId,
          invalidVisitId,
        );
      }
    },
  );

  it.each(prefixedCases)(
    "97DU Geo $level-prefixed mixed Count filter uses the bound comparison gate and matches legacy",
    async ({ prefix, level }) =>
      withGeoQualificationEvent(async () => {
        const nativeVisitId = "wave97du-prefix-native";
        const countVisitId = "wave97du-prefix-count";
        const nativeSessionId = "wave97du-prefix-native-session";
        const nativeWindow: QueryWindow = {
          ...WINDOW,
          startMs: 139,
          endExclusiveMs: 141,
        };
        try {
          addVisit(db, {
            id: nativeVisitId,
            site,
            session: nativeSessionId,
            visitor: "wave97du-prefix-native-visitor",
            time: 140,
            latitude: 37.7,
            longitude: -122.4,
            country: "US",
            region: "California",
            regionCode: "CA",
            city: "Oakland",
          });
          addVisit(db, {
            id: countVisitId,
            site,
            session: "s1",
            visitor: "v1",
            time: 140,
            latitude: 37.7,
            longitude: -122.4,
            country: "US",
            region: "California",
            regionCode: "CA",
            city: "San Francisco",
          });
          db.prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?").run(
            "/native-only",
            nativeVisitId,
          );
          const filterDsl = `${prefix} and (count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 or page.path eq "/native-only")`;
          const filters = parseFilterDsl(filterDsl, analyticsFilterRegistry);
          const prepared = prepareScopedQuery("geo-points", {
            context: siteQueryContext(SITE, "private-dashboard"),
            time: createQueryTime(
              nativeWindow.startMs,
              nativeWindow.endExclusiveMs,
              nativeWindow.timeZone,
              nativeWindow.nowMs,
            ),
            filters,
            scopePreference: "session",
          } as QueryInput & { readonly time: QueryTime });
          const requestFilters =
            (prepared as QueryInput & { readonly filters?: FilterDocument })
              .filters ?? filters;
          const query = {
            ...prepared,
            filters: requestFilters,
            limit: 50,
          } as QueryInput & Record<string, unknown>;
          expect(scopedFilterMetadata(requestFilters)?.plan.scope).toBe(
            "session",
          );
          const defaultCountSupport = classifyAdvancedCountFilter(
            requestFilters,
            "session",
          );
          expect(defaultCountSupport).toMatchObject({
            kind: "unsupported",
            code: "count_sql_bare_field_requires_registered_string",
          });

          const forwarded = await d1AdvancedFilterMiddleware(
            sqliteEnv(db),
            undefined,
            SITE,
          )("geo-points", query, async (value) => value);
          const forwardedQuery = forwarded as QueryInput &
            Record<string, unknown>;
          const deferred =
            deferredGeoPointsQualificationFromQuery(forwardedQuery);
          expect(deferred).toBeDefined();
          if (!deferred) throw new Error("wave97du_geo_deferred_missing");
          expect(deferred.filterMode).toBe("allow-whole-filter");
          expect(deferred.configuration.summaryLevel).toBe(level);

          const compilation = compileGeoPointsQualificationProgram({
            deferred,
          });
          expect(compilation, JSON.stringify(compilation)).toMatchObject({
            kind: "compiled",
          });
          if (compilation.kind !== "compiled") return;
          expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
          expect(
            compilation.evidence.groupedSummaryProof
              .matchingSharedRelationCount,
          ).toBe(1);
          expect(compilation.evidence.groupedSummaryProof.materialization).toBe(
            "materialized",
          );
          expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
          expect(compilation.evidence.outputDescriptors).toHaveLength(2);

          const semanticPlan = buildJourneyGeoPointsQualificationPlan({
            siteId: deferred.qualification.siteId,
            queryTime: deferred.qualification.requestTime!,
            filters: deferred.qualification.filters,
            scopePlan: deferred.qualification.metadata.plan,
            count: deferred.qualification.countInput,
            limit: deferred.configuration.limit,
            level: deferred.configuration.summaryLevel,
            filterMode: deferred.filterMode,
          });
          const provenance = semanticPlan.comparisonProvenance;
          const expectedFieldIds =
            level === "region"
              ? ["geo.country"]
              : ["geo.country", "geo.region"];
          expect(
            [...new Set(provenance.map(({ fieldId }) => fieldId))].sort(),
          ).toEqual(expectedFieldIds);
          const witness = provenance[0]?.rawCountEligibilityWitness;
          expect(witness).toBeDefined();
          if (!witness) throw new Error("wave97du_geo_witness_missing");
          if (semanticPlan.scope === "event")
            throw new Error("wave97du_geo_comparison_requires_owner_scope");
          const bindingInput = {
            plan: semanticPlan.plan,
            provenance,
            siteId: deferred.qualification.siteId,
            scope: semanticPlan.scope,
            reportSourceRelationIds: semanticPlan.reportSourceRelations.map(
              ({ relationId }) => relationId,
            ),
            rawCountEligibilityWitness: witness,
          };
          const mismatchedSlot = semanticPlan.plan.slots.find(
            (slot) => slot.type.kind === "entity",
          )?.id;
          expect(mismatchedSlot).toBeDefined();
          expect(() =>
            createRegisteredComparisonAdmissionBinding({
              ...bindingInput,
              provenance: [
                { ...provenance[0]!, slotId: mismatchedSlot! },
                ...provenance.slice(1),
              ],
            }),
          ).toThrow("comparison_domain_admission_provenance_invalid");
          expect(() =>
            createRegisteredComparisonAdmissionBinding({
              ...bindingInput,
              reportSourceRelationIds: [
                ...bindingInput.reportSourceRelationIds,
                provenance[0]!.relationId,
              ],
            }),
          ).toThrow("comparison_domain_admission_provenance_invalid");
          const reusableBinding =
            createRegisteredComparisonAdmissionBinding(bindingInput);
          const owner = {};
          expect(
            reusableBinding.attach(owner, { ...semanticPlan.plan } as never),
          ).toBe(false);
          expect(reusableBinding.attach(owner, semanticPlan.plan)).toBe(true);
          const selectedRelations = new Set(
            provenance.map(({ relationId }) => relationId),
          );
          expect(
            reusableBinding.begin(owner, semanticPlan.plan, selectedRelations),
          ).toBe(true);
          reusableBinding.finish(owner);
          expect(
            reusableBinding.begin(owner, semanticPlan.plan, selectedRelations),
          ).toBe(false);

          const comparisonFields = expectedFieldIds.map((fieldId) => ({
            kind: "comparison",
            fieldId,
            outputName:
              fieldId === "geo.country"
                ? "invalidComparisonGeoCountryCount"
                : "invalidComparisonGeoRegionCount",
            semanticProfile: "case-folded-text",
            adapterDomain: "ascii-text-no-nul",
          }));
          expect(compilation.evidence.compatibilityFields).toEqual(
            expect.arrayContaining(comparisonFields),
          );
          expect(compilation.evidence.controlFields).toEqual(
            expect.arrayContaining(
              comparisonFields.map(({ outputName }) => outputName),
            ),
          );

          const fallbackFilters =
            await prepareDeferredEventQualificationFallback(
              deferred.qualification,
            );
          const fallbackMatches =
            scopedFilterMetadata(fallbackFilters)?.plan.advancedMatches;
          expect(fallbackMatches).toBeDefined();
          if (!fallbackMatches)
            throw new Error("wave97du_geo_fallback_matches_missing");
          const matchingIds =
            fallbackMatches.entityIds?.map(({ id }) => id) ?? [];
          expect(matchingIds).toEqual(
            expect.arrayContaining(["s1", nativeSessionId]),
          );
          expect(new Set(["s1", nativeSessionId]).size).toBe(2);
          expect(
            db
              .prepare(
                "SELECT pathname, session_id AS sessionId FROM visits WHERE visit_id = ?",
              )
              .get(countVisitId),
          ).toEqual({ pathname: "/geo", sessionId: "s1" });
          expect(
            db
              .prepare(
                "SELECT pathname, session_id AS sessionId FROM visits WHERE visit_id = ?",
              )
              .get(nativeVisitId),
          ).toEqual({ pathname: "/native-only", sessionId: nativeSessionId });
          const countEventsForSession = (sessionId: string): number => {
            const row = db
              .prepare(
                `SELECT COUNT(*) AS eventCount
                 FROM custom_events AS events
                 JOIN custom_event_names AS names
                   ON names.id = events.event_name_id
                 JOIN visits AS event_visits
                   ON event_visits.visit_id = events.visit_id
                 WHERE events.site_pk = ?
                   AND events.occurred_at >= ?
                   AND events.occurred_at < ?
                   AND event_visits.session_id = ?
                   AND names.name = ?`,
              )
              .get(
                site.pk,
                nativeWindow.startMs,
                nativeWindow.endExclusiveMs,
                sessionId,
                "wave97i-geo-qualifier",
              ) as { readonly eventCount: number };
            return Number(row.eventCount);
          };
          expect(countEventsForSession("s1")).toBe(1);
          expect(countEventsForSession(nativeSessionId)).toBe(0);
          const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
          const legacy = await queryGeoPointsFromD1(
            sqliteEnv(db, legacyTrace),
            SITE,
            nativeWindow,
            fallbackFilters,
            50,
          );
          expect(legacy.points.length).toBeGreaterThan(0);
          if (level === "region") {
            expect(legacy.regionCounts).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  label: "California",
                  views: 2,
                  sessions: 2,
                  visitors: 2,
                }),
              ]),
            );
          } else {
            expect(legacy.cityCounts).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  label: "Oakland",
                  views: 1,
                  sessions: 1,
                  visitors: 1,
                }),
                expect.objectContaining({
                  label: "San Francisco",
                  views: 1,
                  sessions: 1,
                  visitors: 1,
                }),
              ]),
            );
          }

          const runtimeTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
          const runtimeDiagnostics = createD1ReadDiagnostics();
          const runtimeReads: CapturedD1AllResult[] = [];
          const provider = createD1SiteProviderRegistry({
            env: sqliteEnv(db, runtimeTrace, (read) => runtimeReads.push(read)),
            siteId: SITE,
            diagnostics: runtimeDiagnostics,
          }).resolve("geo-points");
          if (!provider) throw new Error("wave97du_geo_provider_missing");
          const actual = await provider.execute(query as never);
          expect(actual.value).toEqual(legacy);
          const statements = geoStatementEvidence(
            runtimeTrace,
            compilation.evidence.sql,
          );
          expect(
            statements.filter(
              ({ statementClass }) => statementClass === "fact-envelope",
            ),
          ).toHaveLength(1);
          expect(
            statements.filter(
              ({ statementClass }) => statementClass === "site-metadata",
            ),
          ).toHaveLength(1);
          expect(
            statements.filter(
              ({ statementClass }) => statementClass === "legacy-fallback-fact",
            ),
          ).toHaveLength(0);
          expect(
            statements.filter(
              ({ statementClass }) => statementClass === "other",
            ),
          ).toHaveLength(0);
          expect(
            runtimeDiagnostics.advancedCountSqlFallbackReason,
          ).toBeUndefined();
          const compiledReads = runtimeReads.filter(
            ({ sql }) => sql === compilation.evidence.sql,
          );
          expect(compiledReads).toHaveLength(1);
          const envelopeRows = capturedRows(compiledReads[0]!);
          const reportRows = envelopeRows.filter(
            (row) => row.rowKind === "report",
          );
          const controlRows = envelopeRows.filter(
            (row) => row.rowKind === "control",
          );
          expect(reportRows.length).toBeGreaterThan(0);
          expect(controlRows).toHaveLength(1);
          await writeGeoEvidence(`prefix-${level}.json`, {
            contract: `97DU Geo ${level} whole-filter comparison domain`,
            filterDsl,
            scope: "session",
            summaryLevel: level,
            window: nativeWindow,
            independentOwners: {
              countOnly: "s1",
              nativeOnly: nativeSessionId,
            },
            matchingIds,
            compiledEvidence: compilation.evidence,
            runtimeStatements: statements,
            compiledRows: envelopeRows,
            controlRows,
            reportRows,
            diagnostics: { ...runtimeDiagnostics },
            actualDto: actual.value,
            legacyDto: legacy,
          });
        } finally {
          db.prepare("DELETE FROM visits WHERE visit_id IN (?, ?)").run(
            nativeVisitId,
            countVisitId,
          );
        }
      }),
  );
  itWithGeoQualificationEvent(
    "97DR Geo keeps split-only AND adjacency and rejects mode state",
    async () => {
      const forwarded = await forwardGeoCountQuery({
        scope: "session",
        filter:
          'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 and geo.country eq "US"',
        limit: 50,
      });
      const deferred = deferredGeoPointsQualificationFromQuery(forwarded);
      expect(deferred).toBeDefined();
      if (!deferred) throw new Error("wave97dr_geo_and_deferred_missing");
      expect(deferred.filterMode).toBe("split-only");
      const compilation = compileGeoPointsQualificationProgram({ deferred });
      expect(compilation.kind).toBe("compiled");

      const mixedFilters = parseFilterDsl(
        'count(event { event.name eq "wave97i-geo-qualifier" }) eq 1 or page.path eq "/geo"',
        analyticsFilterRegistry,
      );
      const prepared = prepareScopedQuery("geo-points", {
        context: siteQueryContext(SITE, "private-dashboard"),
        time: createQueryTime(
          WINDOW.startMs,
          WINDOW.endExclusiveMs,
          WINDOW.timeZone,
          WINDOW.nowMs,
        ),
        filters: mixedFilters,
        scopePreference: "session",
      } as QueryInput & { readonly time: QueryTime });
      const nonCanonical = {
        ...prepared,
        limit: 50,
        mode: "breakdown",
      } as QueryInput & Record<string, unknown>;
      const rejected = await d1AdvancedFilterMiddleware(
        sqliteEnv(db),
        undefined,
        SITE,
      )("geo-points", nonCanonical, async (value) => value);
      expect(deferredGeoPointsQualificationFromQuery(rejected)).toBeUndefined();
    },
  );
});
