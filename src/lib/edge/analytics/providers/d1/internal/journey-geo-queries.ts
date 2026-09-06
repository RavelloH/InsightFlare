import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
} from "@/lib/dashboard/geo-location";
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
  const coordinateClause = filter?.clause ? "AND" : "WHERE";
  const pointsSql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
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
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
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
  const points = (
    await queryD1All<Record<string, unknown>>(
      env,
      pointsSql,
      [
        ...(scopedDataset
          ? scopedDataset.bindings.map((binding) => binding.value)
          : [
              ...visitSourceBindings(siteId, window),
              ...(filter?.bindings ?? []),
            ]),
        limit,
      ],
      diagnostics,
    )
  ).map(mapGeoPointRow);

  const countryCounts: GeoCountryCountRow[] = [];
  const regionCounts: GeoDimensionCountRow[] = [];
  const cityCounts: GeoDimensionCountRow[] = [];

  if (!parsedGeo?.country) {
    const countrySql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    country,
    session_id AS sessionId,
    visitor_id AS visitorId
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
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
    countryCounts.push(
      ...(
        await queryD1All<Record<string, unknown>>(
          env,
          countrySql,
          scopedDataset
            ? scopedDataset.bindings.map((binding) => binding.value)
            : [
                ...visitSourceBindings(siteId, window),
                ...(filter?.bindings ?? []),
              ],
          diagnostics,
        )
      ).map((row) => ({
        country: String(row.country ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      })),
    );
  } else if (!parsedGeo.regionCode) {
    const regionSql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    country,
    region,
    region_code AS regionCode,
    session_id AS sessionId,
    visitor_id AS visitorId
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
)
SELECT
  country,
  regionCode,
  region,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
FROM filtered_visits
WHERE
  TRIM(COALESCE(country, '')) != ''
  AND (
    TRIM(COALESCE(regionCode, '')) != ''
    OR TRIM(COALESCE(region, '')) != ''
  )
GROUP BY country, regionCode, region
ORDER BY views DESC, sessions DESC, region ASC, regionCode ASC
LIMIT 400
`;
    regionCounts.push(
      ...(
        await queryD1All<Record<string, unknown>>(
          env,
          regionSql,
          scopedDataset
            ? scopedDataset.bindings.map((binding) => binding.value)
            : [
                ...visitSourceBindings(siteId, window),
                ...(filter?.bindings ?? []),
              ],
          diagnostics,
        )
      )
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
    const citySql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT
    country,
    region,
    region_code AS regionCode,
    city,
    session_id AS sessionId,
    visitor_id AS visitorId
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
)
SELECT
  country,
  regionCode,
  region,
  city,
  count(*) AS views,
  count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors
FROM filtered_visits
WHERE
  TRIM(COALESCE(country, '')) != ''
  AND TRIM(COALESCE(city, '')) != ''
GROUP BY country, regionCode, region, city
ORDER BY views DESC, sessions DESC, city ASC
LIMIT 600
`;
    cityCounts.push(
      ...(
        await queryD1All<Record<string, unknown>>(
          env,
          citySql,
          scopedDataset
            ? scopedDataset.bindings.map((binding) => binding.value)
            : [
                ...visitSourceBindings(siteId, window),
                ...(filter?.bindings ?? []),
              ],
          diagnostics,
        )
      )
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
