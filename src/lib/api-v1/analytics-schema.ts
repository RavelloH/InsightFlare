import { apiV1RouteRegistry } from "@/lib/api-v1/route-registry";
import type { AnalyticsSchemaData } from "@/lib/api-v1/wire";
import { analyticsOperationById } from "@/lib/edge/analytics/application/operation-registry";
import {
  FILTER_DOCUMENT_VERSION,
  FILTER_OPERATOR_IDS,
} from "@/lib/edge/analytics/contract";
import { INTERVALS, TIME_PRESETS } from "@/lib/edge/analytics/contract/catalog";
import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";

function metricType(key: string): "integer" | "rate" | "duration_ms" {
  if (key.endsWith("Rate")) return "rate";
  if (key.endsWith("Ms")) return "duration_ms";
  return "integer";
}

export interface AnalyticsSchemaClock {
  readonly now?: () => string;
}

function analyticsSchemaOperations(
  subject: "site" | "team",
  siteId?: string,
): AnalyticsSchemaData["operations"] {
  const prefix = `${subject}.analytics.`;
  return apiV1RouteRegistry
    .filter(
      (route) =>
        route.lifecycle === "exposed" &&
        route.id.startsWith(prefix) &&
        (subject === "team" || route.path.includes("{siteId}")),
    )
    .flatMap((route) => {
      if (route.method !== "GET" && route.method !== "POST") return [];
      return [
        {
          id: route.id,
          method: route.method,
          path: siteId
            ? route.path.replace("{siteId}", encodeURIComponent(siteId))
            : route.path,
        },
      ];
    });
}

/** Builds the catalog from the canonical analytics/filter registries. */
export function buildSiteAnalyticsSchema(
  siteId: string,
  clock: AnalyticsSchemaClock = {},
): AnalyticsSchemaData {
  const latestAvailableAt = clock.now?.() ?? new Date().toISOString();
  const overview = analyticsOperationById("site.analytics.overview");
  if (!overview) throw new Error("analytics_overview_operation_missing");
  return {
    metrics: overview.schema.metrics.map((key) => ({
      key,
      label: key,
      type: metricType(key),
      description: `Analytics metric: ${key}.`,
    })),
    dimensions: overview.schema.dimensions.map((key) => ({
      key,
      label: key,
      type: "string" as const,
      description: `Analytics dimension: ${key}.`,
    })),
    filters: [...analyticsFilterRegistry.keys()],
    operators: [...FILTER_OPERATOR_IDS],
    filterProtocol: {
      version: FILTER_DOCUMENT_VERSION,
      fields: [...analyticsFilterRegistry.entries()].map(([id, field]) => ({
        id,
        valueKind: field.valueKind,
        operators: [...field.operators],
      })),
    },
    intervals: [...INTERVALS],
    presets: [...TIME_PRESETS],
    timeRange: { earliestAvailableAt: null, latestAvailableAt },
    operations: analyticsSchemaOperations("site", siteId),
    links: {
      overview: `/api/v1/sites/${encodeURIComponent(siteId)}/analytics/overview`,
    },
  };
}

export function buildTeamAnalyticsSchema(
  clock: AnalyticsSchemaClock = {},
): AnalyticsSchemaData {
  const latestAvailableAt = clock.now?.() ?? new Date().toISOString();
  const overview = analyticsOperationById("team.analytics.overview");
  if (!overview) throw new Error("team_analytics_overview_operation_missing");
  return {
    metrics: overview.schema.metrics.map((key) => ({
      key,
      label: key,
      type: metricType(key),
      description: `Analytics metric: ${key}.`,
    })),
    dimensions: overview.schema.dimensions.map((key) => ({
      key,
      label: key,
      type: "string" as const,
      description: `Analytics dimension: ${key}.`,
    })),
    filters: [...analyticsFilterRegistry.keys()],
    operators: [...FILTER_OPERATOR_IDS],
    filterProtocol: {
      version: FILTER_DOCUMENT_VERSION,
      fields: [...analyticsFilterRegistry.entries()].map(([id, field]) => ({
        id,
        valueKind: field.valueKind,
        operators: [...field.operators],
      })),
    },
    intervals: [...INTERVALS],
    presets: [...TIME_PRESETS],
    timeRange: { earliestAvailableAt: null, latestAvailableAt },
    operations: analyticsSchemaOperations("team"),
    links: { overview: "/api/v1/team/analytics/overview" },
  };
}
