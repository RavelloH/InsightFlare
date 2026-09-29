import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "./logical/builder";
import type { LogicalFilterScope } from "./semantic/entities";
import type { AnalyticsEntityKind } from "./semantic/entities";
import type { SemanticRelationshipId } from "./semantic/relationships";

export interface ScopeUniverse {
  readonly scope: LogicalFilterScope;
  readonly relation: LogicalRelationHandle;
  readonly entitySlot: string;
}

export interface NativeMatchRelation {
  readonly nativeEntity: LogicalFilterScope;
  readonly relation: LogicalRelationHandle;
  readonly entitySlot: string;
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
): readonly string[] {
  const entity = universe.relation.slots[universe.entitySlot];
  const expected: AnalyticsEntityKind = universe.scope;
  const issues: string[] = [];
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
  return Object.freeze(issues);
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

/** Builds set semantics over the candidate universe; null roots stay unfiltered. */
export function resolveScopeFilterSelection(
  builder: LogicalPlanBuilder,
  candidate: ScopeUniverse,
  root: ScopeBooleanExpression | null,
  converter: NativeMatchConverter,
): ScopeFilterSelection {
  if (root === null) return Object.freeze({ kind: "unfiltered" });
  const issues = validateScopeUniverse(candidate);
  if (issues.length > 0) throw new Error(issues.join("; "));

  const lower = (expression: ScopeBooleanExpression): LogicalRelationHandle => {
    if (expression.kind === "match") {
      const contract = scopeConversionContract(
        expression.value.nativeEntity,
        candidate.scope,
      );
      if (!contract) throw new Error("scope_conversion_not_supported");
      return converter.convert(expression.value, candidate);
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
