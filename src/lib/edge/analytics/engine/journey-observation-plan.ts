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

export type JourneyObservationTarget =
  | { readonly type: "visitor"; readonly value: string }
  | { readonly type: "session"; readonly value: string };

export type JourneyObservationShape = "timeline" | "detail-source";

const TIMELINE_ATTRIBUTES = [
  "observation.id",
  "observation.kind",
  "observation.eventName",
  "observation.visitId",
  "observation.sessionId",
  "observation.visitorId",
  "observation.pathname",
  "observation.hash",
  "observation.title",
  "observation.hostname",
  "observation.referrerHost",
  "observation.referrerUrl",
  "observation.country",
  "observation.region",
  "observation.city",
  "observation.browser",
  "observation.browserVersion",
  "observation.os",
  "observation.osVersion",
  "observation.deviceType",
  "observation.screenWidth",
  "observation.screenHeight",
  "observation.durationMs",
  "observation.perfTtfbMs",
  "observation.perfFcpMs",
  "observation.perfLcpMs",
  "observation.perfCls",
  "observation.perfInpMs",
] as const;

const DETAIL_SOURCE_ATTRIBUTES = [
  "observation.kind",
  "observation.eventName",
  "observation.visitId",
  "observation.visitorId",
  "observation.sessionId",
  "observation.userId",
  "observation.userName",
  "observation.status",
  "observation.ownerPageStartedAt",
  "observation.startedAt",
  "observation.lastActivityAt",
  "observation.endedAt",
  "observation.durationMs",
  "observation.pathname",
  "observation.hash",
  "observation.title",
  "observation.hostname",
  "observation.referrerHost",
  "observation.referrerUrl",
  "observation.country",
  "observation.region",
  "observation.regionCode",
  "observation.city",
  "observation.latitude",
  "observation.longitude",
  "observation.browser",
  "observation.browserVersion",
  "observation.os",
  "observation.osVersion",
  "observation.deviceType",
  "observation.screenWidth",
  "observation.screenHeight",
  "observation.perfTtfbMs",
  "observation.perfFcpMs",
  "observation.perfLcpMs",
  "observation.perfCls",
  "observation.perfInpMs",
  "observation.eventId",
] as const;

const STRING = { kind: "scalar", scalar: "string" } as const;
const DATETIME = { kind: "scalar", scalar: "datetime" } as const;
const NUMBER_MS = { kind: "scalar", scalar: "number", unit: "ms" } as const;

function validateWindow(window: QueryWindow | undefined): void {
  if (
    window &&
    (!Number.isFinite(window.startMs) ||
      !Number.isFinite(window.endExclusiveMs) ||
      window.startMs >= window.endExclusiveMs)
  )
    throw new Error("journey_observation_invalid_window");
}

/** Builds the typed Page/Event read consumed by Journey detail code. */
export function buildJourneyObservationPlan(input: {
  readonly siteId: string;
  readonly target: JourneyObservationTarget;
  readonly shape: JourneyObservationShape;
  readonly window?: QueryWindow;
}): ValidatedLogicalPlan {
  if (!input.target || typeof input.target.value !== "string")
    throw new Error("journey_observation_invalid_target");
  if (input.target.type !== "visitor" && input.target.type !== "session")
    throw new Error("journey_observation_unsupported_target");
  if (input.shape !== "timeline" && input.shape !== "detail-source")
    throw new Error("journey_observation_unsupported_shape");
  if (input.shape === "timeline" && input.window)
    throw new Error("journey_observation_timeline_does_not_accept_window");
  validateWindow(input.window);

  const emptyCandidate = {
    startMs: 0 as EpochMs,
    endExclusiveMs: 1 as EpochMs,
  };
  const builder = new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [input.siteId as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: emptyCandidate,
      read: { kind: "retained-history" },
      reportingTimeZone: (input.window?.timeZone ?? "UTC") as ReportingTimeZone,
      capturedAtMs: (input.window?.nowMs ?? 0) as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
  const attributes =
    input.shape === "timeline" ? TIMELINE_ATTRIBUTES : DETAIL_SOURCE_ATTRIBUTES;
  const observations = builder.source("observation", {
    temporalDomain: "read",
    attributes,
    includeOccurrenceTime: true,
  });
  const targetAttribute =
    input.target.type === "visitor"
      ? "observation.visitorId"
      : "observation.sessionId";
  let matching = builder.filter(
    observations,
    builder.compare(
      "eq",
      builder.slot(observations, `attribute:${targetAttribute}`),
      builder.literal(input.target.value, STRING),
    ),
  );

  if (input.shape === "detail-source" && input.window) {
    const ownerStartedAt = builder.slot(
      matching,
      "attribute:observation.ownerPageStartedAt",
    );
    const start = builder.literal(input.window.startMs, DATETIME);
    const end = builder.literal(input.window.endExclusiveMs, DATETIME);
    matching = builder.filter(
      matching,
      builder.and(
        builder.compare("gte", ownerStartedAt, start),
        builder.compare("lt", ownerStartedAt, end),
      ),
    );
  }

  const isPage = builder.compare(
    "eq",
    builder.slot(matching, "attribute:observation.kind"),
    builder.literal("page", STRING),
  );
  const hasEventName = builder.isNull(
    builder.slot(matching, "attribute:observation.eventName"),
    true,
  );
  matching = builder.filter(matching, builder.or(isPage, hasEventName));

  if (input.shape === "timeline") return buildTimelineOutput(builder, matching);
  return buildDetailSourceOutput(builder, matching);
}

function buildTimelineOutput(
  builder: LogicalPlanBuilder,
  observations: LogicalRelationHandle,
): ValidatedLogicalPlan {
  const attr = (name: string) =>
    builder.slot(observations, `attribute:observation.${name}`);
  const isPage = builder.compare(
    "eq",
    attr("kind"),
    builder.literal("page", STRING),
  );
  const eventType = builder.caseWhen(
    [
      {
        when: isPage,
        then: builder.literal("pageview", STRING),
      },
    ],
    attr("eventName"),
  );
  const kind = builder.caseWhen(
    [
      {
        when: isPage,
        then: builder.literal("pageview", STRING),
      },
    ],
    builder.literal("custom", STRING),
  );
  const duration = builder.caseWhen(
    [
      {
        when: isPage,
        then: builder.coalesce(
          attr("durationMs"),
          builder.literal(0, NUMBER_MS),
        ),
      },
    ],
    builder.literal(0, NUMBER_MS),
  );
  const output = builder.project(observations, {
    id: attr("id"),
    kind,
    eventType,
    occurredAt: builder.slot(observations, "time"),
    visitId: attr("visitId"),
    sessionId: attr("sessionId"),
    visitorId: attr("visitorId"),
    pathname: attr("pathname"),
    hash: attr("hash"),
    title: attr("title"),
    hostname: attr("hostname"),
    referrerHost: attr("referrerHost"),
    referrerUrl: attr("referrerUrl"),
    country: attr("country"),
    region: attr("region"),
    city: attr("city"),
    browser: attr("browser"),
    browserVersion: attr("browserVersion"),
    os: attr("os"),
    osVersion: attr("osVersion"),
    deviceType: attr("deviceType"),
    screenWidth: attr("screenWidth"),
    screenHeight: attr("screenHeight"),
    durationMs: duration,
    perfTtfbMs: attr("perfTtfbMs"),
    perfFcpMs: attr("perfFcpMs"),
    perfLcpMs: attr("perfLcpMs"),
    perfCls: attr("perfCls"),
    perfInpMs: attr("perfInpMs"),
  });
  const sorted = builder.sort(output, [
    { slot: "occurredAt", direction: "desc", nulls: "last" },
    { slot: "id", direction: "desc", nulls: "last" },
  ]);
  builder.output("journey-observation-timeline", sorted, [
    { name: "id", slot: "id" },
    { name: "kind", slot: "kind" },
    { name: "eventType", slot: "eventType" },
    { name: "occurredAt", slot: "occurredAt" },
    { name: "visitId", slot: "visitId" },
    { name: "sessionId", slot: "sessionId" },
    { name: "visitorId", slot: "visitorId" },
    { name: "pathname", slot: "pathname" },
    { name: "hash", slot: "hash" },
    { name: "title", slot: "title" },
    { name: "hostname", slot: "hostname" },
    { name: "referrerHost", slot: "referrerHost" },
    { name: "referrerUrl", slot: "referrerUrl" },
    { name: "country", slot: "country" },
    { name: "region", slot: "region" },
    { name: "city", slot: "city" },
    { name: "browser", slot: "browser" },
    { name: "browserVersion", slot: "browserVersion" },
    { name: "os", slot: "os" },
    { name: "osVersion", slot: "osVersion" },
    { name: "deviceType", slot: "deviceType" },
    { name: "screenWidth", slot: "screenWidth" },
    { name: "screenHeight", slot: "screenHeight" },
    { name: "durationMs", slot: "durationMs" },
    { name: "perfTtfbMs", slot: "perfTtfbMs" },
    { name: "perfFcpMs", slot: "perfFcpMs" },
    { name: "perfLcpMs", slot: "perfLcpMs" },
    { name: "perfCls", slot: "perfCls" },
    { name: "perfInpMs", slot: "perfInpMs" },
  ]);
  return builder.finish();
}

function buildDetailSourceOutput(
  builder: LogicalPlanBuilder,
  observations: LogicalRelationHandle,
): ValidatedLogicalPlan {
  const attr = (name: string) =>
    builder.slot(observations, `attribute:observation.${name}`);
  const isPage = builder.compare(
    "eq",
    attr("kind"),
    builder.literal("page", STRING),
  );
  const isEvent = builder.compare(
    "eq",
    attr("kind"),
    builder.literal("event", STRING),
  );
  const sourceType = builder.caseWhen(
    [
      {
        when: isPage,
        then: builder.literal("visit", STRING),
      },
    ],
    builder.literal("custom", STRING),
  );
  const nullDate = builder.literal(null, DATETIME);
  const occurredAt = builder.caseWhen(
    [{ when: isEvent, then: builder.slot(observations, "time") }],
    nullDate,
  );
  const nullText = builder.literal(null, STRING);
  const nullNumber = builder.literal(null, {
    kind: "scalar",
    scalar: "number",
  });
  const output = builder.project(observations, {
    sourceType,
    visitId: attr("visitId"),
    visitorId: attr("visitorId"),
    sessionId: attr("sessionId"),
    userId: attr("userId"),
    userName: attr("userName"),
    status: attr("status"),
    startedAt: attr("startedAt"),
    lastActivityAt: attr("lastActivityAt"),
    endedAt: attr("endedAt"),
    durationMs: attr("durationMs"),
    pathname: attr("pathname"),
    hash: attr("hash"),
    title: attr("title"),
    hostname: attr("hostname"),
    referrerHost: attr("referrerHost"),
    referrerUrl: attr("referrerUrl"),
    country: attr("country"),
    region: attr("region"),
    regionCode: builder.caseWhen(
      [{ when: isPage, then: attr("regionCode") }],
      nullText,
    ),
    city: attr("city"),
    latitude: builder.caseWhen(
      [{ when: isPage, then: attr("latitude") }],
      nullNumber,
    ),
    longitude: builder.caseWhen(
      [{ when: isPage, then: attr("longitude") }],
      nullNumber,
    ),
    browser: attr("browser"),
    browserVersion: attr("browserVersion"),
    os: attr("os"),
    osVersion: attr("osVersion"),
    deviceType: attr("deviceType"),
    screenWidth: attr("screenWidth"),
    screenHeight: attr("screenHeight"),
    perfTtfbMs: attr("perfTtfbMs"),
    perfFcpMs: attr("perfFcpMs"),
    perfLcpMs: attr("perfLcpMs"),
    perfCls: attr("perfCls"),
    perfInpMs: attr("perfInpMs"),
    eventId: attr("eventId"),
    eventType: attr("eventName"),
    occurredAt,
  });
  builder.output(
    "journey-observation-detail-source",
    output,
    [
      "sourceType",
      "visitId",
      "visitorId",
      "sessionId",
      "userId",
      "userName",
      "status",
      "startedAt",
      "lastActivityAt",
      "endedAt",
      "durationMs",
      "pathname",
      "hash",
      "title",
      "hostname",
      "referrerHost",
      "referrerUrl",
      "country",
      "region",
      "regionCode",
      "city",
      "latitude",
      "longitude",
      "browser",
      "browserVersion",
      "os",
      "osVersion",
      "deviceType",
      "screenWidth",
      "screenHeight",
      "perfTtfbMs",
      "perfFcpMs",
      "perfLcpMs",
      "perfCls",
      "perfInpMs",
      "eventId",
      "eventType",
      "occurredAt",
    ].map((name) => ({ name, slot: name })),
  );
  return builder.finish();
}
