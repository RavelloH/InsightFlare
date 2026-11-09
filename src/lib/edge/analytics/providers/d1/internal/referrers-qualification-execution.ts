import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  type ScopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";
import type {
  LogicalNode,
  SourceNode,
} from "@/lib/edge/analytics/engine/logical/nodes";
import {
  snapshotLogicalPlan,
  type ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { assertNever } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { buildReferrerSummaryPlan } from "@/lib/edge/analytics/engine/referrer-report-plan";
import { EVENT_FILTER_PAGE_VISIT_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

import type { AnalyticsDbRelation } from "./analytics-relational-storage";
import {
  createQualificationExecutionInputsForTrustedPlan,
  type QualificationExecutionInputs,
} from "./qualification-execution-inputs";

interface QualificationPreparationState {
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly time: SemanticTemporalDomains;
  readonly metadata: ScopedFilterMetadata;
  readonly topN: number;
  readonly relation: AnalyticsDbRelation;
  bound: boolean;
}

declare const referrersQualificationPreparationBrand: unique symbol;

export type ReferrersSummaryQualificationPreparation = Readonly<{
  readonly [referrersQualificationPreparationBrand]: true;
}>;

const preparationStates = new WeakMap<object, QualificationPreparationState>();

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotQueryTime(time: QueryTime): QueryTime {
  return deepFreeze(JSON.parse(JSON.stringify(time)) as QueryTime);
}

function logicalNodeInputs(node: LogicalNode): readonly RelationId[] {
  switch (node.kind) {
    case "source":
    case "analysis-result":
      return [];
    case "relationship-lookup":
    case "filter":
    case "event-payload-occurrences":
    case "event-payload-properties":
    case "project":
    case "aggregate":
    case "sample-statistics":
    case "distinct":
    case "ordered-member":
    case "ranked-members":
    case "sort":
    case "limit":
      return [node.input];
    case "set-operation":
    case "row-concatenation":
      return node.inputs;
    case "semi-join":
    case "anti-join":
    case "join":
      return [node.left, node.right];
  }
  return assertNever(node);
}

function sourceReachesOutput(
  plan: ValidatedLogicalPlan,
  source: SourceNode,
  outputRelationId: RelationId,
): boolean {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node] as const));
  const pending = [outputRelationId];
  const seen = new Set<RelationId>();
  while (pending.length > 0) {
    const relationId = pending.pop()!;
    if (relationId === source.id) return true;
    if (seen.has(relationId)) continue;
    seen.add(relationId);
    const node = nodes.get(relationId);
    if (!node) return false;
    pending.push(...logicalNodeInputs(node));
  }
  return false;
}

function sourceAttributes(source: SourceNode): string[] {
  return source.values
    .filter((binding) => binding.kind === "attribute")
    .map((binding) => binding.attribute)
    .sort();
}

function assertReferrerSummaryPlan(
  plan: ValidatedLogicalPlan,
  input: {
    readonly siteId: string;
    readonly filters: FilterDocument;
    readonly time: SemanticTemporalDomains;
  },
): void {
  if (
    !Object.isFrozen(plan) ||
    plan.context.scope.requested !== "event" ||
    plan.context.scope.contractScope !== "event" ||
    plan.context.scope.logicalScope !== "observation" ||
    plan.context.subject.origin !== "site" ||
    plan.context.subject.siteIds.length !== 1 ||
    plan.context.subject.siteIds[0] !== input.siteId ||
    !sameJsonValue(plan.context.time, input.time)
  )
    throw new Error("qualification_execution_plan_context_mismatch");

  const expectedOutputIds = ["referrer-summary", "referrer-top-sources"];
  if (
    plan.outputs.length !== expectedOutputIds.length ||
    expectedOutputIds.some(
      (id) => !plan.outputs.some((output) => output.id === id),
    ) ||
    plan.outputs.some((output) => !expectedOutputIds.includes(output.id))
  )
    throw new Error("qualification_execution_plan_output_mismatch");
  const expectedFields = [
    "directViews",
    "externalViews",
    "referrer",
    "rowType",
    "totalViews",
    "uniqueDomains",
    "uniqueLinks",
    "views",
  ];
  if (
    plan.outputs.some(
      (output) =>
        output.fields
          .map((field) => field.name)
          .sort()
          .join("\u0000") !== expectedFields.join("\u0000"),
    )
  )
    throw new Error("qualification_execution_plan_schema_mismatch");

  const dependencies = plan.nodes.flatMap((node) =>
    node.kind === "source" && node.selection?.qualificationDependencyRefs
      ? node.selection.qualificationDependencyRefs.map((dependencyRef) => ({
          source: node,
          dependencyRef,
        }))
      : [],
  );
  if (
    dependencies.length !== 1 ||
    dependencies[0]!.dependencyRef !== EVENT_FILTER_PAGE_VISIT_DEPENDENCY
  )
    throw new Error("qualification_execution_plan_dependency_mismatch");

  const source = dependencies[0]!.source;
  const selection = source.selection!;
  const selfBinding = source.values.find((binding) => binding.kind === "self");
  if (
    source.entity !== "page" ||
    source.temporalDomain !== "candidate" ||
    source.grain.kind !== "entity" ||
    source.grain.entity !== "page" ||
    !selfBinding ||
    source.grain.key !== selfBinding.slot ||
    source.values.length !== 3 ||
    sourceAttributes(source).join("\u0000") !==
      ["page.report.referrerHost", "page.report.referrerUrl"].join("\u0000") ||
    selection.profile !== "prepared-scoped-v1" ||
    selection.scope !== "event" ||
    selection.mode !== "observation" ||
    selection.preparedMatches !== undefined ||
    !sameJsonValue(selection.filter, input.filters) ||
    !sameJsonValue(selection.time, input.time) ||
    !sameJsonValue(selection.subject.siteIds, [input.siteId]) ||
    !sameJsonValue(selection.authorizedSiteIds, [input.siteId]) ||
    selection.subject.origin !== "site" ||
    plan.outputs.some(
      (output) => !sourceReachesOutput(plan, source, output.relation),
    )
  )
    throw new Error("qualification_execution_plan_source_mismatch");
}

/** Trusted evaluator handoff. The caller supplies a physical relation, never raw IDs. */
export function createReferrersSummaryQualificationPreparation(input: {
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly metadata: ScopedFilterMetadata;
  readonly topN: number;
  readonly relation: AnalyticsDbRelation;
}): ReferrersSummaryQualificationPreparation {
  if (
    !input.siteId ||
    !input.filters.root ||
    !Number.isSafeInteger(input.topN) ||
    input.topN < 0
  )
    throw new Error("qualification_execution_preparation_invalid");
  const filters = deepFreeze(
    normalizeFilterDocument(input.filters, analyticsFilterRegistry),
  );
  const queryTime = snapshotQueryTime(input.queryTime);
  const time = semanticTemporalDomainsFromQueryTime(queryTime);
  const scopePlan = createScopedFilterPlan(
    "referrers",
    filters,
    input.metadata.requestedScope,
  );
  if (
    !scopePlan ||
    scopePlan.scope !== "event" ||
    scopePlan.mode !== "observation" ||
    scopePlan.advancedMatches !== undefined ||
    input.metadata.plan.scope !== scopePlan.scope ||
    input.metadata.plan.mode !== scopePlan.mode ||
    input.metadata.resolvedScope !== scopePlan.scope ||
    input.metadata.siteIds.length !== 1 ||
    input.metadata.siteIds[0] !== input.siteId ||
    !sameJsonValue(
      semanticTemporalDomainsFromQueryTime(input.metadata.time),
      time,
    )
  )
    throw new Error("qualification_execution_metadata_mismatch");

  const state: QualificationPreparationState = {
    siteId: input.siteId,
    filters,
    queryTime,
    time,
    metadata: Object.freeze({
      requestedScope: input.metadata.requestedScope,
      resolvedScope: scopePlan.scope,
      plan: scopePlan,
      time: queryTime,
      siteIds: Object.freeze([input.siteId]),
    }),
    topN: input.topN,
    relation: input.relation,
    bound: false,
  };
  const preparation = Object.freeze(
    Object.create(null),
  ) as ReferrersSummaryQualificationPreparation;
  preparationStates.set(preparation as object, state);
  return preparation;
}

/** Build the Referrers plan once, then bind that exact frozen snapshot. */
export function bindReferrersSummaryQualification(input: {
  readonly preparation: unknown;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly queryTime: QueryTime;
  readonly topN: number;
}): {
  readonly plan: ValidatedLogicalPlan;
  readonly executionInputs: QualificationExecutionInputs;
} {
  const state =
    typeof input.preparation === "object" && input.preparation !== null
      ? preparationStates.get(input.preparation)
      : undefined;
  if (!state) throw new Error("qualification_execution_preparation_untrusted");
  if (state.bound)
    throw new Error("qualification_execution_preparation_replayed");
  let normalizedFilters: FilterDocument;
  try {
    normalizedFilters = normalizeFilterDocument(
      input.filters,
      analyticsFilterRegistry,
    );
  } catch {
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  }
  if (
    input.siteId !== state.siteId ||
    input.topN !== state.topN ||
    !sameJsonValue(normalizedFilters, state.filters) ||
    !sameJsonValue(input.queryTime, state.queryTime) ||
    !sameJsonValue(input.scopePlan, state.metadata.plan)
  )
    throw new Error("qualification_execution_plan_snapshot_mismatch");

  const plan = validateLogicalPlan(
    snapshotLogicalPlan(
      buildReferrerSummaryPlan({
        siteId: state.siteId,
        queryTime: state.queryTime,
        filters: attachScopedFilterMetadata(state.filters, state.metadata),
        scopePlan: state.metadata.plan,
        qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
        topN: state.topN,
      }),
    ),
  );
  assertReferrerSummaryPlan(plan, {
    siteId: state.siteId,
    filters: state.filters,
    time: state.time,
  });
  const executionInputs = createQualificationExecutionInputsForTrustedPlan(
    state.relation,
    plan,
  );
  state.bound = true;
  return Object.freeze({ plan, executionInputs });
}
