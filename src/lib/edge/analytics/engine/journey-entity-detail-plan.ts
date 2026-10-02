import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import type { JourneyObservationTarget } from "@/lib/edge/analytics/engine/journey-observation-plan";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const NUMBER_MS = { kind: "scalar", scalar: "number", unit: "ms" } as const;

const VISITOR_PAGE_ATTRIBUTES = [
  "page.report.localId",
  "page.report.visitorId",
  "page.report.sessionId",
  "page.report.userId",
  "page.report.userName",
  "page.report.startedAt",
  "page.report.country",
  "page.report.region",
  "page.report.regionCode",
  "page.report.city",
  "page.report.referrerHost",
  "page.report.referrerUrl",
  "page.report.browser",
  "page.report.browserVersion",
  "page.report.os",
  "page.report.osVersion",
  "page.report.deviceType",
  "page.report.screenWidth",
  "page.report.screenHeight",
] as const;

const SESSION_PAGE_ATTRIBUTES = [
  "page.report.localId",
  "page.report.visitorId",
  "page.report.sessionId",
  "page.report.userId",
  "page.report.userName",
  "page.report.startedAt",
  "page.report.endedAt",
  "page.report.lastActivityAt",
  "page.report.durationMs",
  "page.report.status",
  "page.report.pathname",
  "page.report.referrerHost",
  "page.report.referrerUrl",
  "page.report.country",
  "page.report.region",
  "page.report.regionCode",
  "page.report.city",
  "page.report.latitude",
  "page.report.longitude",
  "page.report.browser",
  "page.report.browserVersion",
  "page.report.os",
  "page.report.osVersion",
  "page.report.deviceType",
  "page.report.screenWidth",
  "page.report.screenHeight",
] as const;

function createBuilder(siteId: string): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [siteId as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: {
        startMs: 0 as EpochMs,
        endExclusiveMs: 1 as EpochMs,
      },
      read: { kind: "retained-history" },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 0 as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function pageField(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(relation, `attribute:page.report.${name}`);
}

function observationField(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
) {
  return builder.slot(relation, `attribute:observation.${name}`);
}

function visitorDetailEvents(
  builder: LogicalPlanBuilder,
  visitorId: string,
): LogicalRelationHandle {
  const observations = builder.source("observation", {
    temporalDomain: "read",
    attributes: [
      "observation.kind",
      "observation.visitorId",
      "observation.eventName",
    ],
  });
  const visitor = observationField(builder, observations, "visitorId");
  const matching = builder.filter(
    observations,
    builder.and(
      builder.compare(
        "eq",
        observationField(builder, observations, "kind"),
        builder.literal("event", STRING),
      ),
      builder.isNull(
        observationField(builder, observations, "eventName"),
        true,
      ),
      builder.compare("eq", visitor, builder.literal(visitorId, STRING)),
      builder.compare("neq", visitor, builder.literal("", STRING)),
    ),
  );
  const counts = builder.aggregate(
    matching,
    { visitorId: observationField(builder, matching, "visitorId") },
    [{ name: "eventCount", kind: "count-rows" }],
  );
  return builder.project(counts, {
    eventsVisitorId: builder.slot(counts, "visitorId"),
    eventCount: builder.slot(counts, "eventCount"),
  });
}

function sessionDetailEvents(
  builder: LogicalPlanBuilder,
  target: JourneyObservationTarget,
): LogicalRelationHandle {
  const observations = builder.source("observation", {
    temporalDomain: "read",
    attributes: [
      "observation.kind",
      "observation.sessionId",
      "observation.eventName",
      ...(target.type === "visitor" ? ["observation.visitorId"] : []),
    ],
  });
  const sessionId = observationField(builder, observations, "sessionId");
  const targetSlot = observationField(
    builder,
    observations,
    target.type === "visitor" ? "visitorId" : "sessionId",
  );
  const matching = builder.filter(
    observations,
    builder.and(
      builder.compare(
        "eq",
        observationField(builder, observations, "kind"),
        builder.literal("event", STRING),
      ),
      builder.isNull(
        observationField(builder, observations, "eventName"),
        true,
      ),
      builder.compare("eq", targetSlot, builder.literal(target.value, STRING)),
      builder.compare("neq", sessionId, builder.literal("", STRING)),
    ),
  );
  const counts = builder.aggregate(
    matching,
    { sessionId: observationField(builder, matching, "sessionId") },
    [{ name: "eventCount", kind: "count-rows" }],
  );
  return builder.project(counts, {
    eventsSessionId: builder.slot(counts, "sessionId"),
    eventCount: builder.slot(counts, "eventCount"),
  });
}

/** Builds retained-history Visitor detail from Page report rows and events. */
export function buildJourneyVisitorDetailPlan(input: {
  readonly siteId: string;
  readonly visitorId: string;
}): ValidatedLogicalPlan {
  if (!input || typeof input.visitorId !== "string")
    throw new Error("journey_entity_detail_invalid_visitor");
  const builder = createBuilder(input.siteId);
  const source = builder.source("page", {
    temporalDomain: "read",
    attributes: VISITOR_PAGE_ATTRIBUTES,
  });
  const rawTarget = builder.filter(
    source,
    builder.compare(
      "eq",
      pageField(builder, source, "visitorId"),
      builder.literal(input.visitorId, STRING),
    ),
  );
  const pages = builder.filter(
    rawTarget,
    builder.compare(
      "neq",
      pageField(builder, rawTarget, "visitorId"),
      builder.literal("", STRING),
    ),
  );
  const field = (name: string) => pageField(builder, pages, name);

  const metrics = builder.aggregate(pages, { visitorId: field("visitorId") }, [
    { name: "firstSeenAt", kind: "min", expression: field("startedAt") },
    { name: "lastSeenAt", kind: "max", expression: field("startedAt") },
    { name: "views", kind: "count-rows" },
    {
      name: "sessionCount",
      kind: "count-distinct",
      expression: builder.caseWhen(
        [
          {
            when: builder.compare(
              "neq",
              field("sessionId"),
              builder.literal("", STRING),
            ),
            then: field("sessionId"),
          },
        ],
        builder.literal(null, STRING),
      ),
    },
  ]);

  const firstMember = builder.orderedMember(pages, {
    groups: ["attribute:page.report.visitorId"],
    order: [
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
    ],
  });
  const first = builder.project(firstMember, {
    firstVisitorId: pageField(builder, firstMember, "visitorId"),
    firstReferrerHost: pageField(builder, firstMember, "referrerHost"),
    firstReferrerUrl: pageField(builder, firstMember, "referrerUrl"),
  });

  const latestMember = builder.orderedMember(pages, {
    groups: ["attribute:page.report.visitorId"],
    order: [
      {
        slot: "attribute:page.report.startedAt",
        direction: "desc",
        nulls: "last",
      },
      {
        slot: "attribute:page.report.localId",
        direction: "desc",
        nulls: "last",
      },
    ],
  });
  const latest = builder.project(latestMember, {
    latestVisitorId: pageField(builder, latestMember, "visitorId"),
    latestSessionId: pageField(builder, latestMember, "sessionId"),
    latestCountry: pageField(builder, latestMember, "country"),
    latestRegion: pageField(builder, latestMember, "region"),
    latestRegionCode: pageField(builder, latestMember, "regionCode"),
    latestCity: pageField(builder, latestMember, "city"),
    latestBrowser: pageField(builder, latestMember, "browser"),
    latestBrowserVersion: pageField(builder, latestMember, "browserVersion"),
    latestOs: pageField(builder, latestMember, "os"),
    latestOsVersion: pageField(builder, latestMember, "osVersion"),
    latestDeviceType: pageField(builder, latestMember, "deviceType"),
    latestScreenWidth: pageField(builder, latestMember, "screenWidth"),
    latestScreenHeight: pageField(builder, latestMember, "screenHeight"),
  });

  const userId = field("userId");
  const empty = builder.literal("", STRING);
  const hasIdentity = builder.compare(
    "neq",
    builder.coalesce(userId, empty),
    empty,
    "trim-ascii-space",
  );
  const identityInput = builder.project(pages, {
    identityVisitorId: field("visitorId"),
    identityUserId: userId,
    identityUserName: field("userName"),
    identityPriority: builder.caseWhen(
      [{ when: hasIdentity, then: builder.literal(0, NUMBER) }],
      builder.literal(1, NUMBER),
    ),
    identityStartedAt: field("startedAt"),
    identityLocalId: field("localId"),
  });
  const identityMember = builder.orderedMember(identityInput, {
    groups: ["identityVisitorId"],
    order: [
      { slot: "identityPriority", direction: "asc", nulls: "last" },
      { slot: "identityStartedAt", direction: "desc", nulls: "last" },
      { slot: "identityLocalId", direction: "desc", nulls: "last" },
    ],
  });
  const identity = builder.project(identityMember, {
    identityVisitorId: builder.slot(identityMember, "identityVisitorId"),
    identityUserId: builder.slot(identityMember, "identityUserId"),
    identityUserName: builder.slot(identityMember, "identityUserName"),
  });

  let detail = builder.join(metrics, first, [
    { left: "visitorId", right: "firstVisitorId" },
  ]);
  detail = builder.join(detail, latest, [
    { left: "visitorId", right: "latestVisitorId" },
  ]);
  detail = builder.join(detail, identity, [
    { left: "visitorId", right: "identityVisitorId" },
  ]);
  detail = builder.join(
    detail,
    visitorDetailEvents(builder, input.visitorId),
    [{ left: "visitorId", right: "eventsVisitorId" }],
    "left",
  );

  const joined = (name: string) => builder.slot(detail, name);
  const output = builder.project(detail, {
    visitorId: joined("visitorId"),
    sessionId: builder.coalesce(joined("right.latestSessionId"), empty),
    userId: builder.coalesce(joined("right.identityUserId"), empty),
    userName: builder.coalesce(joined("right.identityUserName"), empty),
    firstSeenAt: joined("firstSeenAt"),
    lastSeenAt: joined("lastSeenAt"),
    views: joined("views"),
    sessions: joined("sessionCount"),
    events: builder.coalesce(
      joined("right.eventCount"),
      builder.literal(0, NUMBER),
    ),
    country: builder.coalesce(joined("right.latestCountry"), empty),
    region: builder.coalesce(joined("right.latestRegion"), empty),
    regionCode: builder.coalesce(joined("right.latestRegionCode"), empty),
    city: builder.coalesce(joined("right.latestCity"), empty),
    referrerHost: builder.coalesce(joined("right.firstReferrerHost"), empty),
    referrerUrl: builder.coalesce(joined("right.firstReferrerUrl"), empty),
    browser: builder.coalesce(joined("right.latestBrowser"), empty),
    browserVersion: builder.coalesce(
      joined("right.latestBrowserVersion"),
      empty,
    ),
    os: builder.coalesce(joined("right.latestOs"), empty),
    osVersion: builder.coalesce(joined("right.latestOsVersion"), empty),
    deviceType: builder.coalesce(joined("right.latestDeviceType"), empty),
    screenWidth: joined("right.latestScreenWidth"),
    screenHeight: joined("right.latestScreenHeight"),
  });
  const sorted = builder.sort(output, [
    { slot: "lastSeenAt", direction: "desc", nulls: "last" },
    { slot: "visitorId", direction: "asc", nulls: "last" },
  ]);
  const firstResult = builder.limit(sorted, 1);
  const fields = Object.keys(output.slots);
  builder.output(
    "journey-visitor-detail",
    firstResult,
    fields.map((name) => ({ name, slot: name })),
  );
  return builder.finish();
}

/** Builds retained-history Session detail from Page report rows and events. */
export function buildJourneySessionDetailPlan(input: {
  readonly siteId: string;
  readonly target: JourneyObservationTarget;
}): ValidatedLogicalPlan {
  if (
    !input ||
    !input.target ||
    typeof input.target.value !== "string" ||
    (input.target.type !== "visitor" && input.target.type !== "session")
  )
    throw new Error("journey_entity_detail_invalid_target");
  const builder = createBuilder(input.siteId);
  const source = builder.source("page", {
    temporalDomain: "read",
    attributes: SESSION_PAGE_ATTRIBUTES,
  });
  const targetSlot = pageField(
    builder,
    source,
    input.target.type === "visitor" ? "visitorId" : "sessionId",
  );
  const rawTarget = builder.filter(
    source,
    builder.compare(
      "eq",
      targetSlot,
      builder.literal(input.target.value, STRING),
    ),
  );
  const pages = builder.filter(
    rawTarget,
    builder.compare(
      "neq",
      pageField(builder, rawTarget, "sessionId"),
      builder.literal("", STRING),
    ),
  );
  const field = (name: string) => pageField(builder, pages, name);
  const sessionKey = field("sessionId");

  const active = builder.caseWhen(
    [
      {
        when: builder.compare(
          "eq",
          builder.coalesce(field("status"), builder.literal("", STRING)),
          builder.literal("open", STRING),
          "ascii-case-fold",
        ),
        then: builder.literal(1, NUMBER),
      },
    ],
    builder.literal(0, NUMBER),
  );
  const endedAt = builder.coalesce(
    field("endedAt"),
    field("lastActivityAt"),
    field("startedAt"),
  );
  const metrics = builder.aggregate(pages, { sessionId: sessionKey }, [
    { name: "startedAt", kind: "min", expression: field("startedAt") },
    { name: "endedAt", kind: "max", expression: endedAt },
    {
      name: "totalDurationMs",
      kind: "sum",
      expression: builder.coalesce(
        field("durationMs"),
        builder.literal(0, NUMBER_MS),
      ),
    },
    { name: "active", kind: "max", expression: active },
    { name: "views", kind: "count-rows" },
  ]);
  const metricsWithBounce = builder.project(metrics, {
    sessionId: builder.slot(metrics, "sessionId"),
    startedAt: builder.slot(metrics, "startedAt"),
    endedAt: builder.slot(metrics, "endedAt"),
    totalDurationMs: builder.slot(metrics, "totalDurationMs"),
    active: builder.slot(metrics, "active"),
    views: builder.slot(metrics, "views"),
    bounce: builder.caseWhen(
      [
        {
          when: builder.compare(
            "eq",
            builder.slot(metrics, "views"),
            builder.literal(1, NUMBER),
          ),
          then: builder.literal(1, NUMBER),
        },
      ],
      builder.literal(0, NUMBER),
    ),
  });

  const firstMember = builder.orderedMember(pages, {
    groups: ["attribute:page.report.sessionId"],
    order: [
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
    ],
  });
  const first = builder.project(firstMember, {
    firstSessionId: pageField(builder, firstMember, "sessionId"),
    firstVisitorId: pageField(builder, firstMember, "visitorId"),
    firstUserId: pageField(builder, firstMember, "userId"),
    firstPathname: pageField(builder, firstMember, "pathname"),
    firstReferrerHost: pageField(builder, firstMember, "referrerHost"),
    firstReferrerUrl: pageField(builder, firstMember, "referrerUrl"),
    firstCountry: pageField(builder, firstMember, "country"),
    firstRegion: pageField(builder, firstMember, "region"),
    firstRegionCode: pageField(builder, firstMember, "regionCode"),
    firstCity: pageField(builder, firstMember, "city"),
    firstBrowser: pageField(builder, firstMember, "browser"),
    firstBrowserVersion: pageField(builder, firstMember, "browserVersion"),
    firstOs: pageField(builder, firstMember, "os"),
    firstOsVersion: pageField(builder, firstMember, "osVersion"),
    firstDeviceType: pageField(builder, firstMember, "deviceType"),
    firstScreenWidth: pageField(builder, firstMember, "screenWidth"),
    firstScreenHeight: pageField(builder, firstMember, "screenHeight"),
  });

  const latestMember = builder.orderedMember(pages, {
    groups: ["attribute:page.report.sessionId"],
    order: [
      {
        slot: "attribute:page.report.startedAt",
        direction: "desc",
        nulls: "last",
      },
      {
        slot: "attribute:page.report.localId",
        direction: "desc",
        nulls: "last",
      },
    ],
  });
  const latest = builder.project(latestMember, {
    latestSessionId: pageField(builder, latestMember, "sessionId"),
    latestPathname: pageField(builder, latestMember, "pathname"),
  });

  const userId = field("userId");
  const empty = builder.literal("", STRING);
  const hasIdentity = builder.compare(
    "neq",
    builder.coalesce(userId, empty),
    empty,
    "trim-ascii-space",
  );
  const identityInput = builder.project(pages, {
    identitySessionId: sessionKey,
    identityUserId: userId,
    identityUserName: field("userName"),
    identityPriority: builder.caseWhen(
      [{ when: hasIdentity, then: builder.literal(0, NUMBER) }],
      builder.literal(1, NUMBER),
    ),
    identityStartedAt: field("startedAt"),
    identityLocalId: field("localId"),
  });
  const identityMember = builder.orderedMember(identityInput, {
    groups: ["identitySessionId"],
    order: [
      { slot: "identityPriority", direction: "asc", nulls: "last" },
      { slot: "identityStartedAt", direction: "desc", nulls: "last" },
      { slot: "identityLocalId", direction: "desc", nulls: "last" },
    ],
  });
  const identity = builder.project(identityMember, {
    identitySessionId: builder.slot(identityMember, "identitySessionId"),
    identityUserId: builder.slot(identityMember, "identityUserId"),
    identityUserName: builder.slot(identityMember, "identityUserName"),
  });

  const latitude = field("latitude");
  const longitude = field("longitude");
  const geoCandidates = builder.filter(
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
  const firstGeoMember = builder.orderedMember(geoCandidates, {
    groups: ["attribute:page.report.sessionId"],
    order: [
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
    ],
  });
  const geo = builder.project(firstGeoMember, {
    geoSessionId: pageField(builder, firstGeoMember, "sessionId"),
    latitude: pageField(builder, firstGeoMember, "latitude"),
    longitude: pageField(builder, firstGeoMember, "longitude"),
  });

  let detail = builder.join(metricsWithBounce, first, [
    { left: "sessionId", right: "firstSessionId" },
  ]);
  detail = builder.join(detail, latest, [
    { left: "sessionId", right: "latestSessionId" },
  ]);
  detail = builder.join(detail, identity, [
    { left: "sessionId", right: "identitySessionId" },
  ]);
  detail = builder.join(
    detail,
    sessionDetailEvents(builder, input.target),
    [{ left: "sessionId", right: "eventsSessionId" }],
    "left",
  );
  detail = builder.join(
    detail,
    geo,
    [{ left: "sessionId", right: "geoSessionId" }],
    "left",
  );

  const joined = (name: string) => builder.slot(detail, name);
  const output = builder.project(detail, {
    sessionId: joined("sessionId"),
    visitorId: builder.coalesce(joined("right.firstVisitorId"), empty),
    userId: builder.coalesce(joined("right.identityUserId"), empty),
    userName: builder.coalesce(joined("right.identityUserName"), empty),
    startedAt: joined("startedAt"),
    endedAt: joined("endedAt"),
    totalDurationMs: joined("totalDurationMs"),
    active: joined("active"),
    views: joined("views"),
    events: builder.coalesce(
      joined("right.eventCount"),
      builder.literal(0, NUMBER),
    ),
    bounce: joined("bounce"),
    entryPath: builder.coalesce(joined("right.firstPathname"), empty),
    exitPath: builder.coalesce(joined("right.latestPathname"), empty),
    referrerHost: builder.coalesce(joined("right.firstReferrerHost"), empty),
    referrerUrl: builder.coalesce(joined("right.firstReferrerUrl"), empty),
    country: builder.coalesce(joined("right.firstCountry"), empty),
    region: builder.coalesce(joined("right.firstRegion"), empty),
    regionCode: builder.coalesce(joined("right.firstRegionCode"), empty),
    city: builder.coalesce(joined("right.firstCity"), empty),
    latitude: joined("right.latitude"),
    longitude: joined("right.longitude"),
    browser: builder.coalesce(joined("right.firstBrowser"), empty),
    browserVersion: builder.coalesce(
      joined("right.firstBrowserVersion"),
      empty,
    ),
    os: builder.coalesce(joined("right.firstOs"), empty),
    osVersion: builder.coalesce(joined("right.firstOsVersion"), empty),
    deviceType: builder.coalesce(joined("right.firstDeviceType"), empty),
    screenWidth: joined("right.firstScreenWidth"),
    screenHeight: joined("right.firstScreenHeight"),
  });
  const sorted = builder.sort(output, [
    { slot: "startedAt", direction: "desc", nulls: "last" },
    { slot: "sessionId", direction: "asc", nulls: "last" },
  ]);
  const fields = Object.keys(output.slots);
  builder.output(
    "journey-session-detail",
    sorted,
    fields.map((name) => ({ name, slot: name })),
  );
  return builder.finish();
}
