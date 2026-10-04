import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  dimensionRollup,
  PAGE_DIMENSION_SELECTIONS,
  pageDimensionReportSource,
  type PageDimensionSelection,
  selectedPageDimension,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;

type CardDefinition = {
  readonly cardType: string;
  readonly selection: PageDimensionSelection;
  readonly outputId: string;
};

const CLIENT_CARDS = [
  {
    cardType: "browser",
    selection: PAGE_DIMENSION_SELECTIONS.browser,
    outputId: "overview-client-browser",
  },
  {
    cardType: "osVersion",
    selection: PAGE_DIMENSION_SELECTIONS.osVersion,
    outputId: "overview-client-os-version",
  },
  {
    cardType: "deviceType",
    selection: PAGE_DIMENSION_SELECTIONS.deviceType,
    outputId: "overview-client-device-type",
  },
  {
    cardType: "language",
    selection: PAGE_DIMENSION_SELECTIONS.language,
    outputId: "overview-client-language",
  },
  {
    cardType: "screenSize",
    selection: PAGE_DIMENSION_SELECTIONS.screenSize,
    outputId: "overview-client-screen-size",
  },
] as const satisfies readonly CardDefinition[];

const GEO_CARDS = [
  {
    cardType: "country",
    selection: PAGE_DIMENSION_SELECTIONS.countryTrimmed,
    outputId: "overview-geo-country",
  },
  {
    cardType: "region",
    selection: PAGE_DIMENSION_SELECTIONS.region,
    outputId: "overview-geo-region",
  },
  {
    cardType: "city",
    selection: PAGE_DIMENSION_SELECTIONS.city,
    outputId: "overview-geo-city",
  },
  {
    cardType: "continent",
    selection: PAGE_DIMENSION_SELECTIONS.continentTrimmed,
    outputId: "overview-geo-continent",
  },
  {
    cardType: "timezone",
    selection: PAGE_DIMENSION_SELECTIONS.timezoneTrimmed,
    outputId: "overview-geo-timezone",
  },
  {
    cardType: "organization",
    selection: PAGE_DIMENSION_SELECTIONS.organizationTrimmed,
    outputId: "overview-geo-organization",
  },
] as const satisfies readonly CardDefinition[];

const CLIENT_OUTPUT_FIELDS = [
  "cardType",
  "value",
  "views",
  "sessions",
] as const;
const GEO_OUTPUT_FIELDS = [...CLIENT_OUTPUT_FIELDS, "visitors"] as const;

function output(
  builder: LogicalPlanBuilder,
  id: string,
  relation: LogicalRelationHandle,
  fields: readonly string[],
): void {
  builder.output(
    id,
    relation,
    fields.map((name) => ({ name, slot: name })),
  );
}

function cardTopRows(
  builder: LogicalPlanBuilder,
  rolled: LogicalRelationHandle,
  cardType: string,
  limit: number | null,
  includeVisitors: boolean,
): LogicalRelationHandle {
  const value = builder.slot(rolled, "value");
  const nonempty = builder.filter(
    rolled,
    builder.compare(
      "neq",
      builder.normalizeString(value, "trim-ascii-space"),
      builder.literal("", STRING),
    ),
  );
  const projections = {
    cardType: builder.literal(cardType, STRING),
    value: builder.slot(nonempty, "value"),
    views: builder.slot(nonempty, "views"),
    sessions: builder.slot(nonempty, "sessions"),
    ...(includeVisitors
      ? { visitors: builder.slot(nonempty, "visitors") }
      : {}),
  };
  const cardRows = builder.project(nonempty, projections);
  const sorted = builder.sort(cardRows, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    ...(includeVisitors
      ? [
          {
            slot: "visitors",
            direction: "desc" as const,
            nulls: "last" as const,
          },
        ]
      : []),
    { slot: "value", direction: "asc", nulls: "first" },
  ]);
  return limit === null ? sorted : builder.limit(sorted, limit);
}

function selectedCardDimension(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  card: CardDefinition,
) {
  if (card.cardType !== "osVersion")
    return selectedPageDimension(builder, pages, card.selection);
  return builder.pageDimension("overviewOsVersion", {
    "page.report.os": builder.slot(pages, "attribute:page.report.os"),
    "page.report.osVersion": builder.slot(
      pages,
      "attribute:page.report.osVersion",
    ),
  });
}

function cardLimit(limit: number): number | null {
  if (Number.isNaN(limit) || limit <= 0) return 0;
  if (limit === Number.POSITIVE_INFINITY) return null;
  if (!Number.isFinite(limit)) return 0;
  return Math.floor(limit);
}

function buildCardOutputs(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
  readonly cards: readonly CardDefinition[];
  readonly includeVisitors: boolean;
}): ValidatedLogicalPlan {
  const { builder, pages } = pageDimensionReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    selections: input.cards.map((card) => card.selection),
    includeVisitors: input.includeVisitors,
  });
  const limit = cardLimit(input.limit);
  for (const card of input.cards) {
    let rows = dimensionRollup(
      builder,
      pages,
      selectedCardDimension(builder, pages, card),
      { includeVisitors: input.includeVisitors },
    );
    rows = cardTopRows(
      builder,
      rows,
      card.cardType,
      limit,
      input.includeVisitors,
    );
    output(
      builder,
      card.outputId,
      rows,
      input.includeVisitors ? GEO_OUTPUT_FIELDS : CLIENT_OUTPUT_FIELDS,
    );
  }
  return builder.finish();
}

export function buildOverviewChannelsPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
}): ValidatedLogicalPlan {
  if (!Number.isInteger(input.limit))
    throw new Error("channel_limit_must_be_integer");
  const selection = PAGE_DIMENSION_SELECTIONS.trafficChannel;
  const { builder, pages } = pageDimensionReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    selections: [selection],
  });
  let rows = dimensionRollup(
    builder,
    pages,
    selectedPageDimension(builder, pages, selection),
  );
  rows = builder.sort(rows, [
    { slot: "views", direction: "desc", nulls: "last" },
    { slot: "sessions", direction: "desc", nulls: "last" },
    { slot: "value", direction: "asc", nulls: "first" },
  ]);
  if (input.limit >= 0) rows = builder.limit(rows, input.limit);
  builder.output("overview-channels", rows, [
    { name: "channel", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}

export function buildOverviewClientDimensionsPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
}): ValidatedLogicalPlan {
  return buildCardOutputs({
    ...input,
    cards: CLIENT_CARDS,
    includeVisitors: false,
  });
}

export function buildOverviewGeoDimensionsPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
}): ValidatedLogicalPlan {
  return buildCardOutputs({
    ...input,
    cards: GEO_CARDS,
    includeVisitors: true,
  });
}

export const OVERVIEW_CLIENT_DIMENSION_OUTPUTS = CLIENT_CARDS.map(
  ({ outputId }) => outputId,
);

export const OVERVIEW_GEO_DIMENSION_OUTPUTS = GEO_CARDS.map(
  ({ outputId }) => outputId,
);

export const OVERVIEW_CARD_OUTPUT_FIELDS = {
  client: CLIENT_OUTPUT_FIELDS,
  geo: GEO_OUTPUT_FIELDS,
} as const;
