import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const BROWSER_VERSION_UNKNOWN_TOKEN = "__browser_version_unknown__";

export function normalizeBrowserVersionBreakdownBrowserLimit(
  browserLimit: number,
): number | null {
  return Number.isFinite(browserLimit) && browserLimit > 0
    ? Math.max(1, Math.floor(browserLimit))
    : null;
}

export function normalizeBrowserVersionBreakdownVersionLimit(
  versionLimit: number,
): number {
  return Math.min(Math.max(1, versionLimit), 8);
}

export const BROWSER_VERSION_BREAKDOWN_OUTPUT =
  "technology-browser-version-breakdown";

interface BrowserVersionBreakdownPlanInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly browserLimit: number;
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "browser" | "browserVersion" | "sessionId" | "visitorId",
) {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function distinctNonempty(
  builder: LogicalPlanBuilder,
  identity: LogicalExpressionHandle,
) {
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", identity, builder.literal("", STRING)),
        then: identity,
      },
    ],
    builder.literal(null, STRING),
  );
}

function appendOutput(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
): void {
  builder.output(BROWSER_VERSION_BREAKDOWN_OUTPUT, relation, [
    { name: "browser", slot: "browser" },
    { name: "views", slot: "views" },
    { name: "visitors", slot: "visitors" },
    { name: "sessions", slot: "sessions" },
    { name: "browserRank", slot: "browserRank" },
    { name: "version", slot: "version" },
    { name: "versionLabel", slot: "version" },
    { name: "versionViews", slot: "versionViews" },
    { name: "versionVisitors", slot: "versionVisitors" },
    { name: "versionSessions", slot: "versionSessions" },
  ]);
}

/** Appends the existing Browser and browser-major-version outputs to a Page bag. */
export function appendBrowserVersionBreakdownReport(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly browserLimit: number;
}): void {
  const { builder, pages } = input;
  const browser = builder.normalizeString(
    builder.coalesce(
      pageAttribute(builder, pages, "browser"),
      builder.literal("", STRING),
    ),
    "trim-ascii-space",
  );
  const browserMajorVersion = builder.pageDimension("browserMajorVersion", {
    "page.report.browserVersion": pageAttribute(
      builder,
      pages,
      "browserVersion",
    ),
  });
  const browserVersion = builder.caseWhen(
    [
      {
        when: builder.compare(
          "neq",
          browserMajorVersion,
          builder.literal("", STRING),
        ),
        then: browserMajorVersion,
      },
    ],
    builder.literal(BROWSER_VERSION_UNKNOWN_TOKEN, STRING),
  );
  const browserPages = builder.project(pages, {
    browser,
    browserVersion,
    visitorId: pageAttribute(builder, pages, "visitorId"),
    sessionId: pageAttribute(builder, pages, "sessionId"),
  });
  const eligiblePages = builder.filter(
    browserPages,
    builder.compare(
      "neq",
      builder.slot(browserPages, "browser"),
      builder.literal("", STRING),
    ),
  );

  const browserRollup = builder.aggregate(
    eligiblePages,
    { browser: builder.slot(eligiblePages, "browser") },
    [
      { name: "views", kind: "count-rows" },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(eligiblePages, "visitorId"),
        ),
      },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(eligiblePages, "sessionId"),
        ),
      },
    ],
  );
  const rankedBrowsers = builder.rankedMembers(browserRollup, {
    groups: [],
    order: [
      { slot: "visitors", direction: "desc", nulls: "last" },
      { slot: "views", direction: "desc", nulls: "last" },
      { slot: "sessions", direction: "desc", nulls: "last" },
      { slot: "browser", direction: "asc", nulls: "first" },
    ],
  });
  const normalizedBrowserLimit = normalizeBrowserVersionBreakdownBrowserLimit(
    input.browserLimit,
  );
  const topBrowsers =
    normalizedBrowserLimit === null
      ? rankedBrowsers
      : builder.filter(
          rankedBrowsers,
          builder.compare(
            "lte",
            builder.slot(rankedBrowsers, "rank"),
            builder.literal(normalizedBrowserLimit, NUMBER),
          ),
        );

  const versionPages = builder.join(eligiblePages, topBrowsers, [
    { left: "browser", right: "browser" },
  ]);
  const versionRollup = builder.aggregate(
    versionPages,
    {
      browser: builder.slot(versionPages, "browser"),
      version: builder.slot(versionPages, "browserVersion"),
    },
    [
      { name: "views", kind: "count-rows" },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(versionPages, "visitorId"),
        ),
      },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: distinctNonempty(
          builder,
          builder.slot(versionPages, "sessionId"),
        ),
      },
    ],
  );
  const visibleVersionRows = builder.filter(
    versionRollup,
    builder.compare(
      "gt",
      builder.slot(versionRollup, "visitors"),
      builder.literal(0, NUMBER),
    ),
  );
  const rowsWithBrowserMetrics = builder.join(visibleVersionRows, topBrowsers, [
    { left: "browser", right: "browser" },
  ]);
  const outputRows = builder.project(rowsWithBrowserMetrics, {
    browser: builder.slot(rowsWithBrowserMetrics, "browser"),
    views: builder.slot(rowsWithBrowserMetrics, "right.views"),
    visitors: builder.slot(rowsWithBrowserMetrics, "right.visitors"),
    sessions: builder.slot(rowsWithBrowserMetrics, "right.sessions"),
    browserRank: builder.slot(rowsWithBrowserMetrics, "right.rank"),
    version: builder.slot(rowsWithBrowserMetrics, "version"),
    versionViews: builder.slot(rowsWithBrowserMetrics, "views"),
    versionVisitors: builder.slot(rowsWithBrowserMetrics, "visitors"),
    versionSessions: builder.slot(rowsWithBrowserMetrics, "sessions"),
  });
  const sorted = builder.sort(outputRows, [
    { slot: "browserRank", direction: "asc", nulls: "last" },
    { slot: "versionVisitors", direction: "desc", nulls: "last" },
    { slot: "versionViews", direction: "desc", nulls: "last" },
    { slot: "versionSessions", direction: "desc", nulls: "last" },
    { slot: "version", direction: "asc", nulls: "first" },
  ]);
  appendOutput(builder, sorted);
}

/** Builds the one-statement browser and browser-major-version breakdown. */
export function buildBrowserVersionBreakdownPlan(
  input: BrowserVersionBreakdownPlanInput,
): ValidatedLogicalPlan {
  const { builder, pages } = createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan
      ? {
          scopePlan: input.scopePlan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    attributes: [
      "page.report.browser",
      "page.report.browserVersion",
      "page.report.visitorId",
      "page.report.sessionId",
    ],
  });
  appendBrowserVersionBreakdownReport({
    builder,
    pages,
    browserLimit: input.browserLimit,
  });
  return builder.finish();
}
