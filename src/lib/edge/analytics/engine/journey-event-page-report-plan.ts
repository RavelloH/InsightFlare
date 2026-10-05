import {
  EMPTY_FILTER_DOCUMENT,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { QueryWindow, SiteId } from "@/lib/edge/analytics/contract/types";
import {
  type LogicalExpressionHandle,
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const DATETIME = { kind: "scalar", scalar: "datetime" } as const;
const NUMBER_MS = { kind: "scalar", scalar: "number", unit: "ms" } as const;
const NUMBER_RATIO = {
  kind: "scalar",
  scalar: "number",
  unit: "ratio",
} as const;

const PAGE_ATTRIBUTES = [
  "page.report.localId",
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.startedAt",
  "page.report.durationMs",
  "page.report.pathname",
  "page.report.hash",
  "page.report.title",
  "page.report.hostname",
  "page.report.referrerHost",
  "page.report.referrerUrl",
  "page.report.country",
  "page.report.region",
  "page.report.city",
  "page.report.browser",
  "page.report.browserVersion",
  "page.report.os",
  "page.report.osVersion",
  "page.report.deviceType",
  "page.report.screenWidth",
  "page.report.screenHeight",
  "page.report.perfTtfbMs",
  "page.report.perfFcpMs",
  "page.report.perfLcpMs",
  "page.report.perfCls",
  "page.report.perfInpMs",
] as const;

const EVENT_ATTRIBUTES = [
  "event.report.localId",
  "event.report.ownerVisitId",
  "event.report.eventName",
  "event.report.occurredAt",
  "event.report.ownerPresent",
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
  "event.report.ownerPathname",
  "event.report.ownerHash",
  "event.report.ownerTitle",
  "event.report.ownerHostname",
  "event.report.ownerReferrerHost",
  "event.report.ownerReferrerUrl",
  "event.report.ownerCountry",
  "event.report.ownerRegion",
  "event.report.ownerCity",
  "event.report.ownerBrowser",
  "event.report.ownerBrowserVersion",
  "event.report.ownerOs",
  "event.report.ownerOsVersion",
  "event.report.ownerDeviceType",
  "event.report.ownerScreenWidth",
  "event.report.ownerScreenHeight",
  "event.report.ownerPerfTtfbMs",
  "event.report.ownerPerfFcpMs",
  "event.report.ownerPerfLcpMs",
  "event.report.ownerPerfCls",
  "event.report.ownerPerfInpMs",
] as const;

const OUTPUT_FIELDS = [
  "id",
  "kind",
  "eventType",
  "occurredAt",
  "visitId",
  "sessionId",
  "visitorId",
  "pathname",
  "hash",
  "title",
  "hostname",
  "referrerHost",
  "referrerUrl",
  "country",
  "region",
  "city",
  "browser",
  "browserVersion",
  "os",
  "osVersion",
  "deviceType",
  "screenWidth",
  "screenHeight",
  "durationMs",
  "perfTtfbMs",
  "perfFcpMs",
  "perfLcpMs",
  "perfCls",
  "perfInpMs",
] as const;

export const JOURNEY_EVENT_PAGE_REPORT_OUTPUT = "journey-event-page";

export interface JourneyEventPageCursor {
  readonly occurredAt: number;
  readonly id: string;
}

export interface BuildJourneyEventPageReportPlanInput {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly target: {
    readonly type: "visitor" | "session";
    readonly value: string;
  };
  readonly limit: number;
  readonly cursor?: JourneyEventPageCursor | null;
}

function pageAttribute(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  name: string,
): LogicalExpressionHandle {
  return builder.slot(pages, `attribute:page.report.${name}`);
}

function eventAttribute(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  name: string,
): LogicalExpressionHandle {
  return builder.slot(events, `attribute:event.report.${name}`);
}

function createSelection(input: {
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly subject: ReturnType<typeof createSemanticSubjectDomain>;
  readonly time: ReturnType<typeof semanticTemporalDomainsFromQueryTime>;
}) {
  return createSemanticScopedSourceSelection({
    profile: input.scopePlan
      ? "prepared-scoped-reader-window-v1"
      : "direct-page-analytics-v1",
    filters: input.filters,
    subject: input.subject,
    time: input.time,
    ...(input.scopePlan ? { expectedPlan: input.scopePlan } : {}),
  });
}

function projectPageRows(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
): LogicalRelationHandle {
  return builder.project(pages, {
    id: pageAttribute(builder, pages, "localId"),
    kind: builder.literal("pageview", STRING),
    eventType: builder.literal("pageview", STRING),
    occurredAt: pageAttribute(builder, pages, "startedAt"),
    visitId: pageAttribute(builder, pages, "localId"),
    sessionId: pageAttribute(builder, pages, "sessionId"),
    visitorId: pageAttribute(builder, pages, "visitorId"),
    pathname: pageAttribute(builder, pages, "pathname"),
    hash: pageAttribute(builder, pages, "hash"),
    title: pageAttribute(builder, pages, "title"),
    hostname: pageAttribute(builder, pages, "hostname"),
    referrerHost: pageAttribute(builder, pages, "referrerHost"),
    referrerUrl: pageAttribute(builder, pages, "referrerUrl"),
    country: pageAttribute(builder, pages, "country"),
    region: pageAttribute(builder, pages, "region"),
    city: pageAttribute(builder, pages, "city"),
    browser: pageAttribute(builder, pages, "browser"),
    browserVersion: pageAttribute(builder, pages, "browserVersion"),
    os: pageAttribute(builder, pages, "os"),
    osVersion: pageAttribute(builder, pages, "osVersion"),
    deviceType: pageAttribute(builder, pages, "deviceType"),
    screenWidth: pageAttribute(builder, pages, "screenWidth"),
    screenHeight: pageAttribute(builder, pages, "screenHeight"),
    durationMs: builder.coalesce(
      pageAttribute(builder, pages, "durationMs"),
      builder.literal(0, NUMBER_MS),
    ),
    perfTtfbMs: pageAttribute(builder, pages, "perfTtfbMs"),
    perfFcpMs: pageAttribute(builder, pages, "perfFcpMs"),
    perfLcpMs: pageAttribute(builder, pages, "perfLcpMs"),
    perfCls: pageAttribute(builder, pages, "perfCls"),
    perfInpMs: pageAttribute(builder, pages, "perfInpMs"),
  });
}

function projectCustomEventRows(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  prepared: boolean,
): LogicalRelationHandle {
  return builder.project(events, {
    id: eventAttribute(builder, events, "localId"),
    kind: builder.literal("custom", STRING),
    eventType: eventAttribute(builder, events, "eventName"),
    occurredAt: eventAttribute(builder, events, "occurredAt"),
    visitId: eventAttribute(builder, events, "ownerVisitId"),
    sessionId: eventAttribute(builder, events, "ownerSessionId"),
    visitorId: eventAttribute(builder, events, "ownerVisitorId"),
    pathname: eventAttribute(builder, events, "ownerPathname"),
    hash: eventAttribute(builder, events, "ownerHash"),
    title: eventAttribute(builder, events, "ownerTitle"),
    hostname: eventAttribute(builder, events, "ownerHostname"),
    referrerHost: eventAttribute(builder, events, "ownerReferrerHost"),
    referrerUrl: eventAttribute(builder, events, "ownerReferrerUrl"),
    country: eventAttribute(builder, events, "ownerCountry"),
    region: eventAttribute(builder, events, "ownerRegion"),
    city: eventAttribute(builder, events, "ownerCity"),
    browser: eventAttribute(builder, events, "ownerBrowser"),
    browserVersion: eventAttribute(builder, events, "ownerBrowserVersion"),
    os: eventAttribute(builder, events, "ownerOs"),
    osVersion: eventAttribute(builder, events, "ownerOsVersion"),
    deviceType: eventAttribute(builder, events, "ownerDeviceType"),
    screenWidth: eventAttribute(builder, events, "ownerScreenWidth"),
    screenHeight: eventAttribute(builder, events, "ownerScreenHeight"),
    durationMs: builder.literal(0, NUMBER_MS),
    perfTtfbMs: prepared
      ? builder.literal(null, NUMBER_MS)
      : eventAttribute(builder, events, "ownerPerfTtfbMs"),
    perfFcpMs: prepared
      ? builder.literal(null, NUMBER_MS)
      : eventAttribute(builder, events, "ownerPerfFcpMs"),
    perfLcpMs: prepared
      ? builder.literal(null, NUMBER_MS)
      : eventAttribute(builder, events, "ownerPerfLcpMs"),
    perfCls: prepared
      ? builder.literal(null, NUMBER_RATIO)
      : eventAttribute(builder, events, "ownerPerfCls"),
    perfInpMs: prepared
      ? builder.literal(null, NUMBER_MS)
      : eventAttribute(builder, events, "ownerPerfInpMs"),
  });
}

/** Builds the one-statement Logical plan for the visitor/session Events page. */
export function buildJourneyEventPageReportPlan(
  input: BuildJourneyEventPageReportPlanInput,
): ValidatedLogicalPlan {
  const metadata = scopedFilterMetadata(input.filters);
  const scopePlan = metadata?.plan;
  const queryTime = queryWindowToTime(input.window);
  const time = semanticTemporalDomainsFromQueryTime(queryTime);
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [input.siteId as SiteId],
  });
  const builder = new LogicalPlanBuilder({
    subject,
    time,
    scope: resolveAnalyticsScope(scopePlan?.scope ?? "event"),
    originOperation: "event-records",
  });

  const preparedSelection = scopePlan
    ? createSelection({
        filters: input.filters,
        scopePlan,
        subject,
        time,
      })
    : undefined;
  const pageSelection =
    preparedSelection ??
    createSelection({
      filters: input.filters,
      subject,
      time,
    });
  const eventSelection =
    preparedSelection ??
    createSemanticScopedSourceSelection({
      profile: "direct-event-analytics-v1",
      filters: EMPTY_FILTER_DOCUMENT,
      subject,
      time,
    });

  let pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: PAGE_ATTRIBUTES,
    selection: pageSelection,
  });
  let events = builder.source("event", {
    temporalDomain: "candidate",
    attributes: EVENT_ATTRIBUTES,
    selection: eventSelection,
  });

  const targetAttribute =
    input.target.type === "visitor" ? "visitorId" : "sessionId";
  const targetValue = builder.literal(input.target.value, STRING);
  pages = builder.filter(
    pages,
    builder.compare(
      "eq",
      pageAttribute(builder, pages, targetAttribute),
      targetValue,
    ),
  );

  const eventName = eventAttribute(builder, events, "eventName");
  events = builder.filter(
    events,
    builder.and(
      builder.isNull(eventAttribute(builder, events, "ownerPresent"), true),
      builder.isNull(eventName, true),
      ...(scopePlan
        ? [
            builder.compare(
              "eq",
              eventAttribute(
                builder,
                events,
                input.target.type === "visitor"
                  ? "ownerVisitorId"
                  : "ownerSessionId",
              ),
              targetValue,
            ),
          ]
        : []),
    ),
  );

  if (!scopePlan) {
    const pageIds = builder.distinct(pages, [
      { input: "attribute:page.report.localId", output: "visitId" },
    ]);
    events = builder.semiJoin(events, pageIds, [
      {
        left: "attribute:event.report.ownerVisitId",
        right: "visitId",
      },
    ]);
  }

  const pageRows = projectPageRows(builder, pages);
  const customEventRows = projectCustomEventRows(
    builder,
    events,
    scopePlan !== undefined,
  );
  let allRows = builder.appendRows([pageRows, customEventRows], OUTPUT_FIELDS);

  if (input.cursor) {
    const occurredAt = builder.slot(allRows, "occurredAt");
    const id = builder.slot(allRows, "id");
    const cursorTime = builder.literal(input.cursor.occurredAt, DATETIME);
    const cursorId = builder.literal(input.cursor.id, STRING);
    allRows = builder.filter(
      allRows,
      builder.or(
        builder.compare("lt", occurredAt, cursorTime),
        builder.and(
          builder.compare("eq", occurredAt, cursorTime),
          builder.compare("lt", id, cursorId),
        ),
      ),
    );
  }

  const sorted = builder.sort(allRows, [
    { slot: "occurredAt", direction: "desc", nulls: "last" },
    { slot: "id", direction: "desc", nulls: "last" },
  ]);
  const limited = builder.limit(sorted, input.limit + 1);
  builder.output(
    JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
    limited,
    OUTPUT_FIELDS.map((name) => ({ name, slot: name })),
  );
  return builder.finish();
}
