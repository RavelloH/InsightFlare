import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type FunnelConfigV2,
  type QueryWindow,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  type SiteId,
  type SortDirection,
} from "@/lib/edge/analytics/contract";
import {
  appendFunnelProgressionRelations,
  createJourneyFunnelProgressionSourceSelections,
} from "@/lib/edge/analytics/engine/funnel-progression-report-plan";
import {
  type LogicalExpressionHandle,
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticPostObservationFilter,
  createSemanticScopedSourceSelection,
  type SemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
type VisitorListSortKey = "firstSeenAt" | "lastSeenAt" | "sessions" | "views";
type SessionListSortKey = "startedAt" | "durationMs" | "views";
interface ListSort<K extends string> {
  readonly key: K;
  readonly direction: SortDirection;
}
interface VisitorListCursor {
  readonly sortValue: number;
  readonly lastSeenAt?: number;
  readonly visitorId: string;
}
interface SessionListCursor {
  readonly sortValue: number;
  readonly startedAt?: number;
  readonly sessionId: string;
}

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const NUMBER_MS = { kind: "scalar", scalar: "number", unit: "ms" } as const;
const BOOLEAN = { kind: "scalar", scalar: "boolean" } as const;

export const JOURNEY_VISITOR_LIST_REPORT_OUTPUT = "journey-visitor-list";
export const JOURNEY_SESSION_LIST_REPORT_OUTPUT = "journey-session-list";

export const JOURNEY_LIST_PAGE_ATTRIBUTES = [
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
  "page.report.queryString",
  "page.report.hash",
  "page.report.hostname",
  "page.report.title",
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

export const JOURNEY_LIST_EVENT_ATTRIBUTES = [
  "event.report.localId",
  "event.report.ownerVisitId",
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
  "event.report.occurredAt",
  "event.report.ownerUserId",
  "event.report.ownerUserName",
  "event.report.ownerStartedAt",
  "event.report.ownerLastActivityAt",
  "event.report.ownerEndedAt",
  "event.report.ownerDurationMs",
  "event.report.ownerStatus",
  "event.report.ownerPathname",
  "event.report.ownerQueryString",
  "event.report.ownerHash",
  "event.report.ownerHostname",
  "event.report.ownerTitle",
  "event.report.ownerReferrerHost",
  "event.report.ownerReferrerUrl",
  "event.report.ownerCountry",
  "event.report.ownerRegion",
  "event.report.ownerRegionCode",
  "event.report.ownerCity",
  "event.report.ownerBrowser",
  "event.report.ownerBrowserVersion",
  "event.report.ownerOs",
  "event.report.ownerOsVersion",
  "event.report.ownerDeviceType",
  "event.report.ownerScreenWidth",
  "event.report.ownerScreenHeight",
] as const;

type ListEntity = "visitor" | "session";
type JourneyListAnalysis =
  | { readonly type: "goal"; readonly filter: FilterDocument }
  | {
      readonly type: "funnel";
      readonly config: FunnelConfigV2;
      readonly stepIndex: number;
      readonly outcome?: "converted" | "dropoff";
    };

interface CommonListInput {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly search?: string;
  readonly analysis?: JourneyListAnalysis;
  readonly sessionTarget?: {
    readonly type: "visitor" | "session";
    readonly value: string;
  };
}

interface VisitorListInput extends CommonListInput {
  readonly sort: ListSort<VisitorListSortKey>;
  readonly cursor?: VisitorListCursor | null;
}

interface SessionListInput extends CommonListInput {
  readonly sort: ListSort<SessionListSortKey>;
  readonly cursor?: SessionListCursor | null;
  readonly preparedPlanOperation?: "sessions" | "visitor-sessions";
}

interface JourneyListSources {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
  readonly filters: FilterDocument;
  readonly expectedPlan?: ScopedFilterPlan;
  readonly pageSelection: SemanticScopedSourceSelection;
  readonly eventSelection: SemanticScopedSourceSelection;
  readonly scoped: boolean;
}

function createJourneyListSources(
  input: CommonListInput,
  entity: ListEntity,
  preparedPlanOperation?: "sessions" | "visitor-sessions",
): JourneyListSources {
  const metadata = scopedFilterMetadata(input.filters);
  if (input.analysis || metadata) {
    const selections = createJourneyFunnelProgressionSourceSelections({
      siteId: input.siteId,
      window: input.window,
      filters: input.filters,
      entityScope: entity,
      ...(preparedPlanOperation ? { preparedPlanOperation } : {}),
    });
    const pageSelection = selections.page;
    const eventSelection = selections.event;
    const builder = new LogicalPlanBuilder({
      subject: pageSelection.subject,
      time: pageSelection.time,
      scope: resolveAnalyticsScope(pageSelection.scope),
      originOperation: entity === "visitor" ? "visitors" : "sessions",
    });
    return {
      builder,
      pages: builder.source("page", {
        temporalDomain: "candidate",
        attributes: JOURNEY_LIST_PAGE_ATTRIBUTES,
        selection: pageSelection,
      }),
      events: builder.source("event", {
        temporalDomain: "candidate",
        attributes: JOURNEY_LIST_EVENT_ATTRIBUTES,
        selection: eventSelection,
      }),
      filters: selections.filters,
      ...(selections.expectedPlan
        ? { expectedPlan: selections.expectedPlan }
        : {}),
      pageSelection,
      eventSelection,
      scoped: Boolean(input.analysis || metadata),
    };
  }

  const queryTime = createQueryTime(
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    input.window.nowMs,
  );
  const time = semanticTemporalDomainsFromQueryTime(queryTime);
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [input.siteId as SiteId],
  });
  const pageSelection = createSemanticScopedSourceSelection({
    profile: "direct-page-analytics-v1",
    filters: input.filters,
    subject,
    time,
  });
  const eventSelection = createSemanticScopedSourceSelection({
    profile: "direct-event-analytics-v1",
    filters: EMPTY_FILTER_DOCUMENT,
    subject,
    time,
  });
  const allPagesSelection = createSemanticScopedSourceSelection({
    profile: "direct-page-analytics-v1",
    filters: EMPTY_FILTER_DOCUMENT,
    subject,
    time,
  });
  const builder = new LogicalPlanBuilder({
    subject,
    time,
    scope: resolveAnalyticsScope("event"),
    originOperation: entity === "visitor" ? "visitors" : "sessions",
  });
  return {
    builder,
    pages: builder.source("page", {
      temporalDomain: "candidate",
      attributes: JOURNEY_LIST_PAGE_ATTRIBUTES,
      selection: allPagesSelection,
    }),
    events: builder.source("event", {
      temporalDomain: "candidate",
      attributes: JOURNEY_LIST_EVENT_ATTRIBUTES,
      selection: eventSelection,
    }),
    filters: input.filters,
    pageSelection,
    eventSelection,
    scoped: false,
  };
}

function pageField(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
): LogicalExpressionHandle {
  return builder.slot(relation, `attribute:page.report.${name}`);
}

function eventField(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  name: string,
): LogicalExpressionHandle {
  return builder.slot(relation, `attribute:event.report.${name}`);
}

function rowSearchPredicate(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  search: string | undefined,
): LogicalExpressionHandle | undefined {
  const value = search?.trim();
  if (!value) return undefined;
  const needle = value.toLowerCase();
  const field = (name: string) => builder.slot(relation, name);
  const asText = (input: LogicalExpressionHandle) =>
    builder.normalizeString(input, "trim-ascii-space");
  const contains = (input: LogicalExpressionHandle) =>
    builder.stringMatch(
      "contains",
      asText(input),
      needle,
      false,
      undefined,
      "legacy-report-search-v1",
    );
  const empty = builder.literal("", STRING);
  const referrerHost = field("referrerHost");
  const directReferrer = builder.caseWhen(
    [
      {
        when: builder.compare(
          "eq",
          builder.normalizeString(
            builder.coalesce(referrerHost, empty),
            "trim-ascii-space",
          ),
          empty,
        ),
        then: builder.literal("direct", STRING),
      },
    ],
    referrerHost,
  );
  const browserVersion = field("browserVersion");
  const os = field("os");
  const osVersion = field("osVersion");
  const browserCombined = builder.concatText(
    builder.coalesce(field("browser"), empty),
    builder.literal(" ", STRING),
    builder.coalesce(browserVersion, empty),
  );
  const osCombined = builder.concatText(
    builder.coalesce(os, empty),
    builder.literal(" ", STRING),
    builder.coalesce(osVersion, empty),
  );
  const names = [
    "visitorId",
    "sessionId",
    "userId",
    "userName",
    "pathname",
    "queryString",
    "hash",
    "hostname",
    "title",
  ];
  const terms = names.map((name) => contains(field(name)));
  terms.push(
    contains(referrerHost),
    contains(field("referrerUrl")),
    contains(directReferrer),
    contains(field("country")),
    contains(field("region")),
    contains(field("regionCode")),
    contains(field("city")),
    contains(field("browser")),
    contains(browserVersion),
    contains(browserCombined),
    contains(os),
    contains(osVersion),
    contains(osCombined),
    contains(field("deviceType")),
  );
  return builder.or(...terms);
}

function pageSearchSource(input: {
  readonly builder: LogicalPlanBuilder;
  readonly relation: LogicalRelationHandle;
  readonly search?: string;
}): LogicalRelationHandle {
  const predicate = rowSearchPredicate(
    input.builder,
    input.relation,
    input.search,
  );
  return predicate
    ? input.builder.filter(input.relation, predicate)
    : input.relation;
}

function eventSearchSource(input: {
  readonly builder: LogicalPlanBuilder;
  readonly relation: LogicalRelationHandle;
  readonly search?: string;
}): LogicalRelationHandle {
  const predicate = rowSearchPredicate(
    input.builder,
    input.relation,
    input.search,
  );
  return predicate
    ? input.builder.filter(input.relation, predicate)
    : input.relation;
}

function membershipIdentityRows(
  builder: LogicalPlanBuilder,
  input: {
    readonly relations: readonly LogicalRelationHandle[];
    readonly entityField: (
      relation: LogicalRelationHandle,
    ) => LogicalExpressionHandle;
  },
): LogicalRelationHandle {
  // Membership joins observe only existence; duplicate identity rows are valid.
  const identityRows = input.relations.map((relation) =>
    builder.project(relation, {
      identity: input.entityField(relation),
    }),
  );
  const combined =
    identityRows.length === 1
      ? identityRows[0]!
      : builder.appendRows(identityRows, ["identity"]);
  return combined;
}

export function createJourneyListAnalysisStageSelection(
  selection: SemanticScopedSourceSelection,
  filters: FilterDocument,
  expectedPlan: JourneyListSources["expectedPlan"],
  stage: FilterDocument,
  preparedPlanOperation?: "visitors" | "sessions" | "visitor-sessions",
): SemanticScopedSourceSelection {
  return createSemanticScopedSourceSelection({
    profile: selection.profile,
    filters,
    subject: selection.subject,
    time: selection.time,
    ...(preparedPlanOperation ? { preparedPlanOperation } : {}),
    ...(expectedPlan ? { expectedPlan } : {}),
    ...(selection.profile === "direct-page-entity-only-compat-v1"
      ? { compatibilityScope: selection.entityKind! }
      : {}),
    postObservationFilter: createSemanticPostObservationFilter({
      filter: stage,
    }),
  });
}

export function appendJourneyListAnalysisIdentityRestriction(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
  readonly goalPages: LogicalRelationHandle;
  readonly goalEvents: LogicalRelationHandle;
  readonly entity: "visitor" | "session";
}): { pages: LogicalRelationHandle; events: LogicalRelationHandle } {
  const ids = membershipIdentityRows(input.builder, {
    relations: [input.goalPages, input.goalEvents],
    entityField: (relation) =>
      relation === input.goalPages
        ? pageIdentityField(input.builder, relation, input.entity)
        : eventIdentityField(input.builder, relation, input.entity),
  });
  return {
    pages: input.builder.semiJoin(input.pages, ids, [
      {
        left:
          input.entity === "visitor"
            ? "attribute:page.report.visitorId"
            : "attribute:page.report.sessionId",
        right: "identity",
      },
    ]),
    events: input.builder.semiJoin(input.events, ids, [
      {
        left:
          input.entity === "visitor"
            ? "attribute:event.report.ownerVisitorId"
            : "attribute:event.report.ownerSessionId",
        right: "identity",
      },
    ]),
  };
}

function applySessionTarget(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  entity: ListEntity,
  target: CommonListInput["sessionTarget"],
): LogicalRelationHandle {
  if (!target || entity !== "session") return relation;
  const slot = target.type === "visitor" ? "visitorId" : "sessionId";
  return builder.filter(
    relation,
    builder.compare(
      "eq",
      builder.slot(relation, slot),
      builder.literal(target.value, STRING),
    ),
  );
}

function applyPageTarget(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  target: CommonListInput["sessionTarget"],
): LogicalRelationHandle {
  if (!target) return relation;
  return builder.filter(
    relation,
    builder.compare(
      "eq",
      pageField(
        builder,
        relation,
        target.type === "visitor" ? "visitorId" : "sessionId",
      ),
      builder.literal(target.value, STRING),
    ),
  );
}

function pageIdentityField(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  entity: ListEntity,
): LogicalExpressionHandle {
  return pageField(
    builder,
    relation,
    entity === "visitor" ? "visitorId" : "sessionId",
  );
}

function eventIdentityField(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  entity: ListEntity,
): LogicalExpressionHandle {
  return eventField(
    builder,
    relation,
    entity === "visitor" ? "ownerVisitorId" : "ownerSessionId",
  );
}

function pageEntityIds(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  entity: ListEntity,
): LogicalRelationHandle {
  const id = pageIdentityField(builder, relation, entity);
  const nonempty = builder.filter(
    relation,
    builder.compare("neq", id, builder.literal("", STRING)),
  );
  return membershipIdentityRows(builder, {
    relations: [nonempty],
    entityField: (input) => pageIdentityField(builder, input, entity),
  });
}

function eventOnlyRows(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
  readonly entity: ListEntity;
}): LogicalRelationHandle {
  const { builder, pages, events, entity } = input;
  const pageIds = pageEntityIds(builder, pages, entity);
  const rawEvents = builder.filter(
    events,
    builder.compare(
      "neq",
      builder.normalizeString(
        eventIdentityField(builder, events, entity),
        "trim-ascii-space",
      ),
      builder.literal("", STRING),
    ),
  );
  const missingPageEvents = builder.antiJoin(rawEvents, pageIds, [
    {
      left:
        entity === "visitor"
          ? "attribute:event.report.ownerVisitorId"
          : "attribute:event.report.ownerSessionId",
      right: "identity",
    },
  ]);
  return projectEventObservationRows(builder, missingPageEvents);
}

const ROW_FIELDS = [
  "visitorId",
  "sessionId",
  "userId",
  "userName",
  "localId",
  "startedAt",
  "endedAt",
  "lastActivityAt",
  "durationMs",
  "status",
  "pathname",
  "queryString",
  "hash",
  "hostname",
  "title",
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
  "isVisitObservation",
] as const;

function projectPageObservationRows(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
): LogicalRelationHandle {
  const browserVersion = pageField(builder, pages, "browserVersion");
  return builder.project(pages, {
    visitorId: pageField(builder, pages, "visitorId"),
    sessionId: pageField(builder, pages, "sessionId"),
    userId: pageField(builder, pages, "userId"),
    userName: pageField(builder, pages, "userName"),
    localId: pageField(builder, pages, "localId"),
    startedAt: pageField(builder, pages, "startedAt"),
    endedAt: pageField(builder, pages, "endedAt"),
    lastActivityAt: pageField(builder, pages, "lastActivityAt"),
    durationMs: pageField(builder, pages, "durationMs"),
    status: pageField(builder, pages, "status"),
    pathname: pageField(builder, pages, "pathname"),
    queryString: pageField(builder, pages, "queryString"),
    hash: pageField(builder, pages, "hash"),
    hostname: pageField(builder, pages, "hostname"),
    title: pageField(builder, pages, "title"),
    referrerHost: pageField(builder, pages, "referrerHost"),
    referrerUrl: pageField(builder, pages, "referrerUrl"),
    country: pageField(builder, pages, "country"),
    region: pageField(builder, pages, "region"),
    regionCode: pageField(builder, pages, "regionCode"),
    city: pageField(builder, pages, "city"),
    latitude: pageField(builder, pages, "latitude"),
    longitude: pageField(builder, pages, "longitude"),
    browser: pageField(builder, pages, "browser"),
    browserVersion,
    os: pageField(builder, pages, "os"),
    osVersion: pageField(builder, pages, "osVersion"),
    deviceType: pageField(builder, pages, "deviceType"),
    screenWidth: pageField(builder, pages, "screenWidth"),
    screenHeight: pageField(builder, pages, "screenHeight"),
    isVisitObservation: builder.literal(true, BOOLEAN),
  });
}

function projectEventObservationRows(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
): LogicalRelationHandle {
  const browserVersion = eventField(builder, events, "ownerBrowserVersion");
  return builder.project(events, {
    visitorId: eventField(builder, events, "ownerVisitorId"),
    sessionId: eventField(builder, events, "ownerSessionId"),
    userId: eventField(builder, events, "ownerUserId"),
    userName: eventField(builder, events, "ownerUserName"),
    localId: eventField(builder, events, "ownerVisitId"),
    startedAt: eventField(builder, events, "occurredAt"),
    endedAt: eventField(builder, events, "occurredAt"),
    lastActivityAt: eventField(builder, events, "occurredAt"),
    durationMs: builder.literal(null, NUMBER_MS),
    status: builder.literal(null, STRING),
    pathname: eventField(builder, events, "ownerPathname"),
    queryString: eventField(builder, events, "ownerQueryString"),
    hash: eventField(builder, events, "ownerHash"),
    hostname: eventField(builder, events, "ownerHostname"),
    title: eventField(builder, events, "ownerTitle"),
    referrerHost: eventField(builder, events, "ownerReferrerHost"),
    referrerUrl: eventField(builder, events, "ownerReferrerUrl"),
    country: eventField(builder, events, "ownerCountry"),
    region: eventField(builder, events, "ownerRegion"),
    regionCode: eventField(builder, events, "ownerRegionCode"),
    city: eventField(builder, events, "ownerCity"),
    latitude: builder.literal(null, NUMBER),
    longitude: builder.literal(null, NUMBER),
    browser: eventField(builder, events, "ownerBrowser"),
    browserVersion,
    os: eventField(builder, events, "ownerOs"),
    osVersion: eventField(builder, events, "ownerOsVersion"),
    deviceType: eventField(builder, events, "ownerDeviceType"),
    screenWidth: eventField(builder, events, "ownerScreenWidth"),
    screenHeight: eventField(builder, events, "ownerScreenHeight"),
    isVisitObservation: builder.literal(false, BOOLEAN),
  });
}

function scopedObservationRows(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
  readonly entity: ListEntity;
}): LogicalRelationHandle {
  const pageRows = projectPageObservationRows(input.builder, input.pages);
  const eventRows = eventOnlyRows(input);
  return input.builder.appendRows([pageRows, eventRows], ROW_FIELDS);
}

function restrictAnalysis(
  sources: JourneyListSources,
  input: CommonListInput,
  entity: ListEntity,
): { pages: LogicalRelationHandle; events: LogicalRelationHandle } {
  const { builder } = sources;
  const analysis = input.analysis;
  if (!analysis) return { pages: sources.pages, events: sources.events };

  if (analysis.type === "goal") {
    const goalPages =
      analysis.filter.root === null
        ? sources.pages
        : builder.source("page", {
            temporalDomain: "candidate",
            attributes: JOURNEY_LIST_PAGE_ATTRIBUTES,
            selection: createJourneyListAnalysisStageSelection(
              sources.pageSelection,
              sources.filters,
              sources.expectedPlan,
              analysis.filter,
              entity === "visitor" ? "visitors" : undefined,
            ),
          });
    const goalEvents =
      analysis.filter.root === null
        ? sources.events
        : builder.source("event", {
            temporalDomain: "candidate",
            attributes: JOURNEY_LIST_EVENT_ATTRIBUTES,
            selection: createJourneyListAnalysisStageSelection(
              sources.eventSelection,
              sources.filters,
              sources.expectedPlan,
              analysis.filter,
              entity === "visitor" ? "visitors" : undefined,
            ),
          });
    return appendJourneyListAnalysisIdentityRestriction({
      builder,
      pages: sources.pages,
      events: sources.events,
      goalPages,
      goalEvents,
      entity,
    });
  }
  const progressionSources = createJourneyFunnelProgressionSourceSelections({
    siteId: input.siteId,
    window: input.window,
    filters: input.filters,
    entityScope: entity,
    preparedPlanOperation: entity === "visitor" ? "visitors" : "sessions",
  });
  const throughStepIndex = analysis.stepIndex;
  const progression = appendFunnelProgressionRelations({
    builder,
    sources: progressionSources,
    config: analysis.config,
    throughStepIndex,
    preparedPlanOperation: entity === "visitor" ? "visitors" : "sessions",
  });
  const reached = progression.reachedSteps[analysis.stepIndex];
  const membership =
    analysis.outcome === "dropoff"
      ? analysis.stepIndex === 0
        ? builder.filter(reached!, builder.literal(false, BOOLEAN))
        : builder.antiJoin(
            progression.reachedSteps[analysis.stepIndex - 1]!,
            reached!,
            [{ left: "identity", right: "identity" }],
          )
      : reached!;
  const identityAttribute =
    analysis.config.progressionScope === "visitor" ? "visitorId" : "sessionId";
  const pageName = `attribute:page.report.${identityAttribute}`;
  const eventName =
    analysis.config.progressionScope === "visitor"
      ? "attribute:event.report.ownerVisitorId"
      : "attribute:event.report.ownerSessionId";
  return {
    pages: builder.semiJoin(sources.pages, membership, [
      { left: pageName, right: "identity" },
    ]),
    events: builder.semiJoin(sources.events, membership, [
      { left: eventName, right: "identity" },
    ]),
  };
}

function filteredRows(input: {
  readonly builder: LogicalPlanBuilder;
  readonly qualifyingRows: LogicalRelationHandle;
  readonly expansionRows: LogicalRelationHandle;
  readonly entity: ListEntity;
  readonly filters: FilterDocument;
  readonly search?: string;
  readonly targetApplied: boolean;
}): LogicalRelationHandle {
  const { builder, entity, filters } = input;
  const hitRows = pageSearchSource({
    builder,
    relation: input.qualifyingRows,
    search: input.search,
  });
  const needsEntityExpansion =
    filters.root !== null || Boolean(input.search?.trim());
  if (!needsEntityExpansion) return input.qualifyingRows;
  const ids = membershipIdentityRows(builder, {
    relations: [hitRows],
    entityField: (relation) =>
      builder.slot(relation, entity === "visitor" ? "visitorId" : "sessionId"),
  });
  const expansionBase =
    filters.root === null && input.targetApplied
      ? input.qualifyingRows
      : input.expansionRows;
  return builder.semiJoin(expansionBase, ids, [
    {
      left: entity === "visitor" ? "visitorId" : "sessionId",
      right: "identity",
    },
  ]);
}

function searchScopedRows(input: {
  readonly builder: LogicalPlanBuilder;
  readonly rows: LogicalRelationHandle;
  readonly entity: ListEntity;
  readonly search?: string;
}): LogicalRelationHandle {
  const hitRows = eventSearchSource({
    builder: input.builder,
    relation: input.rows,
    search: input.search,
  });
  if (!input.search?.trim()) return hitRows;
  const ids = membershipIdentityRows(input.builder, {
    relations: [hitRows],
    entityField: (relation) =>
      input.builder.slot(
        relation,
        input.entity === "visitor" ? "visitorId" : "sessionId",
      ),
  });
  return input.builder.semiJoin(input.rows, ids, [
    {
      left: input.entity === "visitor" ? "visitorId" : "sessionId",
      right: "identity",
    },
  ]);
}

function eventCounts(
  builder: LogicalPlanBuilder,
  events: LogicalRelationHandle,
  entity: ListEntity,
): LogicalRelationHandle {
  const identity = eventIdentityField(builder, events, entity);
  const eligible = builder.filter(
    events,
    builder.compare("neq", identity, builder.literal("", STRING)),
  );
  return builder.aggregate(
    eligible,
    { identity: eventIdentityField(builder, eligible, entity) },
    [{ name: "events", kind: "count-rows" }],
  );
}

function nonemptyEntityRows(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  entity: ListEntity,
): LogicalRelationHandle {
  return builder.filter(
    rows,
    builder.compare(
      "neq",
      builder.slot(rows, entity === "visitor" ? "visitorId" : "sessionId"),
      builder.literal("", STRING),
    ),
  );
}

function firstMember(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  entity: ListEntity,
): LogicalRelationHandle {
  const identity = entity === "visitor" ? "visitorId" : "sessionId";
  const member = builder.orderedMember(rows, {
    groups: [identity],
    order: [
      { slot: "startedAt", direction: "asc", nulls: "first" },
      { slot: "localId", direction: "asc", nulls: "first" },
    ],
  });
  const names =
    entity === "visitor"
      ? ["visitorId", "referrerHost", "referrerUrl", "pathname"]
      : [
          "sessionId",
          "visitorId",
          "pathname",
          "referrerHost",
          "referrerUrl",
          "country",
          "region",
          "regionCode",
          "city",
          "latitude",
          "longitude",
          "browser",
          "os",
          "osVersion",
          "deviceType",
          "screenWidth",
          "screenHeight",
        ];
  const projections = Object.fromEntries(
    names.map((name) => [
      `first${name[0]!.toUpperCase()}${name.slice(1)}`,
      builder.slot(member, name),
    ]),
  ) as Record<string, LogicalExpressionHandle>;
  if (entity === "session") {
    projections.firstBrowserMajorVersion = builder.pageDimension(
      "browserMajorVersion",
      {
        "page.report.browserVersion": builder.slot(member, "browserVersion"),
      },
    );
  }
  return builder.project(member, projections);
}

function latestMember(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  entity: ListEntity,
): LogicalRelationHandle {
  const identity = entity === "visitor" ? "visitorId" : "sessionId";
  const member = builder.orderedMember(rows, {
    groups: [identity],
    order: [
      { slot: "startedAt", direction: "desc", nulls: "last" },
      { slot: "localId", direction: "desc", nulls: "last" },
    ],
  });
  const names =
    entity === "visitor"
      ? [
          "visitorId",
          "sessionId",
          "country",
          "region",
          "regionCode",
          "city",
          "browser",
          "os",
          "osVersion",
          "deviceType",
          "screenWidth",
          "screenHeight",
          "pathname",
        ]
      : ["sessionId", "pathname"];
  const projections = Object.fromEntries(
    names.map((name) => [
      `latest${name[0]!.toUpperCase()}${name.slice(1)}`,
      builder.slot(member, name),
    ]),
  ) as Record<string, LogicalExpressionHandle>;
  if (entity === "visitor") {
    projections.latestBrowserMajorVersion = builder.pageDimension(
      "browserMajorVersion",
      {
        "page.report.browserVersion": builder.slot(member, "browserVersion"),
      },
    );
  }
  return builder.project(member, projections);
}

function identityMember(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  entity: ListEntity,
): LogicalRelationHandle {
  const identity = entity === "visitor" ? "visitorId" : "sessionId";
  const empty = builder.literal("", STRING);
  const userId = builder.slot(rows, "userId");
  const hasUserId = builder.compare(
    "neq",
    builder.coalesce(userId, empty),
    empty,
    "trim-ascii-space",
  );
  const ranked = builder.project(rows, {
    entityId: builder.slot(rows, identity),
    userId,
    userName: builder.slot(rows, "userName"),
    priority: builder.caseWhen(
      [{ when: hasUserId, then: builder.literal(0, NUMBER) }],
      builder.literal(1, NUMBER),
    ),
    startedAt: builder.slot(rows, "startedAt"),
    localId: builder.slot(rows, "localId"),
  });
  const member = builder.orderedMember(ranked, {
    groups: ["entityId"],
    order: [
      { slot: "priority", direction: "asc", nulls: "last" },
      { slot: "startedAt", direction: "desc", nulls: "last" },
      { slot: "localId", direction: "desc", nulls: "last" },
    ],
  });
  return builder.project(member, {
    identityEntityId: builder.slot(member, "entityId"),
    userId: builder.slot(member, "userId"),
    userName: builder.slot(member, "userName"),
  });
}

function visitorMetrics(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
): LogicalRelationHandle {
  const visitorId = builder.slot(rows, "visitorId");
  const sessionId = builder.slot(rows, "sessionId");
  const nonemptySession = builder.caseWhen(
    [
      {
        when: builder.compare("neq", sessionId, builder.literal("", STRING)),
        then: sessionId,
      },
    ],
    builder.literal(null, STRING),
  );
  const pageCount = builder.caseWhen(
    [
      {
        when: builder.slot(rows, "isVisitObservation"),
        then: builder.literal(1, NUMBER),
      },
    ],
    builder.literal(0, NUMBER),
  );
  return builder.aggregate(rows, { visitorId }, [
    {
      name: "firstSeenAt",
      kind: "min",
      expression: builder.slot(rows, "startedAt"),
    },
    {
      name: "lastSeenAt",
      kind: "max",
      expression: builder.slot(rows, "startedAt"),
    },
    { name: "views", kind: "sum", expression: pageCount },
    { name: "sessions", kind: "count-distinct", expression: nonemptySession },
  ]);
}

function sessionMetrics(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
): LogicalRelationHandle {
  const duration = builder.coalesce(
    builder.slot(rows, "durationMs"),
    builder.literal(0, NUMBER_MS),
  );
  const endedAt = builder.coalesce(
    builder.slot(rows, "endedAt"),
    builder.slot(rows, "lastActivityAt"),
    builder.slot(rows, "startedAt"),
  );
  const active = builder.caseWhen(
    [
      {
        when: builder.compare(
          "eq",
          builder.coalesce(
            builder.slot(rows, "status"),
            builder.literal("", STRING),
          ),
          builder.literal("open", STRING),
          "ascii-case-fold",
        ),
        then: builder.literal(1, NUMBER),
      },
    ],
    builder.literal(0, NUMBER),
  );
  return builder.aggregate(
    rows,
    { sessionId: builder.slot(rows, "sessionId") },
    [
      {
        name: "startedAt",
        kind: "min",
        expression: builder.slot(rows, "startedAt"),
      },
      { name: "endedAt", kind: "max", expression: endedAt },
      { name: "totalDurationMs", kind: "sum", expression: duration },
      { name: "active", kind: "max", expression: active },
      {
        name: "views",
        kind: "sum",
        expression: builder.caseWhen(
          [
            {
              when: builder.slot(rows, "isVisitObservation"),
              then: builder.literal(1, NUMBER),
            },
          ],
          builder.literal(0, NUMBER),
        ),
      },
    ],
  );
}

function validGeoMember(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
): LogicalRelationHandle {
  const eligible = builder.filter(
    rows,
    builder.and(
      builder.isNull(builder.slot(rows, "latitude"), true),
      builder.isNull(builder.slot(rows, "longitude"), true),
      builder.compare(
        "lte",
        builder.absolute(builder.slot(rows, "latitude")),
        builder.literal(90, NUMBER),
      ),
      builder.compare(
        "lte",
        builder.absolute(builder.slot(rows, "longitude")),
        builder.literal(180, NUMBER),
      ),
    ),
  );
  const member = builder.orderedMember(eligible, {
    groups: ["sessionId"],
    order: [
      { slot: "startedAt", direction: "asc", nulls: "first" },
      { slot: "localId", direction: "asc", nulls: "first" },
    ],
  });
  return builder.project(member, {
    sessionId: builder.slot(member, "sessionId"),
    latitude: builder.slot(member, "latitude"),
    longitude: builder.slot(member, "longitude"),
  });
}

function joinListFacts(
  builder: LogicalPlanBuilder,
  entity: ListEntity,
  rows: LogicalRelationHandle,
  eventFacts: LogicalRelationHandle,
): LogicalRelationHandle {
  const metrics =
    entity === "visitor"
      ? visitorMetrics(builder, rows)
      : sessionMetrics(builder, rows);
  const first = firstMember(builder, rows, entity);
  const latest = latestMember(builder, rows, entity);
  const identity = identityMember(builder, rows, entity);
  const key = entity === "visitor" ? "visitorId" : "sessionId";
  let joined = builder.join(metrics, first, [
    { left: key, right: `first${key[0]!.toUpperCase()}${key.slice(1)}` },
  ]);
  joined = builder.join(joined, latest, [
    { left: key, right: `latest${key[0]!.toUpperCase()}${key.slice(1)}` },
  ]);
  joined = builder.join(joined, identity, [
    { left: key, right: "identityEntityId" },
  ]);
  joined = builder.join(
    joined,
    eventFacts,
    [{ left: key, right: "identity" }],
    "left",
  );
  if (entity === "visitor") return joined;
  const geo = validGeoMember(builder, rows);
  return builder.join(joined, geo, [{ left: key, right: "sessionId" }], "left");
}

function cursorPredicate(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  entity: ListEntity,
  sort: ListSort<VisitorListSortKey | SessionListSortKey>,
  cursor: VisitorListCursor | SessionListCursor | null | undefined,
): LogicalExpressionHandle | undefined {
  if (!cursor) return undefined;
  const primary =
    entity === "visitor"
      ? sort.key === "firstSeenAt"
        ? "firstSeenAt"
        : sort.key === "lastSeenAt"
          ? "lastSeenAt"
          : sort.key
      : sort.key === "durationMs"
        ? "totalDurationMs"
        : sort.key;
  const id = entity === "visitor" ? "visitorId" : "sessionId";
  const op = sort.direction === "asc" ? "gt" : "lt";
  const primaryValue = builder.slot(relation, primary);
  if (primaryValue.type.kind !== "scalar")
    throw new Error("journey_list_cursor_primary_non_scalar");
  const value = builder.literal(cursor.sortValue, primaryValue.type);
  const afterPrimary = builder.compare(op, primaryValue, value);
  const tied = builder.compare("eq", primaryValue, value);
  const afterId = builder.compare(
    "gt",
    builder.slot(relation, id),
    builder.literal(
      entity === "visitor"
        ? (cursor as VisitorListCursor).visitorId
        : (cursor as SessionListCursor).sessionId,
      STRING,
    ),
  );
  if (
    (entity === "visitor" && sort.key === "lastSeenAt") ||
    (entity === "session" && sort.key === "startedAt")
  )
    return builder.or(afterPrimary, builder.and(tied, afterId));
  const secondaryName = entity === "visitor" ? "lastSeenAt" : "startedAt";
  const secondaryValue =
    entity === "visitor"
      ? (cursor as VisitorListCursor).lastSeenAt
      : (cursor as SessionListCursor).startedAt;
  const secondary = builder.slot(relation, secondaryName);
  if (secondary.type.kind !== "scalar")
    throw new Error("journey_list_cursor_secondary_non_scalar");
  const secondaryCursor = builder.literal(
    secondaryValue ?? null,
    secondary.type,
  );
  return builder.or(
    afterPrimary,
    builder.and(
      tied,
      builder.or(
        builder.compare("lt", secondary, secondaryCursor),
        builder.and(builder.compare("eq", secondary, secondaryCursor), afterId),
      ),
    ),
  );
}

function sortedRows(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  entity: ListEntity,
  sort: ListSort<VisitorListSortKey | SessionListSortKey>,
): LogicalRelationHandle {
  const id = entity === "visitor" ? "visitorId" : "sessionId";
  const primary =
    entity === "visitor"
      ? sort.key
      : sort.key === "durationMs"
        ? "totalDurationMs"
        : sort.key;
  const keys = [
    { slot: primary, direction: sort.direction, nulls: "last" as const },
  ];
  if (
    (entity === "visitor" && sort.key !== "lastSeenAt") ||
    (entity === "session" && sort.key !== "startedAt")
  )
    keys.push({
      slot: entity === "visitor" ? "lastSeenAt" : "startedAt",
      direction: "desc",
      nulls: "last",
    });
  keys.push({ slot: id, direction: "asc", nulls: "last" });
  return builder.sort(relation, keys);
}

function appendVisitorOutput(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
): LogicalRelationHandle {
  const empty = builder.literal("", STRING);
  const f = (name: string) => builder.slot(relation, name);
  return builder.project(relation, {
    visitorId: f("visitorId"),
    sessionId: builder.coalesce(f("right.latestSessionId"), empty),
    userId: builder.coalesce(f("right.userId"), empty),
    userName: builder.coalesce(f("right.userName"), empty),
    firstSeenAt: f("firstSeenAt"),
    lastSeenAt: f("lastSeenAt"),
    views: f("views"),
    sessions: f("sessions"),
    events: builder.coalesce(f("right.events"), builder.literal(0, NUMBER)),
    country: builder.coalesce(f("right.latestCountry"), empty),
    region: builder.coalesce(f("right.latestRegion"), empty),
    regionCode: builder.coalesce(f("right.latestRegionCode"), empty),
    city: builder.coalesce(f("right.latestCity"), empty),
    referrerHost: builder.coalesce(f("right.firstReferrerHost"), empty),
    referrerUrl: builder.coalesce(f("right.firstReferrerUrl"), empty),
    browser: builder.coalesce(f("right.latestBrowser"), empty),
    browserVersion: builder.coalesce(
      f("right.latestBrowserMajorVersion"),
      empty,
    ),
    os: builder.coalesce(f("right.latestOs"), empty),
    osVersion: builder.coalesce(f("right.latestOsVersion"), empty),
    deviceType: builder.coalesce(f("right.latestDeviceType"), empty),
    screenWidth: f("right.latestScreenWidth"),
    screenHeight: f("right.latestScreenHeight"),
  });
}

function appendSessionOutput(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
): LogicalRelationHandle {
  const empty = builder.literal("", STRING);
  const f = (name: string) => builder.slot(relation, name);
  return builder.project(relation, {
    sessionId: f("sessionId"),
    visitorId: builder.coalesce(f("right.firstVisitorId"), empty),
    userId: builder.coalesce(f("right.userId"), empty),
    userName: builder.coalesce(f("right.userName"), empty),
    startedAt: f("startedAt"),
    endedAt: f("endedAt"),
    totalDurationMs: f("totalDurationMs"),
    active: f("active"),
    views: f("views"),
    events: builder.coalesce(f("right.events"), builder.literal(0, NUMBER)),
    bounce: builder.caseWhen(
      [
        {
          when: builder.compare("eq", f("views"), builder.literal(1, NUMBER)),
          then: builder.literal(1, NUMBER),
        },
      ],
      builder.literal(0, NUMBER),
    ),
    entryPath: builder.coalesce(f("right.firstPathname"), empty),
    exitPath: builder.coalesce(f("right.latestPathname"), empty),
    referrerHost: builder.coalesce(f("right.firstReferrerHost"), empty),
    referrerUrl: builder.coalesce(f("right.firstReferrerUrl"), empty),
    country: builder.coalesce(f("right.firstCountry"), empty),
    region: builder.coalesce(f("right.firstRegion"), empty),
    regionCode: builder.coalesce(f("right.firstRegionCode"), empty),
    city: builder.coalesce(f("right.firstCity"), empty),
    latitude: f("right.latitude"),
    longitude: f("right.longitude"),
    browser: builder.coalesce(f("right.firstBrowser"), empty),
    browserVersion: builder.coalesce(
      f("right.firstBrowserMajorVersion"),
      empty,
    ),
    os: builder.coalesce(f("right.firstOs"), empty),
    osVersion: builder.coalesce(f("right.firstOsVersion"), empty),
    deviceType: builder.coalesce(f("right.firstDeviceType"), empty),
    screenWidth: f("right.firstScreenWidth"),
    screenHeight: f("right.firstScreenHeight"),
  });
}

function appendListOutput(input: {
  readonly builder: LogicalPlanBuilder;
  readonly relation: LogicalRelationHandle;
  readonly entity: ListEntity;
  readonly limit: number;
  readonly sort: ListSort<VisitorListSortKey | SessionListSortKey>;
  readonly cursor?: VisitorListCursor | SessionListCursor | null;
}): LogicalRelationHandle {
  const cursor = cursorPredicate(
    input.builder,
    input.relation,
    input.entity,
    input.sort,
    input.cursor,
  );
  const afterCursor = cursor
    ? input.builder.filter(input.relation, cursor)
    : input.relation;
  const sorted = sortedRows(
    input.builder,
    afterCursor,
    input.entity,
    input.sort,
  );
  let limited = sorted;
  if (!Number.isInteger(input.limit) || input.limit >= -1)
    limited = input.builder.limit(sorted, input.limit + 1);
  const output =
    input.entity === "visitor"
      ? appendVisitorOutput(input.builder, limited)
      : appendSessionOutput(input.builder, limited);
  const fields = Object.keys(output.slots);
  input.builder.output(
    input.entity === "visitor"
      ? JOURNEY_VISITOR_LIST_REPORT_OUTPUT
      : JOURNEY_SESSION_LIST_REPORT_OUTPUT,
    output,
    fields.map((name) => ({ name, slot: name })),
  );
  return output;
}

function finishListPlan(input: {
  readonly builder: LogicalPlanBuilder;
  readonly relation: LogicalRelationHandle;
  readonly entity: ListEntity;
  readonly limit: number;
  readonly sort: ListSort<VisitorListSortKey | SessionListSortKey>;
  readonly cursor?: VisitorListCursor | SessionListCursor | null;
}): ValidatedLogicalPlan {
  appendListOutput(input);
  return input.builder.finish();
}

/** Appends the existing scoped Session list algorithm to a caller-owned builder. */
export function appendJourneySessionListReport(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
  readonly limit: number;
  readonly sort: ListSort<SessionListSortKey>;
  readonly search?: string;
  readonly cursor?: SessionListCursor | null;
  readonly sessionTarget?: CommonListInput["sessionTarget"];
  readonly suppressReportRows?: boolean;
}): LogicalRelationHandle {
  let rows = scopedObservationRows({
    builder: input.builder,
    pages: input.pages,
    events: input.events,
    entity: "session",
  });
  rows = applySessionTarget(
    input.builder,
    rows,
    "session",
    input.sessionTarget,
  );
  rows = searchScopedRows({
    builder: input.builder,
    rows,
    entity: "session",
    search: input.search,
  });
  const eligible = nonemptyEntityRows(input.builder, rows, "session");
  const facts = eventCounts(input.builder, input.events, "session");
  const joined = joinListFacts(input.builder, "session", eligible, facts);
  const reportRows = input.suppressReportRows
    ? input.builder.filter(joined, input.builder.literal(false, BOOLEAN))
    : joined;
  return appendListOutput({
    builder: input.builder,
    relation: reportRows,
    entity: "session",
    limit: input.limit,
    sort: input.sort,
    cursor: input.cursor,
  });
}

/** Appends the existing scoped Visitor list algorithm to a caller-owned builder. */
export function appendJourneyVisitorListReport(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
  readonly limit: number;
  readonly sort: ListSort<VisitorListSortKey>;
  readonly search?: string;
  readonly cursor?: VisitorListCursor | null;
  readonly suppressReportRows?: boolean;
}): LogicalRelationHandle {
  const rows = searchScopedRows({
    builder: input.builder,
    rows: scopedObservationRows({
      builder: input.builder,
      pages: input.pages,
      events: input.events,
      entity: "visitor",
    }),
    entity: "visitor",
    search: input.search,
  });
  const eligible = nonemptyEntityRows(input.builder, rows, "visitor");
  const facts = eventCounts(input.builder, input.events, "visitor");
  const joined = joinListFacts(input.builder, "visitor", eligible, facts);
  const reportRows = input.suppressReportRows
    ? input.builder.filter(joined, input.builder.literal(false, BOOLEAN))
    : joined;
  return appendListOutput({
    builder: input.builder,
    relation: reportRows,
    entity: "visitor",
    limit: input.limit,
    sort: input.sort,
    cursor: input.cursor,
  });
}

export function buildJourneyVisitorListReportPlan(
  input: VisitorListInput,
): ValidatedLogicalPlan {
  const sources = createJourneyListSources(input, "visitor");
  const selected = restrictAnalysis(sources, input, "visitor");
  if (sources.scoped) {
    appendJourneyVisitorListReport({
      builder: sources.builder,
      pages: selected.pages,
      events: selected.events,
      limit: input.limit,
      sort: input.sort,
      search: input.search,
      cursor: input.cursor,
    });
    return sources.builder.finish();
  }
  const events = selected.events;
  const pageBase = sources.pages;
  const filteredPage =
    input.filters.root === null
      ? pageBase
      : sources.builder.source("page", {
          temporalDomain: "candidate",
          attributes: JOURNEY_LIST_PAGE_ATTRIBUTES,
          selection: sources.pageSelection,
        });
  const qualifyingRows = projectPageObservationRows(
    sources.builder,
    filteredPage,
  );
  const expansionRows =
    input.filters.root !== null || Boolean(input.search?.trim())
      ? projectPageObservationRows(sources.builder, pageBase)
      : qualifyingRows;
  const rows = filteredRows({
    builder: sources.builder,
    qualifyingRows,
    expansionRows,
    entity: "visitor",
    filters: input.filters,
    search: input.search,
    targetApplied: false,
  });
  const eligible = nonemptyEntityRows(sources.builder, rows, "visitor");
  const facts = eventCounts(sources.builder, events, "visitor");
  const joined = joinListFacts(sources.builder, "visitor", eligible, facts);
  return finishListPlan({
    builder: sources.builder,
    relation: joined,
    entity: "visitor",
    limit: input.limit,
    sort: input.sort,
    cursor: input.cursor,
  });
}

export function buildJourneySessionListReportPlan(
  input: SessionListInput,
): ValidatedLogicalPlan {
  const sources = createJourneyListSources(
    input,
    "session",
    input.preparedPlanOperation,
  );
  const selected = restrictAnalysis(sources, input, "session");
  const events = selected.events;
  if (sources.scoped) {
    appendJourneySessionListReport({
      builder: sources.builder,
      pages: selected.pages,
      events,
      limit: input.limit,
      sort: input.sort,
      search: input.search,
      cursor: input.cursor,
      sessionTarget: input.sessionTarget,
    });
    return sources.builder.finish();
  }
  const pageBase = sources.pages;
  const filteredPage =
    input.filters.root === null
      ? pageBase
      : sources.builder.source("page", {
          temporalDomain: "candidate",
          attributes: JOURNEY_LIST_PAGE_ATTRIBUTES,
          selection: sources.pageSelection,
        });
  const targetedPage = applyPageTarget(
    sources.builder,
    filteredPage,
    input.sessionTarget,
  );
  const qualifyingRows = projectPageObservationRows(
    sources.builder,
    targetedPage,
  );
  const expansionRows =
    input.filters.root !== null || Boolean(input.search?.trim())
      ? projectPageObservationRows(sources.builder, pageBase)
      : qualifyingRows;
  const rows = filteredRows({
    builder: sources.builder,
    qualifyingRows,
    expansionRows,
    entity: "session",
    filters: input.filters,
    search: input.search,
    targetApplied: Boolean(input.sessionTarget),
  });
  const eligible = nonemptyEntityRows(sources.builder, rows, "session");
  const facts = eventCounts(sources.builder, events, "session");
  const joined = joinListFacts(sources.builder, "session", eligible, facts);
  return finishListPlan({
    builder: sources.builder,
    relation: joined,
    entity: "session",
    limit: input.limit,
    sort: input.sort,
    cursor: input.cursor,
  });
}
