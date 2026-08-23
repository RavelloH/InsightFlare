import { z } from "zod";

import { TRAFFIC_CHANNEL_IDS } from "@/lib/analytics/traffic-channel-rules";
import {
  SavedFilterDefinitionSchema,
  SavedFilterPageSchema,
} from "@/lib/api-v1/application-registry";
import { TypedBatchItemSchema } from "@/lib/api-v1/dto/batch";

export const ApiV1ResponseMetaSchema = z
  .object({ requestId: z.string().min(1) })
  .strict();

export const ApiV1AnalyticsResponseMetaSchema = ApiV1ResponseMetaSchema.extend({
  generatedAt: z.string().datetime({ offset: true }),
  timeRange: z
    .object({
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      timeZone: z.string().min(1),
    })
    .strict(),
  source: z.enum(["raw", "rollup", "realtime", "mixed", "mock"]),
  accuracy: z.enum(["exact", "approximate"]),
});

export const ApiV1ErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean().optional(),
    issues: z
      .array(z.object({ path: z.string(), code: z.string() }).strict())
      .optional(),
  })
  .strict();

export const ApiV1ErrorEnvelopeSchema = z
  .object({
    error: ApiV1ErrorSchema,
    meta: ApiV1ResponseMetaSchema,
  })
  .strict();

export function apiV1SuccessEnvelopeSchema<
  Data extends z.ZodType,
  Meta extends z.ZodType = typeof ApiV1ResponseMetaSchema,
>(data: Data, meta?: Meta) {
  return z
    .object({
      data,
      meta: (meta ?? ApiV1ResponseMetaSchema) as Meta,
    })
    .strict();
}

export const TypedBatchItemResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.number().int().min(100).max(599),
    body: z.unknown(),
  })
  .strict();

export const TypedBatchDataSchema = z
  .object({ responses: z.array(TypedBatchItemResponseSchema) })
  .strict();
export type TypedBatchData = z.infer<typeof TypedBatchDataSchema>;

export const TypedBatchResponseSchema = apiV1SuccessEnvelopeSchema(
  TypedBatchDataSchema,
  ApiV1ResponseMetaSchema.extend({ partialFailure: z.boolean() }),
);

export { TypedBatchItemSchema };

export const AnalyticsOverviewDataSchema = z
  .object({
    views: z.number(),
    sessions: z.number(),
    visitors: z.number(),
    bounces: z.number(),
    totalDurationMs: z.number(),
    avgDurationMs: z.number(),
    bounceRate: z.number(),
    approximateVisitors: z.boolean(),
  })
  .strict();
export type AnalyticsOverviewData = z.infer<typeof AnalyticsOverviewDataSchema>;

export const AnalyticsOverviewResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsOverviewDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);
export const TeamAnalyticsOverviewResponseSchema =
  AnalyticsOverviewResponseSchema;

const AnalyticsOverviewDeltaSchema = z
  .object({
    views: z.number().nullable(),
    sessions: z.number().nullable(),
    visitors: z.number().nullable(),
    bounces: z.number().nullable(),
    totalDurationMs: z.number().nullable(),
    durationViews: z.number().nullable(),
  })
  .strict();
export const AnalyticsComparisonOverviewDataSchema = z
  .object({
    a: AnalyticsOverviewDataSchema,
    b: AnalyticsOverviewDataSchema,
    delta: AnalyticsOverviewDeltaSchema,
  })
  .strict();
export const ApiV1ComparisonAnalyticsResponseMetaSchema =
  ApiV1ResponseMetaSchema.extend({
    generatedAt: z.string().datetime({ offset: true }),
    aTimeRange: ApiV1AnalyticsResponseMetaSchema.shape.timeRange,
    bTimeRange: ApiV1AnalyticsResponseMetaSchema.shape.timeRange,
    source: z.enum(["raw", "rollup", "realtime", "mixed", "mock"]),
    accuracy: z.enum(["exact", "approximate"]),
  });
export const AnalyticsComparisonOverviewResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsComparisonOverviewDataSchema,
    ApiV1ComparisonAnalyticsResponseMetaSchema,
  );
export type AnalyticsComparisonOverviewData = z.infer<
  typeof AnalyticsComparisonOverviewDataSchema
>;

export const AnalyticsTimeseriesPointSchema = z
  .object({
    timestamp: z.string().datetime({ offset: true }),
    views: z.number(),
    sessions: z.number(),
    visitors: z.number(),
    bounces: z.number(),
    totalDurationMs: z.number(),
    avgDurationMs: z.number(),
    bounceRate: z.number(),
  })
  .strict();

export const AnalyticsTimeseriesDataSchema = z
  .object({
    interval: z.enum(["minute", "hour", "day", "week", "month"]),
    points: z.array(AnalyticsTimeseriesPointSchema),
  })
  .strict();
export type AnalyticsTimeseriesData = z.infer<
  typeof AnalyticsTimeseriesDataSchema
>;

export const AnalyticsTimeseriesResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsTimeseriesDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

const AnalyticsComparisonTimeseriesDeltaPointSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    aTimestamp: z.string().datetime({ offset: true }),
    bTimestamp: z.string().datetime({ offset: true }),
    views: z.number().nullable(),
    sessions: z.number().nullable(),
    visitors: z.number().nullable(),
    bounces: z.number().nullable(),
    totalDurationMs: z.number().nullable(),
    durationViews: z.number().nullable(),
  })
  .strict();
export const AnalyticsComparisonTimeseriesDataSchema = z
  .object({
    interval: AnalyticsTimeseriesDataSchema.shape.interval,
    a: AnalyticsTimeseriesDataSchema,
    b: AnalyticsTimeseriesDataSchema,
    delta: z
      .object({
        points: z.array(AnalyticsComparisonTimeseriesDeltaPointSchema),
      })
      .strict(),
  })
  .strict();
export const AnalyticsComparisonTimeseriesResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsComparisonTimeseriesDataSchema,
    ApiV1ComparisonAnalyticsResponseMetaSchema,
  );
export type AnalyticsComparisonTimeseriesData = z.infer<
  typeof AnalyticsComparisonTimeseriesDataSchema
>;

export const TeamAnalyticsSiteSchema = z
  .object({
    siteId: z.string().min(1),
    name: z.string(),
    domain: z.string(),
    publicEnabled: z.boolean(),
    publicSlug: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    metrics: AnalyticsOverviewDataSchema,
    trend: z.array(AnalyticsTimeseriesPointSchema).optional(),
    lastEventAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type TeamAnalyticsSite = z.infer<typeof TeamAnalyticsSiteSchema>;

export const TeamAnalyticsSitesDataSchema = z
  .object({ sites: z.array(TeamAnalyticsSiteSchema) })
  .strict();
export type TeamAnalyticsSitesData = z.infer<
  typeof TeamAnalyticsSitesDataSchema
>;

export const TeamAnalyticsSitesResponseSchema = apiV1SuccessEnvelopeSchema(
  TeamAnalyticsSitesDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

export const AnalyticsBreakdownItemSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    views: z.number(),
    sessions: z.number(),
    visitors: z.number(),
  })
  .strict();

export const AnalyticsBreakdownDataSchema = z
  .object({
    dimension: z.string().min(1),
    items: z.array(AnalyticsBreakdownItemSchema),
  })
  .strict();
export type AnalyticsBreakdownData = z.infer<
  typeof AnalyticsBreakdownDataSchema
>;

export const AnalyticsBreakdownResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsBreakdownDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

const AnalyticsComparisonBreakdownMetricSchema = z
  .object({
    absolute: z.number(),
    relative: z.number().nullable(),
  })
  .strict();
export const AnalyticsComparisonBreakdownDataSchema = z
  .object({
    dimension: z.string().min(1),
    items: z.array(
      z
        .object({
          key: z.string(),
          label: z.string(),
          a: AnalyticsBreakdownItemSchema,
          b: AnalyticsBreakdownItemSchema,
          delta: z
            .object({
              views: AnalyticsComparisonBreakdownMetricSchema,
              sessions: AnalyticsComparisonBreakdownMetricSchema,
              visitors: AnalyticsComparisonBreakdownMetricSchema,
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();
export const AnalyticsComparisonBreakdownResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsComparisonBreakdownDataSchema,
    ApiV1ComparisonAnalyticsResponseMetaSchema,
  );
export type AnalyticsComparisonBreakdownData = z.infer<
  typeof AnalyticsComparisonBreakdownDataSchema
>;

export const AnalyticsCrossBreakdownRowSchema =
  AnalyticsBreakdownItemSchema.extend({
    cells: z.array(AnalyticsBreakdownItemSchema),
  }).strict();
export const AnalyticsCrossBreakdownDataSchema = z
  .object({
    columns: z.array(AnalyticsBreakdownItemSchema),
    rows: z.array(AnalyticsCrossBreakdownRowSchema),
    totalVisitors: z.number(),
  })
  .strict();
export type AnalyticsCrossBreakdownData = z.infer<
  typeof AnalyticsCrossBreakdownDataSchema
>;
export const AnalyticsCrossBreakdownResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsCrossBreakdownDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

export const AnalyticsPageItemSchema = z
  .object({
    pathname: z.string(),
    query: z.string(),
    hash: z.string(),
    views: z.number(),
    sessions: z.number(),
  })
  .strict();
export const AnalyticsPagesDataSchema = z
  .object({ items: z.array(AnalyticsPageItemSchema) })
  .strict();
export type AnalyticsPagesData = z.infer<typeof AnalyticsPagesDataSchema>;
export const AnalyticsPagesResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsPagesDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

export const AnalyticsReferrerItemSchema = z
  .object({
    referrer: z.string(),
    views: z.number(),
    sessions: z.number(),
    visitors: z.number(),
  })
  .strict();
export const AnalyticsReferrersDataSchema = z
  .object({ items: z.array(AnalyticsReferrerItemSchema) })
  .strict();
export type AnalyticsReferrersData = z.infer<
  typeof AnalyticsReferrersDataSchema
>;
export const AnalyticsReferrersResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsReferrersDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

export const AnalyticsChannelItemSchema = z
  .object({
    channel: z.enum(TRAFFIC_CHANNEL_IDS),
    views: z.number(),
    sessions: z.number(),
    visitors: z.number(),
  })
  .strict();
export const AnalyticsChannelsDataSchema = z
  .object({ items: z.array(AnalyticsChannelItemSchema) })
  .strict();
export type AnalyticsChannelsData = z.infer<typeof AnalyticsChannelsDataSchema>;
export const AnalyticsChannelsResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsChannelsDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

export const AnalyticsFilterValueSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    occurrences: z.number(),
  })
  .strict();
export const AnalyticsFilterValuesDataSchema = z
  .object({
    field: z.string().min(1),
    items: z.array(AnalyticsFilterValueSchema),
    page: z
      .object({
        limit: z.number().int().positive(),
        hasMore: z.literal(false),
        nextCursor: z.null(),
      })
      .strict(),
  })
  .strict();
export type AnalyticsFilterValuesData = z.infer<
  typeof AnalyticsFilterValuesDataSchema
>;
export const AnalyticsFilterValuesResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsFilterValuesDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

export const AnalyticsRetentionCohortPeriodSchema = z
  .object({
    index: z.number().int().nonnegative(),
    visitors: z.number(),
    rate: z.number(),
  })
  .strict();
export const AnalyticsRetentionCohortSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    size: z.number(),
    periods: z.array(AnalyticsRetentionCohortPeriodSchema),
  })
  .strict();
export const AnalyticsRetentionCohortsDataSchema = z
  .object({
    granularity: z.enum(["minute", "hour", "day", "week", "month"]),
    cohorts: z.array(AnalyticsRetentionCohortSchema),
  })
  .strict();
export type AnalyticsRetentionCohortsData = z.infer<
  typeof AnalyticsRetentionCohortsDataSchema
>;
export const AnalyticsRetentionCohortsResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsRetentionCohortsDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

const AnalyticsFunnelStepSchema = z
  .object({
    type: z.enum(["pageview", "event"]),
    value: z.string().min(1),
  })
  .strict();
const AnalyticsFunnelDefinitionSchema = z
  .object({
    id: z.string().min(1).max(512),
    siteId: z.string().min(1).max(512),
    name: z.string(),
    steps: z.array(AnalyticsFunnelStepSchema),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();
const AnalyticsFunnelAnalysisStepSchema = z
  .object({
    index: z.number().int(),
    label: z.string(),
    type: z.enum(["pageview", "event"]),
    sessions: z.number().int(),
    visitors: z.number().int(),
    conversionRate: z.number(),
    stepConversionRate: z.number(),
    dropOffSessions: z.number().int(),
    dropOffRate: z.number(),
  })
  .strict();
const AnalyticsFunnelAnalysisSummarySchema = z
  .object({
    totalSessions: z.number().int(),
    convertedSessions: z.number().int(),
    totalVisitors: z.number().int(),
    convertedVisitors: z.number().int(),
    overallConversionRate: z.number(),
    largestDropOffStepIndex: z.number().int().nullable(),
  })
  .strict();
export const AnalyticsFunnelAnalysisDataSchema = z
  .object({
    funnel: AnalyticsFunnelDefinitionSchema,
    analysis: z
      .object({
        steps: z.array(AnalyticsFunnelAnalysisStepSchema),
        summary: AnalyticsFunnelAnalysisSummarySchema,
      })
      .strict(),
  })
  .strict();
export type AnalyticsFunnelAnalysisData = z.infer<
  typeof AnalyticsFunnelAnalysisDataSchema
>;
export const AnalyticsFunnelAnalysisResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsFunnelAnalysisDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

export const AnalyticsPerformanceMetricSummarySchema = z
  .object({
    avg: z.number().nullable(),
    p50: z.number().nullable(),
    p75: z.number().nullable(),
    p95: z.number().nullable(),
    samples: z.number().int().nonnegative(),
  })
  .strict();
export const AnalyticsPerformanceMetricsSchema = z
  .object({
    ttfb: AnalyticsPerformanceMetricSummarySchema,
    fcp: AnalyticsPerformanceMetricSummarySchema,
    lcp: AnalyticsPerformanceMetricSummarySchema,
    cls: AnalyticsPerformanceMetricSummarySchema,
    inp: AnalyticsPerformanceMetricSummarySchema,
  })
  .strict();
export const AnalyticsPerformanceSummaryDataSchema = z
  .object({ metrics: AnalyticsPerformanceMetricsSchema })
  .strict();
export type AnalyticsPerformanceSummaryData = z.infer<
  typeof AnalyticsPerformanceSummaryDataSchema
>;
export const AnalyticsPerformanceSummaryResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsPerformanceSummaryDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

export const AnalyticsPerformanceTimeseriesPointSchema =
  AnalyticsPerformanceMetricSummarySchema.extend({
    timestamp: z.string().datetime({ offset: true }),
  }).strict();
export const AnalyticsPerformanceTimeseriesDataSchema = z
  .object({
    interval: z.enum(["minute", "hour", "day", "week", "month"]),
    series: z
      .object({
        ttfb: z.array(AnalyticsPerformanceTimeseriesPointSchema),
        fcp: z.array(AnalyticsPerformanceTimeseriesPointSchema),
        lcp: z.array(AnalyticsPerformanceTimeseriesPointSchema),
        cls: z.array(AnalyticsPerformanceTimeseriesPointSchema),
        inp: z.array(AnalyticsPerformanceTimeseriesPointSchema),
      })
      .strict(),
  })
  .strict();
export type AnalyticsPerformanceTimeseriesData = z.infer<
  typeof AnalyticsPerformanceTimeseriesDataSchema
>;
export const AnalyticsPerformanceTimeseriesResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsPerformanceTimeseriesDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

export const AnalyticsPerformanceBreakdownItemSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    views: z.number(),
    avg: z.number().nullable(),
    p50: z.number().nullable(),
    p75: z.number().nullable(),
    p95: z.number().nullable(),
    samples: z.number().int().nonnegative(),
  })
  .strict();
export const AnalyticsPerformanceBreakdownDataSchema = z
  .object({
    dimension: z.string().min(1),
    metric: z.enum(["ttfb", "fcp", "lcp", "cls", "inp"]),
    items: z.array(AnalyticsPerformanceBreakdownItemSchema),
  })
  .strict();
export type AnalyticsPerformanceBreakdownData = z.infer<
  typeof AnalyticsPerformanceBreakdownDataSchema
>;
export const AnalyticsPerformanceBreakdownResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsPerformanceBreakdownDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

const AnalyticsEventSummaryTabItemSchema = z
  .object({
    label: z.string(),
    views: z.number(),
    sessions: z.number(),
    visitors: z.number(),
  })
  .strict();
export const AnalyticsEventsSummaryDataSchema = z
  .object({
    summary: z
      .object({
        events: z.number(),
        eventTypes: z.number(),
        sessions: z.number(),
        visitors: z.number(),
        avgEventsPerSession: z.number(),
      })
      .strict(),
    cards: z
      .object({
        event: z
          .object({ name: z.array(AnalyticsEventSummaryTabItemSchema) })
          .strict(),
        page: z
          .object({
            path: z.array(AnalyticsEventSummaryTabItemSchema),
            title: z.array(AnalyticsEventSummaryTabItemSchema),
            hostname: z.array(AnalyticsEventSummaryTabItemSchema),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type AnalyticsEventsSummaryData = z.infer<
  typeof AnalyticsEventsSummaryDataSchema
>;
export const AnalyticsEventsSummaryResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsEventsSummaryDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

const AnalyticsEventsTimeseriesSeriesSchema = z
  .object({
    key: z.string(),
    eventName: z.string(),
    label: z.string(),
    events: z.number(),
    sessions: z.number(),
    visitors: z.number(),
    isOther: z.boolean().optional(),
  })
  .strict();
export const AnalyticsEventsTimeseriesDataSchema = z
  .object({
    interval: z.enum(["minute", "hour", "day", "week", "month"]),
    series: z.array(AnalyticsEventsTimeseriesSeriesSchema),
    points: z.array(
      z
        .object({
          bucket: z.number().int().nonnegative(),
          timestamp: z.string().datetime({ offset: true }),
          totalEvents: z.number(),
          eventsBySeries: z.record(z.string(), z.number()),
        })
        .strict(),
    ),
  })
  .strict();
export type AnalyticsEventsTimeseriesData = z.infer<
  typeof AnalyticsEventsTimeseriesDataSchema
>;
export const AnalyticsEventsTimeseriesResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsEventsTimeseriesDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

const AnalyticsEventRecordSchema = z
  .object({
    eventId: z.string(),
    eventName: z.string(),
    eventKind: z.literal("custom_event").optional(),
    occurredAt: z.number(),
    receivedAt: z.number(),
    sequence: z.number(),
    visitId: z.string(),
    sessionId: z.string(),
    visitorId: z.string(),
    pathname: z.string(),
    title: z.string(),
    hostname: z.string(),
    referrerHost: z.string(),
    country: z.string(),
    region: z.string(),
    browser: z.string(),
    browserVersion: z.string(),
    os: z.string(),
    osVersion: z.string(),
    deviceType: z.string(),
    nodeCount: z.number(),
    valueCount: z.number(),
  })
  .strict();
export const AnalyticsEventsSearchDataSchema = z
  .object({
    items: z.array(AnalyticsEventRecordSchema),
    page: z
      .object({
        limit: z.number().int().positive(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type AnalyticsEventsSearchData = z.infer<
  typeof AnalyticsEventsSearchDataSchema
>;
export const AnalyticsEventsSearchResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsEventsSearchDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);
export const AnalyticsEventDetailDataSchema = z
  .object({
    event: AnalyticsEventRecordSchema,
    context: z
      .object({
        visitId: z.string(),
        sessionId: z.string(),
        visitorId: z.string(),
        userId: z.string().optional(),
        userName: z.string().optional(),
        pathname: z.string(),
        queryString: z.string().optional(),
        hash: z.string().optional(),
        title: z.string(),
        hostname: z.string(),
        referrerUrl: z.string().optional(),
        referrerHost: z.string(),
        utmSource: z.string().optional(),
        utmMedium: z.string().optional(),
        utmCampaign: z.string().optional(),
        utmTerm: z.string().optional(),
        utmContent: z.string().optional(),
        country: z.string(),
        region: z.string(),
        regionCode: z.string().optional(),
        city: z.string().optional(),
        continent: z.string().optional(),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        postalCode: z.string().optional(),
        metroCode: z.string().optional(),
        timezone: z.string().optional(),
        organization: z.string().optional(),
        isEU: z.boolean().optional(),
        browser: z.string(),
        browserVersion: z.string(),
        os: z.string(),
        osVersion: z.string(),
        deviceType: z.string(),
        userAgent: z.string().optional(),
        language: z.string().optional(),
        screenWidth: z.number().nullable().optional(),
        screenHeight: z.number().nullable().optional(),
        status: z.string().optional(),
        startedAt: z.number().optional(),
        previousVisitId: z.string().optional(),
        previousVisitStartedAt: z.number().nullable().optional(),
        lastActivityAt: z.number().optional(),
        endedAt: z.number().nullable().optional(),
        finalizedAt: z.number().nullable().optional(),
        durationMs: z.number().nullable().optional(),
        durationSource: z.string().optional(),
        exitReason: z.string().optional(),
        performance: z
          .object({
            ttfb: z.number().nullable(),
            fcp: z.number().nullable(),
            lcp: z.number().nullable(),
            cls: z.number().nullable(),
            inp: z.number().nullable(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    eventData: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AnalyticsEventDetailData = z.infer<
  typeof AnalyticsEventDetailDataSchema
>;
export const AnalyticsEventDetailResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsEventDetailDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

const AnalyticsEventTypeItemSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    events: z.number(),
    sessions: z.number(),
    visitors: z.number(),
  })
  .strict();
export const AnalyticsEventTypesDataSchema = z
  .object({
    items: z.array(AnalyticsEventTypeItemSchema),
    page: z.object({ limit: z.number().int().positive() }).strict(),
  })
  .strict();
export type AnalyticsEventTypesData = z.infer<
  typeof AnalyticsEventTypesDataSchema
>;
export const AnalyticsEventTypesResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsEventTypesDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

const AnalyticsEventFieldSchema = z
  .object({
    path: z.string(),
    valueType: z.enum([
      "string",
      "number",
      "boolean",
      "null",
      "object",
      "array",
    ]),
    events: z.number(),
    occurrences: z.number(),
    firstSeenAt: z.number(),
    lastSeenAt: z.number(),
    exampleValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  })
  .strict();
export const AnalyticsEventFieldsDataSchema = z
  .object({
    eventName: z.string(),
    fields: z.array(AnalyticsEventFieldSchema),
    page: z.object({ limit: z.number().int().positive() }).strict(),
  })
  .strict();
export type AnalyticsEventFieldsData = z.infer<
  typeof AnalyticsEventFieldsDataSchema
>;
export const AnalyticsEventFieldsResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsEventFieldsDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);

const AnalyticsEventFieldValueSchema = z
  .object({
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    events: z.number(),
    occurrences: z.number(),
    firstSeenAt: z.number(),
    lastSeenAt: z.number(),
  })
  .strict();
export const AnalyticsEventFieldValuesDataSchema = z
  .object({
    eventName: z.string(),
    fieldPath: z.string(),
    fieldValueType: z.enum([
      "string",
      "number",
      "boolean",
      "null",
      "object",
      "array",
    ]),
    items: z.array(AnalyticsEventFieldValueSchema),
    page: z.object({ limit: z.number().int().positive() }).strict(),
  })
  .strict();
export type AnalyticsEventFieldValuesData = z.infer<
  typeof AnalyticsEventFieldValuesDataSchema
>;
export const AnalyticsEventFieldValuesResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsEventFieldValuesDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

const AnalyticsEventContextTabItemSchema = AnalyticsEventSummaryTabItemSchema;
const AnalyticsEventContextGeoTabItemSchema = z
  .object({
    value: z.string(),
    label: z.string(),
    views: z.number(),
    sessions: z.number(),
    visitors: z.number(),
  })
  .strict();
const AnalyticsEventContextTabSchema = z.array(
  AnalyticsEventContextTabItemSchema,
);
const AnalyticsEventContextGeoTabSchema = z.array(
  AnalyticsEventContextGeoTabItemSchema,
);
const AnalyticsEventContextCardsSchema = z
  .object({
    page: z
      .object({
        path: AnalyticsEventContextTabSchema,
        query: AnalyticsEventContextTabSchema,
        title: AnalyticsEventContextTabSchema,
        hostname: AnalyticsEventContextTabSchema,
        entry: AnalyticsEventContextTabSchema,
        exit: AnalyticsEventContextTabSchema,
      })
      .strict(),
    source: z
      .object({
        domain: AnalyticsEventContextTabSchema,
        link: AnalyticsEventContextTabSchema,
      })
      .strict(),
    client: z
      .object({
        browser: AnalyticsEventContextTabSchema,
        osVersion: AnalyticsEventContextTabSchema,
        deviceType: AnalyticsEventContextTabSchema,
        language: AnalyticsEventContextTabSchema,
        screenSize: AnalyticsEventContextTabSchema,
      })
      .strict(),
    geo: z
      .object({
        country: AnalyticsEventContextGeoTabSchema,
        region: AnalyticsEventContextGeoTabSchema,
        city: AnalyticsEventContextGeoTabSchema,
        continent: AnalyticsEventContextGeoTabSchema,
        timezone: AnalyticsEventContextGeoTabSchema,
        organization: AnalyticsEventContextGeoTabSchema,
      })
      .strict(),
  })
  .strict();
export const AnalyticsEventTypeDetailDataSchema = z
  .object({
    eventName: z.string(),
    summary: z
      .object({
        events: z.number(),
        eventTypes: z.number(),
        sessions: z.number(),
        visitors: z.number(),
        avgEventsPerSession: z.number(),
        shareOfAllEvents: z.number(),
      })
      .strict(),
    trend: z
      .object({
        data: z.array(
          z
            .object({
              bucket: z.number().int().nonnegative(),
              timestamp: z.string().datetime({ offset: true }),
              events: z.number(),
              visitors: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
    breakdowns: z
      .object({
        pages: z.array(AnalyticsEventSummaryTabItemSchema),
        countries: z.array(AnalyticsEventSummaryTabItemSchema),
        devices: z.array(AnalyticsEventSummaryTabItemSchema),
        browsers: z.array(AnalyticsEventSummaryTabItemSchema),
      })
      .strict(),
    cards: AnalyticsEventContextCardsSchema,
    fields: z.array(AnalyticsEventFieldSchema),
  })
  .strict();
export type AnalyticsEventTypeDetailData = z.infer<
  typeof AnalyticsEventTypeDetailDataSchema
>;
export const AnalyticsEventTypeDetailResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsEventTypeDetailDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

const AnalyticsVisitPerformanceSchema = z
  .object({
    ttfb: z.number().nullable(),
    fcp: z.number().nullable(),
    lcp: z.number().nullable(),
    cls: z.number().nullable(),
    inp: z.number().nullable(),
  })
  .strict();
const AnalyticsJourneyPerformanceMetricSchema = z
  .object({
    avg: z.number().nullable(),
    p75: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    samples: z.number().int().nonnegative(),
  })
  .strict();
const AnalyticsJourneyPerformanceSchema = z
  .object({
    ttfb: AnalyticsJourneyPerformanceMetricSchema,
    fcp: AnalyticsJourneyPerformanceMetricSchema,
    lcp: AnalyticsJourneyPerformanceMetricSchema,
    cls: AnalyticsJourneyPerformanceMetricSchema,
    inp: AnalyticsJourneyPerformanceMetricSchema,
  })
  .strict();
const AnalyticsVisitorSchema = z
  .object({
    visitorId: z.string(),
    sessionId: z.string(),
    firstSeenAt: z.number(),
    lastSeenAt: z.number(),
    views: z.number(),
    sessions: z.number(),
    events: z.number(),
    country: z.string(),
    region: z.string(),
    regionCode: z.string(),
    city: z.string(),
    referrerHost: z.string(),
    referrerUrl: z.string(),
    browser: z.string(),
    browserVersion: z.string(),
    os: z.string(),
    osVersion: z.string(),
    deviceType: z.string(),
    screenWidth: z.number().nullable(),
    screenHeight: z.number().nullable(),
  })
  .strict();
const AnalyticsSessionSchema = z
  .object({
    sessionId: z.string(),
    visitorId: z.string(),
    startedAt: z.number(),
    endedAt: z.number(),
    durationMs: z.number(),
    active: z.boolean(),
    views: z.number(),
    events: z.number(),
    bounce: z.boolean(),
    entryPath: z.string(),
    exitPath: z.string(),
    referrerHost: z.string(),
    referrerUrl: z.string(),
    country: z.string(),
    region: z.string(),
    regionCode: z.string(),
    city: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    browser: z.string(),
    browserVersion: z.string(),
    os: z.string(),
    osVersion: z.string(),
    deviceType: z.string(),
    screenWidth: z.number().nullable(),
    screenHeight: z.number().nullable(),
    performance: AnalyticsVisitPerformanceSchema,
  })
  .strict();
const AnalyticsJourneyEventSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["session_start", "pageview", "leave", "custom"]),
    eventType: z.string(),
    occurredAt: z.number(),
    visitId: z.string(),
    sessionId: z.string(),
    visitorId: z.string(),
    pathname: z.string(),
    hash: z.string(),
    title: z.string(),
    hostname: z.string(),
    referrerHost: z.string(),
    referrerUrl: z.string(),
    country: z.string(),
    region: z.string(),
    city: z.string(),
    browser: z.string(),
    browserVersion: z.string(),
    os: z.string(),
    osVersion: z.string(),
    deviceType: z.string(),
    screenWidth: z.number().nullable(),
    screenHeight: z.number().nullable(),
    durationMs: z.number(),
    performance: AnalyticsVisitPerformanceSchema,
  })
  .strict();
const AnalyticsJourneyPageSchema = z
  .object({ pathname: z.string(), views: z.number() })
  .strict();
const AnalyticsJourneyEventCountSchema = z
  .object({ eventType: z.string(), count: z.number() })
  .strict();
export const AnalyticsVisitorDetailDataSchema = z
  .object({
    visitor: AnalyticsVisitorSchema,
    metrics: z
      .object({
        totalEvents: z.number(),
        sessions: z.number(),
        views: z.number(),
        avgEventsPerSession: z.number(),
        bounceRate: z.number(),
        avgDurationMs: z.number(),
        p90DurationMs: z.number(),
        firstSeenAt: z.number(),
        lastSeenAt: z.number(),
        daysActive: z.number(),
        conversionEvents: z.number(),
        avgTimeBetweenSessionsMs: z.number(),
      })
      .strict(),
    sessions: z.array(AnalyticsSessionSchema),
    events: z.array(AnalyticsJourneyEventSchema),
    visitedPages: z.array(AnalyticsJourneyPageSchema),
    eventDistribution: z.array(AnalyticsJourneyEventCountSchema),
    activity: z.array(
      z.object({ date: z.string(), count: z.number() }).strict(),
    ),
    performance: AnalyticsJourneyPerformanceSchema,
  })
  .strict();
export type AnalyticsVisitorDetailData = z.infer<
  typeof AnalyticsVisitorDetailDataSchema
>;
export const AnalyticsVisitorDetailResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsVisitorDetailDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);
export const AnalyticsSessionDetailDataSchema = z
  .object({
    session: AnalyticsSessionSchema,
    locationPoints: z.array(
      z
        .object({
          latitude: z.number(),
          longitude: z.number(),
          timestampMs: z.number(),
          country: z.string(),
          region: z.string(),
          regionCode: z.string(),
          city: z.string(),
          pointCount: z.number(),
        })
        .strict(),
    ),
    events: z.array(AnalyticsJourneyEventSchema),
    visitedPages: z.array(AnalyticsJourneyPageSchema),
    eventDistribution: z.array(AnalyticsJourneyEventCountSchema),
    performance: AnalyticsJourneyPerformanceSchema,
  })
  .strict();
export type AnalyticsSessionDetailData = z.infer<
  typeof AnalyticsSessionDetailDataSchema
>;
export const AnalyticsSessionDetailResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsSessionDetailDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);
export const AnalyticsVisitorsSearchDataSchema = z
  .object({
    items: z.array(AnalyticsVisitorSchema),
    page: z
      .object({
        limit: z.number().int().positive(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type AnalyticsVisitorsSearchData = z.infer<
  typeof AnalyticsVisitorsSearchDataSchema
>;
export const AnalyticsVisitorsSearchResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsVisitorsSearchDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);
export const AnalyticsSessionsSearchDataSchema = z
  .object({
    items: z.array(AnalyticsSessionSchema),
    page: z
      .object({
        limit: z.number().int().positive(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type AnalyticsSessionsSearchData = z.infer<
  typeof AnalyticsSessionsSearchDataSchema
>;
export const AnalyticsSessionsSearchResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsSessionsSearchDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);
export const AnalyticsJourneyEventsDataSchema = z
  .object({ items: z.array(AnalyticsJourneyEventSchema) })
  .strict();
export type AnalyticsJourneyEventsData = z.infer<
  typeof AnalyticsJourneyEventsDataSchema
>;
export const AnalyticsJourneyEventsResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsJourneyEventsDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);
export const AnalyticsJourneySessionsDataSchema = z
  .object({ items: z.array(AnalyticsSessionSchema) })
  .strict();
export type AnalyticsJourneySessionsData = z.infer<
  typeof AnalyticsJourneySessionsDataSchema
>;
export const AnalyticsJourneySessionsResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsJourneySessionsDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

const AnalyticsRealtimeEventSchema = z
  .object({
    id: z.string(),
    eventType: z.string(),
    eventAt: z.number(),
    visitId: z.string(),
    sessionId: z.string(),
    pathname: z.string(),
    hash: z.string(),
    title: z.string(),
    hostname: z.string(),
    referrerUrl: z.string(),
    referrerHost: z.string(),
    visitorId: z.string(),
    country: z.string(),
    region: z.string(),
    regionCode: z.string(),
    city: z.string(),
    continent: z.string(),
    timezone: z.string(),
    organization: z.string(),
    browser: z.string(),
    osVersion: z.string(),
    deviceType: z.string(),
    language: z.string(),
    screenSize: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  })
  .strict();
const AnalyticsRealtimeSessionSchema = z
  .object({
    visitId: z.string(),
    visitorId: z.string(),
    sessionId: z.string(),
    startedAt: z.number(),
    lastActivityAt: z.number(),
    pathname: z.string(),
    hash: z.string(),
    title: z.string(),
    hostname: z.string(),
    referrerUrl: z.string(),
    referrerHost: z.string(),
    country: z.string(),
    region: z.string(),
    regionCode: z.string(),
    city: z.string(),
    continent: z.string(),
    timezone: z.string(),
    organization: z.string(),
    browser: z.string(),
    osVersion: z.string(),
    deviceType: z.string(),
    language: z.string(),
    screenSize: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  })
  .strict();
export const AnalyticsRealtimeSnapshotDataSchema = z
  .object({
    activeVisitors: z.number().int().nonnegative(),
    events: z.array(AnalyticsRealtimeEventSchema),
    sessions: z.array(AnalyticsRealtimeSessionSchema),
  })
  .strict();
export type AnalyticsRealtimeSnapshotData = z.infer<
  typeof AnalyticsRealtimeSnapshotDataSchema
>;
export const AnalyticsRealtimeSnapshotResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsRealtimeSnapshotDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );
export const AnalyticsRealtimeActiveVisitorsDataSchema = z
  .object({ activeVisitors: z.number().int().nonnegative() })
  .strict();
export type AnalyticsRealtimeActiveVisitorsData = z.infer<
  typeof AnalyticsRealtimeActiveVisitorsDataSchema
>;
export const AnalyticsRealtimeActiveVisitorsResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsRealtimeActiveVisitorsDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );
export const AnalyticsRealtimeEventsDataSchema = z
  .object({ items: z.array(AnalyticsRealtimeEventSchema) })
  .strict();
export type AnalyticsRealtimeEventsData = z.infer<
  typeof AnalyticsRealtimeEventsDataSchema
>;
export const AnalyticsRealtimeEventsResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsRealtimeEventsDataSchema,
  ApiV1AnalyticsResponseMetaSchema,
);
export const AnalyticsRealtimeSessionsDataSchema = z
  .object({ items: z.array(AnalyticsRealtimeSessionSchema) })
  .strict();
export type AnalyticsRealtimeSessionsData = z.infer<
  typeof AnalyticsRealtimeSessionsDataSchema
>;
export const AnalyticsRealtimeSessionsResponseSchema =
  apiV1SuccessEnvelopeSchema(
    AnalyticsRealtimeSessionsDataSchema,
    ApiV1AnalyticsResponseMetaSchema,
  );

const AnalyticsSchemaMetricSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["integer", "rate", "duration_ms"]),
    description: z.string().min(1),
  })
  .strict();

const AnalyticsSchemaDimensionSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.literal("string"),
    description: z.string().min(1),
  })
  .strict();

const AnalyticsSchemaFilterFieldSchema = z
  .object({
    id: z.string().min(1),
    valueKind: z.enum([
      "string",
      "enum",
      "number",
      "boolean",
      "date",
      "datetime",
      "json-scalar",
    ]),
    operators: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const AnalyticsSchemaDataSchema = z
  .object({
    metrics: z.array(AnalyticsSchemaMetricSchema),
    dimensions: z.array(AnalyticsSchemaDimensionSchema),
    filters: z.array(z.string().min(1)),
    operators: z.array(z.string().min(1)),
    filterProtocol: z
      .object({
        version: z.number().int().positive(),
        fields: z.array(AnalyticsSchemaFilterFieldSchema),
      })
      .strict(),
    intervals: z.array(z.enum(["minute", "hour", "day", "week", "month"])),
    presets: z.array(
      z.enum([
        "today",
        "yesterday",
        "last_7_days",
        "last_30_days",
        "this_week",
        "last_week",
        "this_month",
        "last_month",
      ]),
    ),
    timeRange: z
      .object({
        earliestAvailableAt: z.string().datetime({ offset: true }).nullable(),
        latestAvailableAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    // Route IDs are owned by ApiV1RouteRegistry. Keeping a literal union here
    // would be a second route registry that silently drifts as routes change.
    operations: z
      .array(
        z
          .object({
            id: z.string().min(1),
            method: z.enum(["GET", "POST"]),
            path: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    links: z.object({ overview: z.string().min(1) }).strict(),
  })
  .strict();
export type AnalyticsSchemaData = z.infer<typeof AnalyticsSchemaDataSchema>;

export const AnalyticsSchemaResponseSchema = apiV1SuccessEnvelopeSchema(
  AnalyticsSchemaDataSchema,
);

export const SavedFilterPageResponseSchema = apiV1SuccessEnvelopeSchema(
  SavedFilterPageSchema,
);

export const SavedFilterDefinitionResponseSchema = apiV1SuccessEnvelopeSchema(
  SavedFilterDefinitionSchema,
);
