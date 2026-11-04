import type { CrossBreakdownDimension } from "@/lib/edge/analytics/contract/dimensions";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import {
  type LogicalExpressionHandle,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  addPageReportSourceToBuilder,
  createPageReportSource,
} from "@/lib/edge/analytics/engine/page-report-plan";
import {
  semanticPageDimension,
  type SemanticPageDimensionId,
} from "@/lib/edge/analytics/engine/semantic/page-dimensions";
import type { SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

type StoredPageReportAttribute =
  | "page.report.pathname"
  | "page.report.queryString"
  | "page.report.hash"
  | "page.report.title"
  | "page.report.hostname"
  | "page.report.referrerUrl"
  | "page.report.utmSource"
  | "page.report.utmMedium"
  | "page.report.utmCampaign"
  | "page.report.utmTerm"
  | "page.report.utmContent"
  | "page.report.country"
  | "page.report.region"
  | "page.report.regionCode"
  | "page.report.city"
  | "page.report.continent"
  | "page.report.timezone"
  | "page.report.organization"
  | "page.report.browser"
  | "page.report.browserVersion"
  | "page.report.os"
  | "page.report.deviceType"
  | "page.report.language"
  | "page.report.userId"
  | "page.report.userName";

export const PAGE_DIMENSION_SELECTIONS = {
  pagePath: {
    id: "pagePath",
    kind: "stored",
    attribute: "page.report.pathname",
    normalization: "raw",
  },
  pagePathTrimmed: {
    id: "pagePathTrimmed",
    kind: "stored",
    attribute: "page.report.pathname",
    normalization: "trim-ascii-space",
  },
  pageTitle: {
    id: "pageTitle",
    kind: "stored",
    attribute: "page.report.title",
    normalization: "raw",
  },
  pageTitleTrimmed: {
    id: "pageTitleTrimmed",
    kind: "stored",
    attribute: "page.report.title",
    normalization: "trim-ascii-space",
  },
  pageHostname: {
    id: "pageHostname",
    kind: "stored",
    attribute: "page.report.hostname",
    normalization: "raw",
  },
  pageHostnameTrimmed: {
    id: "pageHostnameTrimmed",
    kind: "stored",
    attribute: "page.report.hostname",
    normalization: "trim-ascii-space",
  },
  pageQuery: {
    id: "pageQuery",
    kind: "stored",
    attribute: "page.report.queryString",
    normalization: "raw",
  },
  pageQueryTrimmed: {
    id: "pageQueryTrimmed",
    kind: "stored",
    attribute: "page.report.queryString",
    normalization: "trim-ascii-space",
  },
  pageHash: {
    id: "pageHash",
    kind: "stored",
    attribute: "page.report.hash",
    normalization: "raw",
  },
  pageHashTrimmed: {
    id: "pageHashTrimmed",
    kind: "stored",
    attribute: "page.report.hash",
    normalization: "trim-ascii-space",
  },
  referrerUrl: {
    id: "referrerUrl",
    kind: "stored",
    attribute: "page.report.referrerUrl",
    normalization: "trim-ascii-space",
  },
  utmSource: {
    id: "utmSource",
    kind: "stored",
    attribute: "page.report.utmSource",
    normalization: "trim-ascii-space",
  },
  utmMedium: {
    id: "utmMedium",
    kind: "stored",
    attribute: "page.report.utmMedium",
    normalization: "trim-ascii-space",
  },
  utmCampaign: {
    id: "utmCampaign",
    kind: "stored",
    attribute: "page.report.utmCampaign",
    normalization: "trim-ascii-space",
  },
  utmTerm: {
    id: "utmTerm",
    kind: "stored",
    attribute: "page.report.utmTerm",
    normalization: "trim-ascii-space",
  },
  utmContent: {
    id: "utmContent",
    kind: "stored",
    attribute: "page.report.utmContent",
    normalization: "trim-ascii-space",
  },
  country: {
    id: "country",
    kind: "stored",
    attribute: "page.report.country",
    normalization: "raw",
  },
  countryTrimmed: {
    id: "countryTrimmed",
    kind: "stored",
    attribute: "page.report.country",
    normalization: "trim-ascii-space",
  },
  region: { id: "region", kind: "derived", dimension: "geoRegion" },
  city: { id: "city", kind: "derived", dimension: "geoCity" },
  continent: {
    id: "continent",
    kind: "stored",
    attribute: "page.report.continent",
    normalization: "raw",
  },
  continentTrimmed: {
    id: "continentTrimmed",
    kind: "stored",
    attribute: "page.report.continent",
    normalization: "trim-ascii-space",
  },
  timezone: {
    id: "timezone",
    kind: "stored",
    attribute: "page.report.timezone",
    normalization: "raw",
  },
  timezoneTrimmed: {
    id: "timezoneTrimmed",
    kind: "stored",
    attribute: "page.report.timezone",
    normalization: "trim-ascii-space",
  },
  organization: {
    id: "organization",
    kind: "stored",
    attribute: "page.report.organization",
    normalization: "raw",
  },
  organizationTrimmed: {
    id: "organizationTrimmed",
    kind: "stored",
    attribute: "page.report.organization",
    normalization: "trim-ascii-space",
  },
  browser: {
    id: "browser",
    kind: "stored",
    attribute: "page.report.browser",
    normalization: "trim-ascii-space",
  },
  browserVersion: {
    id: "browserVersion",
    kind: "stored",
    attribute: "page.report.browserVersion",
    normalization: "trim-ascii-space",
  },
  browserEngine: {
    id: "browserEngine",
    kind: "derived",
    dimension: "browserEngine",
  },
  operatingSystem: {
    id: "operatingSystem",
    kind: "stored",
    attribute: "page.report.os",
    normalization: "trim-ascii-space",
  },
  osVersion: { id: "osVersion", kind: "derived", dimension: "osVersion" },
  deviceType: {
    id: "deviceType",
    kind: "stored",
    attribute: "page.report.deviceType",
    normalization: "trim-ascii-space",
  },
  language: {
    id: "language",
    kind: "stored",
    attribute: "page.report.language",
    normalization: "trim-ascii-space",
  },
  screenSize: {
    id: "screenSize",
    kind: "derived",
    dimension: "screenSize",
  },
  userId: {
    id: "userId",
    kind: "stored",
    attribute: "page.report.userId",
    normalization: "trim-ascii-space",
  },
  userName: {
    id: "userName",
    kind: "stored",
    attribute: "page.report.userName",
    normalization: "trim-ascii-space",
  },
  referrerDomain: {
    id: "referrerDomain",
    kind: "derived",
    dimension: "referrerDomain",
  },
  trafficChannel: {
    id: "trafficChannel",
    kind: "derived",
    dimension: "trafficChannel",
  },
} as const satisfies Readonly<
  Record<
    string,
    | {
        readonly id: string;
        readonly kind: "stored";
        readonly attribute: StoredPageReportAttribute;
        readonly normalization: "raw" | "trim-ascii-space";
      }
    | {
        readonly id: string;
        readonly kind: "derived";
        readonly dimension: SemanticPageDimensionId;
      }
  >
>;

export type PageDimensionSelection =
  (typeof PAGE_DIMENSION_SELECTIONS)[keyof typeof PAGE_DIMENSION_SELECTIONS];

export type PageDimensionSelectionId = PageDimensionSelection["id"];

export const OVERVIEW_PAGE_TABLES = {
  "page.path": {
    family: "page",
    selection: PAGE_DIMENSION_SELECTIONS.pagePath,
    excludeEmpty: true,
  },
  "page.query": {
    family: "page",
    selection: PAGE_DIMENSION_SELECTIONS.pageQuery,
    excludeEmpty: true,
  },
  "page.title": {
    family: "page",
    selection: PAGE_DIMENSION_SELECTIONS.pageTitle,
    excludeEmpty: true,
  },
  "page.hostname": {
    family: "page",
    selection: PAGE_DIMENSION_SELECTIONS.pageHostname,
    excludeEmpty: true,
  },
  "client.browser": {
    family: "client",
    selection: PAGE_DIMENSION_SELECTIONS.browser,
    excludeEmpty: true,
  },
  "client.osVersion": {
    family: "client",
    selection: PAGE_DIMENSION_SELECTIONS.osVersion,
    excludeEmpty: true,
  },
  "client.deviceType": {
    family: "client",
    selection: PAGE_DIMENSION_SELECTIONS.deviceType,
    excludeEmpty: true,
  },
  "client.language": {
    family: "client",
    selection: PAGE_DIMENSION_SELECTIONS.language,
    excludeEmpty: true,
  },
  "client.screenSize": {
    family: "client",
    selection: PAGE_DIMENSION_SELECTIONS.screenSize,
    excludeEmpty: true,
  },
  "utm.source": {
    family: "utm",
    selection: PAGE_DIMENSION_SELECTIONS.utmSource,
    excludeEmpty: false,
  },
  "utm.medium": {
    family: "utm",
    selection: PAGE_DIMENSION_SELECTIONS.utmMedium,
    excludeEmpty: false,
  },
  "utm.campaign": {
    family: "utm",
    selection: PAGE_DIMENSION_SELECTIONS.utmCampaign,
    excludeEmpty: false,
  },
  "utm.term": {
    family: "utm",
    selection: PAGE_DIMENSION_SELECTIONS.utmTerm,
    excludeEmpty: false,
  },
  "utm.content": {
    family: "utm",
    selection: PAGE_DIMENSION_SELECTIONS.utmContent,
    excludeEmpty: false,
  },
  "geo.country": {
    family: "geo",
    selection: PAGE_DIMENSION_SELECTIONS.country,
    excludeEmpty: true,
  },
  "geo.region": {
    family: "geo",
    selection: PAGE_DIMENSION_SELECTIONS.region,
    excludeEmpty: true,
  },
  "geo.city": {
    family: "geo",
    selection: PAGE_DIMENSION_SELECTIONS.city,
    excludeEmpty: true,
  },
  "geo.continent": {
    family: "geo",
    selection: PAGE_DIMENSION_SELECTIONS.continent,
    excludeEmpty: true,
  },
  "geo.timezone": {
    family: "geo",
    selection: PAGE_DIMENSION_SELECTIONS.timezone,
    excludeEmpty: true,
  },
  "geo.organization": {
    family: "geo",
    selection: PAGE_DIMENSION_SELECTIONS.organization,
    excludeEmpty: true,
  },
  "source.channel": {
    family: "channel",
    selection: PAGE_DIMENSION_SELECTIONS.trafficChannel,
    excludeEmpty: true,
  },
} as const;

export type OverviewPageTableTab = keyof typeof OVERVIEW_PAGE_TABLES;
export type OverviewPageTableDescriptor = {
  readonly tab: OverviewPageTableTab;
  readonly family: (typeof OVERVIEW_PAGE_TABLES)[OverviewPageTableTab]["family"];
  readonly selection: PageDimensionSelection;
  readonly excludeEmpty: boolean;
};

export interface NormalizedOverviewPageTableRequest extends OverviewPageTableDescriptor {
  readonly mode: "overview-tab";
  readonly limit: number;
  readonly cursorText: string | null;
  readonly sortBy: DimensionSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly search?: string;
}

export function overviewPageTableDescriptor(
  tab: string,
): OverviewPageTableDescriptor | null {
  if (!Object.hasOwn(OVERVIEW_PAGE_TABLES, tab)) return null;
  const descriptor = OVERVIEW_PAGE_TABLES[tab as OverviewPageTableTab];
  return { tab: tab as OverviewPageTableTab, ...descriptor };
}

/** Normalizes the existing single-period overview table controls. */
export function normalizeOverviewPageTableRequest(input: {
  readonly operation?: "dimension" | "channels";
  readonly mode?: unknown;
  readonly tab?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly search?: unknown;
}): NormalizedOverviewPageTableRequest | null {
  if (input.mode !== "overview-tab" || typeof input.tab !== "string")
    return null;
  const descriptor = overviewPageTableDescriptor(input.tab);
  if (!descriptor) return null;
  if (
    (descriptor.family === "channel" && input.operation !== "channels") ||
    (input.operation === "channels" && descriptor.family !== "channel")
  )
    return null;
  const sort =
    input.sort === "sessions" || input.sort === "visitors"
      ? input.sort
      : "views";
  return {
    mode: "overview-tab",
    ...descriptor,
    limit:
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? input.limit
        : 100,
    cursorText:
      typeof input.cursor === "string" && input.cursor.length > 0
        ? input.cursor
        : null,
    sortBy: sort,
    sortDirection: input.direction === "asc" ? "asc" : "desc",
    ...(typeof input.search === "string" && input.search.length > 0
      ? { search: input.search }
      : {}),
  };
}

const pageDimensionSelectionById = new Map<string, PageDimensionSelection>(
  Object.values(PAGE_DIMENSION_SELECTIONS).map((selection) => [
    selection.id,
    Object.freeze(selection),
  ]),
);

export function validatePageDimensionSelection(
  value: unknown,
): PageDimensionSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("unsupported-page-dimension-selection");
  const candidate = value as Record<string, unknown>;
  const registered = pageDimensionSelectionById.get(
    typeof candidate.id === "string" ? candidate.id : "",
  );
  if (
    !registered ||
    Object.keys(candidate).sort().join("\u0000") !==
      Object.keys(registered).sort().join("\u0000") ||
    Object.keys(registered).some(
      (key) => candidate[key] !== (registered as Record<string, unknown>)[key],
    )
  )
    throw new Error("unsupported-page-dimension-selection");
  return registered;
}

export type CrossBreakdownPageDimension = CrossBreakdownDimension;

const CROSS_BREAKDOWN_SELECTIONS: Readonly<
  Record<CrossBreakdownPageDimension, PageDimensionSelection>
> = {
  "page.path": PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
  "page.title": PAGE_DIMENSION_SELECTIONS.pageTitleTrimmed,
  "page.hostname": PAGE_DIMENSION_SELECTIONS.pageHostnameTrimmed,
  "page.query": PAGE_DIMENSION_SELECTIONS.pageQueryTrimmed,
  "page.hash": PAGE_DIMENSION_SELECTIONS.pageHashTrimmed,
  "referrer.domain": PAGE_DIMENSION_SELECTIONS.referrerDomain,
  "referrer.url": PAGE_DIMENSION_SELECTIONS.referrerUrl,
  "utm.source": PAGE_DIMENSION_SELECTIONS.utmSource,
  "utm.medium": PAGE_DIMENSION_SELECTIONS.utmMedium,
  "utm.campaign": PAGE_DIMENSION_SELECTIONS.utmCampaign,
  "utm.term": PAGE_DIMENSION_SELECTIONS.utmTerm,
  "utm.content": PAGE_DIMENSION_SELECTIONS.utmContent,
  "client.browser": PAGE_DIMENSION_SELECTIONS.browser,
  browser: PAGE_DIMENSION_SELECTIONS.browser,
  "client.browserVersion": PAGE_DIMENSION_SELECTIONS.browserVersion,
  "client.browserEngine": PAGE_DIMENSION_SELECTIONS.browserEngine,
  "client.os": PAGE_DIMENSION_SELECTIONS.operatingSystem,
  operatingSystem: PAGE_DIMENSION_SELECTIONS.operatingSystem,
  "client.osVersion": PAGE_DIMENSION_SELECTIONS.osVersion,
  osVersion: PAGE_DIMENSION_SELECTIONS.osVersion,
  "client.deviceType": PAGE_DIMENSION_SELECTIONS.deviceType,
  deviceType: PAGE_DIMENSION_SELECTIONS.deviceType,
  "client.language": PAGE_DIMENSION_SELECTIONS.language,
  language: PAGE_DIMENSION_SELECTIONS.language,
  "client.screenSize": PAGE_DIMENSION_SELECTIONS.screenSize,
  screenSize: PAGE_DIMENSION_SELECTIONS.screenSize,
  "geo.country": PAGE_DIMENSION_SELECTIONS.countryTrimmed,
  "geo.region": PAGE_DIMENSION_SELECTIONS.region,
  "geo.city": PAGE_DIMENSION_SELECTIONS.city,
  "geo.continent": PAGE_DIMENSION_SELECTIONS.continentTrimmed,
  "geo.timeZone": PAGE_DIMENSION_SELECTIONS.timezoneTrimmed,
  "geo.organization": PAGE_DIMENSION_SELECTIONS.organizationTrimmed,
  "user.id": PAGE_DIMENSION_SELECTIONS.userId,
  "user.name": PAGE_DIMENSION_SELECTIONS.userName,
};

export function crossBreakdownPageDimensionSelection(
  value: string,
): PageDimensionSelection | null {
  return Object.hasOwn(CROSS_BREAKDOWN_SELECTIONS, value)
    ? CROSS_BREAKDOWN_SELECTIONS[value as CrossBreakdownPageDimension]
    : null;
}

export function analyticsPageDimensionSelection(
  value: string,
): PageDimensionSelection | null {
  if (value === "page.query") return PAGE_DIMENSION_SELECTIONS.pageQuery;
  if (value === "page.hash") return PAGE_DIMENSION_SELECTIONS.pageHash;
  if (value === "country") return PAGE_DIMENSION_SELECTIONS.country;
  if (value === "geo.timezone")
    return PAGE_DIMENSION_SELECTIONS.timezoneTrimmed;
  const crossBreakdown = crossBreakdownPageDimensionSelection(value);
  if (crossBreakdown) return crossBreakdown;
  return null;
}

export function dimensionPageSelection(
  value: string,
): PageDimensionSelection | null {
  if (value === "traffic.channel")
    return PAGE_DIMENSION_SELECTIONS.trafficChannel;
  return analyticsPageDimensionSelection(value);
}

export interface NormalizedDimensionPageRequest extends DimensionPageReportOptions {
  readonly dimension: string;
  readonly cursorText: string | null;
}

/** Applies the public dimension paging defaults in one shared place. */
export function normalizeDimensionPageRequest(input: {
  readonly dimension: string;
  readonly page?: unknown;
  readonly limit?: unknown;
  readonly sort?: unknown;
  readonly search?: unknown;
}): NormalizedDimensionPageRequest | null {
  const selection = dimensionPageSelection(input.dimension);
  if (!selection) return null;
  const page =
    input.page && typeof input.page === "object"
      ? (input.page as { limit?: unknown; cursor?: unknown })
      : {};
  const sort =
    input.sort && typeof input.sort === "object"
      ? (input.sort as { key?: unknown; direction?: unknown })
      : null;
  return {
    dimension: input.dimension,
    selection,
    limit:
      typeof page.limit === "number" && Number.isFinite(page.limit)
        ? page.limit
        : typeof input.limit === "number" && Number.isFinite(input.limit)
          ? input.limit
          : 20,
    cursorText: typeof page.cursor === "string" ? page.cursor : null,
    sortBy:
      sort?.key === "sessions" || sort?.key === "visitors" ? sort.key : "views",
    sortDirection: sort?.direction === "asc" ? "asc" : "desc",
    ...(typeof input.search === "string" ? { search: input.search } : {}),
    excludeEmpty: false,
  };
}

function pageReportAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  attribute: string,
): LogicalExpressionHandle {
  return builder.slot(pages, `attribute:${attribute}`);
}

export function selectedPageDimension(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  selection: PageDimensionSelection,
): LogicalExpressionHandle {
  if (selection.kind === "stored") {
    const value = pageReportAttribute(builder, pages, selection.attribute);
    return selection.normalization === "raw"
      ? value
      : builder.normalizeString(value, "trim-ascii-space");
  }
  const definition = semanticPageDimension(selection.dimension);
  if (!definition)
    throw new Error(`unsupported-page-dimension:${selection.dimension}`);
  return builder.pageDimension(
    selection.dimension,
    Object.fromEntries(
      definition.dependencies.map((attribute) => [
        attribute,
        pageReportAttribute(builder, pages, attribute),
      ]),
    ),
  );
}

function distinctNonempty(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
): LogicalExpressionHandle {
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

export function pageDimensionReportSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly selections: readonly PageDimensionSelection[];
  readonly includeVisitors?: boolean;
  readonly additionalAttributes?: readonly string[];
}) {
  const attributes = pageDimensionReportAttributes(input);
  return createPageReportSource({
    ...input,
    attributes,
  });
}

/** Adds the same Page dimension Source to a caller-owned Logical builder. */
export function appendPageDimensionReportSource(
  builder: LogicalPlanBuilder,
  input: {
    readonly selections: readonly PageDimensionSelection[];
    readonly sourceSelection: SemanticScopedSourceSelection;
    readonly includeVisitors?: boolean;
    readonly additionalAttributes?: readonly string[];
  },
) {
  return addPageReportSourceToBuilder(builder, {
    attributes: pageDimensionReportAttributes(input),
    selection: input.sourceSelection,
  });
}

function pageDimensionReportAttributes(input: {
  readonly selections: readonly PageDimensionSelection[];
  readonly includeVisitors?: boolean;
  readonly additionalAttributes?: readonly string[];
}): readonly string[] {
  const attributes = new Set<string>(["page.report.sessionId"]);
  if (input.includeVisitors !== false) attributes.add("page.report.visitorId");
  for (const attribute of input.additionalAttributes ?? [])
    attributes.add(attribute);
  for (const selection of input.selections) {
    const definition =
      selection.kind === "derived"
        ? semanticPageDimension(selection.dimension)
        : null;
    if (selection.kind === "derived" && !definition)
      throw new Error(`unsupported-page-dimension:${selection.dimension}`);
    for (const attribute of selection.kind === "stored"
      ? [selection.attribute]
      : (definition?.dependencies ?? []))
      attributes.add(attribute);
  }
  return [...attributes];
}

function pageDimensionSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly selection: PageDimensionSelection;
}) {
  return pageDimensionReportSource({
    ...input,
    selections: [input.selection],
  });
}

export function dimensionRollup(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  value: LogicalExpressionHandle,
  options: { readonly includeVisitors?: boolean } = {},
): LogicalRelationHandle {
  const sessionId = pageReportAttribute(
    builder,
    pages,
    "page.report.sessionId",
  );
  const measures = [
    { name: "views", kind: "count-rows" as const },
    {
      name: "sessions",
      kind: "count-distinct" as const,
      expression: distinctNonempty(builder, sessionId),
    },
  ];
  if (options.includeVisitors !== false) {
    const visitorId = pageReportAttribute(
      builder,
      pages,
      "page.report.visitorId",
    );
    measures.push({
      name: "visitors",
      kind: "count-distinct",
      expression: distinctNonempty(builder, visitorId),
    });
  }
  return builder.aggregate(
    pages,
    { value: builder.coalesce(value, builder.literal("", STRING)) },
    measures,
  );
}

function filterDimension(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  options: { readonly excludeEmpty?: boolean; readonly search?: string },
): LogicalRelationHandle {
  let result = input;
  const value = () => builder.slot(result, "value");
  if (options.excludeEmpty) {
    result = builder.filter(
      result,
      builder.compare(
        "neq",
        builder.normalizeString(value(), "trim-ascii-space"),
        builder.literal("", STRING),
      ),
    );
  }
  if (options.search) {
    result = builder.filter(
      result,
      builder.stringMatch(
        "contains",
        value(),
        options.search.trim().toLowerCase(),
        false,
        undefined,
        "legacy-report-search-v1",
      ),
    );
  }
  return result;
}

export type DimensionSortKey = "views" | "sessions" | "visitors";

export function dimensionSortColumns(sortBy: DimensionSortKey): {
  primary: DimensionSortKey;
  secondary: DimensionSortKey;
} {
  if (sortBy === "visitors") return { primary: "visitors", secondary: "views" };
  if (sortBy === "sessions") return { primary: "sessions", secondary: "views" };
  return { primary: "views", secondary: "sessions" };
}

function cursorPredicate(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  cursor: {
    readonly primary: number;
    readonly secondary: number;
    readonly value: string;
  },
  sortBy: DimensionSortKey,
  direction: "asc" | "desc",
): LogicalExpressionHandle {
  const { primary: primaryName, secondary: secondaryName } =
    dimensionSortColumns(sortBy);
  const primary = builder.slot(input, primaryName);
  const secondary = builder.slot(input, secondaryName);
  const value = builder.slot(input, "value");
  const primaryLiteral = builder.literal(cursor.primary, NUMBER);
  const secondaryLiteral = builder.literal(cursor.secondary, NUMBER);
  const valueLiteral = builder.literal(cursor.value, STRING);
  const directional = direction === "asc" ? "gt" : "lt";
  const primaryEqual = () => builder.compare("eq", primary, primaryLiteral);
  const secondaryEqual = () =>
    builder.compare("eq", secondary, secondaryLiteral);
  return builder.or(
    builder.compare(directional, primary, primaryLiteral),
    builder.and(
      primaryEqual(),
      builder.compare(directional, secondary, secondaryLiteral),
    ),
    builder.and(
      primaryEqual(),
      secondaryEqual(),
      builder.compare("gt", value, valueLiteral),
    ),
  );
}

function sortedDimensions(
  builder: LogicalPlanBuilder,
  input: LogicalRelationHandle,
  sortBy: DimensionSortKey,
  direction: "asc" | "desc",
): LogicalRelationHandle {
  const columns = dimensionSortColumns(sortBy);
  return builder.sort(input, [
    { slot: columns.primary, direction, nulls: "last" },
    { slot: columns.secondary, direction, nulls: "last" },
    { slot: "value", direction: "asc", nulls: "first" },
  ]);
}

export interface DimensionPageReportOptions {
  readonly limit: number;
  readonly selection: PageDimensionSelection;
  readonly excludeEmpty?: boolean;
  readonly search?: string;
  readonly sortBy: DimensionSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly cursor?: {
    readonly primary: number;
    readonly secondary: number;
    readonly value: string;
  } | null;
}

export const DIMENSION_PAGE_REPORT_OUTPUT = "dimension-page";

/** Appends the stored/derived dimension Top-N report to an existing builder. */
export function appendDimensionTopReport(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  options: DimensionPageReportOptions,
): void {
  let result = dimensionRollup(
    builder,
    pages,
    selectedPageDimension(builder, pages, options.selection),
  );
  result = filterDimension(builder, result, options);
  result = sortedDimensions(
    builder,
    result,
    options.sortBy,
    options.sortDirection,
  );
  if (options.limit > 0) result = builder.limit(result, options.limit);
  builder.output("dimension-top", result, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
}

/** Appends the keyset-paginated dimension report to an existing builder. */
export function appendDimensionPageReport(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  options: DimensionPageReportOptions,
): void {
  let result = dimensionRollup(
    builder,
    pages,
    selectedPageDimension(builder, pages, options.selection),
  );
  result = filterDimension(builder, result, options);
  if (options.cursor)
    result = builder.filter(
      result,
      cursorPredicate(
        builder,
        result,
        options.cursor,
        options.sortBy,
        options.sortDirection,
      ),
    );
  result = sortedDimensions(
    builder,
    result,
    options.sortBy,
    options.sortDirection,
  );
  result = builder.limit(result, options.limit + 1);
  builder.output(DIMENSION_PAGE_REPORT_OUTPUT, result, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
}

export function buildDimensionTopPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly limit: number;
  readonly selection: PageDimensionSelection;
  readonly excludeEmpty?: boolean;
  readonly search?: string;
  readonly sortBy: DimensionSortKey;
  readonly sortDirection: "asc" | "desc";
}): ValidatedLogicalPlan {
  const { builder, pages } = pageDimensionSource(input);
  appendDimensionTopReport(builder, pages, input);
  return builder.finish();
}

export function buildDimensionPagePlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly preparedTimePolicy?: "reader-window-v1" | "scoped-reader-window-v1";
  readonly limit: number;
  readonly selection: PageDimensionSelection;
  readonly excludeEmpty?: boolean;
  readonly search?: string;
  readonly sortBy: DimensionSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly cursor?: {
    readonly primary: number;
    readonly secondary: number;
    readonly value: string;
  } | null;
}): ValidatedLogicalPlan {
  const { builder, pages } = pageDimensionSource(input);
  appendDimensionPageReport(builder, pages, input);
  return builder.finish();
}
