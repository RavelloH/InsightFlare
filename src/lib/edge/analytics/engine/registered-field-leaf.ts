import {
  preparePrimitiveFieldCondition,
  primitivePredicateForValue,
} from "@/lib/edge/analytics/engine/filter-lowering";
import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";
import {
  type CountBareField,
  isQualifiedGeoBareField,
  type QualifiedGeoBareField,
  qualifiedGeoConditionSupport,
  type QualifiedGeoLiteralProof,
} from "@/lib/edge/analytics/engine/semantic/count-bare-fields";
import {
  advancedCountSelectorField,
  advancedCountSelectorUsesRawPresence,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import type { FilterCondition } from "@/lib/filter-contract/filters";

export interface QualifiedGeoBareLeafCreation {
  readonly field: QualifiedGeoBareField;
  readonly relationId: RelationId;
  readonly slotId: SlotId;
  readonly literalProof: QualifiedGeoLiteralProof;
}

/**
 * Lower one already-analyzed primitive field leaf against an existing
 * observation relation while retaining Filter v1's two-valued NULL contract.
 * Callers still own whole-tree preflight and must provide every semantic
 * attribute referenced by the leaf in `relation`.
 */
export function registeredFieldLeafPredicateExpression(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  condition: FilterCondition,
  expectedCollection?: "page" | "event",
  uncheckedErrorCode = "engine_field_predicate_received_unchecked_field",
  options: {
    readonly bareField?: CountBareField;
    readonly onQualifiedGeoBareLeaf?: (
      input: QualifiedGeoBareLeafCreation,
    ) => void;
  } = {},
): LogicalExpressionHandle {
  const prepared = preparePrimitiveFieldCondition(condition);
  if (prepared.kind !== "prepared" || condition.target.kind !== "field")
    throw new Error(uncheckedErrorCode);
  const field =
    options.bareField ?? advancedCountSelectorField(condition.target.field);
  if (
    !field ||
    field.fieldId !== condition.target.field ||
    (expectedCollection !== undefined &&
      field.collection !== expectedCollection)
  )
    throw new Error(uncheckedErrorCode);

  const value = builder.slot(relation, `attribute:${field.valueAttribute}`);
  if (isQualifiedGeoBareField(field) && options.onQualifiedGeoBareLeaf) {
    const proof = qualifiedGeoConditionSupport(
      prepared.condition,
      "root",
      field,
    );
    if (proof.kind !== "supported")
      throw new Error("advanced_count_plan_received_unchecked_geo_literal");
    if (value.expression.kind !== "slot")
      throw new Error("advanced_count_plan_geo_slot_provenance_missing");
    options.onQualifiedGeoBareLeaf({
      field,
      relationId: relation.id,
      slotId: value.expression.slot,
      literalProof: proof.proof,
    });
  }
  const primitive = primitivePredicateForValue(
    builder,
    value,
    prepared.condition,
    prepared.field,
    prepared.attribute,
  );
  if (advancedCountSelectorUsesRawPresence(prepared.condition.operator))
    return primitive;

  const falseValue = builder.compare(
    "eq",
    builder.literal(0, { kind: "scalar", scalar: "number" }),
    builder.literal(1, { kind: "scalar", scalar: "number" }),
  );
  if (field.kind === "number")
    return builder.caseWhen(
      [{ when: builder.isNull(value), then: falseValue }],
      primitive,
    );

  const nonStringFallback =
    prepared.condition.operator === "neq" ||
    prepared.condition.operator === "notIn"
      ? builder.compare(
          "eq",
          builder.literal(0, { kind: "scalar", scalar: "number" }),
          builder.literal(0, { kind: "scalar", scalar: "number" }),
        )
      : falseValue;
  const textAware =
    field.kind === "string" && "stringClassAttribute" in field
      ? builder.caseWhen(
          [
            {
              when: builder.slot(
                relation,
                `attribute:${field.stringClassAttribute}`,
              ),
              then: primitive,
            },
          ],
          nonStringFallback,
        )
      : primitive;
  return builder.caseWhen(
    [{ when: builder.isNull(value), then: falseValue }],
    textAware,
  );
}
