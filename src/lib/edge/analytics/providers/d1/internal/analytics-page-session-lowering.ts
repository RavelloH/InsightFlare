import { compileD1Query, type CompiledQuery, lowerLogicalPlan } from "@/lib/db";
import { D1StatementBudgetError } from "@/lib/db/d1-budget";
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
  AggregateNode,
  LogicalNode,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalOutput,
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
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

import { nativePrimitiveFieldContract } from "./analytics-primitive-predicate-lowering";
import type {
  AnalyticsDbOutputColumn,
  AnalyticsLogicalToDbLowerer,
} from "./analytics-relational-lowering";
import {
  AnalyticsLogicalToDbLowerer as createAnalyticsLowerer,
  AnalyticsRelationalLoweringError,
} from "./analytics-relational-lowering";

export interface AnalyticsPageSessionLoweringInput {
  readonly document: unknown;
  readonly siteIds: readonly SiteId[];
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
  readonly reportingTimeZone: ReportingTimeZone;
  readonly capturedAtMs: EpochMs;
}

export interface AnalyticsSessionIdentityRow {
  readonly site_pk: number;
  readonly session_id: string;
}

export interface AnalyticsSessionCountRow {
  readonly sessions: number;
}

export interface AnalyticsSessionViewsRow {
  readonly views: number;
}

export interface AnalyticsSessionOverviewPairRow {
  readonly sessions: number;
  readonly views: number;
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

export type AnalyticsSessionCountLoweringResult =
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<AnalyticsSessionCountRow>;
    }
  | UnsupportedResult;

export type AnalyticsSessionViewsLoweringResult =
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<AnalyticsSessionViewsRow>;
    }
  | UnsupportedResult;

export type AnalyticsSessionOverviewPairLoweringResult =
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<AnalyticsSessionOverviewPairRow>;
    }
  | UnsupportedResult;

export interface AnalyticsSessionViewsExpectedContext {
  readonly siteId: string;
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
}

type UnsupportedResult = Extract<
  AnalyticsPageSessionLoweringResult,
  { readonly kind: "unsupported" }
>;

interface SessionPlanContext {
  readonly siteId: SiteId;
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
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

function compilationFailure(error: unknown): UnsupportedResult {
  if (error instanceof D1StatementBudgetError) {
    return unsupported(
      "d1-query-budget-exceeded",
      "compiled-query",
      (error.item === "sql_bytes" ? "SQL UTF-8 bytes" : "bound parameters") +
        ": " +
        error.actual +
        " (limit " +
        error.limit +
        "); the compiled query cannot be submitted to D1.",
    );
  }
  return unsupported(
    "generic-db-ir-lowering-failed",
    "generic-db-ir",
    error instanceof Error ? error.message : String(error),
  );
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

function planNodePath(id: RelationId): string {
  return "nodes[" + String(id) + "]";
}

function rangeIsSafe(range: TimeRange): boolean {
  return (
    Number.isSafeInteger(range.startMs) &&
    Number.isSafeInteger(range.endExclusiveMs) &&
    range.startMs < range.endExclusiveMs
  );
}

function matchPlanContext(plan: ValidatedLogicalPlan): SessionPlanContext {
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
    "Exactly one non-empty authorized site identity is required.",
  );
  requirePlan(
    context.time.filter === undefined &&
      context.time.read.kind === "bounded" &&
      rangeIsSafe(context.time.candidate) &&
      rangeIsSafe(context.time.read.range),
    "context.time",
    "Only bounded candidate/read domains are supported; a filter domain is not.",
  );
  return {
    siteId: context.subject.siteIds[0] as SiteId,
    candidateRange: context.time.candidate,
    readRange: context.time.read.range,
  };
}

function requireExpectedContext(
  context: SessionPlanContext,
  expected: AnalyticsSessionViewsExpectedContext,
): void {
  requirePlan(
    context.siteId === expected.siteId,
    "context.subject.siteIds[0]",
    "The plan site must match the caller-authorized site.",
  );
  requirePlan(
    context.candidateRange.startMs === expected.candidateRange.startMs &&
      context.candidateRange.endExclusiveMs ===
        expected.candidateRange.endExclusiveMs,
    "context.time.candidate",
    "The plan candidate range must match the caller-authorized range.",
  );
  requirePlan(
    context.readRange.startMs === expected.readRange.startMs &&
      context.readRange.endExclusiveMs === expected.readRange.endExclusiveMs,
    "context.time.read.range",
    "The plan read range must match the caller-authorized range.",
  );
}

function slotAt(plan: ValidatedLogicalPlan, slotId: SlotId, path: string) {
  const slot = plan.slots.find((candidate) => candidate.id === slotId);
  if (!slot) mismatch(path, "Slot " + String(slotId) + " is missing.");
  return slot;
}

function nodeAt(
  plan: ValidatedLogicalPlan,
  relationId: RelationId,
  path: string,
): LogicalNode {
  const node = plan.nodes.find((candidate) => candidate.id === relationId);
  if (!node) mismatch(path, "Relation " + String(relationId) + " is missing.");
  return node;
}

function validateProjectLineage(plan: ValidatedLogicalPlan): void {
  for (const node of plan.nodes) {
    if (node.kind !== "project") continue;
    requirePlan(
      node.output.length === node.projections.length &&
        node.projections.every(
          (projection, index) => node.output[index] === projection.slot,
        ),
      planNodePath(node.id),
      "Project outputs must match their projection slots in order.",
    );
    for (const [index, projection] of node.projections.entries()) {
      const outputSlot = slotAt(
        plan,
        projection.slot,
        planNodePath(node.id) + ".projections[" + index + "].slot",
      );
      if (projection.expression.kind === "slot") {
        requirePlan(
          outputSlot.lineage.kind === "alias" &&
            outputSlot.lineage.source === projection.expression.slot,
          planNodePath(node.id) + ".projections[" + index + "]",
          "A passthrough Project must preserve its declared source slot lineage.",
        );
      } else {
        requirePlan(
          outputSlot.lineage.kind === "derived" &&
            outputSlot.lineage.operation === projection.expression.kind,
          planNodePath(node.id) + ".projections[" + index + "]",
          "A computed Project must preserve its declared expression lineage.",
        );
      }
    }
  }
}

function requireMetricField(
  plan: ValidatedLogicalPlan,
  output: LogicalOutput,
  index: number,
  name: "sessions" | "views",
): SlotId {
  const field = output.fields[index];
  requirePlan(
    field !== undefined &&
      field.name === name &&
      field.semantic?.kind === "metric" &&
      field.semantic.id === name,
    "outputs.fields[" + index + "]",
    "Expected the " + name + " semantic metric output.",
  );
  const slot = slotAt(plan, field.slot, "outputs.fields[" + index + "].slot");
  requirePlan(
    slot.type.kind === "scalar" &&
      slot.type.scalar === "number" &&
      !slot.nullable,
    "outputs.fields[" + index + "].slot",
    "The " + name + " output must be a non-null numeric scalar.",
  );
  return field.slot;
}

function countRowsAggregateForOutput(
  plan: ValidatedLogicalPlan,
  outputSlot: SlotId,
  metric: "sessions" | "views",
): AggregateNode {
  const seen = new Set<SlotId>();
  let current: SlotId | undefined = outputSlot;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const slot = slotAt(plan, current, "outputs." + metric);
    if (
      slot.lineage.kind === "derived" &&
      slot.lineage.operation === "aggregate:count-rows"
    ) {
      const node = plan.nodes.find(
        (candidate) =>
          candidate.kind === "aggregate" && candidate.output.includes(current!),
      );
      if (!node || node.kind !== "aggregate")
        mismatch("outputs." + metric, "COUNT_ROWS aggregate node is missing.");
      requirePlan(
        node.groups.length === 0 &&
          node.measures.length === 1 &&
          node.measures[0]!.kind === "count-rows" &&
          node.measures[0]!.output === current &&
          node.output.length === 1 &&
          node.output[0] === current &&
          node.grain.kind === "scalar",
        planNodePath(node.id),
        "The " +
          metric +
          " output must trace to one ungrouped COUNT_ROWS aggregate.",
      );
      return node;
    }
    if (slot.lineage.kind === "alias") {
      current = slot.lineage.source;
      continue;
    }
    break;
  }
  mismatch(
    "outputs." + metric,
    "The " +
      metric +
      " output has no COUNT_ROWS aggregate in its alias lineage.",
  );
}

function requireCandidateSessionAggregateInput(
  plan: ValidatedLogicalPlan,
  lowerer: AnalyticsLogicalToDbLowerer,
  aggregateNode: AggregateNode,
  path: string,
): SlotId {
  const input = nodeAt(
    plan,
    aggregateNode.input,
    planNodePath(aggregateNode.id) + ".input",
  );
  requirePlan(
    input.output.length === 1 &&
      input.grain.kind === "entity" &&
      input.grain.entity === "session" &&
      input.grain.key === input.output[0],
    planNodePath(input.id),
    "The sessions aggregate must count one Session identity per input row.",
  );
  const sessionSlot = slotAt(
    plan,
    input.output[0]!,
    planNodePath(input.id) + ".output[0]",
  );
  requirePlan(
    sessionSlot.type.kind === "entity" &&
      sessionSlot.type.entity === "session" &&
      !sessionSlot.nullable &&
      lowerer.isCandidateBoundedSlot(input.id, sessionSlot.id),
    path,
    "The Session aggregate input must be a non-null candidate-bounded Session identity.",
  );
  return sessionSlot.id;
}

function hasRelationshipLineage(
  plan: ValidatedLogicalPlan,
  id: SlotId,
  relationship: "page.session",
): boolean {
  const seen = new Set<SlotId>();
  let current: SlotId | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const slot = plan.slots.find((candidate) => candidate.id === current);
    if (!slot) return false;
    if (
      slot.lineage.kind === "relationship" &&
      slot.lineage.relationship === relationship
    )
      return true;
    current = slot.lineage.kind === "alias" ? slot.lineage.source : undefined;
  }
  return false;
}

function requireCandidateViewsAggregateInput(
  plan: ValidatedLogicalPlan,
  lowerer: AnalyticsLogicalToDbLowerer,
  aggregateNode: AggregateNode,
): RelationId {
  const input = nodeAt(
    plan,
    aggregateNode.input,
    planNodePath(aggregateNode.id) + ".input",
  );
  requirePlan(
    input.grain.kind === "entity" &&
      input.grain.entity === "page" &&
      input.output.includes(input.grain.key),
    planNodePath(input.id),
    "The views aggregate must count candidate Page rows.",
  );
  const pageKey = slotAt(
    plan,
    input.grain.key,
    planNodePath(input.id) + ".grain.key",
  );
  requirePlan(
    pageKey.type.kind === "entity" &&
      pageKey.type.entity === "page" &&
      !pageKey.nullable,
    planNodePath(input.id),
    "The views aggregate must preserve a non-null Page identity.",
  );
  const sessionRelation = lowerer.candidateActivitySessionRelation(input.id);
  requirePlan(
    lowerer.candidateActivity(input.id) === "page" &&
      sessionRelation !== undefined &&
      lowerer.isCandidateActivitySessionRestricted(input.id) &&
      input.output.some((slot) =>
        hasRelationshipLineage(plan, slot, "page.session"),
      ),
    planNodePath(input.id),
    "Candidate Page rows must be restricted by a candidate-bounded page.session membership proof.",
  );
  return sessionRelation;
}

function lowerPlan<Row extends object>(
  input: LogicalPlan,
  capability: string,
  tag: string,
  expected: AnalyticsSessionViewsExpectedContext | undefined,
  selectColumns: (
    plan: ValidatedLogicalPlan,
    output: LogicalOutput,
    lowerer: AnalyticsLogicalToDbLowerer,
    lowered: ReturnType<AnalyticsLogicalToDbLowerer["lower"]>,
  ) => readonly AnalyticsDbOutputColumn[],
):
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<Row>;
    }
  | UnsupportedResult {
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

  let context: SessionPlanContext;
  let output: LogicalOutput;
  try {
    validateProjectLineage(logicalPlan);
    context = matchPlanContext(logicalPlan);
    if (expected) requireExpectedContext(context, expected);
    output = logicalPlan.outputs[0]!;
    requirePlan(output !== undefined, "outputs", "The output is missing.");
  } catch (error) {
    return unsupported(
      capability,
      error instanceof PlanShapeMismatch ? error.node : "context",
      error instanceof Error ? error.message : String(error),
    );
  }

  const lowerer = new createAnalyticsLowerer(logicalPlan, {
    siteId: context.siteId,
    time: logicalPlan.context.time,
  });
  let lowered: ReturnType<AnalyticsLogicalToDbLowerer["lower"]>;
  try {
    lowered = lowerer.lower(output);
  } catch (error) {
    return unsupported(
      capability,
      error instanceof AnalyticsRelationalLoweringError ? error.node : "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  let columns: readonly AnalyticsDbOutputColumn[];
  let relation;
  try {
    columns = selectColumns(logicalPlan, output, lowerer, lowered);
    relation = lowerer.projectOutput(lowered, columns);
  } catch (error) {
    if (error instanceof PlanShapeMismatch) {
      return unsupported(capability, error.node, error.message);
    }
    return unsupported(
      capability,
      error instanceof AnalyticsRelationalLoweringError
        ? error.node
        : "outputs",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const query = compileD1Query(lowerLogicalPlan(relation), {
      tag,
    }) as CompiledQuery<Row>;
    return { kind: "supported", logicalPlan, query };
  } catch (error) {
    return compilationFailure(error);
  }
}

/** Lowers a validated candidate-bounded Session identity output. */
export function lowerAnalyticsPagePathSessionPlan(
  input: LogicalPlan,
): AnalyticsPageSessionLoweringResult {
  return lowerPlan<AnalyticsSessionIdentityRow>(
    input,
    "session-boolean-plan-shape",
    "analytics.session-filter.wave-2",
    undefined,
    (plan, output, lowerer, lowered) => {
      requirePlan(
        output.id === "matches" &&
          output.fields.length === 1 &&
          output.fields[0]!.name === "entity" &&
          output.fields[0]!.semantic === undefined,
        "outputs",
        "Expected one matches.entity Session key output.",
      );
      const field = output.fields[0]!;
      const slot = slotAt(plan, field.slot, "outputs.fields[0].slot");
      requirePlan(
        slot.type.kind === "entity" &&
          slot.type.entity === "session" &&
          !slot.nullable,
        "outputs.fields[0].slot",
        "The output must be a non-null Session identity.",
      );
      if (
        !lowerer.isCandidateBoundedSlot(output.relation, slot.id) ||
        !lowered.candidateBounded
      ) {
        const relation = nodeAt(plan, output.relation, "outputs.relation");
        mismatch(
          relation.kind === "set-operation"
            ? planNodePath(relation.id)
            : "outputs.fields[0].slot",
          relation.kind === "set-operation"
            ? "The Session set is not proven to be a subset of the candidate Session universe."
            : "The output must be a candidate-bounded Session identity.",
        );
      }
      return [
        { name: "site_pk", slot: slot.id, component: 0 },
        { name: "session_id", slot: slot.id, component: 1 },
      ];
    },
  );
}

/** Lowers a COUNT_ROWS over a candidate-bounded Session relation. */
export function lowerAnalyticsFilteredSessionCountPlan(
  input: LogicalPlan,
): AnalyticsSessionCountLoweringResult {
  return lowerPlan<AnalyticsSessionCountRow>(
    input,
    "filtered-session-count-plan-shape",
    "analytics.filtered-session-count.wave-3",
    undefined,
    (plan, output, lowerer) => {
      requirePlan(
        output.id === "semantic-aggregate" && output.fields.length === 1,
        "outputs",
        "Expected the semantic-aggregate.sessions metric output only.",
      );
      const outputSlot = requireMetricField(plan, output, 0, "sessions");
      const aggregateNode = countRowsAggregateForOutput(
        plan,
        outputSlot,
        "sessions",
      );
      requireCandidateSessionAggregateInput(
        plan,
        lowerer,
        aggregateNode,
        planNodePath(aggregateNode.id) + ".input",
      );
      return [{ name: "sessions", slot: outputSlot }];
    },
  );
}

/** Counts candidate Pages whose page.session has candidate Session evidence. */
export function lowerAnalyticsFilteredSessionViewsPlan(
  input: LogicalPlan,
  expected: AnalyticsSessionViewsExpectedContext,
): AnalyticsSessionViewsLoweringResult {
  return lowerPlan<AnalyticsSessionViewsRow>(
    input,
    "filtered-session-views-plan-shape",
    "analytics.filtered-session-views.wave-4",
    expected,
    (plan, output, lowerer) => {
      requirePlan(
        output.id === "semantic-aggregate" && output.fields.length === 1,
        "outputs",
        "Expected the semantic-aggregate.views metric output only.",
      );
      const outputSlot = requireMetricField(plan, output, 0, "views");
      const aggregateNode = countRowsAggregateForOutput(
        plan,
        outputSlot,
        "views",
      );
      requireCandidateViewsAggregateInput(plan, lowerer, aggregateNode);
      return [{ name: "views", slot: outputSlot }];
    },
  );
}

/** Lowers sessions and views metrics over the same candidate Session relation. */
export function lowerAnalyticsFilteredSessionOverviewPairPlan(
  input: LogicalPlan,
  expected: AnalyticsSessionViewsExpectedContext,
): AnalyticsSessionOverviewPairLoweringResult {
  return lowerPlan<AnalyticsSessionOverviewPairRow>(
    input,
    "filtered-session-overview-pair-plan-shape",
    "analytics.filtered-session-overview-pair.wave-5",
    expected,
    (plan, output, lowerer) => {
      requirePlan(
        output.id === "semantic-aggregate" && output.fields.length === 2,
        "outputs",
        "Expected semantic-aggregate.sessions and semantic-aggregate.views outputs in order.",
      );
      const sessionsSlot = requireMetricField(plan, output, 0, "sessions");
      const viewsSlot = requireMetricField(plan, output, 1, "views");
      const sessionsAggregate = countRowsAggregateForOutput(
        plan,
        sessionsSlot,
        "sessions",
      );
      const viewsAggregate = countRowsAggregateForOutput(
        plan,
        viewsSlot,
        "views",
      );
      const sessionRelation = requireCandidateViewsAggregateInput(
        plan,
        lowerer,
        viewsAggregate,
      );
      requirePlan(
        sessionsAggregate.input === sessionRelation,
        planNodePath(sessionsAggregate.id) + ".input",
        "The sessions aggregate must consume the exact candidate Session relation that restricts the views Page rows.",
      );
      requireCandidateSessionAggregateInput(
        plan,
        lowerer,
        sessionsAggregate,
        planNodePath(sessionsAggregate.id) + ".input",
      );
      return [
        { name: "sessions", slot: sessionsSlot },
        { name: "views", slot: viewsSlot },
      ];
    },
  );
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validateSessionDocumentExpression(
  expression: unknown,
  path: string,
): UnsupportedResult | undefined {
  const record = recordOf(expression);
  if (!record) {
    return unsupported(
      "session-equality-leaf-only",
      path,
      "Expected a registered native Page/Event primitive condition.",
    );
  }

  if (record.kind === "condition") {
    const target = recordOf(record.target);
    const contract =
      target?.kind === "field" && typeof target.field === "string"
        ? nativePrimitiveFieldContract(target.field)
        : undefined;
    const validComparison =
      (record.operator === "eq" || record.operator === "neq") &&
      typeof record.value === "string";
    const validMembership =
      (record.operator === "in" || record.operator === "notIn") &&
      Array.isArray(record.value) &&
      record.value.length > 0 &&
      record.value.every((value) => typeof value === "string");
    const validNullTest =
      (record.operator === "isNull" || record.operator === "notNull") &&
      record.value === undefined;
    if (
      target?.kind !== "field" ||
      !contract ||
      (!validComparison && !validMembership && !validNullTest)
    ) {
      return unsupported(
        "session-equality-leaf-only",
        path,
        "Only registered native Page/Event eq/neq, in/notIn, isNull/notNull primitive conditions are supported.",
      );
    }
    return undefined;
  }

  if (record.kind === "not") {
    return validateSessionDocumentExpression(record.child, `${path}.child`);
  }

  if (record.kind === "and" || record.kind === "or") {
    if (!Array.isArray(record.children) || record.children.length < 2) {
      return unsupported(
        "session-boolean-shape",
        path,
        "AND and OR require at least two child expressions.",
      );
    }
    for (const [index, child] of record.children.entries()) {
      const unsupportedChild = validateSessionDocumentExpression(
        child,
        `${path}.children[${index}]`,
      );
      if (unsupportedChild) return unsupportedChild;
    }
    return undefined;
  }

  return unsupported(
    "session-boolean-shape",
    path,
    "Only AND, OR, NOT, and registered native Page/Event primitive conditions are supported.",
  );
}

function analyzeSessionFilterDocument(
  document: unknown,
):
  | { readonly kind: "supported"; readonly analysis: AnalyzedFilterDocument }
  | UnsupportedResult {
  let normalized: ReturnType<typeof normalizeFilterDocument>;
  try {
    normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
  } catch (error) {
    return unsupported(
      "valid-filter-document-required",
      "root",
      error instanceof Error ? error.message : String(error),
    );
  }

  const rawRoot = recordOf(document)?.root;
  if (rawRoot === null || rawRoot === undefined) {
    return unsupported(
      "session-equality-leaf-only",
      "empty-document",
      "A non-empty native Page/Event primitive expression is required.",
    );
  }
  const shapeIssue = validateSessionDocumentExpression(rawRoot, "root");
  if (shapeIssue) return shapeIssue;

  try {
    return {
      kind: "supported",
      analysis: analyzeFilterDocument(normalized, analyticsFilterRegistry),
    };
  } catch (error) {
    return unsupported(
      "valid-filter-document-required",
      "root",
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
      "Wave 2 requires exactly one authorized site identity.",
    );
  }

  const analyzed = analyzeSessionFilterDocument(input.document);
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
      "non-empty-session-filter-required",
      "root",
      "A supported non-empty native Page/Event primitive expression is required.",
    );
  }

  builder.output("matches", lowered.selection.relation, [
    { name: "entity", slot: "entity" },
  ]);
  return lowerAnalyticsPagePathSessionPlan(builder.finish());
}
