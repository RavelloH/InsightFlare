import {
  assertHistoricalFunnelConfigForAnalysis,
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  factEntityKindsForFilter,
  type FilterDocument,
  type FunnelConfigV2,
  parseFunnelStepFilter,
  type QueryWindow,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  type SiteId,
} from "@/lib/edge/analytics/contract";
import { planObservationFilter } from "@/lib/edge/analytics/contract/observation-planner";
import {
  type LogicalExpressionHandle,
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { appendQualifiedObservationMembership } from "@/lib/edge/analytics/engine/qualified-page-source";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import {
  createSemanticPostObservationFilter,
  createSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const BOOLEAN = { kind: "scalar", scalar: "boolean" } as const;

const PAGE_ATTRIBUTES = [
  "page.report.localId",
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.startedAt",
] as const;

const EVENT_ATTRIBUTES = [
  "event.report.localId",
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
  "event.report.occurredAt",
  "event.report.sequence",
] as const;

export const FUNNEL_PROGRESSION_REPORT_OUTPUT = "funnel-progression-counts";

export interface FunnelProgressionReportPlan {
  readonly plan: ValidatedLogicalPlan;
}

export interface FunnelProgressionSourceSelections {
  readonly page: SemanticScopedSourceSelection;
  readonly event: SemanticScopedSourceSelection;
  readonly filters: FilterDocument;
  readonly expectedPlan?: ScopedFilterPlan;
}

export function createFunnelProgressionSourceSelections(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly preparedPlanOperation?: "visitors" | "sessions" | "visitor-sessions";
  /** Request-private entity membership that replaces the legacy ID set. */
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
}): FunnelProgressionSourceSelections {
  const metadata = scopedFilterMetadata(input.filters);
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
  const filters = metadata ? input.filters : EMPTY_FILTER_DOCUMENT;
  const selectionInput = {
    filters,
    subject,
    time,
    ...(metadata ? { expectedPlan: metadata.plan } : {}),
    ...(metadata && input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
    ...(input.preparedPlanOperation
      ? { preparedPlanOperation: input.preparedPlanOperation }
      : {}),
  } as const;
  const profile = metadata
    ? ("prepared-scoped-reader-window-v1" as const)
    : undefined;

  return {
    filters,
    ...(metadata ? { expectedPlan: metadata.plan } : {}),
    page: createSemanticScopedSourceSelection({
      ...selectionInput,
      profile: profile ?? "direct-page-analytics-v1",
    }),
    event: createSemanticScopedSourceSelection({
      ...selectionInput,
      profile: profile ?? "direct-event-analytics-v1",
    }),
  };
}

function stepSelection(
  base: SemanticScopedSourceSelection,
  filters: FilterDocument,
  expectedPlan: ScopedFilterPlan | undefined,
  document: FilterDocument,
  predicate: ReturnType<typeof planObservationFilter>["visit"],
  preparedPlanOperation?: "visitors" | "sessions" | "visitor-sessions",
): SemanticScopedSourceSelection {
  if (predicate.kind !== "expression") return base;
  return createSemanticScopedSourceSelection({
    profile: base.profile,
    filters,
    subject: base.subject,
    time: base.time,
    ...(preparedPlanOperation ? { preparedPlanOperation } : {}),
    ...(expectedPlan ? { expectedPlan } : {}),
    ...(base.profile === "direct-page-entity-only-compat-v1"
      ? { compatibilityScope: base.entityKind! }
      : {}),
    postObservationFilter: createSemanticPostObservationFilter({
      filter: { ...document, root: predicate.expression },
    }),
  });
}

function nonemptyOrNull(
  builder: LogicalPlanBuilder,
  input: LogicalExpressionHandle,
): LogicalExpressionHandle {
  const nonempty = builder.and(
    builder.isNull(input, true),
    builder.compare(
      "neq",
      builder.normalizeString(input, "trim-ascii-space"),
      builder.literal("", STRING),
    ),
  );
  return builder.caseWhen(
    [{ when: nonempty, then: input }],
    builder.literal(null, STRING),
  );
}

function projectPageObservations(input: {
  readonly builder: LogicalPlanBuilder;
  readonly relation: LogicalRelationHandle;
  readonly scope: FunnelConfigV2["progressionScope"];
}): LogicalRelationHandle {
  const { builder, relation } = input;
  const sessionId = builder.slot(relation, "attribute:page.report.sessionId");
  const visitorId = builder.slot(relation, "attribute:page.report.visitorId");
  return builder.project(relation, {
    sessionId,
    visitorId,
    identity: input.scope === "session" ? sessionId : visitorId,
    observedAt: builder.slot(relation, "attribute:page.report.startedAt"),
    rank: builder.literal(0, NUMBER),
    sequence: builder.literal(0, NUMBER),
    sourceId: builder.slot(relation, "attribute:page.report.localId"),
  });
}

function projectEventObservations(input: {
  readonly builder: LogicalPlanBuilder;
  readonly relation: LogicalRelationHandle;
  readonly scope: FunnelConfigV2["progressionScope"];
}): LogicalRelationHandle {
  const { builder, relation } = input;
  const sessionId = builder.slot(
    relation,
    "attribute:event.report.ownerSessionId",
  );
  const visitorId = builder.slot(
    relation,
    "attribute:event.report.ownerVisitorId",
  );
  return builder.project(relation, {
    sessionId,
    visitorId,
    identity: input.scope === "session" ? sessionId : visitorId,
    observedAt: builder.slot(relation, "attribute:event.report.occurredAt"),
    rank: builder.literal(1, NUMBER),
    sequence: builder.slot(relation, "attribute:event.report.sequence"),
    sourceId: builder.slot(relation, "attribute:event.report.localId"),
  });
}

function emptyObservationRows(input: {
  readonly builder: LogicalPlanBuilder;
  readonly selection: SemanticScopedSourceSelection;
  readonly scope: FunnelConfigV2["progressionScope"];
}): LogicalRelationHandle {
  const pages = input.builder.source("page", {
    temporalDomain: "candidate",
    attributes: PAGE_ATTRIBUTES,
    selection: input.selection,
  });
  const empty = input.builder.filter(
    pages,
    input.builder.literal(false, BOOLEAN),
  );
  return projectPageObservations({
    builder: input.builder,
    relation: empty,
    scope: input.scope,
  });
}

function matchedObservations(input: {
  readonly builder: LogicalPlanBuilder;
  readonly pageRows?: LogicalRelationHandle;
  readonly eventRows?: LogicalRelationHandle;
}): LogicalRelationHandle {
  if (input.pageRows && input.eventRows)
    return input.builder.appendRows(
      [input.pageRows, input.eventRows],
      [
        "sessionId",
        "visitorId",
        "identity",
        "observedAt",
        "rank",
        "sequence",
        "sourceId",
      ],
    );
  if (input.pageRows) return input.pageRows;
  if (input.eventRows) return input.eventRows;
  throw new Error("funnel_observation_rows_missing");
}

function validWitnesses(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
): LogicalRelationHandle {
  const identity = builder.slot(relation, "identity");
  const sourceId = builder.slot(relation, "sourceId");
  return builder.filter(
    relation,
    builder.and(
      builder.isNull(builder.slot(relation, "observedAt"), true),
      builder.isNull(identity, true),
      builder.compare(
        "neq",
        builder.normalizeString(identity, "trim-ascii-space"),
        builder.literal("", STRING),
      ),
      builder.isNull(sourceId, true),
      builder.compare(
        "neq",
        builder.normalizeString(sourceId, "trim-ascii-space"),
        builder.literal("", STRING),
      ),
    ),
  );
}

function earliestSourceWitness(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
): LogicalRelationHandle {
  return builder.orderedMember(relation, {
    groups: ["rank", "sourceId"],
    order: [
      { slot: "observedAt", direction: "asc", nulls: "last" },
      { slot: "rank", direction: "asc", nulls: "last" },
      { slot: "sequence", direction: "asc", nulls: "last" },
      { slot: "sourceId", direction: "asc", nulls: "last" },
    ],
  });
}

function observationAfter(
  builder: LogicalPlanBuilder,
  joined: LogicalRelationHandle,
): LogicalExpressionHandle {
  const candidateTime = builder.slot(joined, "observedAt");
  const previousTime = builder.slot(joined, "right.observedAt");
  const candidateRank = builder.slot(joined, "rank");
  const previousRank = builder.slot(joined, "right.rank");
  const candidateSequence = builder.slot(joined, "sequence");
  const previousSequence = builder.slot(joined, "right.sequence");
  const candidateId = builder.slot(joined, "sourceId");
  const previousId = builder.slot(joined, "right.sourceId");
  return builder.or(
    builder.compare("gt", candidateTime, previousTime),
    builder.and(
      builder.compare("eq", candidateTime, previousTime),
      builder.or(
        builder.compare("gt", candidateRank, previousRank),
        builder.and(
          builder.compare("eq", candidateRank, previousRank),
          builder.or(
            builder.compare("gt", candidateSequence, previousSequence),
            builder.and(
              builder.compare("eq", candidateSequence, previousSequence),
              builder.compare("gt", candidateId, previousId),
            ),
          ),
        ),
      ),
    ),
  );
}

function firstReached(input: {
  readonly builder: LogicalPlanBuilder;
  readonly witness: LogicalRelationHandle;
  readonly scope: FunnelConfigV2["progressionScope"];
  readonly conversionWindowMs: number | null;
}): LogicalRelationHandle {
  const { builder, witness } = input;
  const firstTime = builder.slot(witness, "observedAt");
  const first = builder.project(witness, {
    sessionId: builder.slot(witness, "sessionId"),
    visitorId: builder.slot(witness, "visitorId"),
    identity: builder.slot(witness, "identity"),
    firstTime,
    ...(input.scope === "visitor"
      ? {
          conversionBoundary: builder.arithmetic(
            "add",
            firstTime,
            builder.elapsedDuration(input.conversionWindowMs!, "ms"),
          ),
        }
      : {}),
    observedAt: firstTime,
    rank: builder.slot(witness, "rank"),
    sequence: builder.slot(witness, "sequence"),
    sourceId: builder.slot(witness, "sourceId"),
  });
  return builder.orderedMember(first, {
    groups: ["identity"],
    order: [
      { slot: "observedAt", direction: "asc", nulls: "last" },
      { slot: "rank", direction: "asc", nulls: "last" },
      { slot: "sequence", direction: "asc", nulls: "last" },
      { slot: "sourceId", direction: "asc", nulls: "last" },
    ],
  });
}

function nextReached(input: {
  readonly builder: LogicalPlanBuilder;
  readonly candidates: LogicalRelationHandle;
  readonly previous: LogicalRelationHandle;
  readonly scope: FunnelConfigV2["progressionScope"];
}): LogicalRelationHandle {
  const { builder, candidates, previous } = input;
  const joined = builder.join(candidates, previous, [
    { left: "identity", right: "identity" },
  ]);
  const predicates = [observationAfter(builder, joined)];
  if (input.scope === "visitor")
    predicates.push(
      builder.compare(
        "lte",
        builder.slot(joined, "observedAt"),
        builder.slot(joined, "right.conversionBoundary"),
      ),
    );
  const eligible = builder.filter(joined, builder.and(...predicates));
  const projected = builder.project(eligible, {
    sessionId: builder.slot(eligible, "right.sessionId"),
    visitorId: builder.slot(eligible, "right.visitorId"),
    identity: builder.slot(eligible, "right.identity"),
    firstTime: builder.slot(eligible, "right.firstTime"),
    ...(input.scope === "visitor"
      ? {
          conversionBoundary: builder.slot(
            eligible,
            "right.conversionBoundary",
          ),
        }
      : {}),
    observedAt: builder.slot(eligible, "observedAt"),
    rank: builder.slot(eligible, "rank"),
    sequence: builder.slot(eligible, "sequence"),
    sourceId: builder.slot(eligible, "sourceId"),
  });
  return builder.orderedMember(projected, {
    groups: ["identity"],
    order: [
      { slot: "observedAt", direction: "asc", nulls: "last" },
      { slot: "rank", direction: "asc", nulls: "last" },
      { slot: "sequence", direction: "asc", nulls: "last" },
      { slot: "sourceId", direction: "asc", nulls: "last" },
    ],
  });
}

function countRows(input: {
  readonly builder: LogicalPlanBuilder;
  readonly matched: readonly LogicalRelationHandle[];
  readonly reached: readonly LogicalRelationHandle[];
}): LogicalRelationHandle {
  const { builder } = input;
  const first = builder.project(input.matched[0]!, {
    stepIndex: builder.literal(0, NUMBER),
    sessionId: nonemptyOrNull(
      builder,
      builder.slot(input.matched[0]!, "sessionId"),
    ),
    visitorId: nonemptyOrNull(
      builder,
      builder.slot(input.matched[0]!, "visitorId"),
    ),
  });
  const rows = [
    first,
    ...input.reached.slice(1).map((relation, index) =>
      builder.project(relation, {
        stepIndex: builder.literal(index + 1, NUMBER),
        sessionId: nonemptyOrNull(builder, builder.slot(relation, "sessionId")),
        visitorId: nonemptyOrNull(builder, builder.slot(relation, "visitorId")),
      }),
    ),
  ];
  let combined = rows[0]!;
  for (const relation of rows.slice(1))
    combined = builder.appendRows(
      [combined, relation],
      ["stepIndex", "sessionId", "visitorId"],
    );
  return builder.aggregate(
    combined,
    { stepIndex: builder.slot(combined, "stepIndex") },
    [
      {
        name: "sessions",
        kind: "count-distinct",
        expression: builder.slot(combined, "sessionId"),
      },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: builder.slot(combined, "visitorId"),
      },
    ],
  );
}

export interface FunnelProgressionRelations {
  readonly matchedSteps: readonly LogicalRelationHandle[];
  readonly reachedSteps: readonly LogicalRelationHandle[];
  readonly firstStepPages?: LogicalRelationHandle;
  readonly firstStepEvents?: LogicalRelationHandle;
}

export interface AppendFunnelProgressionRelationsInput {
  readonly builder: LogicalPlanBuilder;
  readonly sources: FunnelProgressionSourceSelections;
  readonly config: FunnelConfigV2;
  readonly qualificationMembership?: {
    readonly matches: LogicalRelationHandle;
    readonly siteId: string;
    readonly countScope: "session" | "visitor";
  };
  readonly preparedPlanOperation?: "visitors" | "sessions" | "visitor-sessions";
  /** Omit for only the first matched bag; otherwise build the reached prefix. */
  readonly throughStepIndex?: number;
}

function assertProgressionBuilderContext(
  builder: LogicalPlanBuilder,
  sources: FunnelProgressionSourceSelections,
): void {
  const { page, event } = sources;
  const siteId = page.subject.siteIds[0];
  if (
    page.subject.origin !== "site" ||
    page.subject.siteIds.length !== 1 ||
    !siteId ||
    event.subject.origin !== "site" ||
    event.subject.siteIds.length !== 1 ||
    event.subject.siteIds[0] !== siteId ||
    !page.authorizedSiteIds.includes(siteId) ||
    !event.authorizedSiteIds.includes(siteId)
  )
    throw new Error("funnel_progression_single_site_required");

  const sameSourceContext =
    JSON.stringify(page.subject) === JSON.stringify(event.subject) &&
    JSON.stringify(page.time) === JSON.stringify(event.time) &&
    JSON.stringify(page.filter) === JSON.stringify(event.filter) &&
    JSON.stringify(page.preparedMatches) ===
      JSON.stringify(event.preparedMatches) &&
    JSON.stringify(page.eventNameGate) ===
      JSON.stringify(event.eventNameGate) &&
    JSON.stringify(page.preparationTime) ===
      JSON.stringify(event.preparationTime) &&
    page.scope === event.scope &&
    page.mode === event.mode &&
    page.entityKind === event.entityKind &&
    JSON.stringify(page.authorizedSiteIds) ===
      JSON.stringify(event.authorizedSiteIds) &&
    JSON.stringify(
      normalizeFilterDocument(sources.filters, analyticsFilterRegistry),
    ) === JSON.stringify(page.filter) &&
    page.postObservationFilter === undefined &&
    event.postObservationFilter === undefined &&
    sources.expectedPlan === scopedFilterMetadata(sources.filters)?.plan;
  const expectedPageProfile = sources.expectedPlan
    ? "prepared-scoped-reader-window-v1"
    : "direct-page-analytics-v1";
  const expectedEventProfile = sources.expectedPlan
    ? "prepared-scoped-reader-window-v1"
    : "direct-event-analytics-v1";
  const standardSourceProfilesMatch =
    page.profile === expectedPageProfile &&
    event.profile === expectedEventProfile;
  const journeyCompatibilityProfilesMatch =
    !sources.expectedPlan &&
    sources.filters.root !== null &&
    factEntityKindsForFilter(sources.filters.root).size === 0 &&
    page.profile === "direct-page-entity-only-compat-v1" &&
    event.profile === "direct-page-entity-only-compat-v1" &&
    page.mode === "entity" &&
    event.mode === "entity" &&
    (page.scope === "session" || page.scope === "visitor") &&
    page.scope === event.scope &&
    page.entityKind === page.scope &&
    event.entityKind === event.scope &&
    JSON.stringify(page.authorizedSiteIds) === JSON.stringify([siteId]) &&
    JSON.stringify(event.authorizedSiteIds) === JSON.stringify([siteId]);
  const sourceProfilesMatch =
    standardSourceProfilesMatch || journeyCompatibilityProfilesMatch;
  const sameBuilderContext =
    JSON.stringify(builder.context.subject) === JSON.stringify(page.subject) &&
    JSON.stringify(builder.context.time) === JSON.stringify(page.time) &&
    JSON.stringify(builder.context.scope) ===
      JSON.stringify(resolveAnalyticsScope(page.scope));
  if (!sameSourceContext || !sourceProfilesMatch || !sameBuilderContext)
    throw new Error("funnel_progression_builder_context_mismatch");
}

/** Append a requested matched/reached prefix to the caller-owned Logical builder. */
export function appendFunnelProgressionRelations(
  input: AppendFunnelProgressionRelationsInput,
): FunnelProgressionRelations {
  assertHistoricalFunnelConfigForAnalysis(input.config);
  assertProgressionBuilderContext(input.builder, input.sources);
  const lastStepIndex = input.throughStepIndex ?? 0;
  if (
    input.throughStepIndex !== undefined &&
    (!Number.isSafeInteger(input.throughStepIndex) ||
      input.throughStepIndex < 0 ||
      input.throughStepIndex >= input.config.steps.length)
  )
    throw new Error("funnel_step_not_found");

  const { builder, sources, config } = input;
  const matchedSteps: LogicalRelationHandle[] = [];
  const witnessRelations: LogicalRelationHandle[] = [];
  let firstStepPages: LogicalRelationHandle | undefined;
  let firstStepEvents: LogicalRelationHandle | undefined;
  let emptyRows: LogicalRelationHandle | undefined;

  for (let index = 0; index <= lastStepIndex; index += 1) {
    const step = config.steps[index]!;
    const document = parseFunnelStepFilter(step);
    const applicability = planObservationFilter(document.root);
    let pageRows: LogicalRelationHandle | undefined;
    let eventRows: LogicalRelationHandle | undefined;

    if (applicability.visit.kind !== "none") {
      const selection = stepSelection(
        sources.page,
        sources.filters,
        sources.expectedPlan,
        document,
        applicability.visit,
        input.preparedPlanOperation,
      );
      const pages = builder.source("page", {
        temporalDomain: "candidate",
        attributes: PAGE_ATTRIBUTES,
        selection,
      });
      const qualifiedPages = input.qualificationMembership
        ? appendQualifiedObservationMembership({
            builder,
            observations: pages,
            matches: input.qualificationMembership.matches,
            siteId: input.qualificationMembership.siteId,
            ownerAttribute:
              input.qualificationMembership.countScope === "session"
                ? "page.report.sessionId"
                : "page.report.visitorId",
          })
        : pages;
      pageRows = projectPageObservations({
        builder,
        relation: qualifiedPages,
        scope: config.progressionScope,
      });
    }

    if (applicability.event.kind !== "none") {
      const selection = stepSelection(
        sources.event,
        sources.filters,
        sources.expectedPlan,
        document,
        applicability.event,
        input.preparedPlanOperation,
      );
      const events = builder.source("event", {
        temporalDomain: "candidate",
        attributes: EVENT_ATTRIBUTES,
        selection,
      });
      const qualifiedEvents = input.qualificationMembership
        ? appendQualifiedObservationMembership({
            builder,
            observations: events,
            matches: input.qualificationMembership.matches,
            siteId: input.qualificationMembership.siteId,
            ownerAttribute:
              input.qualificationMembership.countScope === "session"
                ? "event.report.ownerSessionId"
                : "event.report.ownerVisitorId",
          })
        : events;
      eventRows = projectEventObservations({
        builder,
        relation: qualifiedEvents,
        scope: config.progressionScope,
      });
    }

    if (index === 0) {
      firstStepPages = pageRows;
      firstStepEvents = eventRows;
    }
    const stepRows =
      pageRows || eventRows
        ? matchedObservations({ builder, pageRows, eventRows })
        : (emptyRows ??= emptyObservationRows({
            builder,
            selection: sources.page,
            scope: config.progressionScope,
          }));
    matchedSteps.push(stepRows);
    if (input.throughStepIndex !== undefined)
      witnessRelations.push(
        earliestSourceWitness(builder, validWitnesses(builder, stepRows)),
      );
  }

  const reachedSteps: LogicalRelationHandle[] = [];
  if (input.throughStepIndex !== undefined) {
    reachedSteps.push(
      firstReached({
        builder,
        witness: witnessRelations[0]!,
        scope: config.progressionScope,
        conversionWindowMs: config.conversionWindowMs,
      }),
    );
    for (const witness of witnessRelations.slice(1))
      reachedSteps.push(
        nextReached({
          builder,
          candidates: witness,
          previous: reachedSteps.at(-1)!,
          scope: config.progressionScope,
        }),
      );
  }

  return {
    matchedSteps,
    reachedSteps,
    ...(firstStepPages ? { firstStepPages } : {}),
    ...(firstStepEvents ? { firstStepEvents } : {}),
  };
}

export function buildFunnelProgressionReportPlan(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly config: FunnelConfigV2;
}): FunnelProgressionReportPlan {
  assertHistoricalFunnelConfigForAnalysis(input.config);
  const metadata = scopedFilterMetadata(input.filters);
  // An unprepared funnel historically runs over the canonical empty filter,
  // even if a caller supplied a non-empty document without prepared metadata.
  const filters = metadata ? input.filters : EMPTY_FILTER_DOCUMENT;
  const sources = createFunnelProgressionSourceSelections({
    siteId: input.siteId,
    window: input.window,
    filters,
  });
  const time = sources.page.time;
  const subject = sources.page.subject;
  const builder = new LogicalPlanBuilder({
    subject,
    time,
    scope: resolveAnalyticsScope(metadata?.plan.scope ?? "event"),
    originOperation: "funnel-analysis",
  });

  const progression = appendFunnelProgressionRelations({
    builder,
    sources,
    config: input.config,
    ...(input.config.steps.length > 1
      ? { throughStepIndex: input.config.steps.length - 1 }
      : {}),
  });
  const counts = countRows({
    builder,
    matched: progression.matchedSteps,
    reached: progression.reachedSteps,
  });
  builder.output(FUNNEL_PROGRESSION_REPORT_OUTPUT, counts, [
    { name: "stepIndex", slot: "stepIndex" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);

  return {
    plan: builder.finish(),
  };
}

/**
 * Build the legacy Goal/Funnel base for Journey list analysis. Unlike the
 * standalone Funnel report, an unprepared nonempty no-fact filter is part of
 * the selected base and has the historical empty Event output domain.
 */
export function createJourneyFunnelProgressionSourceSelections(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly entityScope: "session" | "visitor";
  readonly preparedPlanOperation?: "visitors" | "sessions" | "visitor-sessions";
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
}): FunnelProgressionSourceSelections {
  const metadata = scopedFilterMetadata(input.filters);
  const preparedPlanOperation =
    input.preparedPlanOperation ??
    (input.entityScope === "visitor" ? "visitors" : "sessions");
  if (metadata || input.filters.root === null)
    return createFunnelProgressionSourceSelections({
      ...input,
      preparedPlanOperation,
    });

  const queryTime = createQueryTime(
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    input.window.nowMs,
  );
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [input.siteId as SiteId],
  });
  const time = semanticTemporalDomainsFromQueryTime(queryTime);
  if (factEntityKindsForFilter(input.filters.root).size === 0) {
    const selection = {
      profile: "direct-page-entity-only-compat-v1" as const,
      filters: input.filters,
      subject,
      time,
      compatibilityScope: input.entityScope,
    };
    return {
      filters: input.filters,
      page: createSemanticScopedSourceSelection(selection),
      event: createSemanticScopedSourceSelection(selection),
    };
  }

  const plan = createScopedFilterPlan(
    "goal-summary",
    input.filters,
    input.entityScope,
  );
  if (!plan) throw new Error("journey_analysis_scope_unavailable");
  const scopedFilters = attachScopedFilterMetadata(input.filters, {
    requestedScope: input.entityScope,
    resolvedScope: plan.scope,
    plan,
    time: queryTime,
    siteIds: [input.siteId],
  });
  return createFunnelProgressionSourceSelections({
    siteId: input.siteId,
    window: input.window,
    filters: scopedFilters,
    preparedPlanOperation,
  });
}
