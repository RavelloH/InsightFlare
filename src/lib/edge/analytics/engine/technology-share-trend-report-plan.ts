import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type {
  CalendarGranularity,
  ClientDimensionKey,
  Interval,
  UtmDimensionKey,
} from "@/lib/edge/analytics/contract/types";
import {
  PAGE_DIMENSION_SELECTIONS,
  type PageDimensionSelection,
  selectedPageDimension,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import { semanticPageDimension } from "@/lib/edge/analytics/engine/semantic/page-dimensions";
import { EVENT_FILTER_PAGE_VISIT_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const OTHER_TOKEN = "__share_trend_other__";

export const TECHNOLOGY_SHARE_TREND_DIMENSIONS = {
  browser: PAGE_DIMENSION_SELECTIONS.browser,
  browserEngine: PAGE_DIMENSION_SELECTIONS.browserEngine,
  operatingSystem: PAGE_DIMENSION_SELECTIONS.operatingSystem,
  osVersion: PAGE_DIMENSION_SELECTIONS.osVersion,
  deviceType: PAGE_DIMENSION_SELECTIONS.deviceType,
  language: PAGE_DIMENSION_SELECTIONS.language,
  screenSize: PAGE_DIMENSION_SELECTIONS.screenSize,
  utmSource: PAGE_DIMENSION_SELECTIONS.utmSource,
  utmMedium: PAGE_DIMENSION_SELECTIONS.utmMedium,
  utmCampaign: PAGE_DIMENSION_SELECTIONS.utmCampaign,
  utmTerm: PAGE_DIMENSION_SELECTIONS.utmTerm,
  utmContent: PAGE_DIMENSION_SELECTIONS.utmContent,
  referrerDomain: PAGE_DIMENSION_SELECTIONS.referrerDomain,
  trafficChannel: PAGE_DIMENSION_SELECTIONS.trafficChannel,
} as const satisfies Readonly<Record<string, PageDimensionSelection>>;

export type TechnologyShareTrendDimension =
  keyof typeof TECHNOLOGY_SHARE_TREND_DIMENSIONS;

export const CLIENT_DIMENSIONS: Readonly<
  Record<ClientDimensionKey, TechnologyShareTrendDimension>
> = {
  browser: "browser",
  operatingSystem: "operatingSystem",
  osVersion: "osVersion",
  deviceType: "deviceType",
  language: "language",
  screenSize: "screenSize",
};

export const UTM_DIMENSIONS: Readonly<
  Record<UtmDimensionKey, TechnologyShareTrendDimension>
> = {
  source: "utmSource",
  medium: "utmMedium",
  campaign: "utmCampaign",
  term: "utmTerm",
  content: "utmContent",
};

export type TechnologyShareTrendQualificationConfiguration =
  | {
      readonly kind: "single";
      readonly dimension: TechnologyShareTrendDimension;
      readonly interval: Interval;
      readonly limit: number;
    }
  | {
      readonly kind: "dual";
      readonly interval: Interval;
      readonly limit: number;
    };

const SHARE_TREND_INTERVALS = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const satisfies readonly Interval[];

const CLIENT_DIMENSION_KEYS = Object.keys(
  CLIENT_DIMENSIONS,
) as ClientDimensionKey[];
const UTM_DIMENSION_KEYS = Object.keys(UTM_DIMENSIONS) as UtmDimensionKey[];

/** Normalizes only the exact finite production variants handled by share-trend. */
export function technologyShareTrendQualificationConfiguration(input: {
  readonly variant: unknown;
  readonly dimension: unknown;
  readonly interval: unknown;
  readonly limit: unknown;
}): TechnologyShareTrendQualificationConfiguration | undefined {
  if (
    typeof input.interval !== "string" ||
    !SHARE_TREND_INTERVALS.includes(input.interval as Interval)
  )
    return undefined;
  const normalizedLimit = Math.min(
    Math.max(1, (input.limit ?? 5) as number),
    12,
  );
  if (
    !Number.isSafeInteger(normalizedLimit) ||
    normalizedLimit < 1 ||
    normalizedLimit > 12
  )
    return undefined;
  if (input.variant === "referrer-channel") {
    if (input.dimension !== undefined) return undefined;
    return {
      kind: "dual",
      interval: input.interval as Interval,
      limit: normalizedLimit,
    };
  }
  let dimension: TechnologyShareTrendDimension | undefined;
  if (input.variant === "browser") {
    if (input.dimension !== undefined) return undefined;
    dimension = "browser";
  } else if (input.variant === "browser-engine") {
    if (input.dimension !== undefined) return undefined;
    dimension = "browserEngine";
  } else if (input.variant === "client") {
    if (
      typeof input.dimension !== "string" ||
      !CLIENT_DIMENSION_KEYS.includes(input.dimension as ClientDimensionKey)
    )
      return undefined;
    dimension = CLIENT_DIMENSIONS[input.dimension as ClientDimensionKey];
  } else if (input.variant === "utm") {
    if (
      typeof input.dimension !== "string" ||
      !UTM_DIMENSION_KEYS.includes(input.dimension as UtmDimensionKey)
    )
      return undefined;
    dimension = UTM_DIMENSIONS[input.dimension as UtmDimensionKey];
  } else if (input.variant === undefined || input.variant === "referrer") {
    if (input.dimension !== undefined) return undefined;
    dimension = "referrerDomain";
  } else return undefined;
  return {
    kind: "single",
    dimension,
    interval: input.interval as Interval,
    limit: normalizedLimit,
  };
}

type TrendKind = "single" | "source" | "channel";
type TrendRowType = "top" | "series" | "bucket";

export const TECHNOLOGY_SHARE_TREND_OUTPUTS = {
  single: {
    top: "technology-share-trend-single-top",
    series: "technology-share-trend-single-series",
    bucket: "technology-share-trend-single-bucket",
  },
  source: {
    top: "technology-share-trend-source-top",
    series: "technology-share-trend-source-series",
    bucket: "technology-share-trend-source-bucket",
  },
  channel: {
    top: "technology-share-trend-channel-top",
    series: "technology-share-trend-channel-series",
    bucket: "technology-share-trend-channel-bucket",
  },
} as const;

interface TechnologyShareTrendPlanInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  /** Select the canonical prepared-scoped Page Source for an already prepared visit relation. */
  readonly pageVisitQualification?: true;
  readonly interval: CalendarGranularity;
  readonly limit: number;
}

export interface SelectedTrendDimension {
  readonly kind: TrendKind;
  readonly dimension: TechnologyShareTrendDimension;
}

const OUTPUT_FIELDS = [
  { name: "trendKind", slot: "trendKind" },
  { name: "rowType", slot: "rowType" },
  { name: "bucket", slot: "bucket" },
  { name: "label", slot: "label" },
  { name: "views", slot: "views" },
  { name: "visitors", slot: "visitors" },
  { name: "sessions", slot: "sessions" },
  { name: "rowOrder", slot: "rowOrder" },
] as const;

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "startedAt" | "localId" | "visitorId" | "sessionId",
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function distinctNonempty(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
) {
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", value, builder.literal("", STRING)),
        then: value,
      },
    ],
    builder.literal(null, STRING),
  );
}

function requiredAttributes(
  dimensions: readonly SelectedTrendDimension[],
): SemanticAttributeId[] {
  const attributes = new Set<SemanticAttributeId>([
    "page.report.startedAt",
    "page.report.localId",
    "page.report.visitorId",
    "page.report.sessionId",
  ]);
  for (const { dimension } of dimensions) {
    const selection = TECHNOLOGY_SHARE_TREND_DIMENSIONS[dimension];
    if (selection.kind === "stored") {
      attributes.add(selection.attribute);
      continue;
    }
    const definition = semanticPageDimension(selection.dimension);
    if (!definition)
      throw new Error(`unsupported-page-dimension:${selection.dimension}`);
    for (const attribute of definition.dependencies) attributes.add(attribute);
  }
  return [...attributes];
}

function taggedOutput(
  builder: LogicalPlanBuilder,
  kind: TrendKind,
  rowType: TrendRowType,
  relation: LogicalRelationHandle,
  values: {
    readonly bucket: LogicalExpressionHandle;
    readonly label: LogicalExpressionHandle;
    readonly views: LogicalExpressionHandle;
    readonly visitors: LogicalExpressionHandle;
    readonly sessions: LogicalExpressionHandle;
    readonly rowOrder: LogicalExpressionHandle;
  },
): void {
  const output = builder.project(relation, {
    trendKind: builder.literal(kind, STRING),
    rowType: builder.literal(rowType, STRING),
    bucket: values.bucket,
    label: values.label,
    views: values.views,
    visitors: values.visitors,
    sessions: values.sessions,
    rowOrder: values.rowOrder,
  });
  builder.output(
    TECHNOLOGY_SHARE_TREND_OUTPUTS[kind][rowType],
    output,
    OUTPUT_FIELDS,
  );
}

function dimensionOutputs(
  builder: LogicalPlanBuilder,
  sharedRows: LogicalRelationHandle,
  dimension: TechnologyShareTrendDimension,
  kind: TrendKind,
  limit: number,
): void {
  const rows = builder.project(sharedRows, {
    bucket: builder.slot(sharedRows, "bucket"),
    visitorId: builder.slot(sharedRows, "visitorId"),
    sessionId: builder.slot(sharedRows, "sessionId"),
    globalLabel: builder.slot(sharedRows, `${kind}GlobalLabel`),
    bucketLabel: builder.slot(sharedRows, `${kind}BucketLabel`),
  });

  const globalNonemptyRows = builder.filter(
    rows,
    builder.compare(
      "neq",
      builder.slot(rows, "globalLabel"),
      builder.literal("", STRING),
    ),
  );
  const topAggregate = builder.aggregate(
    globalNonemptyRows,
    { label: builder.slot(globalNonemptyRows, "globalLabel") },
    [
      { name: "views", kind: "count-rows" },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: builder.slot(globalNonemptyRows, "visitorId"),
      },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(globalNonemptyRows, "sessionId"),
        ),
      },
    ],
  );
  const rankedTop = builder.rankedMembers(topAggregate, {
    groups: [],
    order: [
      { slot: "visitors", direction: "desc", nulls: "last" },
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "sessions", direction: "desc", nulls: "last" },
      { slot: "label", direction: "asc", nulls: "first" },
    ],
  });
  const topRows = builder.limit(
    builder.sort(rankedTop, [
      { slot: "rank", direction: "asc", nulls: "last" },
    ]),
    limit,
  );
  taggedOutput(builder, kind, "top", topRows, {
    bucket: builder.literal(null, NUMBER),
    label: builder.slot(topRows, "label"),
    views: builder.slot(topRows, "views"),
    visitors: builder.slot(topRows, "visitors"),
    sessions: builder.slot(topRows, "sessions"),
    rowOrder: builder.slot(topRows, "rank"),
  });

  const rowsWithGlobalTop = builder.join(
    rows,
    topRows,
    [{ left: "globalLabel", right: "label" }],
    "left",
  );
  const globalSeries = builder.aggregate(
    rowsWithGlobalTop,
    {
      label: builder.coalesce(
        builder.slot(rowsWithGlobalTop, "right.label"),
        builder.literal(OTHER_TOKEN, STRING),
      ),
    },
    [
      { name: "views", kind: "count-rows" },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: builder.slot(rowsWithGlobalTop, "visitorId"),
      },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(rowsWithGlobalTop, "sessionId"),
        ),
      },
    ],
  );
  taggedOutput(builder, kind, "series", globalSeries, {
    bucket: builder.literal(null, NUMBER),
    label: builder.slot(globalSeries, "label"),
    views: builder.slot(globalSeries, "views"),
    visitors: builder.slot(globalSeries, "visitors"),
    sessions: builder.slot(globalSeries, "sessions"),
    rowOrder: builder.literal(0, NUMBER),
  });

  const rowsWithBucketTop = builder.join(
    rows,
    topRows,
    [{ left: "bucketLabel", right: "label" }],
    "left",
  );
  const bucketSeries = builder.aggregate(
    rowsWithBucketTop,
    {
      bucket: builder.slot(rowsWithBucketTop, "bucket"),
      label: builder.coalesce(
        builder.slot(rowsWithBucketTop, "right.label"),
        builder.literal(OTHER_TOKEN, STRING),
      ),
    },
    [
      { name: "views", kind: "count-rows" },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: builder.slot(rowsWithBucketTop, "visitorId"),
      },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(rowsWithBucketTop, "sessionId"),
        ),
      },
    ],
  );
  taggedOutput(builder, kind, "bucket", bucketSeries, {
    bucket: builder.slot(bucketSeries, "bucket"),
    label: builder.slot(bucketSeries, "label"),
    views: builder.slot(bucketSeries, "views"),
    visitors: builder.slot(bucketSeries, "visitors"),
    sessions: builder.slot(bucketSeries, "sessions"),
    rowOrder: builder.literal(0, NUMBER),
  });
}

export function appendTechnologyShareTrendReport(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly dimensions: readonly SelectedTrendDimension[];
  readonly interval: CalendarGranularity;
  readonly limit: number;
}): void {
  const { builder, pages, dimensions } = input;
  const visitorId = pageAttribute(builder, pages, "visitorId");
  const eligiblePages = builder.filter(
    pages,
    builder.compare("neq", visitorId, builder.literal("", STRING)),
  );
  const bucketIndex = builder.bucketIndex(
    builder.timeBucket(
      pageAttribute(builder, pages, "startedAt"),
      input.interval,
    ),
  );
  const bucketPartitionKey = builder.coalesce(
    bucketIndex,
    builder.literal(-1, NUMBER),
  );

  const memberLabels = Object.fromEntries(
    dimensions.map(({ kind, dimension }) => [
      `${kind}Label`,
      builder.coalesce(
        selectedPageDimension(
          builder,
          pages,
          TECHNOLOGY_SHARE_TREND_DIMENSIONS[dimension],
        ),
        builder.literal("", STRING),
      ),
    ]),
  );
  const members = builder.project(eligiblePages, {
    bucket: bucketIndex,
    bucketPartitionKey,
    startedAt: pageAttribute(builder, pages, "startedAt"),
    visitId: pageAttribute(builder, pages, "localId"),
    visitorId,
    sessionId: pageAttribute(builder, pages, "sessionId"),
    ...memberLabels,
  });
  const latestGlobal = builder.orderedMember(members, {
    groups: ["visitorId"],
    order: [
      { slot: "startedAt", direction: "desc", nulls: "last" },
      { slot: "visitId", direction: "desc", nulls: "last" },
    ],
  });
  const latestBucket = builder.orderedMember(members, {
    groups: ["visitorId", "bucketPartitionKey"],
    order: [
      { slot: "startedAt", direction: "desc", nulls: "last" },
      { slot: "visitId", direction: "desc", nulls: "last" },
    ],
  });

  const latestGlobalLabels = builder.project(latestGlobal, {
    visitorId: builder.slot(latestGlobal, "visitorId"),
    ...Object.fromEntries(
      dimensions.map(({ kind }) => [
        `${kind}Label`,
        builder.slot(latestGlobal, `${kind}Label`),
      ]),
    ),
  });
  const withGlobalLabels = builder.join(members, latestGlobalLabels, [
    { left: "visitorId", right: "visitorId" },
  ]);
  const globalRows = builder.project(withGlobalLabels, {
    bucket: builder.slot(withGlobalLabels, "bucket"),
    bucketPartitionKey: builder.slot(withGlobalLabels, "bucketPartitionKey"),
    visitorId: builder.slot(withGlobalLabels, "visitorId"),
    sessionId: builder.slot(withGlobalLabels, "sessionId"),
    ...Object.fromEntries(
      dimensions.map(({ kind }) => [
        `${kind}GlobalLabel`,
        builder.slot(withGlobalLabels, `right.${kind}Label`),
      ]),
    ),
  });
  const latestBucketLabels = builder.project(latestBucket, {
    visitorId: builder.slot(latestBucket, "visitorId"),
    bucketPartitionKey: builder.slot(latestBucket, "bucketPartitionKey"),
    ...Object.fromEntries(
      dimensions.map(({ kind }) => [
        `${kind}Label`,
        builder.slot(latestBucket, `${kind}Label`),
      ]),
    ),
  });
  const withBucketLabels = builder.join(globalRows, latestBucketLabels, [
    { left: "visitorId", right: "visitorId" },
    { left: "bucketPartitionKey", right: "bucketPartitionKey" },
  ]);
  const sharedRows = builder.project(withBucketLabels, {
    bucket: builder.slot(withBucketLabels, "bucket"),
    visitorId: builder.slot(withBucketLabels, "visitorId"),
    sessionId: builder.slot(withBucketLabels, "sessionId"),
    ...Object.fromEntries(
      dimensions.flatMap(({ kind }) => [
        [
          `${kind}GlobalLabel`,
          builder.slot(withBucketLabels, `${kind}GlobalLabel`),
        ],
        [
          `${kind}BucketLabel`,
          builder.slot(withBucketLabels, `right.${kind}Label`),
        ],
      ]),
    ),
  });

  for (const selected of dimensions)
    dimensionOutputs(
      builder,
      sharedRows,
      selected.dimension,
      selected.kind,
      input.limit,
    );
}

function buildPlan(
  input: TechnologyShareTrendPlanInput,
  dimensions: readonly SelectedTrendDimension[],
): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.pageVisitQualification
      ? {
          qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
        }
      : {}),
    ...(input.scopePlan
      ? {
          scopePlan: input.scopePlan,
          ...(!input.pageVisitQualification
            ? { preparedTimePolicy: "reader-window-v1" as const }
            : {}),
        }
      : {}),
    attributes: requiredAttributes(dimensions),
  });
  appendTechnologyShareTrendReport({
    builder,
    pages,
    dimensions,
    interval: input.interval,
    limit: input.limit,
  });
  return builder.finish();
}

/** Builds one typed top/series/bucket trend over a finite Page dimension. */
export function buildTechnologyShareTrendPlan(
  input: TechnologyShareTrendPlanInput & {
    readonly dimension: TechnologyShareTrendDimension;
  },
): ValidatedLogicalPlan {
  return buildPlan(input, [{ kind: "single", dimension: input.dimension }]);
}

/** Builds Referrer-domain and traffic-channel outputs over one shared Page bag. */
export function buildTechnologyReferrerChannelTrendPlan(
  input: TechnologyShareTrendPlanInput,
): ValidatedLogicalPlan {
  return buildPlan(input, [
    { kind: "source", dimension: "referrerDomain" },
    { kind: "channel", dimension: "trafficChannel" },
  ]);
}
