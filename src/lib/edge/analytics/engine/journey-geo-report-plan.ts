import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { snapshotLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import {
  appendQualifiedPageSource,
  type QualifiedSourceFilterMode,
} from "@/lib/edge/analytics/engine/qualified-page-source";
import type { QualifiedGeoComparisonProvenance } from "@/lib/edge/analytics/engine/semantic/count-bare-fields";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const DATETIME = { kind: "scalar", scalar: "datetime" } as const;

export type JourneyGeoSummaryLevel = "country" | "region" | "city";

export const JOURNEY_GEO_POINTS_OUTPUT = "journey-geo-points";
export const JOURNEY_GEO_PAGE_COMPATIBILITY_POINTS_OUTPUT =
  "journey-geo-page-compatibility-points";
export const JOURNEY_GEO_PAGE_COMPATIBILITY_SUMMARY_OUTPUT =
  "journey-geo-page-compatibility-summary";
export const JOURNEY_GEO_PAGE_COMPATIBILITY_OUTPUT_FIELDS = [
  "rowType",
  "latitude",
  "longitude",
  "timestampMs",
  "country",
  "region",
  "regionCode",
  "city",
  "pointCount",
  "views",
  "sessions",
  "visitors",
] as const;

export const JOURNEY_GEO_POINT_ATTRIBUTES = [
  "page.report.latitude",
  "page.report.longitude",
  "page.report.startedAt",
  "page.report.country",
  "page.report.region",
  "page.report.regionCode",
  "page.report.city",
] as const;

export const JOURNEY_GEO_SUMMARY_ATTRIBUTES = [
  "page.report.country",
  "page.report.region",
  "page.report.regionCode",
  "page.report.city",
  "page.report.sessionId",
  "page.report.visitorId",
] as const;

export type JourneyGeoQualificationPlan = AnalyticsQualificationPlan<
  "session" | "visitor" | "event"
> & {
  readonly reportOutputIds: readonly [string, string];
  readonly comparisonProvenance: readonly QualifiedGeoComparisonProvenance[];
};

interface JourneyGeoPlanInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
}

function createGeoSource(
  input: JourneyGeoPlanInput,
  attributes: readonly string[],
) {
  return createPageReportSource({
    ...input,
    ...(input.scopePlan
      ? { preparedTimePolicy: "reader-window-v1" as const }
      : {}),
    attributes,
  });
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name:
    | "latitude"
    | "longitude"
    | "startedAt"
    | "country"
    | "region"
    | "regionCode"
    | "city"
    | "sessionId"
    | "visitorId",
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

/** Appends the coordinate-grouped Page report to a caller-owned builder. */
export function appendJourneyGeoPointsReport(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  limit: number,
): LogicalRelationHandle {
  const latitude = pageAttribute(builder, pages, "latitude");
  const longitude = pageAttribute(builder, pages, "longitude");
  const validCoordinates = builder.filter(
    pages,
    builder.and(
      builder.isNull(latitude, true),
      builder.isNull(longitude, true),
      builder.compare(
        "lte",
        builder.absolute(latitude),
        builder.literal(90, NUMBER),
      ),
      builder.compare(
        "lte",
        builder.absolute(longitude),
        builder.literal(180, NUMBER),
      ),
    ),
  );
  const grouped = builder.aggregate(
    validCoordinates,
    {
      latitude: builder.round(latitude, 3),
      longitude: builder.round(longitude, 3),
      country: pageAttribute(builder, pages, "country"),
      region: pageAttribute(builder, pages, "region"),
      regionCode: pageAttribute(builder, pages, "regionCode"),
      city: pageAttribute(builder, pages, "city"),
    },
    [
      {
        name: "timestampMs",
        kind: "max",
        expression: pageAttribute(builder, pages, "startedAt"),
      },
      { name: "pointCount", kind: "count-rows" },
    ],
  );
  const sorted = builder.sort(grouped, [
    { slot: "timestampMs", direction: "desc", nulls: "last" },
  ]);
  // SQLite treats a negative integer LIMIT as unbounded.
  const limited =
    Number.isInteger(limit) && limit < 0
      ? sorted
      : builder.limit(sorted, limit);
  builder.output(JOURNEY_GEO_POINTS_OUTPUT, limited, [
    { name: "latitude", slot: "latitude" },
    { name: "longitude", slot: "longitude" },
    { name: "timestampMs", slot: "timestampMs" },
    { name: "country", slot: "country" },
    { name: "region", slot: "region" },
    { name: "regionCode", slot: "regionCode" },
    { name: "city", slot: "city" },
    { name: "pointCount", slot: "pointCount" },
  ]);
  return limited;
}

/** Builds the standalone coordinate report used by the compatibility path. */
export function buildJourneyGeoPointsPlan(
  input: JourneyGeoPlanInput & { readonly limit: number },
) {
  const { builder, pages } = createGeoSource(
    input,
    JOURNEY_GEO_POINT_ATTRIBUTES,
  );
  appendJourneyGeoPointsReport(builder, pages, input.limit);
  return builder.finish();
}

/** Appends a selected country, region, or city rollup over matching Pages. */
export function appendJourneyGeoSummaryReport(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  level: JourneyGeoSummaryLevel,
): LogicalRelationHandle {
  const country = pageAttribute(builder, pages, "country");
  const region = pageAttribute(builder, pages, "region");
  const regionCode = pageAttribute(builder, pages, "regionCode");
  const city = pageAttribute(builder, pages, "city");
  const sessionId = pageAttribute(builder, pages, "sessionId");
  const visitorId = pageAttribute(builder, pages, "visitorId");

  const nonemptyDistinctValue = (value: typeof sessionId) =>
    builder.caseWhen(
      [
        {
          when: builder.compare("neq", value, builder.literal("", STRING)),
          then: value,
        },
      ],
      builder.literal(null, STRING),
    );

  let filtered = pages;
  let groups: Record<string, LogicalExpressionHandle>;
  let outputFields: readonly { readonly name: string; readonly slot: string }[];
  let rowLimit: number;
  if (level === "country") {
    groups = { country };
    outputFields = [
      { name: "country", slot: "country" },
      { name: "views", slot: "views" },
      { name: "sessions", slot: "sessions" },
      { name: "visitors", slot: "visitors" },
    ];
    rowLimit = 300;
  } else if (level === "region") {
    const hasRegionCode = builder.compare(
      "neq",
      builder.normalizeString(
        builder.coalesce(regionCode, builder.literal("", STRING)),
        "trim-ascii-space",
      ),
      builder.literal("", STRING),
    );
    const hasRegionName = builder.compare(
      "neq",
      builder.normalizeString(
        builder.coalesce(region, builder.literal("", STRING)),
        "trim-ascii-space",
      ),
      builder.literal("", STRING),
    );
    const hasCountry = builder.compare(
      "neq",
      builder.normalizeString(
        builder.coalesce(country, builder.literal("", STRING)),
        "trim-ascii-space",
      ),
      builder.literal("", STRING),
    );
    filtered = builder.filter(
      pages,
      builder.and(hasCountry, builder.or(hasRegionCode, hasRegionName)),
    );
    groups = { country, regionCode, region };
    outputFields = [
      { name: "country", slot: "country" },
      { name: "regionCode", slot: "regionCode" },
      { name: "region", slot: "region" },
      { name: "views", slot: "views" },
      { name: "sessions", slot: "sessions" },
      { name: "visitors", slot: "visitors" },
    ];
    rowLimit = 400;
  } else {
    const hasCountry = builder.compare(
      "neq",
      builder.normalizeString(
        builder.coalesce(country, builder.literal("", STRING)),
        "trim-ascii-space",
      ),
      builder.literal("", STRING),
    );
    const hasCity = builder.compare(
      "neq",
      builder.normalizeString(
        builder.coalesce(city, builder.literal("", STRING)),
        "trim-ascii-space",
      ),
      builder.literal("", STRING),
    );
    filtered = builder.filter(pages, builder.and(hasCountry, hasCity));
    groups = { country, regionCode, region, city };
    outputFields = [
      { name: "country", slot: "country" },
      { name: "regionCode", slot: "regionCode" },
      { name: "region", slot: "region" },
      { name: "city", slot: "city" },
      { name: "views", slot: "views" },
      { name: "sessions", slot: "sessions" },
      { name: "visitors", slot: "visitors" },
    ];
    rowLimit = 600;
  }

  const grouped = builder.aggregate(filtered, groups, [
    { name: "views", kind: "count-rows" },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: nonemptyDistinctValue(sessionId),
    },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonemptyDistinctValue(visitorId),
    },
  ]);
  const orderBy = [
    { slot: "views", direction: "desc" as const, nulls: "last" as const },
    { slot: "sessions", direction: "desc" as const, nulls: "last" as const },
    ...(level === "country"
      ? [
          {
            slot: "country",
            direction: "asc" as const,
            nulls: "first" as const,
          },
        ]
      : level === "region"
        ? [
            {
              slot: "region",
              direction: "asc" as const,
              nulls: "first" as const,
            },
            {
              slot: "regionCode",
              direction: "asc" as const,
              nulls: "first" as const,
            },
          ]
        : [
            {
              slot: "city",
              direction: "asc" as const,
              nulls: "first" as const,
            },
          ]),
  ];
  const sorted = builder.sort(grouped, orderBy);
  const limited = builder.limit(sorted, rowLimit);
  builder.output(`journey-geo-${level}-summary`, limited, outputFields);
  return limited;
}

/** Builds the standalone selected summary for the compatibility path. */
export function buildJourneyGeoSummaryPlan(
  input: JourneyGeoPlanInput & { readonly level: JourneyGeoSummaryLevel },
) {
  const { builder, pages } = createGeoSource(
    input,
    JOURNEY_GEO_SUMMARY_ATTRIBUTES,
  );
  appendJourneyGeoSummaryReport(builder, pages, input.level);
  return builder.finish();
}

/** Selects the legacy shallow root condition that controls the summary DTO. */
export function journeyGeoSummaryLevelFromFilter(
  filters: FilterDocument,
): JourneyGeoSummaryLevel {
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
  const country = valueFor("geo.country");
  const regionCode = valueFor("geo.region");
  return !country ? "country" : !regionCode ? "region" : "city";
}

/**
 * Builds both legacy Core Geo roots over one Page Source for Page-visit
 * compatibility. The points and summary appenders retain their separate
 * filters, groupings, and limits; only their output rows are normalized so a
 * single D1 output-set execution can return the complete Geo DTO.
 */
export function buildJourneyGeoPageVisitCompatibilityPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly qualificationDependencyRefs: readonly QualificationDependencyRef[];
  readonly limit: number;
  readonly level: JourneyGeoSummaryLevel;
}) {
  const source = createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    qualificationDependencyRefs: input.qualificationDependencyRefs,
    attributes: [
      ...new Set([
        ...JOURNEY_GEO_POINT_ATTRIBUTES,
        ...JOURNEY_GEO_SUMMARY_ATTRIBUTES,
      ]),
    ],
  });
  const points = appendJourneyGeoPointsReport(
    source.builder,
    source.pages,
    input.limit,
  );
  const summary = appendJourneyGeoSummaryReport(
    source.builder,
    source.pages,
    input.level,
  );
  const nullString = () => source.builder.literal(null, STRING);
  const nullNumber = () => source.builder.literal(null, NUMBER);
  const nullTimestamp = () => source.builder.literal(null, DATETIME);
  const pointRows = source.builder.project(points, {
    rowType: source.builder.literal("points", STRING),
    latitude: source.builder.slot(points, "latitude"),
    longitude: source.builder.slot(points, "longitude"),
    timestampMs: source.builder.slot(points, "timestampMs"),
    country: source.builder.slot(points, "country"),
    region: source.builder.slot(points, "region"),
    regionCode: source.builder.slot(points, "regionCode"),
    city: source.builder.slot(points, "city"),
    pointCount: source.builder.slot(points, "pointCount"),
    views: nullNumber(),
    sessions: nullNumber(),
    visitors: nullNumber(),
  });
  const hasRegion = input.level !== "country";
  const hasCity = input.level === "city";
  const summaryRows = source.builder.project(summary, {
    rowType: source.builder.literal("summary", STRING),
    latitude: nullNumber(),
    longitude: nullNumber(),
    timestampMs: nullTimestamp(),
    country: source.builder.slot(summary, "country"),
    region: hasRegion ? source.builder.slot(summary, "region") : nullString(),
    regionCode: hasRegion
      ? source.builder.slot(summary, "regionCode")
      : nullString(),
    city: hasCity ? source.builder.slot(summary, "city") : nullString(),
    pointCount: nullNumber(),
    views: source.builder.slot(summary, "views"),
    sessions: source.builder.slot(summary, "sessions"),
    visitors: source.builder.slot(summary, "visitors"),
  });
  for (const [outputId, rows] of [
    [JOURNEY_GEO_PAGE_COMPATIBILITY_POINTS_OUTPUT, pointRows],
    [JOURNEY_GEO_PAGE_COMPATIBILITY_SUMMARY_OUTPUT, summaryRows],
  ] as const)
    source.builder.output(
      outputId,
      rows,
      JOURNEY_GEO_PAGE_COMPATIBILITY_OUTPUT_FIELDS.map((name) => ({
        name,
        slot: name,
      })),
    );
  return source.builder.finish();
}

/** Builds points and exactly one selected summary from one qualified Page bag. */
export function buildJourneyGeoPointsQualificationPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountQualificationPlanInput;
  readonly limit: number;
  readonly level: JourneyGeoSummaryLevel;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly eventCandidateReportProjection?: "page-visits";
}): JourneyGeoQualificationPlan {
  const source = appendQualifiedPageSource({
    semanticOperation: "geo-points",
    filterMode: input.eventCandidateReportProjection
      ? "allow-whole-filter"
      : (input.filterMode ?? "split-only"),
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    ...(input.eventCandidateReportProjection
      ? { eventCandidateReportProjection: input.eventCandidateReportProjection }
      : {}),
    selections: [],
    additionalAttributes: [
      ...JOURNEY_GEO_POINT_ATTRIBUTES,
      ...JOURNEY_GEO_SUMMARY_ATTRIBUTES,
    ],
  });
  appendJourneyGeoPointsReport(
    source.builder,
    source.qualifiedPages,
    input.limit,
  );
  appendJourneyGeoSummaryReport(
    source.builder,
    source.qualifiedPages,
    input.level,
  );
  const controlOutputId = "geo-points-qualification-controls";
  source.builder.output(
    controlOutputId,
    source.qualification.controls,
    Object.keys(source.qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );
  const summaryOutputId = `journey-geo-${input.level}-summary`;
  const logicalPlan = validateLogicalPlan(
    snapshotLogicalPlan(source.builder.finish()),
  );
  return {
    plan: logicalPlan,
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: source.qualification.matches.id,
    controlsRelationId: source.qualification.controls.id,
    groupedSummaryRelationId: source.qualification.groupedSummary.id,
    controlOutputId,
    reportOutputIds: [JOURNEY_GEO_POINTS_OUTPUT, summaryOutputId],
    numericCompatibilityFields: source.qualification.numericCompatibilityFields,
    comparisonProvenance: source.qualification.comparisonProvenance,
    scope: source.qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      source.qualification,
      source.eventCandidateReportProjection,
    ),
  };
}
