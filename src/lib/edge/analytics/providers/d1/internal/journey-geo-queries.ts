import {
  buildLocalityLocationValue,
  buildRegionLocationValue,
} from "@/lib/analytics/geo-location";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  buildJourneyGeoPointsPlan,
  buildJourneyGeoSummaryPlan,
  type JourneyGeoSummaryLevel,
} from "@/lib/edge/analytics/engine/journey-geo-report-plan";
import { buildJourneySessionLocationPlan } from "@/lib/edge/analytics/engine/journey-page-report-plan";
import type { Env } from "@/lib/edge/types";

import type {
  FilterDocument,
  GeoCountryCountRow,
  GeoDimensionCountRow,
  GeoPointAggregate,
  GeoPointRow,
  QueryWindow,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import { mapGeoPointRow } from "./journey-helpers";
import { queryJourneyPageReportRowsFromD1 } from "./journey-page-report-query";

export async function querySessionLocationPointsFromD1(
  env: Env,
  siteId: string,
  sessionId: string,
): Promise<GeoPointRow[]> {
  return (
    await queryJourneyPageReportRowsFromD1(
      env,
      buildJourneySessionLocationPlan({ siteId, sessionId }),
      "journey-session-location-points",
    )
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
  const metadata = scopedFilterMetadata(filters);
  const planInput = {
    siteId,
    // Page reports consume the reader window for prepared scopes so time
    // cannot silently expand to the filter-preparation window.
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
  };
  const points = (
    await queryJourneyPageReportRowsFromD1(
      env,
      buildJourneyGeoPointsPlan({ ...planInput, limit }),
      "journey-geo-points",
      diagnostics,
    )
  ).map(mapGeoPointRow);

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
  const summaryLevel: JourneyGeoSummaryLevel = !parsedGeo.country
    ? "country"
    : !parsedGeo.regionCode
      ? "region"
      : "city";
  const summaryRows = await queryJourneyPageReportRowsFromD1(
    env,
    buildJourneyGeoSummaryPlan({ ...planInput, level: summaryLevel }),
    `journey-geo-${summaryLevel}-summary`,
    diagnostics,
  );

  const countryCounts: GeoCountryCountRow[] = [];
  const regionCounts: GeoDimensionCountRow[] = [];
  const cityCounts: GeoDimensionCountRow[] = [];
  if (summaryLevel === "country") {
    countryCounts.push(
      ...summaryRows.map((row) => ({
        country: String(row.country ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      })),
    );
  } else if (summaryLevel === "region") {
    regionCounts.push(
      ...summaryRows
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
      ...summaryRows
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

  return { points, countryCounts, regionCounts, cityCounts };
}
