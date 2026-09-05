import { z } from "zod";

import { analyticsFilterDefinition } from "@/lib/edge/analytics/contract/filter-registry";
import type { FilterScopePreference } from "@/lib/edge/analytics/contract/scoped-filter";
import { FILTER_DSL_MAX_LENGTH } from "@/lib/filter-contract";

const rfc3339 = z.string().datetime({ offset: true }).max(64);
const timeZone = z.string().min(1).max(80);

export const ANALYTICS_TIME_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
] as const;

const filterValue = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const filterTarget = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("field"), field: z.string().min(1).max(128) })
    .strict(),
  z
    .object({
      kind: z.literal("event-payload"),
      path: z.string().min(1).max(240),
    })
    .strict(),
]);

type PublicFilterExpression =
  | {
      readonly kind: "condition";
      readonly target:
        | { readonly kind: "field"; readonly field: string }
        | { readonly kind: "event-payload"; readonly path: string };
      readonly operator: string;
      readonly value?:
        | string
        | number
        | boolean
        | null
        | readonly (string | number | boolean | null)[];
    }
  | {
      readonly kind: "and" | "or";
      readonly children: readonly PublicFilterExpression[];
    }
  | { readonly kind: "not"; readonly child: PublicFilterExpression };

const publicFilterExpressionSchema: z.ZodType<PublicFilterExpression> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("condition"),
          target: filterTarget,
          operator: z.string().min(1).max(32),
          value: z
            .union([filterValue, z.array(filterValue).min(1).max(128)])
            .optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("and"),
          children: z.array(publicFilterExpressionSchema).min(1).max(128),
        })
        .strict(),
      z
        .object({
          kind: z.literal("or"),
          children: z.array(publicFilterExpressionSchema).min(1).max(128),
        })
        .strict(),
      z
        .object({ kind: z.literal("not"), child: publicFilterExpressionSchema })
        .strict(),
    ]),
);

export const AbsoluteTimeRangeDtoSchema = z
  .object({ from: rfc3339, to: rfc3339 })
  .strict();

export const QueryTimeRangeDtoSchema = AbsoluteTimeRangeDtoSchema.extend({
  timeZone: timeZone.optional(),
}).strict();

export const PresetTimeRangeDtoSchema = z
  .object({
    kind: z.literal("preset"),
    preset: z.enum(ANALYTICS_TIME_PRESETS),
    timeZone: timeZone.optional(),
  })
  .strict();

export const AnalyticsTimeRangeInputDtoSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("absolute") })
    .merge(QueryTimeRangeDtoSchema)
    .strict(),
  PresetTimeRangeDtoSchema,
]);

export const FilterScopePreferenceDtoSchema = z
  .enum(["auto", "event", "session", "visitor"])
  .optional() satisfies z.ZodType<FilterScopePreference | undefined>;

/**
 * A comparison dataset intentionally cannot select its own reporting zone.
 * Explicit comparison carries one zone at the top level so both datasets use
 * identical calendar boundaries when either side uses a preset.
 */
export const ComparisonDatasetTimeRangeDtoSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({ kind: z.literal("absolute"), from: rfc3339, to: rfc3339 })
      .strict(),
    z
      .object({
        kind: z.literal("preset"),
        preset: z.enum(ANALYTICS_TIME_PRESETS),
      })
      .strict(),
  ],
);

export const InlineQueryFilterDtoSchema = z
  .object({
    type: z.literal("inline"),
    expression: publicFilterExpressionSchema,
  })
  .strict();

const dslExpression = z
  .string()
  .min(1)
  .max(FILTER_DSL_MAX_LENGTH)
  .refine((expression) => expression.trim().length > 0, {
    message: "DSL expression must contain a non-whitespace character.",
  });

export const DslQueryFilterDtoSchema = z
  .object({
    type: z.literal("dsl"),
    expression: dslExpression,
  })
  .strict();

export const SavedFilterReferenceDtoSchema = z
  .object({ type: z.literal("saved"), id: z.string().min(1).max(256) })
  .strict();

export const SiteQueryFilterDtoSchema = z.discriminatedUnion("type", [
  InlineQueryFilterDtoSchema,
  DslQueryFilterDtoSchema,
  SavedFilterReferenceDtoSchema,
]);

export const TeamQueryFilterDtoSchema = z.discriminatedUnion("type", [
  InlineQueryFilterDtoSchema,
  DslQueryFilterDtoSchema,
]);

const overviewMetricsSchema = z
  .array(
    z.enum([
      "views",
      "sessions",
      "visitors",
      "bounces",
      "bounceRate",
      "avgDurationMs",
      "viewsPerSession",
      "events",
    ]),
  )
  .min(1)
  .max(20)
  .optional();

/** Dataset-first comparison transport contract. */
export const ComparisonVersionDtoSchema = z.literal(2);
export const ComparisonMetricDtoSchema = z.enum([
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDurationMs",
  "durationViews",
  "bounceRate",
  "avgDurationMs",
  "viewsPerSession",
  "events",
]);
export const ComparisonTrendIntervalDtoSchema = z.enum([
  "minute",
  "hour",
  "day",
  "week",
  "month",
]);
const comparisonDatasetTimeRangeV2 = z.union([
  ComparisonDatasetTimeRangeDtoSchema,
  z.object({ kind: z.literal("previous_period") }).strict(),
]);
const comparisonDatasetV2 = <
  Range extends z.ZodTypeAny,
  Filter extends z.ZodTypeAny,
>(
  range: Range,
  filter: Filter,
) =>
  z.object({ timeRange: range, filter: filter.nullable().optional() }).strict();
const siteCurrentDatasetV2 = comparisonDatasetV2(
  ComparisonDatasetTimeRangeDtoSchema,
  SiteQueryFilterDtoSchema,
);
const siteReferenceDatasetV2 = comparisonDatasetV2(
  comparisonDatasetTimeRangeV2,
  SiteQueryFilterDtoSchema,
);
const teamCurrentDatasetV2 = comparisonDatasetV2(
  ComparisonDatasetTimeRangeDtoSchema,
  TeamQueryFilterDtoSchema,
);
const teamReferenceDatasetV2 = comparisonDatasetV2(
  comparisonDatasetTimeRangeV2,
  TeamQueryFilterDtoSchema,
);
export const ComparisonTrendSelectionDtoSchema = z.union([
  z
    .object({
      interval: ComparisonTrendIntervalDtoSchema,
      metrics: z.array(ComparisonMetricDtoSchema).min(1).max(10),
    })
    .strict(),
]);
const comparisonSelectV2 = z
  .object({
    metrics: z.array(ComparisonMetricDtoSchema).min(1).max(10),
    trend: ComparisonTrendSelectionDtoSchema.optional(),
  })
  .strict();
const comparisonRequestV2 = <
  Current extends z.ZodTypeAny,
  Reference extends z.ZodTypeAny,
>(
  current: Current,
  reference: Reference,
) =>
  z
    .object({
      version: ComparisonVersionDtoSchema,
      timeZone,
      scope: FilterScopePreferenceDtoSchema,
      current,
      reference,
    })
    .strict();
export const SiteComparisonQueryDtoSchema = comparisonRequestV2(
  siteCurrentDatasetV2,
  siteReferenceDatasetV2,
)
  .extend({ select: comparisonSelectV2 })
  .strict();
export const TeamComparisonQueryDtoSchema = comparisonRequestV2(
  teamCurrentDatasetV2,
  teamReferenceDatasetV2,
)
  .extend({ select: comparisonSelectV2 })
  .strict();
export const ComparisonSortByDtoSchema = z.enum([
  "current.views",
  "current.sessions",
  "current.visitors",
  "reference.views",
  "reference.sessions",
  "reference.visitors",
  "change.views.absolute",
  "change.views.relative",
  "change.sessions.absolute",
  "change.sessions.relative",
  "change.visitors.absolute",
  "change.visitors.relative",
  "key",
]);
const comparisonSortV2 = z
  .object({
    by: ComparisonSortByDtoSchema,
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .default({ by: "current.views", direction: "desc" });
const comparisonBreakdownV2 = z.object({
  limit: z.number().int().min(1).max(200).default(20),
  sort: comparisonSortV2,
});
export const SiteComparisonBreakdownV2QueryDtoSchema = comparisonRequestV2(
  siteCurrentDatasetV2,
  siteReferenceDatasetV2,
)
  .extend(comparisonBreakdownV2.shape)
  .strict();
export const TeamComparisonBreakdownV2QueryDtoSchema = comparisonRequestV2(
  teamCurrentDatasetV2,
  teamReferenceDatasetV2,
)
  .extend(comparisonBreakdownV2.shape)
  .strict();
export const SiteAnalyticsComparisonQueryDtoSchema =
  SiteComparisonQueryDtoSchema;
export const TeamAnalyticsComparisonQueryDtoSchema =
  TeamComparisonQueryDtoSchema;
export const SiteAnalyticsComparisonBreakdownQueryDtoSchema =
  SiteComparisonBreakdownV2QueryDtoSchema;
export const TeamAnalyticsComparisonBreakdownQueryDtoSchema =
  TeamComparisonBreakdownV2QueryDtoSchema;

export const SiteAnalyticsQueryBaseDtoSchema = z
  .object({
    timeRange: AnalyticsTimeRangeInputDtoSchema,
    filter: SiteQueryFilterDtoSchema.nullable().optional(),
    scope: FilterScopePreferenceDtoSchema,
  })
  .strict();

export const TeamAnalyticsQueryBaseDtoSchema = z
  .object({
    timeRange: AnalyticsTimeRangeInputDtoSchema,
    filter: TeamQueryFilterDtoSchema.nullable().optional(),
    scope: FilterScopePreferenceDtoSchema,
  })
  .strict();

export const SiteOverviewQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    metrics: overviewMetricsSchema,
  }).strict();

export const SiteTimeseriesQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    interval: z.enum(["minute", "hour", "day", "week", "month"]),
  }).strict();

export const TeamOverviewQueryDtoSchema =
  TeamAnalyticsQueryBaseDtoSchema.extend({
    metrics: overviewMetricsSchema,
  }).strict();

export const TeamTimeseriesQueryDtoSchema =
  TeamAnalyticsQueryBaseDtoSchema.extend({
    interval: z.enum(["minute", "hour", "day", "week", "month"]),
  }).strict();

export const TeamBreakdownQueryDtoSchema =
  TeamAnalyticsQueryBaseDtoSchema.extend({
    limit: z.number().int().min(1).max(200).default(20),
  }).strict();

/** A team-site composite is deliberately distinct from a generic breakdown. */
export const TeamSitesQueryDtoSchema = TeamAnalyticsQueryBaseDtoSchema.extend({
  interval: z.enum(["minute", "hour", "day", "week", "month"]).optional(),
  page: z
    .object({
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).max(12_288).nullable().optional(),
    })
    .strict()
    .default({ limit: 20 }),
}).strict();

export const SiteBreakdownQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    limit: z.number().int().min(1).max(200).default(20),
  }).strict();

export const SiteCrossBreakdownQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    primaryDimension: z.string().min(1).max(128),
    secondaryDimension: z.string().min(1).max(128),
    primaryLimit: z.number().int().min(1).max(12).default(5),
    secondaryLimit: z.number().int().min(1).max(8).default(6),
  }).strict();

export const SitePagesQueryDtoSchema = SiteAnalyticsQueryBaseDtoSchema.extend({
  page: z
    .object({
      limit: z.number().int().min(1).max(200).default(20),
      cursor: z.string().min(1).max(12_288).nullable().optional(),
    })
    .strict()
    .default({ limit: 20 }),
  includeDetails: z.boolean().default(false),
}).strict();

export const SiteReferrersQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    sort: z.enum(["views", "visitors"]).default("views"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    page: z
      .object({
        limit: z.number().int().min(1).max(200).default(20),
        cursor: z.string().min(1).max(12_288).nullable().optional(),
      })
      .strict()
      .default({ limit: 20 }),
    includeFullUrl: z.boolean().default(false),
    search: z.string().trim().min(1).max(256).optional(),
  }).strict();

export const SiteChannelsQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    limit: z.number().int().min(1).max(200).default(20),
  }).strict();

const filterValueField = z
  .string()
  .min(1)
  .max(128)
  .refine((field) => {
    const definition = analyticsFilterDefinition(field);
    return Boolean(definition && definition.source !== "payload");
  }, "Unknown or non-enumerable filter field.");

export const SiteFilterValuesQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    field: filterValueField,
    search: z.string().max(256).optional(),
    page: z
      .object({
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().min(1).max(12_288).nullable().optional(),
      })
      .strict()
      .default({ limit: 50 }),
  }).strict();

export const SiteRetentionCohortsQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    granularity: z.enum(["minute", "hour", "day", "week", "month"]),
  }).strict();

/** Saved funnel analysis is a query operation; the funnel ID stays in the
 * body so opaque IDs never collide with static path segments. */
export const SiteFunnelAnalysisQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    funnelId: z.string().min(1).max(512),
  }).strict();

export const SitePerformanceSummaryQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema;
export const SitePerformanceBreakdownDimensionSchema = z.enum([
  "page.path",
  "geo.country",
]);
export type SitePerformanceBreakdownDimension = z.infer<
  typeof SitePerformanceBreakdownDimensionSchema
>;
export const SitePerformanceTimeseriesQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    interval: z.enum(["minute", "hour", "day", "week", "month"]),
  }).strict();
export const SitePerformanceBreakdownQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    metric: z.enum(["ttfb", "fcp", "lcp", "cls", "inp"]).default("lcp"),
    limit: z.number().int().min(1).max(200).default(100),
  }).strict();

export const SiteEventsSummaryQueryDtoSchema = SiteAnalyticsQueryBaseDtoSchema;
export const SiteEventsTimeseriesQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    interval: z.enum(["minute", "hour", "day", "week", "month"]),
    limit: z.number().int().min(1).max(12).default(8),
  }).strict();
export const SiteEventsSearchQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    search: z.string().min(1).max(160).optional(),
    eventName: z.string().trim().min(1).max(120).optional(),
    sort: z
      .object({
        field: z.enum(["occurredAt", "eventName", "pathname"]),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .default({ field: "occurredAt", direction: "desc" }),
    page: z
      .object({
        limit: z.number().int().min(1).max(200).default(80),
        cursor: z.string().min(1).max(12_288).nullable().optional(),
      })
      .strict()
      .default({ limit: 80 }),
  }).strict();
export const SiteEventDetailQueryDtoSchema = z
  .object({
    timeRange: AnalyticsTimeRangeInputDtoSchema,
    eventId: z.string().min(1).max(512),
  })
  .strict();

export const SiteJourneyEventDetailQueryDtoSchema = z
  .object({
    timeRange: AnalyticsTimeRangeInputDtoSchema,
    eventId: z.string().min(1).max(512),
    eventKind: z.enum(["pageview", "session_start", "leave"]).optional(),
  })
  .strict();

export const SiteEventTypesQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    search: z.string().min(1).max(160).optional(),
    page: z
      .object({
        limit: z.number().int().min(1).max(200).default(20),
        cursor: z.string().min(1).max(12_288).nullable().optional(),
      })
      .strict()
      .default({ limit: 20 }),
  }).strict();

export const SiteEventTypeDetailQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    eventName: z.string().trim().min(1).max(120),
    interval: z.enum(["minute", "hour", "day", "week", "month"]).default("day"),
  }).strict();

export const SiteEventFieldsQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    eventName: z.string().trim().min(1).max(120),
    page: z
      .object({
        limit: z.number().int().min(1).max(200).default(100),
        cursor: z.string().min(1).max(12_288).nullable().optional(),
      })
      .strict()
      .default({ limit: 100 }),
  }).strict();

export const SiteEventFieldValuesQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    eventName: z.string().trim().min(1).max(120),
    fieldPath: z.string().min(1).max(240),
    fieldValueType: z.enum([
      "string",
      "number",
      "boolean",
      "null",
      "object",
      "array",
    ]),
    search: z.string().max(256).optional(),
    page: z
      .object({
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().min(1).max(12_288).nullable().optional(),
      })
      .strict()
      .default({ limit: 25 }),
  }).strict();

/** Opaque visitor and session IDs are intentionally body fields, not path segments. */
export const SiteVisitorDetailQueryDtoSchema = z
  .object({
    timeRange: AnalyticsTimeRangeInputDtoSchema,
    visitorId: z.string().min(1).max(512),
  })
  .strict();

export const SiteSessionDetailQueryDtoSchema = z
  .object({
    timeRange: AnalyticsTimeRangeInputDtoSchema,
    sessionId: z.string().min(1).max(512),
  })
  .strict();

export const SiteVisitorsSearchQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    search: z.string().min(1).max(160).optional(),
    sort: z
      .object({
        field: z.enum(["firstSeenAt", "lastSeenAt", "sessions", "views"]),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .default({ field: "lastSeenAt", direction: "desc" }),
    page: z
      .object({
        limit: z.number().int().min(1).max(200).default(80),
        cursor: z.string().min(1).max(12_288).nullable().optional(),
      })
      .strict()
      .default({ limit: 80 }),
  }).strict();

export const SiteSessionsSearchQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    search: z.string().min(1).max(160).optional(),
    sort: z
      .object({
        field: z.enum(["startedAt", "durationMs", "views"]),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .default({ field: "startedAt", direction: "desc" }),
    page: z
      .object({
        limit: z.number().int().min(1).max(200).default(80),
        cursor: z.string().min(1).max(12_288).nullable().optional(),
      })
      .strict()
      .default({ limit: 80 }),
  }).strict();

const trajectoryPage = z
  .object({
    limit: z.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).max(12_288).nullable().optional(),
  })
  .strict()
  .default({ limit: 100 });

export const SiteVisitorEventsQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    visitorId: z.string().min(1).max(512),
    page: trajectoryPage,
  }).strict();

export const SiteVisitorSessionsQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    visitorId: z.string().min(1).max(512),
    page: trajectoryPage,
  }).strict();

export const SiteSessionEventsQueryDtoSchema =
  SiteAnalyticsQueryBaseDtoSchema.extend({
    sessionId: z.string().min(1).max(512),
    page: trajectoryPage,
  }).strict();

const SiteRealtimeQueryBaseDtoSchema = SiteAnalyticsQueryBaseDtoSchema.omit({
  filter: true,
  scope: true,
}).strict();
const realtimeLimit = z.number().int().min(1).max(500).default(100);

export const SiteRealtimeSnapshotQueryDtoSchema =
  SiteRealtimeQueryBaseDtoSchema.extend({ limit: realtimeLimit }).strict();
export const SiteRealtimeActiveVisitorsQueryDtoSchema =
  SiteRealtimeQueryBaseDtoSchema.strict();
export const SiteRealtimeEventsQueryDtoSchema =
  SiteRealtimeQueryBaseDtoSchema.extend({ limit: realtimeLimit }).strict();
export const SiteRealtimeSessionsQueryDtoSchema =
  SiteRealtimeQueryBaseDtoSchema.extend({ limit: realtimeLimit }).strict();

export type AbsoluteTimeRangeDto = z.infer<typeof AbsoluteTimeRangeDtoSchema>;
export type QueryTimeRangeDto = z.infer<typeof QueryTimeRangeDtoSchema>;
export type PresetTimeRangeDto = z.infer<typeof PresetTimeRangeDtoSchema>;
export type AnalyticsTimeRangeInputDto = z.infer<
  typeof AnalyticsTimeRangeInputDtoSchema
>;
export type ComparisonDatasetTimeRangeDto = z.infer<
  typeof ComparisonDatasetTimeRangeDtoSchema
>;
export type SiteComparisonQueryDto = z.infer<
  typeof SiteComparisonQueryDtoSchema
>;
export type SiteComparisonQueryDtoInput = z.input<
  typeof SiteComparisonQueryDtoSchema
>;
export type TeamComparisonQueryDto = z.infer<
  typeof TeamComparisonQueryDtoSchema
>;
export type TeamComparisonQueryDtoInput = z.input<
  typeof TeamComparisonQueryDtoSchema
>;
export type SiteComparisonBreakdownV2QueryDto = z.infer<
  typeof SiteComparisonBreakdownV2QueryDtoSchema
>;
export type SiteComparisonBreakdownV2QueryDtoInput = z.input<
  typeof SiteComparisonBreakdownV2QueryDtoSchema
>;
export type TeamComparisonBreakdownV2QueryDto = z.infer<
  typeof TeamComparisonBreakdownV2QueryDtoSchema
>;
export type TeamComparisonBreakdownV2QueryDtoInput = z.input<
  typeof TeamComparisonBreakdownV2QueryDtoSchema
>;
export type SiteFunnelAnalysisQueryDto = z.infer<
  typeof SiteFunnelAnalysisQueryDtoSchema
>;
export type InlineQueryFilterDto = z.infer<typeof InlineQueryFilterDtoSchema>;
export type DslQueryFilterDto = z.infer<typeof DslQueryFilterDtoSchema>;
export type SavedFilterReferenceDto = z.infer<
  typeof SavedFilterReferenceDtoSchema
>;
export type SiteQueryFilterDto = z.infer<typeof SiteQueryFilterDtoSchema>;
export type TeamQueryFilterDto = z.infer<typeof TeamQueryFilterDtoSchema>;
export type SiteAnalyticsQueryBaseDto = z.infer<
  typeof SiteAnalyticsQueryBaseDtoSchema
>;
export type TeamAnalyticsQueryBaseDto = z.infer<
  typeof TeamAnalyticsQueryBaseDtoSchema
>;
export type SiteOverviewQueryDto = z.infer<typeof SiteOverviewQueryDtoSchema>;
export type SiteTimeseriesQueryDto = z.infer<
  typeof SiteTimeseriesQueryDtoSchema
>;
export type TeamOverviewQueryDto = z.infer<typeof TeamOverviewQueryDtoSchema>;
export type TeamTimeseriesQueryDto = z.infer<
  typeof TeamTimeseriesQueryDtoSchema
>;
export type TeamBreakdownQueryDto = z.infer<typeof TeamBreakdownQueryDtoSchema>;
export type TeamSitesQueryDto = z.infer<typeof TeamSitesQueryDtoSchema>;
export type TeamSitesQueryDtoInput = z.input<typeof TeamSitesQueryDtoSchema>;
export type SiteBreakdownQueryDto = z.infer<typeof SiteBreakdownQueryDtoSchema>;
export type SiteBreakdownQueryDtoInput = z.input<
  typeof SiteBreakdownQueryDtoSchema
>;
export type SiteCrossBreakdownQueryDto = z.infer<
  typeof SiteCrossBreakdownQueryDtoSchema
>;
export type SiteCrossBreakdownQueryDtoInput = z.input<
  typeof SiteCrossBreakdownQueryDtoSchema
>;
export type SitePagesQueryDto = z.infer<typeof SitePagesQueryDtoSchema>;
export type SitePagesQueryDtoInput = z.input<typeof SitePagesQueryDtoSchema>;
export type SiteReferrersQueryDto = z.infer<typeof SiteReferrersQueryDtoSchema>;
export type SiteReferrersQueryDtoInput = z.input<
  typeof SiteReferrersQueryDtoSchema
>;
export type SiteChannelsQueryDto = z.infer<typeof SiteChannelsQueryDtoSchema>;
export type SiteChannelsQueryDtoInput = z.input<
  typeof SiteChannelsQueryDtoSchema
>;
export type SiteFilterValuesQueryDto = z.infer<
  typeof SiteFilterValuesQueryDtoSchema
>;
export type SiteFilterValuesQueryDtoInput = z.input<
  typeof SiteFilterValuesQueryDtoSchema
>;
export type SiteRetentionCohortsQueryDto = z.infer<
  typeof SiteRetentionCohortsQueryDtoSchema
>;
export type SiteRetentionCohortsQueryDtoInput = z.input<
  typeof SiteRetentionCohortsQueryDtoSchema
>;
export type SiteFunnelAnalysisQueryDtoInput = z.input<
  typeof SiteFunnelAnalysisQueryDtoSchema
>;
export type SitePerformanceSummaryQueryDto = z.infer<
  typeof SitePerformanceSummaryQueryDtoSchema
>;
export type SitePerformanceSummaryQueryDtoInput = z.input<
  typeof SitePerformanceSummaryQueryDtoSchema
>;
export type SitePerformanceTimeseriesQueryDto = z.infer<
  typeof SitePerformanceTimeseriesQueryDtoSchema
>;
export type SitePerformanceTimeseriesQueryDtoInput = z.input<
  typeof SitePerformanceTimeseriesQueryDtoSchema
>;
export type SitePerformanceBreakdownQueryDto = z.infer<
  typeof SitePerformanceBreakdownQueryDtoSchema
>;
export type SitePerformanceBreakdownQueryDtoInput = z.input<
  typeof SitePerformanceBreakdownQueryDtoSchema
>;
export type SiteEventsSummaryQueryDto = z.infer<
  typeof SiteEventsSummaryQueryDtoSchema
>;
export type SiteEventsSummaryQueryDtoInput = z.input<
  typeof SiteEventsSummaryQueryDtoSchema
>;
export type SiteEventsTimeseriesQueryDto = z.infer<
  typeof SiteEventsTimeseriesQueryDtoSchema
>;
export type SiteEventsTimeseriesQueryDtoInput = z.input<
  typeof SiteEventsTimeseriesQueryDtoSchema
>;
export type SiteEventsSearchQueryDto = z.infer<
  typeof SiteEventsSearchQueryDtoSchema
>;
export type SiteEventsSearchQueryDtoInput = z.input<
  typeof SiteEventsSearchQueryDtoSchema
>;
export type SiteEventDetailQueryDto = z.infer<
  typeof SiteEventDetailQueryDtoSchema
>;
export type SiteEventDetailQueryDtoInput = z.input<
  typeof SiteEventDetailQueryDtoSchema
>;
export type SiteJourneyEventDetailQueryDto = z.infer<
  typeof SiteJourneyEventDetailQueryDtoSchema
>;
export type SiteJourneyEventDetailQueryDtoInput = z.input<
  typeof SiteJourneyEventDetailQueryDtoSchema
>;
export type SiteEventTypesQueryDto = z.infer<
  typeof SiteEventTypesQueryDtoSchema
>;
export type SiteEventTypesQueryDtoInput = z.input<
  typeof SiteEventTypesQueryDtoSchema
>;
export type SiteEventTypeDetailQueryDto = z.infer<
  typeof SiteEventTypeDetailQueryDtoSchema
>;
export type SiteEventTypeDetailQueryDtoInput = z.input<
  typeof SiteEventTypeDetailQueryDtoSchema
>;
export type SiteEventFieldsQueryDto = z.infer<
  typeof SiteEventFieldsQueryDtoSchema
>;
export type SiteEventFieldsQueryDtoInput = z.input<
  typeof SiteEventFieldsQueryDtoSchema
>;
export type SiteEventFieldValuesQueryDto = z.infer<
  typeof SiteEventFieldValuesQueryDtoSchema
>;
export type SiteEventFieldValuesQueryDtoInput = z.input<
  typeof SiteEventFieldValuesQueryDtoSchema
>;
export type SiteVisitorDetailQueryDto = z.infer<
  typeof SiteVisitorDetailQueryDtoSchema
>;
export type SiteVisitorDetailQueryDtoInput = z.input<
  typeof SiteVisitorDetailQueryDtoSchema
>;
export type SiteSessionDetailQueryDto = z.infer<
  typeof SiteSessionDetailQueryDtoSchema
>;
export type SiteSessionDetailQueryDtoInput = z.input<
  typeof SiteSessionDetailQueryDtoSchema
>;
export type SiteVisitorsSearchQueryDto = z.infer<
  typeof SiteVisitorsSearchQueryDtoSchema
>;
export type SiteVisitorsSearchQueryDtoInput = z.input<
  typeof SiteVisitorsSearchQueryDtoSchema
>;
export type SiteSessionsSearchQueryDto = z.infer<
  typeof SiteSessionsSearchQueryDtoSchema
>;
export type SiteSessionsSearchQueryDtoInput = z.input<
  typeof SiteSessionsSearchQueryDtoSchema
>;
export type SiteVisitorEventsQueryDto = z.infer<
  typeof SiteVisitorEventsQueryDtoSchema
>;
export type SiteVisitorEventsQueryDtoInput = z.input<
  typeof SiteVisitorEventsQueryDtoSchema
>;
export type SiteVisitorSessionsQueryDto = z.infer<
  typeof SiteVisitorSessionsQueryDtoSchema
>;
export type SiteVisitorSessionsQueryDtoInput = z.input<
  typeof SiteVisitorSessionsQueryDtoSchema
>;
export type SiteSessionEventsQueryDto = z.infer<
  typeof SiteSessionEventsQueryDtoSchema
>;
export type SiteSessionEventsQueryDtoInput = z.input<
  typeof SiteSessionEventsQueryDtoSchema
>;
export type SiteRealtimeSnapshotQueryDto = z.infer<
  typeof SiteRealtimeSnapshotQueryDtoSchema
>;
export type SiteRealtimeSnapshotQueryDtoInput = z.input<
  typeof SiteRealtimeSnapshotQueryDtoSchema
>;
export type SiteRealtimeActiveVisitorsQueryDto = z.infer<
  typeof SiteRealtimeActiveVisitorsQueryDtoSchema
>;
export type SiteRealtimeActiveVisitorsQueryDtoInput = z.input<
  typeof SiteRealtimeActiveVisitorsQueryDtoSchema
>;
export type SiteRealtimeEventsQueryDto = z.infer<
  typeof SiteRealtimeEventsQueryDtoSchema
>;
export type SiteRealtimeEventsQueryDtoInput = z.input<
  typeof SiteRealtimeEventsQueryDtoSchema
>;
export type SiteRealtimeSessionsQueryDto = z.infer<
  typeof SiteRealtimeSessionsQueryDtoSchema
>;
export type SiteRealtimeSessionsQueryDtoInput = z.input<
  typeof SiteRealtimeSessionsQueryDtoSchema
>;
