import { z } from "zod";

import {
  createEnvelopeSchema,
  createPaginatedEnvelopeSchema,
  registerSchema,
} from "./common";

// ─── Shared Enums ───────────────────────────────────────────────────────

export const IntervalSchema = z
  .enum(["minute", "hour", "day", "week", "month"])
  .describe("Time bucket granularity for aggregation");

export const QueryNameSchema = z
  .enum([
    "overview",
    "trend",
    "pages",
    "referrers",
    "funnels",
    "pages-dashboard",
    "page-hash",
    "page-query",
    "event-types",
    "events-summary",
    "events-trend",
    "events-records",
    "event-type-field-values",
    "event-type-detail",
    "event-record-detail",
    "sessions",
    "session-detail",
    "visitors",
    "visitor-detail",
    "retention",
    "performance",
    "browser-trend",
    "browser-engine-trend",
    "browser-version-breakdown",
    "browser-cross-breakdown",
    "browser-radar",
    "referrer-radar",
    "referrer-dimension-trend",
    "client-dimension-trend",
    "utm-dimension-trend",
    "client-cross-breakdown",
    "utm-source",
    "utm-medium",
    "utm-campaign",
    "utm-term",
    "utm-content",
    "countries",
    "filter-options",
    "overview-page-path",
    "overview-page-title",
    "overview-page-hostname",
    "overview-page-entry",
    "overview-page-exit",
    "overview-source-domain",
    "overview-source-link",
    "overview-client-browser",
    "overview-client-os-version",
    "overview-client-device-type",
    "overview-client-language",
    "overview-client-screen-size",
    "overview-geo-country",
    "overview-geo-region",
    "overview-geo-city",
    "overview-geo-continent",
    "overview-geo-timezone",
    "overview-geo-organization",
    "overview-geo-points",
  ])
  .describe("Analytics query type identifier");

// ─── Shared Query Parameters ────────────────────────────────────────────

export const DashboardFiltersSchema = z.object({
  country: z.string().optional(),
  device: z.string().optional(),
  browser: z.string().optional(),
  path: z.string().optional(),
  query: z.string().optional(),
  title: z.string().optional(),
  hostname: z.string().optional(),
  entry: z.string().optional(),
  exit: z.string().optional(),
  sourceDomain: z.string().optional(),
  sourceLink: z.string().optional(),
  clientBrowser: z.string().optional(),
  clientOsVersion: z.string().optional(),
  clientDeviceType: z.string().optional(),
  clientLanguage: z.string().optional(),
  clientScreenSize: z.string().optional(),
  geo: z.string().optional(),
  geoCountry: z.string().optional(),
  geoRegion: z.string().optional(),
  geoCity: z.string().optional(),
  geoContinent: z.string().optional(),
  geoTimezone: z.string().optional(),
  geoOrganization: z.string().optional(),
});

export const AnalyticsQueryParamsSchema = z.object({
  from: z.coerce
    .number()
    .int()
    .optional()
    .describe("Start timestamp (Unix ms)"),
  to: z.coerce.number().int().optional().describe("End timestamp (Unix ms)"),
  interval: IntervalSchema,
  timeZone: z.string().optional().describe("IANA timezone identifier"),
  limit: z.coerce.number().int().optional(),
});

export const PaginatedQueryParamsSchema = AnalyticsQueryParamsSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  search: z.string().optional(),
});

// ─── Response Data Schemas ──────────────────────────────────────────────

// overview
export const OverviewDataSchema = z
  .object({
    views: z.number().int(),
    sessions: z.number().int(),
    visitors: z.number().int(),
    bounces: z.number().int(),
    totalDurationMs: z.number().int(),
    avgDurationMs: z.number(),
    bounceRate: z.number(),
    approximateVisitors: z.boolean(),
  })
  .describe("Aggregated overview metrics for a site");

// trend
export const TrendRowSchema = z.object({
  bucket: z.number().int().describe("Bucket timestamp (Unix ms)"),
  timestampMs: z.number().int().describe("Bucket timestamp (Unix ms)"),
  views: z.number().int(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  bounces: z.number().int().optional(),
  totalDurationMs: z.number().int().optional(),
  avgDurationMs: z.number().optional(),
});

// pages
export const PageRowSchema = z.object({
  pathname: z.string().max(2048),
  query: z.string().max(2048).optional(),
  hash: z.string().max(512).optional(),
  views: z.number().int(),
  sessions: z.number().int(),
});

// referrers
export const ReferrerRowSchema = z.object({
  referrer: z.string().max(4096),
  views: z.number().int(),
  sessions: z.number().int(),
  visitors: z.number().int().optional(),
});

// pages-dashboard
export const PageDashboardTrendPointSchema = z.object({
  timestampMs: z.number().int(),
  views: z.number().int(),
  visitors: z.number().int(),
});

export const PageDashboardMetricsSchema = z.object({
  views: z.number().int(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  bounceRate: z.number(),
  pagesPerSession: z.number(),
  avgDurationMs: z.number(),
});

export const PageDashboardChangeRatesSchema = z.object({
  views: z.number(),
  visitors: z.number(),
  sessions: z.number(),
  bounceRate: z.number(),
  pagesPerSession: z.number(),
  avgDurationMs: z.number(),
});

export const PageDashboardRowSchema = z.object({
  pathname: z.string(),
  titles: z.array(z.string()),
  trend: z.array(PageDashboardTrendPointSchema),
  metrics: PageDashboardMetricsSchema,
  changeRates: PageDashboardChangeRatesSchema.optional(),
});

// visitors
export const VisitorRowSchema = z.object({
  visitorId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  firstSeenAt: z.number().int().describe("Unix timestamp in seconds"),
  lastSeenAt: z.number().int().describe("Unix timestamp in seconds"),
  views: z.number().int(),
  sessions: z.number().int(),
  events: z.number().int().optional(),
  country: z.string().max(64).optional(),
  region: z.string().max(128).optional(),
  regionCode: z.string().max(8).optional(),
  city: z.string().max(128).optional(),
  referrerHost: z.string().max(255).optional(),
  referrerUrl: z.string().max(4096).optional(),
  browser: z.string().max(64).optional(),
  browserVersion: z.string().max(32).optional(),
  os: z.string().max(64).optional(),
  osVersion: z.string().max(32).optional(),
  deviceType: z.string().max(32).optional(),
  screenWidth: z.number().int().nullable().optional(),
  screenHeight: z.number().int().nullable().optional(),
});

// sessions
export const PerformanceMetricsSchema = z.object({
  ttfb: z.number().nullable().optional(),
  fcp: z.number().nullable().optional(),
  lcp: z.number().nullable().optional(),
  cls: z.number().nullable().optional(),
  inp: z.number().nullable().optional(),
});

export const SessionRowSchema = z.object({
  sessionId: z.string().uuid(),
  visitorId: z.string().uuid(),
  startedAt: z.number().int().describe("Unix timestamp in seconds"),
  endedAt: z.number().int().describe("Unix timestamp in seconds"),
  durationMs: z.number().int(),
  active: z.boolean(),
  views: z.number().int(),
  events: z.number().int(),
  bounce: z.boolean(),
  entryPath: z.string().max(2048),
  exitPath: z.string().max(2048),
  referrerHost: z.string().max(255).optional(),
  referrerUrl: z.string().max(4096).optional(),
  country: z.string().max(64),
  region: z.string().max(128).optional(),
  regionCode: z.string().max(8).optional(),
  city: z.string().max(128).optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  browser: z.string().max(64),
  browserVersion: z.string().max(32).optional(),
  os: z.string().max(64),
  osVersion: z.string().max(32).optional(),
  deviceType: z.string().max(32),
  screenWidth: z.number().int().nullable().optional(),
  screenHeight: z.number().int().nullable().optional(),
  performance: PerformanceMetricsSchema.optional(),
});

// visitor-detail
export const VisitorActivityRowSchema = z.object({
  date: z.string(),
  count: z.number().int(),
});

export const JourneyPageCountRowSchema = z.object({
  pathname: z.string(),
  views: z.number().int(),
});

export const JourneyEventCountRowSchema = z.object({
  eventType: z.string(),
  count: z.number().int(),
});

export const JourneyPerformanceMetricSummarySchema = z.object({
  avg: z.number().nullable(),
  p75: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  samples: z.number().int(),
});

export const VisitorDetailDataSchema = z.object({
  visitor: z.object({
    visitorId: z.string().uuid(),
    firstSeenAt: z.number().int(),
    lastSeenAt: z.number().int(),
    country: z.string().optional(),
    browser: z.string().optional(),
    os: z.string().optional(),
    deviceType: z.string().optional(),
  }),
  metrics: z.object({
    totalEvents: z.number().int(),
    sessions: z.number().int(),
    views: z.number().int(),
    avgEventsPerSession: z.number(),
    bounceRate: z.number(),
    avgDurationMs: z.number(),
    p90DurationMs: z.number(),
    firstSeenAt: z.number().int(),
    lastSeenAt: z.number().int(),
    daysActive: z.number().int(),
    conversionEvents: z.number().int(),
    avgTimeBetweenSessionsMs: z.number(),
  }),
  sessions: z.array(SessionRowSchema),
  events: z.array(z.unknown()),
  visitedPages: z.array(JourneyPageCountRowSchema),
  eventDistribution: z.array(JourneyEventCountRowSchema),
  activity: z.array(VisitorActivityRowSchema),
  performance: z.object({
    ttfb: JourneyPerformanceMetricSummarySchema,
    fcp: JourneyPerformanceMetricSummarySchema,
    lcp: JourneyPerformanceMetricSummarySchema,
    cls: JourneyPerformanceMetricSummarySchema,
    inp: JourneyPerformanceMetricSummarySchema,
  }),
});

// retention
export const RetentionCohortPeriodSchema = z.object({
  index: z.number().int().describe("Period index (0 = cohort start)"),
  visitors: z.number().int(),
  rate: z.number().describe("Retention rate (0-1)"),
});

export const RetentionCohortSchema = z.object({
  bucket: z.number().int().describe("Cohort start timestamp (Unix ms)"),
  size: z.number().int().describe("Initial visitor count in cohort"),
  periods: z.array(RetentionCohortPeriodSchema),
});

export const RetentionDataSchema = z.object({
  granularity: IntervalSchema,
  cohorts: z.array(RetentionCohortSchema),
});

// performance
export const PerformanceSummaryStatsSchema = z.object({
  avg: z.number().nullable(),
  p50: z.number().nullable(),
  p75: z.number().nullable(),
  p95: z.number().nullable(),
  samples: z.number().int(),
});

export const PerformanceSummaryRowSchema = z.object({
  ttfb: PerformanceSummaryStatsSchema,
  fcp: PerformanceSummaryStatsSchema,
  lcp: PerformanceSummaryStatsSchema,
  cls: PerformanceSummaryStatsSchema,
  inp: PerformanceSummaryStatsSchema,
});

export const PerformanceTrendPointSchema = z.object({
  bucket: z.number().int(),
  timestampMs: z.number().int(),
  avg: z.number().nullable(),
  p50: z.number().nullable(),
  p75: z.number().nullable(),
  p95: z.number().nullable(),
  samples: z.number().int(),
});

export const PerformanceRouteRowSchema = z.object({
  pathname: z.string(),
  views: z.number().int(),
  metrics: PerformanceSummaryRowSchema,
});

export const PerformanceCountryRowSchema = z.object({
  country: z.string(),
  views: z.number().int(),
  metrics: PerformanceSummaryRowSchema,
});

export const PerformanceDataSchema = z.object({
  interval: IntervalSchema,
  summaries: PerformanceSummaryRowSchema,
  trends: z.record(z.string(), z.array(PerformanceTrendPointSchema)),
  routes: z.array(PerformanceRouteRowSchema),
  countries: z.array(PerformanceCountryRowSchema),
});

// share trend (browser-trend, client-dimension-trend, etc.)
export const ShareTrendSeriesEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  views: z.number().int(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  isOther: z.boolean().optional(),
});

export const ShareTrendDataPointSchema = z.object({
  bucket: z.number().int(),
  timestampMs: z.number().int(),
  totalVisitors: z.number().int(),
  visitorsBySeries: z.record(z.string(), z.number().int()),
});

export const ShareTrendDataSchema = z.object({
  interval: IntervalSchema,
  series: z.array(ShareTrendSeriesEntrySchema),
  data: z.array(ShareTrendDataPointSchema),
});

// event-types
export const EventTypeRowSchema = z.object({
  label: z.string(),
  views: z.number().int(),
  sessions: z.number().int(),
  visitors: z.number().int(),
});

// events-summary
export const EventsSummaryCardsSchema = z.object({
  event: z.object({
    name: z.array(EventTypeRowSchema),
  }),
  page: z.object({
    path: z.array(EventTypeRowSchema),
    title: z.array(EventTypeRowSchema),
    hostname: z.array(EventTypeRowSchema),
  }),
});

export const EventsSummaryDataSchema = z.object({
  summary: z.object({
    events: z.number().int(),
    eventTypes: z.number().int(),
    sessions: z.number().int(),
    visitors: z.number().int(),
    avgEventsPerSession: z.number(),
  }),
  cards: EventsSummaryCardsSchema,
});

// events-trend
export const EventTrendSeriesRowSchema = z.object({
  key: z.string(),
  eventName: z.string(),
  label: z.string(),
  events: z.number().int(),
  sessions: z.number().int(),
  visitors: z.number().int(),
});

export const EventTrendDataPointSchema = z.object({
  bucket: z.number().int(),
  timestampMs: z.number().int(),
  totalEvents: z.number().int(),
  eventsBySeries: z.record(z.string(), z.number().int()),
});

export const EventsTrendDataSchema = z.object({
  interval: IntervalSchema,
  series: z.array(EventTrendSeriesRowSchema),
  data: z.array(EventTrendDataPointSchema),
});

// browser-version-breakdown
export const BrowserVersionEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  views: z.number().int(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  isOther: z.boolean().optional(),
  isUnknown: z.boolean().optional(),
});

export const BrowserVersionBrowserSchema = z.object({
  browser: z.string(),
  views: z.number().int(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  versions: z.array(BrowserVersionEntrySchema),
});

// cross-breakdown
export const CrossBreakdownCellSchema = z.object({
  key: z.string(),
  label: z.string(),
  views: z.number().int(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  isOther: z.boolean().optional(),
  isUnknown: z.boolean().optional(),
});

export const CrossBreakdownRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  views: z.number().int(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  isOther: z.boolean().optional(),
  isUnknown: z.boolean().optional(),
  cells: z.array(CrossBreakdownCellSchema),
});

export const CrossBreakdownMatrixSchema = z.object({
  columns: z.array(CrossBreakdownCellSchema),
  rows: z.array(CrossBreakdownRowSchema),
  totalVisitors: z.number().int(),
});

// radar
export const RadarEntrySchema = z.object({
  browser: z.string().optional(),
  referrer: z.string().optional(),
  visitors: z.number().int(),
  sessions: z.number().int(),
  metrics: z.object({
    duration: z.number(),
    engagement: z.number(),
    depth: z.number(),
    loyalty: z.number(),
    frequency: z.number(),
    traffic: z.number(),
  }),
});

// geo points
export const GeoPointRowSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  timestampMs: z.number().int(),
  country: z.string(),
  region: z.string(),
  regionCode: z.string(),
  city: z.string(),
});

// dimension row (used by many overview-* queries)
export const DimensionRowSchema = z.object({
  label: z.string(),
  views: z.number().int(),
  sessions: z.number().int(),
  visitors: z.number().int(),
});

// geo tab row
export const GeoTabRowSchema = z.object({
  value: z.string(),
  label: z.string(),
  views: z.number().int(),
  sessions: z.number().int(),
  visitors: z.number().int(),
});

// filter-options
export const FilterOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  group: z.string().optional(),
});

// ─── Unified Response Schemas ───────────────────────────────────────────

// Overview response
export const OverviewResponseSchema = createEnvelopeSchema(OverviewDataSchema);

// Trend response
export const TrendResponseSchema = createEnvelopeSchema(
  z.object({
    interval: IntervalSchema,
    data: z.array(TrendRowSchema),
  }),
);

// Pages response
export const PagesResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(PageRowSchema),
  }),
);

// Referrers response
export const ReferrersResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(ReferrerRowSchema),
  }),
);

// Pages dashboard response (paginated)
export const PagesDashboardResponseSchema = createPaginatedEnvelopeSchema(
  z.object({
    interval: IntervalSchema,
    data: z.array(PageDashboardRowSchema),
  }),
);

// Visitors response (paginated)
export const VisitorsResponseSchema = createPaginatedEnvelopeSchema(
  z.object({
    data: z.array(VisitorRowSchema),
  }),
);

// Sessions response (paginated)
export const SessionsResponseSchema = createPaginatedEnvelopeSchema(
  z.object({
    data: z.array(SessionRowSchema),
  }),
);

// Visitor detail response
export const VisitorDetailResponseSchema = createEnvelopeSchema(
  z.object({
    data: VisitorDetailDataSchema,
  }),
);

// Retention response
export const RetentionResponseSchema =
  createEnvelopeSchema(RetentionDataSchema);

// Performance response
export const PerformanceResponseSchema = createEnvelopeSchema(
  z.object({
    interval: IntervalSchema,
    summaries: PerformanceSummaryRowSchema,
    trends: z.record(z.string(), z.array(PerformanceTrendPointSchema)),
    routes: z.array(PerformanceRouteRowSchema),
    countries: z.array(PerformanceCountryRowSchema),
  }),
);

// Share trend response (browser-trend, etc.)
export const ShareTrendResponseSchema = createEnvelopeSchema(
  z.object({
    interval: IntervalSchema,
    series: z.array(ShareTrendSeriesEntrySchema),
    data: z.array(ShareTrendDataPointSchema),
  }),
);

// Event types response
export const EventTypesResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(EventTypeRowSchema),
  }),
);

// Events summary response
export const EventsSummaryResponseSchema = createEnvelopeSchema(
  EventsSummaryDataSchema,
);

// Events trend response
export const EventsTrendResponseSchema = createEnvelopeSchema(
  z.object({
    interval: IntervalSchema,
    series: z.array(EventTrendSeriesRowSchema),
    data: z.array(EventTrendDataPointSchema),
  }),
);

// Funnel list response (reuses funnel.ts schema, but wrapped differently for analytics endpoint)
export const FunnelAnalyticsResponseSchema = createEnvelopeSchema(
  z.object({
    funnels: z.array(
      z.object({
        id: z.string().uuid(),
        siteId: z.string(),
        name: z.string(),
        steps: z.array(
          z.object({
            type: z.enum(["pageview", "event"]),
            value: z.string(),
          }),
        ),
        createdAt: z.number().int(),
        updatedAt: z.number().int(),
      }),
    ),
  }),
);

// Filter options response
export const FilterOptionsResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(FilterOptionSchema),
  }),
);

// Browser version breakdown response
export const BrowserVersionBreakdownResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(BrowserVersionBrowserSchema),
  }),
);

// Cross breakdown response
export const CrossBreakdownResponseSchema = createEnvelopeSchema(
  z.object({
    data: CrossBreakdownMatrixSchema,
  }),
);

// Radar response
export const RadarResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(RadarEntrySchema),
  }),
);

// Dimension response (generic, used by many overview-* queries)
export const DimensionResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(DimensionRowSchema),
  }),
);

// Geo tab response
export const GeoTabResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(GeoTabRowSchema),
  }),
);

// Geo points response
export const GeoPointsResponseSchema = createEnvelopeSchema(
  z.object({
    data: z.array(GeoPointRowSchema),
  }),
);

// Batch response
export const BatchResultItemSchema = z.object({
  id: z.string(),
  status: z.number().describe("HTTP status code of the sub-query response"),
  body: z
    .unknown()
    .nullable()
    .describe("Subrequest response body, or null for empty responses"),
});

export const BatchResponseSchema = createEnvelopeSchema(
  z.object({
    responses: z.array(BatchResultItemSchema),
  }),
).extend({
  meta: z.object({
    partialFailure: z
      .boolean()
      .describe("True if any sub-query returned a non-200 status"),
  }),
});

export const BatchInputSchema = z
  .object({
    requests: z
      .array(
        z
          .object({
            id: z.string(),
            method: z.literal("GET"),
            path: z.string().startsWith("/api/v1/"),
            query: z
              .record(
                z.string(),
                z.union([z.string(), z.number(), z.boolean(), z.null()]),
              )
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

// ─── Register ───────────────────────────────────────────────────────────

registerSchema("Interval", IntervalSchema);
registerSchema("QueryName", QueryNameSchema);
registerSchema("DashboardFilters", DashboardFiltersSchema);
registerSchema("AnalyticsQueryParams", AnalyticsQueryParamsSchema);
registerSchema("PaginatedQueryParams", PaginatedQueryParamsSchema);

// Data schemas
registerSchema("OverviewData", OverviewDataSchema);
registerSchema("TrendRow", TrendRowSchema);
registerSchema("PageRow", PageRowSchema);
registerSchema("ReferrerRow", ReferrerRowSchema);
registerSchema("PageDashboardRow", PageDashboardRowSchema);
registerSchema("VisitorRow", VisitorRowSchema);
registerSchema("SessionRow", SessionRowSchema);
registerSchema("PerformanceMetrics", PerformanceMetricsSchema);
registerSchema("PerformanceSummaryStats", PerformanceSummaryStatsSchema);
registerSchema("PerformanceSummaryRow", PerformanceSummaryRowSchema);
registerSchema("RetentionCohort", RetentionCohortSchema);
registerSchema("RetentionData", RetentionDataSchema);
registerSchema("PerformanceData", PerformanceDataSchema);
registerSchema("ShareTrendSeriesEntry", ShareTrendSeriesEntrySchema);
registerSchema("ShareTrendDataPoint", ShareTrendDataPointSchema);
registerSchema("ShareTrendData", ShareTrendDataSchema);
registerSchema("EventTypeRow", EventTypeRowSchema);
registerSchema("EventsSummaryData", EventsSummaryDataSchema);
registerSchema("EventTrendSeriesRow", EventTrendSeriesRowSchema);
registerSchema("EventTrendDataPoint", EventTrendDataPointSchema);
registerSchema("EventsTrendData", EventsTrendDataSchema);
registerSchema("BrowserVersionEntry", BrowserVersionEntrySchema);
registerSchema("BrowserVersionBrowser", BrowserVersionBrowserSchema);
registerSchema("CrossBreakdownCell", CrossBreakdownCellSchema);
registerSchema("CrossBreakdownRow", CrossBreakdownRowSchema);
registerSchema("CrossBreakdownMatrix", CrossBreakdownMatrixSchema);
registerSchema("RadarEntry", RadarEntrySchema);
registerSchema("GeoPointRow", GeoPointRowSchema);
registerSchema("DimensionRow", DimensionRowSchema);
registerSchema("GeoTabRow", GeoTabRowSchema);
registerSchema("FilterOption", FilterOptionSchema);
registerSchema("BatchResultItem", BatchResultItemSchema);

// Response schemas
registerSchema("OverviewResponse", OverviewResponseSchema);
registerSchema("TrendResponse", TrendResponseSchema);
registerSchema("PagesResponse", PagesResponseSchema);
registerSchema("ReferrersResponse", ReferrersResponseSchema);
registerSchema("PagesDashboardResponse", PagesDashboardResponseSchema);
registerSchema("VisitorsResponse", VisitorsResponseSchema);
registerSchema("SessionsResponse", SessionsResponseSchema);
registerSchema("VisitorDetailResponse", VisitorDetailResponseSchema);
registerSchema("RetentionResponse", RetentionResponseSchema);
registerSchema("PerformanceResponse", PerformanceResponseSchema);
registerSchema("ShareTrendResponse", ShareTrendResponseSchema);
registerSchema("EventTypesResponse", EventTypesResponseSchema);
registerSchema("EventsSummaryResponse", EventsSummaryResponseSchema);
registerSchema("EventsTrendResponse", EventsTrendResponseSchema);
registerSchema("FunnelAnalyticsResponse", FunnelAnalyticsResponseSchema);
registerSchema("FilterOptionsResponse", FilterOptionsResponseSchema);
registerSchema(
  "BrowserVersionBreakdownResponse",
  BrowserVersionBreakdownResponseSchema,
);
registerSchema("CrossBreakdownResponse", CrossBreakdownResponseSchema);
registerSchema("RadarResponse", RadarResponseSchema);
registerSchema("DimensionResponse", DimensionResponseSchema);
registerSchema("GeoTabResponse", GeoTabResponseSchema);
registerSchema("GeoPointsResponse", GeoPointsResponseSchema);
registerSchema("BatchResponse", BatchResponseSchema);
registerSchema("BatchInput", BatchInputSchema);

// ─── Types ──────────────────────────────────────────────────────────────

export type AnalyticsQueryParams = z.infer<typeof AnalyticsQueryParamsSchema>;
export type DashboardFilters = z.infer<typeof DashboardFiltersSchema>;
export type OverviewData = z.infer<typeof OverviewDataSchema>;
export type TrendRow = z.infer<typeof TrendRowSchema>;
export type PageRow = z.infer<typeof PageRowSchema>;
export type ReferrerRow = z.infer<typeof ReferrerRowSchema>;
export type VisitorRow = z.infer<typeof VisitorRowSchema>;
export type SessionRow = z.infer<typeof SessionRowSchema>;
export type RetentionData = z.infer<typeof RetentionDataSchema>;
export type PerformanceData = z.infer<typeof PerformanceDataSchema>;
export type BatchInput = z.infer<typeof BatchInputSchema>;
