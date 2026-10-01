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

const EVENT_DETAIL_ATTRIBUTES = [
  "event.report.localId",
  "event.report.ownerVisitId",
  "event.report.nameId",
  "event.report.eventName",
  "event.report.occurredAt",
  "event.report.receivedAt",
  "event.report.sequence",
  "event.report.nodeCount",
  "event.report.valueCount",
  "event.report.userId",
  "event.report.ownerPresent",
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
  "event.report.ownerUserId",
  "event.report.ownerUserName",
  "event.report.ownerStatus",
  "event.report.ownerPreviousVisitId",
  "event.report.ownerPreviousVisitStartedAt",
  "event.report.ownerStartedAt",
  "event.report.ownerLastActivityAt",
  "event.report.ownerEndedAt",
  "event.report.ownerFinalizedAt",
  "event.report.ownerDurationMs",
  "event.report.ownerDurationSource",
  "event.report.ownerExitReason",
  "event.report.ownerPathname",
  "event.report.ownerQueryString",
  "event.report.ownerHash",
  "event.report.ownerTitle",
  "event.report.ownerHostname",
  "event.report.ownerReferrerUrl",
  "event.report.ownerReferrerHost",
  "event.report.ownerUtmSource",
  "event.report.ownerUtmMedium",
  "event.report.ownerUtmCampaign",
  "event.report.ownerUtmTerm",
  "event.report.ownerUtmContent",
  "event.report.ownerIsEU",
  "event.report.ownerCountry",
  "event.report.ownerRegion",
  "event.report.ownerRegionCode",
  "event.report.ownerCity",
  "event.report.ownerContinent",
  "event.report.ownerLatitude",
  "event.report.ownerLongitude",
  "event.report.ownerPostalCode",
  "event.report.ownerMetroCode",
  "event.report.ownerTimezone",
  "event.report.ownerOrganization",
  "event.report.ownerBrowser",
  "event.report.ownerBrowserVersion",
  "event.report.ownerOs",
  "event.report.ownerOsVersion",
  "event.report.ownerDeviceType",
  "event.report.ownerUserAgent",
  "event.report.ownerLanguage",
  "event.report.ownerScreenWidth",
  "event.report.ownerScreenHeight",
  "event.report.ownerPerfTtfbMs",
  "event.report.ownerPerfFcpMs",
  "event.report.ownerPerfLcpMs",
  "event.report.ownerPerfCls",
  "event.report.ownerPerfInpMs",
] as const;

function validateWindow(window: QueryWindow): void {
  if (
    !Number.isFinite(window.startMs) ||
    !Number.isFinite(window.endExclusiveMs) ||
    window.startMs >= window.endExclusiveMs
  )
    throw new Error("event_record_detail_invalid_window");
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
  return builder.slot(source, `attribute:event.report.${name}`);
}

function textLiteral(builder: LogicalPlanBuilder, value: string) {
  return builder.literal(value, STRING);
}

/** Reproduces the legacy event-detail row with optional event-time bounding. */
export function buildEventRecordDetailPlan(input: {
  readonly siteId: string;
  readonly eventId: string;
  readonly window?: QueryWindow;
}): ValidatedLogicalPlan {
  if (input.window) validateWindow(input.window);
  const builder = createBuilder({
    siteId: input.siteId,
    read: input.window
      ? {
          kind: "bounded",
          range: {
            startMs: input.window.startMs,
            endExclusiveMs: input.window.endExclusiveMs,
          },
        }
      : { kind: "retained-history" },
    timeZone: input.window?.timeZone,
    nowMs: input.window?.nowMs,
  });
  const events = builder.source("event", {
    temporalDomain: "read",
    relationships: ["event.observation"],
    attributes: EVENT_DETAIL_ATTRIBUTES,
  });
  const matching = builder.filter(
    events,
    builder.and(
      builder.compare(
        "eq",
        attribute(builder, events, "localId"),
        textLiteral(builder, input.eventId),
      ),
      attribute(builder, events, "ownerPresent"),
      builder.isNull(attribute(builder, events, "eventName"), true),
    ),
  );
  const oneEvent = builder.limit(matching, 1);
  const empty = textLiteral(builder, "");
  const field = (name: string) => attribute(builder, oneEvent, name);
  const projections = {
    eventId: field("localId"),
    eventName: field("eventName"),
    occurredAt: field("occurredAt"),
    receivedAt: field("receivedAt"),
    sequence: field("sequence"),
    visitId: field("ownerVisitId"),
    userId: builder.coalesce(field("userId"), field("ownerUserId"), empty),
    userName: builder.coalesce(field("ownerUserName"), empty),
    sessionId: field("ownerSessionId"),
    visitorId: field("ownerVisitorId"),
    pathname: field("ownerPathname"),
    queryString: field("ownerQueryString"),
    hash: field("ownerHash"),
    title: field("ownerTitle"),
    hostname: field("ownerHostname"),
    referrerUrl: field("ownerReferrerUrl"),
    referrerHost: field("ownerReferrerHost"),
    utmSource: field("ownerUtmSource"),
    utmMedium: field("ownerUtmMedium"),
    utmCampaign: field("ownerUtmCampaign"),
    utmTerm: field("ownerUtmTerm"),
    utmContent: field("ownerUtmContent"),
    isEU: field("ownerIsEU"),
    country: field("ownerCountry"),
    region: field("ownerRegion"),
    regionCode: field("ownerRegionCode"),
    city: field("ownerCity"),
    continent: field("ownerContinent"),
    latitude: field("ownerLatitude"),
    longitude: field("ownerLongitude"),
    postalCode: field("ownerPostalCode"),
    metroCode: field("ownerMetroCode"),
    timezone: field("ownerTimezone"),
    organization: field("ownerOrganization"),
    browser: field("ownerBrowser"),
    browserVersion: field("ownerBrowserVersion"),
    os: field("ownerOs"),
    osVersion: field("ownerOsVersion"),
    deviceType: field("ownerDeviceType"),
    userAgent: field("ownerUserAgent"),
    language: field("ownerLanguage"),
    screenWidth: field("ownerScreenWidth"),
    screenHeight: field("ownerScreenHeight"),
    status: field("ownerStatus"),
    startedAt: field("ownerStartedAt"),
    previousVisitId: builder.coalesce(field("ownerPreviousVisitId"), empty),
    previousVisitStartedAt: field("ownerPreviousVisitStartedAt"),
    lastActivityAt: field("ownerLastActivityAt"),
    endedAt: field("ownerEndedAt"),
    finalizedAt: field("ownerFinalizedAt"),
    durationMs: field("ownerDurationMs"),
    durationSource: builder.coalesce(field("ownerDurationSource"), empty),
    exitReason: builder.coalesce(field("ownerExitReason"), empty),
    perfTtfbMs: field("ownerPerfTtfbMs"),
    perfFcpMs: field("ownerPerfFcpMs"),
    perfLcpMs: field("ownerPerfLcpMs"),
    perfCls: field("ownerPerfCls"),
    perfInpMs: field("ownerPerfInpMs"),
    nodeCount: field("nodeCount"),
    valueCount: field("valueCount"),
  };
  const projected = builder.project(oneEvent, projections);
  builder.output(
    "event-record-detail",
    projected,
    Object.keys(projections).map((name) => ({ name, slot: name })),
  );
  return builder.finish();
}
