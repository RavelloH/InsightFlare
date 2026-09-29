import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import {
  type NativeMatchConverter,
  type NativeMatchRelation,
  scopeConversionContract,
  type ScopeUniverse,
  validateNativeMatchRelation,
  validateScopeUniverse,
} from "@/lib/edge/analytics/engine/scope-contract";
import type { LogicalFilterScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { semanticRelationship } from "@/lib/edge/analytics/engine/semantic/relationships";

function fail(code: string): never {
  throw new Error(`native_match_${code}`);
}

function validateTarget(
  builder: LogicalPlanBuilder,
  target: ScopeUniverse,
): void {
  if (!target || typeof target !== "object") fail("invalid_target");
  const resolvedScope = builder.context.scope.logicalScope;
  if (resolvedScope !== null && resolvedScope !== target.scope) {
    fail("target_conflicts_with_resolved_scope");
  }
  const issues = validateScopeUniverse(target, builder);
  if (issues.length > 0) fail(`invalid_target:${issues.join(";")}`);
}

function unaryEntitySet(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  entitySlot: string,
): LogicalRelationHandle {
  const projected = builder.project(relation, {
    entity: builder.slot(relation, entitySlot),
  });
  return builder.distinctEntity(projected, "entity");
}

function assertUnaryEntitySet(
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
    fail("conversion_result_is_not_unary_entity_set");
  }
  let key;
  try {
    key = builder.slot(relation, "entity");
  } catch {
    fail("conversion_result_not_owned_or_key_not_visible");
  }
  if (key.type.kind !== "entity" || key.type.entity !== scope) {
    fail("conversion_result_entity_type_mismatch");
  }
  if (key.nullable) fail("conversion_result_nullable_entity");
}

function expandMatch(
  builder: LogicalPlanBuilder,
  match: NativeMatchRelation,
  target: ScopeUniverse,
  nativeSet: LogicalRelationHandle,
): LogicalRelationHandle {
  const contract = scopeConversionContract(match.nativeEntity, target.scope);
  if (!contract) fail("unsupported_conversion");
  if (match.nativeEntity === target.scope) return nativeSet;
  if (contract.relationships.length !== 1) {
    fail("conversion_relationship_cardinality");
  }

  const relationshipId = contract.relationships[0]!;
  const relationship = semanticRelationship(relationshipId);
  if (!relationship) fail("semantic_relationship_missing");

  if (
    relationship.from === match.nativeEntity &&
    relationship.to === target.scope
  ) {
    const matchedEvidence = builder.relationshipLookup(
      nativeSet,
      relationshipId,
    );
    return unaryEntitySet(
      builder,
      matchedEvidence,
      `relationship:${relationshipId}`,
    );
  }

  if (
    relationship.from === target.scope &&
    relationship.to === match.nativeEntity
  ) {
    const candidateEvidence = builder.relationshipLookup(
      target.relation,
      relationshipId,
    );
    const matchedEvidence = builder.semiJoin(candidateEvidence, nativeSet, [
      { left: `relationship:${relationshipId}`, right: "entity" },
    ]);
    return unaryEntitySet(builder, matchedEvidence, "entity");
  }

  return fail("relationship_direction_mismatch");
}

/** Converts native matches to a non-null candidate subset without SQL. */
export function createNativeMatchConverter(
  builder: LogicalPlanBuilder,
): NativeMatchConverter {
  return Object.freeze({
    convert(match: NativeMatchRelation, target: ScopeUniverse) {
      validateTarget(builder, target);
      validateNativeMatchRelation(builder, match);

      const nativeSet = unaryEntitySet(
        builder,
        match.relation,
        match.entitySlot,
      );
      const expanded = expandMatch(builder, match, target, nativeSet);
      const candidateSubset = builder.setOperation("intersect", [
        target.relation,
        expanded,
      ]);
      assertUnaryEntitySet(builder, candidateSubset, target.scope);
      return candidateSubset;
    },
  });
}
