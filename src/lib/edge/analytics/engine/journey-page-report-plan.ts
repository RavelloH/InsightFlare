import type {
  EpochMs,
  QueryWindow,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;

const LOCATION_ATTRIBUTES = [
  "page.report.localId",
  "page.report.sessionId",
  "page.report.startedAt",
  "page.report.latitude",
  "page.report.longitude",
  "page.report.country",
  "page.report.region",
  "page.report.regionCode",
  "page.report.city",
] as const;

const PAGEVIEW_DETAIL_ATTRIBUTES = [
  "page.report.localId",
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.userId",
  "page.report.userName",
  "page.report.previousVisitId",
  "page.report.previousVisitStartedAt",
  "page.report.startedAt",
  "page.report.lastActivityAt",
  "page.report.endedAt",
  "page.report.finalizedAt",
  "page.report.durationMs",
  "page.report.durationSource",
  "page.report.exitReason",
  "page.report.pathname",
  "page.report.queryString",
  "page.report.hash",
  "page.report.title",
  "page.report.hostname",
  "page.report.referrerUrl",
  "page.report.referrerHost",
  "page.report.utmSource",
  "page.report.utmMedium",
  "page.report.utmCampaign",
  "page.report.utmTerm",
  "page.report.utmContent",
  "page.report.isEU",
  "page.report.country",
  "page.report.region",
  "page.report.regionCode",
  "page.report.city",
  "page.report.continent",
  "page.report.latitude",
  "page.report.longitude",
  "page.report.postalCode",
  "page.report.metroCode",
  "page.report.timezone",
  "page.report.organization",
  "page.report.browser",
  "page.report.browserVersion",
  "page.report.os",
  "page.report.osVersion",
  "page.report.deviceType",
  "page.report.userAgent",
  "page.report.language",
  "page.report.screenWidth",
  "page.report.screenHeight",
  "page.report.status",
  "page.report.perfTtfbMs",
  "page.report.perfFcpMs",
  "page.report.perfLcpMs",
  "page.report.perfCls",
  "page.report.perfInpMs",
] as const;

function validateWindow(window: QueryWindow): void {
  if (
    !Number.isFinite(window.startMs) ||
    !Number.isFinite(window.endExclusiveMs) ||
    window.startMs >= window.endExclusiveMs
  )
    throw new Error("journey_page_report_invalid_window");
}

function createBuilder(input: {
  readonly siteId: string;
  readonly read:
    | { readonly kind: "retained-history" }
    | {
        readonly kind: "bounded";
        readonly range: {
          readonly startMs: number;
          readonly endExclusiveMs: number;
        };
      };
  readonly timeZone?: string;
  readonly nowMs?: number;
}): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [input.siteId as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: {
        startMs: 0 as EpochMs,
        endExclusiveMs: 1 as EpochMs,
      },
      read:
        input.read.kind === "retained-history"
          ? input.read
          : {
              kind: "bounded",
              range: {
                startMs: input.read.range.startMs as EpochMs,
                endExclusiveMs: input.read.range.endExclusiveMs as EpochMs,
              },
            },
      reportingTimeZone: (input.timeZone ?? "UTC") as ReportingTimeZone,
      capturedAtMs: (input.nowMs ?? 0) as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function attribute(
  builder: LogicalPlanBuilder,
  source: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(source, `attribute:page.report.${name}`);
}

function textLiteral(builder: LogicalPlanBuilder, value: string) {
  return builder.literal(value, STRING);
}

/** Builds the retained-history Page report consumed by Session location points. */
export function buildJourneySessionLocationPlan(input: {
  readonly siteId: string;
  readonly sessionId: string;
}): ValidatedLogicalPlan {
  const builder = createBuilder({
    siteId: input.siteId,
    read: { kind: "retained-history" },
  });
  const pages = builder.source("page", {
    temporalDomain: "read",
    attributes: LOCATION_ATTRIBUTES,
  });
  const latitude = attribute(builder, pages, "latitude");
  const longitude = attribute(builder, pages, "longitude");
  const filtered = builder.filter(
    pages,
    builder.and(
      builder.compare(
        "eq",
        attribute(builder, pages, "sessionId"),
        textLiteral(builder, input.sessionId),
      ),
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
  const sorted = builder.sort(filtered, [
    {
      slot: "attribute:page.report.startedAt",
      direction: "asc",
      nulls: "first",
    },
    {
      slot: "attribute:page.report.localId",
      direction: "asc",
      nulls: "first",
    },
  ]);
  builder.output("journey-session-location-points", sorted, [
    { name: "latitude", slot: "attribute:page.report.latitude" },
    { name: "longitude", slot: "attribute:page.report.longitude" },
    { name: "timestampMs", slot: "attribute:page.report.startedAt" },
    { name: "country", slot: "attribute:page.report.country" },
    { name: "region", slot: "attribute:page.report.region" },
    { name: "regionCode", slot: "attribute:page.report.regionCode" },
    { name: "city", slot: "attribute:page.report.city" },
  ]);
  return builder.finish();
}

/** Builds the bounded Pageview report and its same-session previous-Page context. */
export function buildJourneyPageviewDetailPlan(input: {
  readonly siteId: string;
  readonly eventId: string;
  readonly window: QueryWindow;
}): ValidatedLogicalPlan {
  validateWindow(input.window);
  const builder = createBuilder({
    siteId: input.siteId,
    read: {
      kind: "bounded",
      range: {
        startMs: input.window.startMs,
        endExclusiveMs: input.window.endExclusiveMs,
      },
    },
    timeZone: input.window.timeZone,
    nowMs: input.window.nowMs,
  });
  const pages = builder.source("page", {
    temporalDomain: "read",
    attributes: PAGEVIEW_DETAIL_ATTRIBUTES,
  });
  const matching = builder.filter(
    pages,
    builder.compare(
      "eq",
      attribute(builder, pages, "localId"),
      textLiteral(builder, input.eventId),
    ),
  );
  const onePage = builder.limit(matching, 1);
  const emptyText = textLiteral(builder, "");
  const emptyWhenNull = new Set([
    "previousVisitId",
    "userId",
    "userName",
    "durationSource",
    "exitReason",
  ]);
  const projections: Record<string, ReturnType<typeof attribute>> = {};
  for (const attributeId of PAGEVIEW_DETAIL_ATTRIBUTES) {
    const name = attributeId.slice("page.report.".length);
    const value = attribute(builder, onePage, name);
    projections[name] = emptyWhenNull.has(name)
      ? builder.coalesce(value, emptyText)
      : value;
  }
  const projected = builder.project(onePage, projections);
  builder.output(
    "journey-pageview-detail",
    projected,
    PAGEVIEW_DETAIL_ATTRIBUTES.map((attributeId) => {
      const name = attributeId.slice("page.report.".length);
      return { name: name === "localId" ? "visitId" : name, slot: name };
    }),
  );
  return builder.finish();
}
