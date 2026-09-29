import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "./logical/builder";
import type { LogicalFilterScope } from "./semantic/entities";
import type { AnalyticsEntityKind } from "./semantic/entities";
import type { SemanticRelationshipId } from "./semantic/relationships";
import { temporalDomainExists, type TemporalDomainRef } from "./semantic/time";

export interface ScopeUniverse {
  readonly scope: LogicalFilterScope;
  readonly relation: LogicalRelationHandle;
  readonly entitySlot: string;
  readonly temporalDomain: "candidate";
}

export interface NativeMatchRelation {
  readonly nativeEntity: LogicalFilterScope;
  readonly relation: LogicalRelationHandle;
  readonly entitySlot: string;
  /** Explicit temporal domain used to evaluate this match. */
  readonly temporalDomain: TemporalDomainRef;
}

export interface ScopeConversionContract {
  readonly from: LogicalFilterScope;
  readonly to: LogicalFilterScope;
  readonly strategy: "identity" | "associated-distinct";
  readonly relationships: readonly SemanticRelationshipId[];
}

const observationSession: readonly SemanticRelationshipId[] = [
  "observation.session",
];
const observationVisitor: readonly SemanticRelationshipId[] = [
  "observation.visitor",
];

/** Explicit capability matrix; Phase 4B will provide concrete condition lowering. */
const conversionContracts: readonly ScopeConversionContract[] = [
  {
    from: "observation",
    to: "observation",
    strategy: "identity",
    relationships: [],
  },
  {
    from: "observation",
    to: "session",
    strategy: "associated-distinct",
    relationships: observationSession,
  },
  {
    from: "observation",
    to: "visitor",
    strategy: "associated-distinct",
    relationships: observationVisitor,
  },
  {
    from: "session",
    to: "observation",
    strategy: "associated-distinct",
    relationships: observationSession,
  },
  { from: "session", to: "session", strategy: "identity", relationships: [] },
  {
    from: "session",
    to: "visitor",
    strategy: "associated-distinct",
    relationships: ["session.visitor"],
  },
  {
    from: "visitor",
    to: "observation",
    strategy: "associated-distinct",
    relationships: observationVisitor,
  },
  {
    from: "visitor",
    to: "session",
    strategy: "associated-distinct",
    relationships: ["session.visitor"],
  },
  { from: "visitor", to: "visitor", strategy: "identity", relationships: [] },
];

export const scopeConversionContracts: readonly ScopeConversionContract[] =
  Object.freeze(
    conversionContracts.map((contract) =>
      Object.freeze({
        ...contract,
        relationships: Object.freeze([...contract.relationships]),
      }),
    ),
  );

export function scopeConversionContract(
  from: LogicalFilterScope,
  to: LogicalFilterScope,
): ScopeConversionContract | undefined {
  return scopeConversionContracts.find(
    (contract) => contract.from === from && contract.to === to,
  );
}

export function validateScopeUniverse(
  universe: ScopeUniverse,
  builder?: LogicalPlanBuilder,
): readonly string[] {
  if (
    !universe ||
    typeof universe !== "object" ||
    !universe.relation ||
    typeof universe.relation !== "object" ||
    !universe.relation.slots ||
    !universe.relation.grain
  ) {
    return Object.freeze(["universe: relation handle is invalid"]);
  }
  const entity = universe.relation.slots[universe.entitySlot];
  const expected: AnalyticsEntityKind = universe.scope;
  const issues: string[] = [];
  if (universe.temporalDomain !== "candidate") {
    issues.push("temporalDomain: candidate universe must use candidate");
  }
  if (
    !Array.isArray(universe.relation.temporalDomains) ||
    universe.relation.temporalDomains.length !== 1 ||
    universe.relation.temporalDomains[0] !== "candidate"
  ) {
    issues.push("relation: candidate universe source domain must be candidate");
  }
  const visibleSlots = Object.keys(universe.relation.slots);
  if (
    visibleSlots.length !== 1 ||
    (entity !== undefined && universe.entitySlot !== "entity")
  ) {
    issues.push("relation: candidate universe must expose one entity key");
  }
  if (entity === undefined)
    issues.push("entitySlot: slot name is not visible in relation");
  if (
    universe.relation.grain.kind !== "entity" ||
    universe.relation.grain.entity !== expected
  ) {
    issues.push(`relation: expected Entity<${expected}> grain`);
  } else if (universe.relation.grain.key !== entity) {
    issues.push("entitySlot: must identify the entity grain key");
  }
  if (builder) {
    try {
      const expression = builder.slot(universe.relation, universe.entitySlot);
      if (
        expression.type.kind !== "entity" ||
        expression.type.entity !== expected
      ) {
        issues.push(`entitySlot: expected non-null Entity<${expected}>`);
      } else if (expression.nullable) {
        issues.push("entitySlot: candidate entity key must be non-null");
      }
    } catch {
      issues.push(
        "relation: not owned by builder or entity slot is not visible",
      );
    }
  }
  return Object.freeze(issues);
}

/** Builds the entity universe admitted by the plan's candidate time range. */
export function createCandidateScopeUniverse(
  builder: LogicalPlanBuilder,
  scope: LogicalFilterScope,
): ScopeUniverse {
  const resolvedScope = builder.context.scope.logicalScope;
  if (resolvedScope !== null && resolvedScope !== scope) {
    throw new Error("candidate_scope_conflicts_with_resolved_scope");
  }

  let relation: LogicalRelationHandle;
  if (scope === "observation") {
    relation = builder.source("observation", {
      temporalDomain: "candidate",
    });
  } else {
    const relationship: SemanticRelationshipId =
      scope === "session" ? "observation.session" : "observation.visitor";
    const observations = builder.source("observation", {
      temporalDomain: "candidate",
      relationships: [relationship],
    });
    relation = builder.distinctEntity(
      observations,
      `relationship:${relationship}`,
      "entity",
    );
  }
  const universe = Object.freeze({
    scope,
    relation,
    entitySlot: "entity",
    temporalDomain: "candidate" as const,
  });
  const issues = validateScopeUniverse(universe, builder);
  if (issues.length > 0) throw new Error(issues.join("; "));
  return universe;
}

/** Rejects forged or foreign match handles before a converter uses set algebra. */
export function validateNativeMatchRelation(
  builder: LogicalPlanBuilder,
  match: NativeMatchRelation,
): void {
  if (!match || typeof match !== "object") {
    throw new Error("native_match_invalid_input");
  }
  if (
    !match.relation ||
    typeof match.relation !== "object" ||
    !match.relation.slots ||
    !match.relation.grain
  ) {
    throw new Error("native_match_invalid_relation");
  }
  if (!temporalDomainExists(builder.context.time, match.temporalDomain)) {
    throw new Error("native_match_invalid_temporal_domain");
  }
  if (
    !Array.isArray(match.relation.temporalDomains) ||
    match.relation.temporalDomains.length !== 1 ||
    match.relation.temporalDomains[0] !== match.temporalDomain
  ) {
    throw new Error("native_match_temporal_domain_mismatch");
  }

  let key;
  try {
    key = builder.slot(match.relation, match.entitySlot);
  } catch {
    throw new Error(
      "native_match_relation_not_owned_or_entity_slot_not_visible",
    );
  }
  if (
    match.relation.grain.kind !== "entity" ||
    match.relation.grain.entity !== match.nativeEntity
  ) {
    throw new Error("native_match_native_entity_grain_mismatch");
  }
  if (match.relation.grain.key !== match.relation.slots[match.entitySlot]) {
    throw new Error("native_match_entity_slot_is_not_grain_key");
  }
  if (key.type.kind !== "entity" || key.type.entity !== match.nativeEntity) {
    throw new Error("native_match_entity_slot_type_mismatch");
  }
  if (key.nullable) throw new Error("native_match_nullable_entity_slot");
}

export type ScopeBooleanExpression =
  | { readonly kind: "match"; readonly value: NativeMatchRelation }
  | {
      readonly kind: "and" | "or";
      readonly children: readonly ScopeBooleanExpression[];
    }
  | { readonly kind: "not"; readonly child: ScopeBooleanExpression };

export type ScopeFilterSelection =
  | { readonly kind: "unfiltered" }
  | {
      readonly kind: "matching";
      readonly scope: LogicalFilterScope;
      readonly relation: LogicalRelationHandle;
    };

export interface NativeMatchConverter {
  convert(
    match: NativeMatchRelation,
    target: ScopeUniverse,
  ): LogicalRelationHandle;
}

function validateCandidateSubset(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  scope: LogicalFilterScope,
): void {
  if (
    relation.grain.kind !== "entity" ||
    relation.grain.entity !== scope ||
    relation.grain.key !== relation.slots.entity ||
    Object.keys(relation.slots).length !== 1
  ) {
    throw new Error("scope_conversion_result_must_be_unary_entity_set");
  }
  try {
    const key = builder.slot(relation, "entity");
    if (key.type.kind !== "entity" || key.type.entity !== scope) {
      throw new Error("scope_conversion_result_entity_type_mismatch");
    }
    if (key.nullable) {
      throw new Error("scope_conversion_result_entity_must_be_non_null");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("scope_conversion_result_")
    ) {
      throw error;
    }
    throw new Error("scope_conversion_result_not_owned_or_key_not_visible");
  }
}

/** Builds set semantics over the candidate universe; null roots stay unfiltered. */
export function resolveScopeFilterSelection(
  builder: LogicalPlanBuilder,
  candidate: ScopeUniverse,
  root: ScopeBooleanExpression,
  converter: NativeMatchConverter,
): Extract<ScopeFilterSelection, { kind: "matching" }>;
export function resolveScopeFilterSelection(
  builder: LogicalPlanBuilder,
  candidate: ScopeUniverse,
  root: null,
  converter: NativeMatchConverter,
): Extract<ScopeFilterSelection, { kind: "unfiltered" }>;
export function resolveScopeFilterSelection(
  builder: LogicalPlanBuilder,
  candidate: ScopeUniverse,
  root: ScopeBooleanExpression | null,
  converter: NativeMatchConverter,
): ScopeFilterSelection;
export function resolveScopeFilterSelection(
  builder: LogicalPlanBuilder,
  candidate: ScopeUniverse,
  root: ScopeBooleanExpression | null,
  converter: NativeMatchConverter,
): ScopeFilterSelection {
  if (root === null) return Object.freeze({ kind: "unfiltered" });
  const issues = validateScopeUniverse(candidate, builder);
  if (issues.length > 0) throw new Error(issues.join("; "));

  const lower = (expression: ScopeBooleanExpression): LogicalRelationHandle => {
    if (expression.kind === "match") {
      validateNativeMatchRelation(builder, expression.value);
      const contract = scopeConversionContract(
        expression.value.nativeEntity,
        candidate.scope,
      );
      if (!contract) throw new Error("scope_conversion_not_supported");
      const converted = converter.convert(expression.value, candidate);
      validateCandidateSubset(builder, converted, candidate.scope);
      return converted;
    }
    if (expression.kind === "not") {
      const child = lower(expression.child);
      return builder.setOperation("difference", [candidate.relation, child]);
    }
    if (expression.children.length === 0)
      throw new Error("scope_boolean_group_empty");
    const children = expression.children.map(lower);
    if (children.length === 1) return children[0]!;
    return builder.setOperation(
      expression.kind === "and" ? "intersect" : "union",
      children,
    );
  };

  return Object.freeze({
    kind: "matching",
    scope: candidate.scope,
    relation: lower(root),
  });
}
