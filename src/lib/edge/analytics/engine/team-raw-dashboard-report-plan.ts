import type { Interval, QueryTime } from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSourceForSubject } from "@/lib/edge/analytics/engine/page-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const NUMBER_MS = { kind: "scalar", scalar: "number", unit: "ms" } as const;

export const TEAM_RAW_DASHBOARD_OUTPUTS = {
  overview: "team-raw-overview",
  trend: "team-raw-trend",
} as const;

export const TEAM_RAW_DASHBOARD_OUTPUT_FIELDS = [
  "reportType",
  "siteId",
  "bucket",
  "views",
  "visitors",
  "sessions",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;

const TEAM_RAW_OVERVIEW_PAGE_ATTRIBUTES = [
  "page.report.rawSiteId",
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.durationMs",
] as const;
const TEAM_RAW_TREND_PAGE_ATTRIBUTES = [
  "page.report.rawSiteId",
  "page.report.visitorId",
  "page.report.startedAt",
] as const;
const TEAM_RAW_DASHBOARD_PAGE_ATTRIBUTES = [
  "page.report.rawSiteId",
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.durationMs",
  "page.report.startedAt",
] as const;

export interface TeamRawDashboardPlanInput {
  readonly teamId: string;
  readonly siteIds: readonly string[];
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly interval: Interval;
  readonly outputs?: "overview" | "trend" | "dashboard";
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: "rawSiteId" | "sessionId" | "visitorId" | "durationMs" | "startedAt",
) {
  return builder.slot(pages, name);
}

function nonemptyValue(
  builder: LogicalPlanBuilder,
  value: ReturnType<typeof pageAttribute>,
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

/** Builds the shared, typed Page Source used by the two team raw readers. */
export function buildTeamRawDashboardReportPlan(
  input: TeamRawDashboardPlanInput,
): ValidatedLogicalPlan {
  const outputs = input.outputs ?? "dashboard";
  const attributes =
    outputs === "overview"
      ? TEAM_RAW_OVERVIEW_PAGE_ATTRIBUTES
      : outputs === "trend"
        ? TEAM_RAW_TREND_PAGE_ATTRIBUTES
        : TEAM_RAW_DASHBOARD_PAGE_ATTRIBUTES;
  const { builder, pages: sourcePages } = createPageReportSourceForSubject({
    subject: {
      origin: "team",
      teamId: input.teamId,
      siteIds: input.siteIds,
    },
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan
      ? {
          scopePlan: input.scopePlan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    attributes,
  });
  const pages = builder.project(sourcePages, {
    rawSiteId: builder.slot(sourcePages, "attribute:page.report.rawSiteId"),
    ...(outputs !== "trend"
      ? {
          sessionId: builder.slot(
            sourcePages,
            "attribute:page.report.sessionId",
          ),
          durationMs: builder.slot(
            sourcePages,
            "attribute:page.report.durationMs",
          ),
        }
      : {}),
    visitorId: builder.slot(sourcePages, "attribute:page.report.visitorId"),
    ...(outputs !== "overview"
      ? {
          startedAt: builder.slot(
            sourcePages,
            "attribute:page.report.startedAt",
          ),
        }
      : {}),
  });

  if (outputs !== "trend") addOverviewOutput(builder, pages);
  if (outputs !== "overview")
    addTrendOutput(builder, pages, input.interval, outputs === "trend");
  return builder.finish();
}

function addOverviewOutput(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
): void {
  const siteId = pageAttribute(builder, pages, "rawSiteId");
  const sessionId = pageAttribute(builder, pages, "sessionId");
  const visitorId = pageAttribute(builder, pages, "visitorId");
  const durationMs = pageAttribute(builder, pages, "durationMs");
  const validDuration = builder.and(
    builder.isNull(durationMs, true),
    builder.compare("gte", durationMs, builder.literal(0, NUMBER_MS)),
  );
  const durationForSum = builder.caseWhen(
    [{ when: validDuration, then: durationMs }],
    builder.literal(0, NUMBER_MS),
  );
  const durationForCount = builder.caseWhen(
    [{ when: validDuration, then: builder.literal(1, NUMBER) }],
    builder.literal(0, NUMBER),
  );
  const mainRollup = builder.aggregate(pages, { siteId }, [
    { name: "views", kind: "count-rows" },
    {
      name: "sessions",
      kind: "count-distinct",
      expression: nonemptyValue(builder, sessionId),
    },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonemptyValue(builder, visitorId),
    },
    { name: "totalDuration", kind: "sum", expression: durationForSum },
    { name: "durationViews", kind: "sum", expression: durationForCount },
  ]);

  const nonemptySessions = builder.filter(
    pages,
    builder.compare("neq", sessionId, builder.literal("", STRING)),
  );
  const sessionRollup = builder.aggregate(
    nonemptySessions,
    { siteId, sessionId },
    [{ name: "visitCount", kind: "count-rows" }],
  );
  const singleVisitSessions = builder.filter(
    sessionRollup,
    builder.compare(
      "eq",
      builder.slot(sessionRollup, "visitCount"),
      builder.literal(1, NUMBER),
    ),
  );
  const bounceRollup = builder.aggregate(
    singleVisitSessions,
    { siteId: builder.slot(singleVisitSessions, "siteId") },
    [{ name: "bounces", kind: "count-rows" }],
  );
  const withBounces = builder.join(
    mainRollup,
    bounceRollup,
    [{ left: "siteId", right: "siteId" }],
    "left",
  );
  const projected = builder.project(withBounces, {
    siteId: builder.slot(withBounces, "siteId"),
    views: builder.slot(withBounces, "views"),
    sessions: builder.slot(withBounces, "sessions"),
    visitors: builder.slot(withBounces, "visitors"),
    bounces: builder.coalesce(
      builder.slot(withBounces, "right.bounces"),
      builder.literal(0, NUMBER),
    ),
    totalDuration: builder.coalesce(
      builder.slot(withBounces, "totalDuration"),
      builder.literal(0, NUMBER_MS),
    ),
    durationViews: builder.coalesce(
      builder.slot(withBounces, "durationViews"),
      builder.literal(0, NUMBER),
    ),
  });
  const report = builder.project(projected, {
    reportType: builder.literal("overview", STRING),
    siteId: builder.slot(projected, "siteId"),
    bucket: builder.literal(0, NUMBER),
    views: builder.slot(projected, "views"),
    visitors: builder.slot(projected, "visitors"),
    sessions: builder.slot(projected, "sessions"),
    bounces: builder.slot(projected, "bounces"),
    totalDuration: builder.slot(projected, "totalDuration"),
    durationViews: builder.slot(projected, "durationViews"),
  });
  builder.output(
    TEAM_RAW_DASHBOARD_OUTPUTS.overview,
    report,
    TEAM_RAW_DASHBOARD_OUTPUT_FIELDS.map((name) => ({
      name,
      slot: name,
    })),
  );
}

function addTrendOutput(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  interval: Interval,
  sortOutput: boolean,
): void {
  const siteId = pageAttribute(builder, pages, "rawSiteId");
  const visitorId = pageAttribute(builder, pages, "visitorId");
  const bucket = builder.bucketIndex(
    builder.timeBucket(pageAttribute(builder, pages, "startedAt"), interval),
  );
  const grouped = builder.aggregate(pages, { siteId, bucket }, [
    { name: "views", kind: "count-rows" },
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonemptyValue(builder, visitorId),
    },
  ]);
  const sorted = sortOutput
    ? builder.sort(grouped, [
        { slot: "bucket", direction: "asc", nulls: "first" },
        { slot: "siteId", direction: "asc", nulls: "first" },
      ])
    : grouped;
  const report = builder.project(sorted, {
    reportType: builder.literal("trend", STRING),
    siteId: builder.slot(sorted, "siteId"),
    bucket: builder.coalesce(
      builder.slot(sorted, "bucket"),
      builder.literal(0, NUMBER),
    ),
    views: builder.slot(sorted, "views"),
    visitors: builder.slot(sorted, "visitors"),
    sessions: builder.literal(0, NUMBER),
    bounces: builder.literal(0, NUMBER),
    totalDuration: builder.literal(0, NUMBER_MS),
    durationViews: builder.literal(0, NUMBER),
  });
  builder.output(
    TEAM_RAW_DASHBOARD_OUTPUTS.trend,
    report,
    TEAM_RAW_DASHBOARD_OUTPUT_FIELDS.map((name) => ({
      name,
      slot: name,
    })),
  );
}
