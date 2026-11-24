import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
} from "@/lib/analytics/geo-location";
import type { Env } from "@/lib/edge/types";

import type {
  FilterDocument,
  GeoCountryCountRow,
  GeoDimensionCountRow,
  GeoPointAggregate,
  GeoPointRow,
  QueryWindow,
} from "./core";
import {
  buildTargetVisitSourceCte,
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  targetVisitSourceBindings,
  visitSourceBindings,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import { mapGeoPointRow } from "./journey-helpers";
import { scopedDatasetFor } from "./scoped-dataset";
export async function querySessionLocationPointsFromD1(
  env: Env,
  siteId: string,
  sessionId: string,
): Promise<GeoPointRow[]> {
  const sql = `
WITH
${buildTargetVisitSourceCte("session_id")},
filtered_visits AS (
  SELECT *
  FROM visit_source
)
SELECT
  latitude,
  longitude,
  started_at AS timestampMs,
  country,
  region,
  region_code AS regionCode,
  city
FROM filtered_visits
WHERE
  latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND ABS(latitude) <= 90
  AND ABS(longitude) <= 180
ORDER BY timestampMs ASC, visit_id ASC
`;
  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...targetVisitSourceBindings(siteId, sessionId),
    ])
  ).map(mapGeoPointRow);
}
export async function queryGeoPointsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  diagnostics?: D1ReadDiagnostics,
): Promise<GeoPointAggregate> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", { window });
  const conditions =
    filters.root?.kind === "and"
      ? filters.root.children
      : [filters.root].filter(Boolean);
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
  const parsedGeo = {
    country: valueFor("geo.country"),
    regionCode: valueFor("geo.region"),
    city: valueFor("geo.city"),
  };
  const level = !parsedGeo.country
    ? "country"
    : !parsedGeo.regionCode
      ? "region"
      : "city";
  const source = scopedDataset?.visitRelation ?? "visit_source";
  const bindings = scopedDataset
    ? scopedDataset.bindings.map((binding) => binding.value)
    : [...visitSourceBindings(siteId, window), ...(filter?.bindings ?? [])];
  const coordinateClause = filter?.clause ? "AND" : "WHERE";
  const pointRollup = (
    relation: string,
    clause: string,
    coordinate: string,
  ) => `
  SELECT
    ROUND(latitude, 3) AS lat_bucket,
    ROUND(longitude, 3) AS lon_bucket,
    country, region, region_code AS regionCode, city,
    MAX(started_at) AS latest_at,
    COUNT(*) AS point_count
  FROM ${relation}
  ${clause}
  ${coordinate}
    latitude IS NOT NULL
    AND longitude IS NOT NULL
    AND ABS(latitude) <= 90
    AND ABS(longitude) <= 180
  GROUP BY lat_bucket, lon_bucket, country, region, region_code, city
`;
  const pointSelect = (relation: string) => `
SELECT
  lat_bucket AS latitude, lon_bucket AS longitude, latest_at AS timestampMs,
  country, region, regionCode, city, point_count AS pointCount
FROM ${relation}
ORDER BY timestampMs DESC
LIMIT ?
`;
  const countColumns =
    level === "country"
      ? "country"
      : level === "region"
        ? "country, regionCode, region"
        : "country, regionCode, region, city";
  const countWhere =
    level === "country"
      ? ""
      : level === "region"
        ? `
WHERE TRIM(COALESCE(country, '')) != ''
  AND (TRIM(COALESCE(regionCode, '')) != '' OR TRIM(COALESCE(region, '')) != '')
`
        : `
WHERE TRIM(COALESCE(country, '')) != ''
  AND TRIM(COALESCE(city, '')) != ''
`;
  const countOrder =
    level === "country"
      ? "country ASC"
      : level === "region"
        ? "region ASC, regionCode ASC"
        : "city ASC";
  const countLimit = level === "country" ? 300 : level === "region" ? 400 : 600;
  const countSelect = (relation: string) => `
SELECT
  ${countColumns},
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
FROM ${relation}
${countWhere}
GROUP BY ${countColumns}
ORDER BY views DESC, sessions DESC, ${countOrder}
LIMIT ${countLimit}
`;
  let pointRows: Record<string, unknown>[];
  let countRows: Record<string, unknown>[];
  // Prepared filters can require expensive entity qualification. Materialize
  // their final authorized visits only once, without filtering out invalid
  // coordinates from the independent country/region/city totals.
  // Keep the direct compatibility reader separate: for empty unprepared
  // filters, materializing the extra relation can increase billed reads.
  if (scopedDataset) {
    const countRegion =
      level === "country" ? "NULL, NULL" : "region, regionCode";
    const countCity = level === "city" ? "city" : "NULL";
    const rows = await queryD1All<Record<string, unknown>>(
      env,
      `
WITH
${scopedDataset.ctes},
shared_geo_visits AS MATERIALIZED (
  SELECT latitude, longitude, country, region, region_code,
    region_code AS regionCode, city, started_at,
    session_id AS sessionId, visitor_id AS visitorId
  FROM ${source}
),
point_rollup AS (${pointRollup("shared_geo_visits", "", "WHERE")}),
geo_points AS (${pointSelect("point_rollup")}),
geo_counts AS (${countSelect("shared_geo_visits")})
SELECT 'point' AS rowKind, latitude, longitude, timestampMs, country,
  region, regionCode, city, pointCount, NULL AS views, NULL AS sessions, NULL AS visitors
FROM geo_points
UNION ALL
SELECT 'count', NULL, NULL, NULL, country, ${countRegion}, ${countCity},
  NULL, views, sessions, visitors
FROM geo_counts
`,
      [...bindings, limit],
      diagnostics,
    );
    pointRows = rows.filter((row) => row.rowKind === "point");
    countRows = rows.filter((row) => row.rowKind === "count");
  } else {
    const ctes = buildVisitSourceCte();
    const pointsSql = `
WITH
${ctes},
filtered_visits AS (${pointRollup(source, filter?.clause ?? "", coordinateClause)})
${pointSelect("filtered_visits")}
`;
    const countsSql = `
WITH
${ctes},
filtered_visits AS (
  SELECT country, region, region_code AS regionCode, city,
    session_id AS sessionId, visitor_id AS visitorId
  FROM ${source}
  ${filter?.clause ?? ""}
)
${countSelect("filtered_visits")}
`;
    pointRows = await queryD1All<Record<string, unknown>>(
      env,
      pointsSql,
      [...bindings, limit],
      diagnostics,
    );
    countRows = await queryD1All<Record<string, unknown>>(
      env,
      countsSql,
      bindings,
      diagnostics,
    );
  }
  const points = pointRows.map(mapGeoPointRow);
  const countryCounts: GeoCountryCountRow[] = [];
  const regionCounts: GeoDimensionCountRow[] = [];
  const cityCounts: GeoDimensionCountRow[] = [];

  if (!parsedGeo?.country) {
    countryCounts.push(
      ...countRows.map((row) => ({
        country: String(row.country ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      })),
    );
  } else if (!parsedGeo.regionCode) {
    regionCounts.push(
      ...countRows
        .map((row) => {
          const country = String(row.country ?? "")
            .trim()
            .toUpperCase();
          const regionCode = String(row.regionCode ?? "")
            .trim()
            .toUpperCase();
          const regionName = String(row.region ?? "").trim() || regionCode;
          const value = buildRegionLocationValue(
            country,
            regionCode || regionName,
            regionName || regionCode,
          );
          if (!value) return null;
          return {
            value,
            label: regionName || regionCode,
            views: Number(row.views ?? 0),
            sessions: Number(row.sessions ?? 0),
            visitors: Number(row.visitors ?? 0),
          };
        })
        .filter((row): row is GeoDimensionCountRow => Boolean(row)),
    );
  } else {
    cityCounts.push(
      ...countRows
        .map((row) => {
          const country = String(row.country ?? "")
            .trim()
            .toUpperCase();
          const regionCode = String(row.regionCode ?? "")
            .trim()
            .toUpperCase();
          const regionName = String(row.region ?? "").trim() || regionCode;
          const city = String(row.city ?? "").trim();
          const value = buildLocalityLocationValue(
            country,
            regionCode || null,
            regionName || null,
            city,
          );
          if (!value || !city) return null;
          return {
            value,
            label: city,
            views: Number(row.views ?? 0),
            sessions: Number(row.sessions ?? 0),
            visitors: Number(row.visitors ?? 0),
          };
        })
        .filter((row): row is GeoDimensionCountRow => Boolean(row)),
    );
  }

  return {
    points,
    countryCounts,
    regionCounts,
    cityCounts,
  };
}
