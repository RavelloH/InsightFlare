import {
  and,
  callFunction,
  compileD1Query,
  type CompiledQuery,
  eq,
  filter,
  gte,
  isNotNull,
  join,
  lowerLogicalPlan,
  lt,
  neq,
  param,
  project,
  scan,
  semiJoin,
  union,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
  TimeRange,
} from "@/lib/edge/analytics/contract/types";
import {
  LogicalPlanBuilder,
  lowerFilterDocumentToScope,
} from "@/lib/edge/analytics/engine";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type {
  LogicalNode,
  SourceNode,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalPlan,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type AnalyzedFilterDocument,
  analyzeFilterDocument,
} from "@/lib/filter-contract/filter-semantics";
import {
  type FilterCondition,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

export interface AnalyticsPageSessionLoweringInput {
  readonly document: unknown;
  readonly siteIds: readonly SiteId[];
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
  readonly reportingTimeZone: ReportingTimeZone;
  readonly capturedAtMs: EpochMs;
}

type PagePathEqualityCondition = FilterCondition & {
  readonly target: { readonly kind: "field"; readonly field: "page.path" };
  readonly operator: "eq";
  readonly value: string;
};

export interface AnalyticsSessionIdentityRow {
  readonly site_pk: number;
  readonly session_id: string;
}

export type AnalyticsPageSessionLoweringResult =
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<AnalyticsSessionIdentityRow>;
    }
  | {
      readonly kind: "unsupported";
      readonly capability: string;
      readonly node: string;
      readonly reason: string;
    };

type UnsupportedResult = Extract<
  AnalyticsPageSessionLoweringResult,
  { readonly kind: "unsupported" }
>;

interface PagePathSessionSemantics {
  readonly siteId: SiteId;
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
  readonly pagePath: string;
}

class PlanShapeMismatch extends Error {
  constructor(
    readonly node: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanShapeMismatch";
  }
}

function unsupported(
  capability: string,
  node: string,
  reason: string,
): UnsupportedResult {
  return { kind: "unsupported", capability, node, reason };
}

function mismatch(node: string, reason: string): never {
  throw new PlanShapeMismatch(node, reason);
}

function requirePlan(
  condition: unknown,
  node: string,
  reason: string,
): asserts condition {
  if (!condition) mismatch(node, reason);
}

function nodeAt<Kind extends LogicalNode["kind"]>(
  plan: ValidatedLogicalPlan,
  id: RelationId,
  kind: Kind,
  path: string,
): Extract<LogicalNode, { readonly kind: Kind }> {
  const node = plan.nodes.find((candidate) => candidate.id === id);
  if (!node || node.kind !== kind) {
    mismatch(path, `Expected a ${kind} node for relation ${String(id)}.`);
  }
  return node as Extract<LogicalNode, { readonly kind: Kind }>;
}

function slotAt(plan: ValidatedLogicalPlan, id: SlotId, path: string) {
  const slot = plan.slots.find((candidate) => candidate.id === id);
  if (!slot) mismatch(path, `Slot ${String(id)} is missing.`);
  return slot;
}

function sameSlots(left: readonly SlotId[], right: readonly SlotId[]): boolean {
  return (
    left.length === right.length &&
    left.every((slot, index) => slot === right[index])
  );
}

function rangeIsSafe(range: TimeRange): boolean {
  return (
    Number.isSafeInteger(range.startMs) &&
    Number.isSafeInteger(range.endExclusiveMs) &&
    range.startMs < range.endExclusiveMs
  );
}

function exactSourceBindings(
  plan: ValidatedLogicalPlan,
  source: SourceNode,
  path: string,
  expected: "page-path-read" | "candidate-observation",
): { readonly entity: SlotId; readonly value: SlotId } {
  requirePlan(
    source.entity === "observation",
    path,
    "Expected Observation source.",
  );
  requirePlan(source.values.length === 2, path, "Unexpected Source bindings.");
  const entityBindings = source.values.filter(
    (binding) => binding.kind === "self",
  );
  requirePlan(
    entityBindings.length === 1,
    path,
    "Expected one entity identity binding.",
  );
  const entity = entityBindings[0]!.slot;

  if (expected === "page-path-read") {
    const attributeBindings = source.values.filter(
      (binding) => binding.kind === "attribute",
    );
    requirePlan(
      attributeBindings.length === 1 &&
        attributeBindings[0]!.attribute === "page.path",
      path,
      "The read Source must expose only page.path.",
    );
    const value = attributeBindings[0]!.slot;
    const valueSlot = slotAt(plan, value, `${path}.page.path`);
    requirePlan(
      valueSlot.type.kind === "scalar" &&
        valueSlot.type.scalar === "string" &&
        valueSlot.nullable &&
        valueSlot.lineage.kind === "attribute" &&
        valueSlot.lineage.attribute === "page.path",
      `${path}.page.path`,
      "The page.path slot must be a nullable string attribute.",
    );
    requirePlan(
      sameSlots(source.output, [entity, value]) &&
        source.grain.kind === "entity" &&
        source.grain.entity === "observation" &&
        source.grain.key === entity,
      path,
      "The read Source output or grain is not the expected Observation shape.",
    );
    return { entity, value };
  }

  const relationshipBindings = source.values.filter(
    (binding) => binding.kind === "related-entity",
  );
  requirePlan(
    relationshipBindings.length === 1 &&
      relationshipBindings[0]!.relationship === "observation.session",
    path,
    "The candidate Source must expose observation.session.",
  );
  const value = relationshipBindings[0]!.slot;
  const valueSlot = slotAt(plan, value, `${path}.observation.session`);
  requirePlan(
    valueSlot.type.kind === "entity" &&
      valueSlot.type.entity === "session" &&
      valueSlot.nullable &&
      valueSlot.lineage.kind === "relationship" &&
      valueSlot.lineage.relationship === "observation.session",
    `${path}.observation.session`,
    "The candidate Session relationship must remain nullable.",
  );
  requirePlan(
    sameSlots(source.output, [entity, value]) &&
      source.grain.kind === "entity" &&
      source.grain.entity === "observation" &&
      source.grain.key === entity,
    path,
    "The candidate Source output or grain is not the expected Observation shape.",
  );
  return { entity, value };
}

function matchPagePathSessionPlan(
  plan: ValidatedLogicalPlan,
): PagePathSessionSemantics {
  requirePlan(
    plan.nodes.length === 10,
    "nodes",
    "Expected the ten-node Wave 0 plan.",
  );
  requirePlan(
    plan.slots.length === 12,
    "slots",
    "Unexpected Wave 0 slot schema.",
  );
  requirePlan(
    plan.outputs.length === 1,
    "outputs",
    "Expected one logical output.",
  );

  const context = plan.context;
  requirePlan(
    context.scope.requested === "session" &&
      context.scope.contractScope === "session" &&
      context.scope.logicalScope === "session",
    "context.scope",
    "Only the concrete Session scope is supported.",
  );
  requirePlan(
    context.subject.origin === "site" &&
      context.subject.siteIds.length === 1 &&
      typeof context.subject.siteIds[0] === "string" &&
      context.subject.siteIds[0]!.length > 0,
    "context.subject",
    "Exactly one non-empty site identity is required.",
  );
  requirePlan(
    context.time.read.kind === "bounded" &&
      rangeIsSafe(context.time.candidate) &&
      rangeIsSafe(context.time.read.range),
    "context.time",
    "Candidate and read domains must be bounded safe integer ranges.",
  );

  const output = plan.outputs[0]!;
  requirePlan(
    output.id === "matches" &&
      output.fields.length === 1 &&
      output.fields[0]!.name === "entity" &&
      output.fields[0]!.semantic === undefined,
    "outputs[0]",
    "Expected the unadorned Session entity output named matches.entity.",
  );
  const intersection = nodeAt(
    plan,
    output.relation,
    "set-operation",
    "outputs[0].relation",
  );
  requirePlan(
    intersection.operation === "intersect" && intersection.inputs.length === 2,
    `nodes[${String(intersection.id)}]`,
    "The root must intersect candidate and historical Session sets.",
  );

  const candidateSessions = nodeAt(
    plan,
    intersection.inputs[0]!,
    "distinct",
    `nodes[${String(intersection.id)}].inputs[0]`,
  );
  const historicSessions = nodeAt(
    plan,
    intersection.inputs[1]!,
    "distinct",
    `nodes[${String(intersection.id)}].inputs[1]`,
  );
  requirePlan(
    candidateSessions.excludeNull &&
      candidateSessions.keys.length === 1 &&
      candidateSessions.output.length === 1 &&
      candidateSessions.keys[0]!.output === candidateSessions.output[0],
    `nodes[${String(candidateSessions.id)}]`,
    "Candidate Session identities must be null-excluding and distinct.",
  );
  const candidateSource = nodeAt(
    plan,
    candidateSessions.input,
    "source",
    `nodes[${String(candidateSessions.id)}].input`,
  );
  requirePlan(
    candidateSource.temporalDomain === "candidate",
    `nodes[${String(candidateSource.id)}].temporalDomain`,
    "Candidate Observation activity must use the candidate time domain.",
  );
  const candidateBindings = exactSourceBindings(
    plan,
    candidateSource,
    `nodes[${String(candidateSource.id)}]`,
    "candidate-observation",
  );
  requirePlan(
    candidateSessions.keys[0]!.input === candidateBindings.value &&
      candidateSessions.grain.kind === "entity" &&
      candidateSessions.grain.entity === "session" &&
      candidateSessions.grain.key === candidateSessions.output[0],
    `nodes[${String(candidateSessions.id)}]`,
    "Candidate distinct must key the Session relationship slot.",
  );
  const candidateResultSlot = slotAt(
    plan,
    candidateSessions.output[0]!,
    `nodes[${String(candidateSessions.id)}].output`,
  );
  requirePlan(
    candidateResultSlot.type.kind === "entity" &&
      candidateResultSlot.type.entity === "session" &&
      !candidateResultSlot.nullable,
    `nodes[${String(candidateSessions.id)}].output`,
    "Candidate Session identities must be non-null after distinct.",
  );

  requirePlan(
    historicSessions.excludeNull &&
      historicSessions.keys.length === 1 &&
      historicSessions.output.length === 1 &&
      historicSessions.keys[0]!.output === historicSessions.output[0],
    `nodes[${String(historicSessions.id)}]`,
    "Historical Session identities must be null-excluding and distinct.",
  );
  const historicProjection = nodeAt(
    plan,
    historicSessions.input,
    "project",
    `nodes[${String(historicSessions.id)}].input`,
  );
  const relationship = nodeAt(
    plan,
    historicProjection.input,
    "relationship-lookup",
    `nodes[${String(historicProjection.id)}].input`,
  );
  requirePlan(
    relationship.relationship === "observation.session" &&
      relationship.timeSemantics === "identity-no-activity-filter",
    `nodes[${String(relationship.id)}]`,
    "Historical Session lookup must use observation.session identity semantics.",
  );
  const historicObservationDistinct = nodeAt(
    plan,
    relationship.input,
    "distinct",
    `nodes[${String(relationship.id)}].input`,
  );
  requirePlan(
    historicObservationDistinct.excludeNull &&
      historicObservationDistinct.keys.length === 1 &&
      historicObservationDistinct.output.length === 1,
    `nodes[${String(historicObservationDistinct.id)}]`,
    "Historical Page observations must be non-null and distinct before identity lookup.",
  );
  const historicObservationProjection = nodeAt(
    plan,
    historicObservationDistinct.input,
    "project",
    `nodes[${String(historicObservationDistinct.id)}].input`,
  );
  requirePlan(
    historicObservationDistinct.keys[0]!.input ===
      historicObservationProjection.output[0] &&
      historicObservationDistinct.keys[0]!.output ===
        historicObservationDistinct.output[0],
    `nodes[${String(historicObservationDistinct.id)}]`,
    "The historical Observation distinct must preserve its projected key.",
  );
  const pagePathFilter = nodeAt(
    plan,
    historicObservationProjection.input,
    "filter",
    `nodes[${String(historicObservationProjection.id)}].input`,
  );
  const readSource = nodeAt(
    plan,
    pagePathFilter.input,
    "source",
    `nodes[${String(pagePathFilter.id)}].input`,
  );
  requirePlan(
    readSource.temporalDomain === "read",
    `nodes[${String(readSource.id)}].temporalDomain`,
    "Historical Page evidence must use the read time domain.",
  );
  const readBindings = exactSourceBindings(
    plan,
    readSource,
    `nodes[${String(readSource.id)}]`,
    "page-path-read",
  );
  requirePlan(
    pagePathFilter.output.length === readSource.output.length &&
      pagePathFilter.output.every(
        (slot, index) => slot === readSource.output[index],
      ),
    `nodes[${String(pagePathFilter.id)}].output`,
    "The Filter must preserve its read Source bindings.",
  );
  const predicate = pagePathFilter.predicate;
  if (predicate.kind !== "comparison") {
    mismatch(
      `nodes[${String(pagePathFilter.id)}].predicate`,
      "Expected page.path eq <string> with trim normalization.",
    );
  }
  requirePlan(
    predicate.operator === "eq" &&
      predicate.stringNormalization === "trim" &&
      predicate.left.kind === "slot" &&
      predicate.left.slot === readBindings.value &&
      predicate.right.kind === "literal" &&
      typeof predicate.right.value === "string" &&
      predicate.right.valueType.kind === "scalar" &&
      predicate.right.valueType.scalar === "string",
    `nodes[${String(pagePathFilter.id)}].predicate`,
    "Expected page.path eq <string> with trim normalization.",
  );

  requirePlan(
    historicObservationProjection.projections.length === 1 &&
      historicObservationProjection.projections[0]!.expression.kind ===
        "slot" &&
      historicObservationProjection.projections[0]!.expression.slot ===
        readBindings.entity &&
      historicObservationProjection.output.length === 1 &&
      historicObservationProjection.output[0] ===
        historicObservationProjection.projections[0]!.slot &&
      historicObservationProjection.grain.kind === "entity" &&
      historicObservationProjection.grain.entity === "observation" &&
      historicObservationProjection.grain.key ===
        historicObservationProjection.output[0],
    `nodes[${String(historicObservationProjection.id)}]`,
    "The historical path match must project the Page Observation identity.",
  );
  const historicObservationSlot = historicObservationDistinct.keys[0]!.output;
  requirePlan(
    relationship.inputKey === historicObservationSlot &&
      historicObservationDistinct.grain.kind === "entity" &&
      historicObservationDistinct.grain.entity === "observation" &&
      historicObservationDistinct.grain.key === historicObservationSlot &&
      relationship.output.includes(relationship.inputKey) &&
      relationship.output.includes(relationship.relatedSlot),
    `nodes[${String(relationship.id)}]`,
    "The relationship lookup must attach Session identity to the matched Page key.",
  );
  requirePlan(
    historicProjection.projections.length === 2 &&
      historicProjection.projections[0]!.expression.kind === "slot" &&
      historicProjection.projections[0]!.expression.slot ===
        relationship.relatedSlot &&
      historicProjection.projections[1]!.expression.kind === "slot" &&
      historicProjection.projections[1]!.expression.slot ===
        relationship.inputKey &&
      historicProjection.output.length === 2 &&
      historicProjection.output[0] ===
        historicProjection.projections[0]!.slot &&
      historicProjection.output[1] ===
        historicProjection.projections[1]!.slot &&
      historicProjection.grain.kind === "entity" &&
      historicProjection.grain.entity === "observation" &&
      historicProjection.grain.key === historicProjection.output[1],
    `nodes[${String(historicProjection.id)}]`,
    "The historical projection must preserve Session and Page identity slots.",
  );
  requirePlan(
    historicSessions.keys[0]!.input === historicProjection.output[0] &&
      historicSessions.grain.kind === "entity" &&
      historicSessions.grain.entity === "session" &&
      historicSessions.grain.key === historicSessions.output[0],
    `nodes[${String(historicSessions.id)}]`,
    "Historical distinct must key the looked-up Session relationship.",
  );
  const historicResultSlot = slotAt(
    plan,
    historicSessions.output[0]!,
    `nodes[${String(historicSessions.id)}].output`,
  );
  requirePlan(
    historicResultSlot.type.kind === "entity" &&
      historicResultSlot.type.entity === "session" &&
      !historicResultSlot.nullable,
    `nodes[${String(historicSessions.id)}].output`,
    "Historical Session identities must be non-null after distinct.",
  );
  const outputSlot = slotAt(
    plan,
    intersection.output[0]!,
    "outputs[0].fields[0].slot",
  );
  requirePlan(
    sameSlots(intersection.output, [output.fields[0]!.slot]) &&
      intersection.grain.kind === "entity" &&
      intersection.grain.entity === "session" &&
      intersection.grain.key === output.fields[0]!.slot &&
      output.fields[0]!.slot === intersection.output[0] &&
      outputSlot.type.kind === "entity" &&
      outputSlot.type.entity === "session" &&
      outputSlot.nullable === false,
    "outputs[0].fields[0].slot",
    "The output must be the non-null Session key produced by the intersection.",
  );

  return {
    siteId: context.subject.siteIds[0] as SiteId,
    candidateRange: context.time.candidate,
    readRange: context.time.read.range,
    pagePath: predicate.right.value.trim(),
  };
}

function isPagePathEquality(
  analysis: AnalyzedFilterDocument,
): analysis is AnalyzedFilterDocument & {
  readonly document: {
    readonly version: 1;
    readonly root: PagePathEqualityCondition;
  };
} {
  const root = analysis.document.root;
  return (
    root?.kind === "condition" &&
    root.target.kind === "field" &&
    root.target.field === "page.path" &&
    root.operator === "eq" &&
    typeof root.value === "string"
  );
}

function analyzeExactPagePathDocument(
  document: unknown,
):
  | { readonly kind: "supported"; readonly analysis: AnalyzedFilterDocument }
  | UnsupportedResult {
  try {
    const normalized = normalizeFilterDocument(
      document,
      analyticsFilterRegistry,
    );
    const analysis = analyzeFilterDocument(normalized, analyticsFilterRegistry);
    if (!isPagePathEquality(analysis)) {
      return unsupported(
        "page-path-equality-only",
        analysis.document.root?.kind ?? "empty-document",
        "Wave 0 accepts only one root condition: page.path eq <string>.",
      );
    }
    return { kind: "supported", analysis };
  } catch (error) {
    return unsupported(
      "valid-filter-document-required",
      "root",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function compilePagePathSessionQuery(
  semantics: PagePathSessionSemantics,
): CompiledQuery<AnalyticsSessionIdentityRow> {
  const siteIdentitySource = scan(schema.site_identities);
  const selectedSite = filter(
    siteIdentitySource,
    eq(siteIdentitySource.columns.site_id, param(semantics.siteId)),
  );

  const candidatePagesSource = scan(schema.visits);
  const candidatePagesScoped = semiJoin(
    candidatePagesSource,
    selectedSite,
    eq(candidatePagesSource.columns.site_pk, selectedSite.columns.site_pk),
  );
  const candidatePagesInRange = filter(
    candidatePagesScoped,
    and(
      gte(
        candidatePagesScoped.columns.started_at,
        param(semantics.candidateRange.startMs),
      ),
      lt(
        candidatePagesScoped.columns.started_at,
        param(semantics.candidateRange.endExclusiveMs),
      ),
      isNotNull(candidatePagesScoped.columns.session_id),
      neq(candidatePagesScoped.columns.session_id, param("")),
    ),
  );
  const candidatePageSessions = project(candidatePagesInRange, {
    site_pk: candidatePagesInRange.columns.site_pk,
    session_id: candidatePagesInRange.columns.session_id,
  });

  const candidateEventsSource = scan(schema.custom_events);
  const candidateEventsScoped = semiJoin(
    candidateEventsSource,
    selectedSite,
    eq(candidateEventsSource.columns.site_pk, selectedSite.columns.site_pk),
  );
  const candidateEventsInRange = filter(
    candidateEventsScoped,
    and(
      gte(
        candidateEventsScoped.columns.occurred_at,
        param(semantics.candidateRange.startMs),
      ),
      lt(
        candidateEventsScoped.columns.occurred_at,
        param(semantics.candidateRange.endExclusiveMs),
      ),
    ),
  );
  const eventOwnerPages = scan(schema.visits);
  const candidateEventsWithOwner = join(
    candidateEventsInRange,
    eventOwnerPages,
    and(
      eq(
        candidateEventsInRange.columns.visit_id,
        eventOwnerPages.columns.visit_id,
      ),
      eq(
        candidateEventsInRange.columns.site_pk,
        eventOwnerPages.columns.site_pk,
      ),
    ),
  );
  const candidateEventsWithSession = filter(
    candidateEventsWithOwner,
    and(
      isNotNull(candidateEventsWithOwner.columns.right_session_id),
      neq(candidateEventsWithOwner.columns.right_session_id, param("")),
    ),
  );
  const candidateEventSessions = project(candidateEventsWithSession, {
    site_pk: candidateEventsWithSession.columns.left_site_pk,
    session_id: candidateEventsWithSession.columns.right_session_id,
  });

  // UNION (without ALL) deduplicates the composite identity across activities.
  const candidateSessions = union(
    candidatePageSessions,
    candidateEventSessions,
  );

  const readPagesSource = scan(schema.visits);
  const readPagesScoped = semiJoin(
    readPagesSource,
    selectedSite,
    eq(readPagesSource.columns.site_pk, selectedSite.columns.site_pk),
  );
  const readPagesMatching = filter(
    readPagesScoped,
    and(
      gte(
        readPagesScoped.columns.started_at,
        param(semantics.readRange.startMs),
      ),
      lt(
        readPagesScoped.columns.started_at,
        param(semantics.readRange.endExclusiveMs),
      ),
      isNotNull(readPagesScoped.columns.session_id),
      neq(readPagesScoped.columns.session_id, param("")),
      eq(
        callFunction("trim", readPagesScoped.columns.pathname),
        param(semantics.pagePath),
      ),
    ),
  );
  const readPageSessions = project(readPagesMatching, {
    site_pk: readPagesMatching.columns.site_pk,
    session_id: readPagesMatching.columns.session_id,
  });

  const matchingCandidateSessions = semiJoin(
    candidateSessions,
    readPageSessions,
    and(
      eq(candidateSessions.columns.site_pk, readPageSessions.columns.site_pk),
      eq(
        candidateSessions.columns.session_id,
        readPageSessions.columns.session_id,
      ),
    ),
  );
  return compileD1Query(lowerLogicalPlan(matchingCandidateSessions), {
    tag: "analytics.page-path-session.wave-0",
  });
}

/**
 * Lowers only the verified ten-node Session/page.path plan shape. The site,
 * time domains, path literal, set operation, and output key all come from the
 * supplied Analytics plan; unrelated or modified shapes produce no SQL.
 */
export function lowerAnalyticsPagePathSessionPlan(
  input: LogicalPlan,
): AnalyticsPageSessionLoweringResult {
  let logicalPlan: ValidatedLogicalPlan;
  try {
    logicalPlan = validateLogicalPlan(input);
  } catch (error) {
    return unsupported(
      "valid-analytics-plan-required",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  let semantics: PagePathSessionSemantics;
  try {
    semantics = matchPagePathSessionPlan(logicalPlan);
  } catch (error) {
    if (error instanceof PlanShapeMismatch) {
      return unsupported(
        "page-path-session-plan-shape",
        error.node,
        error.message,
      );
    }
    return unsupported(
      "page-path-session-plan-shape",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    return {
      kind: "supported",
      logicalPlan,
      query: compilePagePathSessionQuery(semantics),
    };
  } catch (error) {
    return unsupported(
      "generic-db-ir-lowering-failed",
      "generic-db-ir",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Build and validate one Analytics plan, then delegate all DB lowering to it. */
export function lowerAnalyticsPagePathToSessionQuery(
  input: AnalyticsPageSessionLoweringInput,
): AnalyticsPageSessionLoweringResult {
  if (!Array.isArray(input.siteIds) || input.siteIds.length !== 1) {
    return unsupported(
      "single-site-only",
      "context.subject",
      "Wave 0 requires exactly one authorized site identity.",
    );
  }

  const analyzed = analyzeExactPagePathDocument(input.document);
  if (analyzed.kind !== "supported") return analyzed;

  let builder: LogicalPlanBuilder;
  try {
    builder = new LogicalPlanBuilder({
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: input.siteIds,
      }),
      time: createSemanticTemporalDomains({
        candidate: input.candidateRange,
        read: { kind: "bounded", range: input.readRange },
        reportingTimeZone: input.reportingTimeZone,
        capturedAtMs: input.capturedAtMs,
      }),
      scope: resolveAnalyticsScope("session"),
    });
  } catch (error) {
    return unsupported(
      "bounded-single-site-context-required",
      "context",
      error instanceof Error ? error.message : String(error),
    );
  }

  const lowered = lowerFilterDocumentToScope(builder, analyzed.analysis, {
    targetScope: "session",
    resolveTemporalDomain: () => "read",
  });
  if (lowered.kind === "unsupported") {
    return unsupported(
      lowered.code,
      lowered.path,
      `${lowered.reason}${lowered.conditionTarget ? ` (${lowered.conditionTarget})` : ""}`,
    );
  }
  if (lowered.kind !== "supported") {
    return unsupported(
      "non-empty-page-path-filter-required",
      "root",
      "Wave 0 requires one supported page.path condition.",
    );
  }

  builder.output("matches", lowered.selection.relation, [
    { name: "entity", slot: "entity" },
  ]);
  return lowerAnalyticsPagePathSessionPlan(builder.finish());
}
