import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

export type JourneyGeoSummaryLevel = "country" | "region" | "city";

const GEO_POINT_ATTRIBUTES = [
  "page.report.latitude",
  "page.report.longitude",
  "page.report.startedAt",
  "page.report.country",
  "page.report.region",
  "page.report.regionCode",
  "page.report.city",
] as const;

const GEO_SUMMARY_ATTRIBUTES = [
  "page.report.country",
  "page.report.region",
  "page.report.regionCode",
  "page.report.city",
  "page.report.sessionId",
  "page.report.visitorId",
] as const;

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

function finishGeoOutput(
  builder: LogicalPlanBuilder,
  outputId: string,
  relation: LogicalRelationHandle,
  fields: readonly { readonly name: string; readonly slot: string }[],
) {
  builder.output(outputId, relation, fields);
  return builder.finish();
}

/** Builds the coordinate-grouped Page report used by the journey map. */
export function buildJourneyGeoPointsPlan(
  input: JourneyGeoPlanInput & { readonly limit: number },
) {
  const { builder, pages } = createGeoSource(input, GEO_POINT_ATTRIBUTES);
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
    Number.isInteger(input.limit) && input.limit < 0
      ? sorted
      : builder.limit(sorted, input.limit);
  return finishGeoOutput(builder, "journey-geo-points", limited, [
    { name: "latitude", slot: "latitude" },
    { name: "longitude", slot: "longitude" },
    { name: "timestampMs", slot: "timestampMs" },
    { name: "country", slot: "country" },
    { name: "region", slot: "region" },
    { name: "regionCode", slot: "regionCode" },
    { name: "city", slot: "city" },
    { name: "pointCount", slot: "pointCount" },
  ]);
}

/** Builds one selected country, region, or city rollup over all matching Pages. */
export function buildJourneyGeoSummaryPlan(
  input: JourneyGeoPlanInput & { readonly level: JourneyGeoSummaryLevel },
) {
  const { builder, pages } = createGeoSource(input, GEO_SUMMARY_ATTRIBUTES);
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
  if (input.level === "country") {
    groups = { country };
    outputFields = [
      { name: "country", slot: "country" },
      { name: "views", slot: "views" },
      { name: "sessions", slot: "sessions" },
      { name: "visitors", slot: "visitors" },
    ];
    rowLimit = 300;
  } else if (input.level === "region") {
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
    ...(input.level === "country"
      ? [
          {
            slot: "country",
            direction: "asc" as const,
            nulls: "first" as const,
          },
        ]
      : input.level === "region"
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
  return finishGeoOutput(
    builder,
    `journey-geo-${input.level}-summary`,
    limited,
    outputFields,
  );
}
