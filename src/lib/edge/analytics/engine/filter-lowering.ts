import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import {
  type LogicalExpressionHandle,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalStringNormalization } from "@/lib/edge/analytics/engine/logical/expression";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import type { NativeMatchRelation } from "@/lib/edge/analytics/engine/scope-contract";
import {
  semanticAttribute,
  type SemanticAttributeDefinition,
} from "@/lib/edge/analytics/engine/semantic/attributes";
import type { ObservationKind } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  temporalDomainExists,
  type TemporalDomainRef,
} from "@/lib/edge/analytics/engine/semantic/time";
import {
  analyticsFilterRegistry,
  type RegisteredFilterField,
} from "@/lib/filter-contract/filter-registry";
import {
  type AnalyzedFilterDocument,
  analyzeFilterDocument,
} from "@/lib/filter-contract/filter-semantics";
import { canonicalizeFilterValue } from "@/lib/filter-contract/filter-value-semantics";
import {
  type FilterCondition,
  type FilterOperator,
  type FilterValue,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

export type FilterLoweringUnsupportedCode =
  | "unsupported-target"
  | "unsupported-operator"
  | "unsupported-presence"
  | "unsupported-evaluation"
  | "unsupported-native-entity"
  | "unsupported-observation-kinds";

export type FilterConditionLoweringResult =
  | { readonly kind: "supported"; readonly match: NativeMatchRelation }
  | {
      readonly kind: "unsupported";
      readonly code: FilterLoweringUnsupportedCode;
      readonly fieldId?: string;
      readonly operator: FilterOperator;
    };

export type PrimitiveObservationSource = "observation" | ObservationKind;

/** Picks only observation kinds where the registered attribute has meaning. */
export function observationSourceForAttribute(
  attribute: Pick<
    SemanticAttributeDefinition,
    "nativeEntity" | "observationKinds"
  >,
): PrimitiveObservationSource | null {
  const supportsPage = attribute.observationKinds.includes("page");
  const supportsEvent = attribute.observationKinds.includes("event");
  if (supportsPage && supportsEvent) return "observation";
  if (!supportsPage && !supportsEvent) return null;
  const kind: ObservationKind = supportsPage ? "page" : "event";
  return attribute.nativeEntity === kind ? kind : null;
}

export type ObservationAttributeCapability =
  | { readonly kind: "supported"; readonly source: PrimitiveObservationSource }
  | {
      readonly kind: "unsupported";
      readonly code:
        | "unsupported-evaluation"
        | "unsupported-native-entity"
        | "unsupported-observation-kinds";
    };

/** Resolves observation eligibility from the semantic catalog metadata. */
export function observationCapabilityForAttribute(
  attribute: Pick<
    SemanticAttributeDefinition,
    "evaluation" | "presence" | "nativeEntity" | "observationKinds"
  >,
): ObservationAttributeCapability {
  if (
    attribute.evaluation !== "observation" ||
    attribute.presence !== "non-null"
  ) {
    return { kind: "unsupported", code: "unsupported-evaluation" };
  }
  if (attribute.nativeEntity !== "page" && attribute.nativeEntity !== "event") {
    return { kind: "unsupported", code: "unsupported-native-entity" };
  }
  const source = observationSourceForAttribute(attribute);
  return source
    ? { kind: "supported", source }
    : { kind: "unsupported", code: "unsupported-observation-kinds" };
}

const SUPPORTED_COMPARISONS = new Set<FilterOperator>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);
const SUPPORTED_SET_OPERATORS = new Set<FilterOperator>(["in", "notIn"]);
const SUPPORTED_STRING_MATCHES = new Set<FilterOperator>([
  "contains",
  "startsWith",
  "endsWith",
]);
const SUPPORTED_NULL_TESTS = new Set<FilterOperator>(["isNull", "notNull"]);

function invalid(code: string): never {
  throw new Error(`filter_lowering_${code}`);
}

function unsupported(
  code: FilterLoweringUnsupportedCode,
  fieldId: string | undefined,
  operator: FilterOperator,
): Extract<FilterConditionLoweringResult, { kind: "unsupported" }> {
  return {
    kind: "unsupported",
    code,
    ...(fieldId ? { fieldId } : {}),
    operator,
  };
}

function stringNormalizationFor(
  field: RegisteredFilterField,
): LogicalStringNormalization | undefined {
  if (field.valueKind !== "string" && field.valueKind !== "enum")
    return undefined;
  return field.comparison === "case-insensitive" ? "trim-case-fold" : "trim";
}

function literalValue(
  field: RegisteredFilterField,
  value: FilterValue,
  operator: FilterOperator,
): FilterValue {
  return canonicalizeFilterValue(value, field.id, operator);
}

function literal(
  builder: LogicalPlanBuilder,
  attributeValueType: LogicalValueType,
  value: FilterValue,
): LogicalExpressionHandle {
  if (attributeValueType.kind !== "scalar") {
    return invalid("attribute_not_scalar");
  }
  return builder.literal(value, attributeValueType);
}

export interface PreparedPrimitiveFieldCondition {
  readonly kind: "prepared";
  readonly condition: FilterCondition;
  readonly field: RegisteredFilterField;
  readonly attribute: SemanticAttributeDefinition;
}

export type PrimitiveFieldPreparationResult =
  | PreparedPrimitiveFieldCondition
  | {
      readonly kind: "unsupported";
      readonly code: FilterLoweringUnsupportedCode;
      readonly fieldId?: string;
      readonly operator: FilterOperator;
    };

/** Normalize and capability-check a raw field condition without lowering it. */
export function preparePrimitiveFieldCondition(
  condition: FilterCondition,
): PrimitiveFieldPreparationResult {
  if (!condition || typeof condition !== "object") {
    return invalid("invalid_condition");
  }
  if (!condition.target || typeof condition.target !== "object") {
    return invalid("invalid_target");
  }
  if (condition.target.kind !== "field") {
    return unsupported("unsupported-target", undefined, condition.operator);
  }
  const field = analyticsFilterRegistry.get(condition.target.field);
  const attribute = semanticAttribute(condition.target.field);
  if (!field || !attribute) return invalid("unknown_field");

  const normalized = normalizeFilterDocument(
    { version: 1, root: condition },
    analyticsFilterRegistry,
  );
  if (!normalized.root || normalized.root.kind !== "condition") {
    return invalid("invalid_condition");
  }
  const loweredCondition = normalized.root;
  if (
    (loweredCondition.operator === "isEmpty" ||
      loweredCondition.operator === "notEmpty") &&
    attribute.empty === "unsupported"
  ) {
    return unsupported(
      "unsupported-presence",
      field.id,
      loweredCondition.operator,
    );
  }
  if (
    !SUPPORTED_COMPARISONS.has(loweredCondition.operator) &&
    !SUPPORTED_SET_OPERATORS.has(loweredCondition.operator) &&
    !SUPPORTED_STRING_MATCHES.has(loweredCondition.operator) &&
    !SUPPORTED_NULL_TESTS.has(loweredCondition.operator)
  ) {
    return unsupported(
      "unsupported-operator",
      field.id,
      loweredCondition.operator,
    );
  }
  if (attribute.presence === "json-path") {
    return unsupported(
      "unsupported-presence",
      field.id,
      loweredCondition.operator,
    );
  }
  return {
    kind: "prepared",
    condition: loweredCondition,
    field,
    attribute,
  };
}

/** Build a prepared primitive predicate against an existing shared source. */
export function primitivePredicateForSource(
  builder: LogicalPlanBuilder,
  source: LogicalRelationHandle,
  condition: FilterCondition,
  field: RegisteredFilterField,
  attribute: SemanticAttributeDefinition,
): LogicalExpressionHandle {
  const input = builder.slot(source, `attribute:${field.id}`);
  const normalization = stringNormalizationFor(field);

  if (SUPPORTED_NULL_TESTS.has(condition.operator)) {
    return builder.isNull(input, condition.operator === "notNull");
  }

  if (SUPPORTED_SET_OPERATORS.has(condition.operator)) {
    const values = condition.value as readonly FilterValue[];
    return builder.in(
      input,
      values.map((value) =>
        literal(
          builder,
          attribute.valueType,
          literalValue(field, value, condition.operator),
        ),
      ),
      condition.operator === "notIn",
      normalization,
    );
  }

  if (SUPPORTED_STRING_MATCHES.has(condition.operator)) {
    const value = literalValue(
      field,
      condition.value as FilterValue,
      condition.operator,
    );
    return builder.stringMatch(
      condition.operator === "startsWith"
        ? "starts-with"
        : condition.operator === "endsWith"
          ? "ends-with"
          : "contains",
      input,
      value as string,
      field.comparison === "case-sensitive",
      normalization,
    );
  }

  // Remaining allowlisted primitive operators are scalar comparisons.
  return builder.compare(
    condition.operator as "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
    input,
    literal(
      builder,
      attribute.valueType,
      literalValue(field, condition.value as FilterValue, condition.operator),
    ),
    normalization,
  );
}

function lowerObservationCondition(
  builder: LogicalPlanBuilder,
  condition: FilterCondition,
  field: RegisteredFilterField,
  temporalDomain: TemporalDomainRef,
): FilterConditionLoweringResult {
  const attribute = semanticAttribute(field.id)!;
  const capability = observationCapabilityForAttribute(attribute);
  if (capability.kind === "unsupported") {
    return unsupported(capability.code, field.id, condition.operator);
  }
  const sourceEntity = capability.source;

  if (sourceEntity === "observation") {
    const source = builder.source("observation", {
      attributes: [field.id],
      temporalDomain,
    });
    const relation = builder.filter(
      source,
      primitivePredicateForSource(builder, source, condition, field, attribute),
    );
    return {
      kind: "supported",
      match: {
        nativeEntity: "observation",
        relation,
        entitySlot: "entity",
        temporalDomain,
      },
    };
  }

  const kind: ObservationKind = sourceEntity;
  const relationship = `${kind}.observation` as const;
  const source = builder.source(kind, {
    attributes: [field.id],
    relationships: [relationship],
    temporalDomain,
  });
  const filtered = builder.filter(
    source,
    primitivePredicateForSource(builder, source, condition, field, attribute),
  );
  const projected = builder.project(filtered, {
    observation: builder.slot(filtered, `relationship:${relationship}`),
  });
  const relation = builder.distinctEntity(projected, "observation");
  return {
    kind: "supported",
    match: {
      nativeEntity: "observation",
      relation,
      entitySlot: "observation",
      temporalDomain,
    },
  };
}

/**
 * Lowers one analyzed, raw Filter v1 field condition into a native membership
 * relation. The temporal domain is required so historical reads cannot be
 * mistaken for the final candidate scope.
 */
export function lowerFilterCondition(
  builder: LogicalPlanBuilder,
  analysis: AnalyzedFilterDocument,
  condition: FilterCondition,
  temporalDomain: TemporalDomainRef,
): FilterConditionLoweringResult {
  if (!condition || typeof condition !== "object") {
    return invalid("invalid_condition");
  }
  if (
    !analysis ||
    typeof analysis !== "object" ||
    !analysis.document ||
    typeof analysis.document !== "object" ||
    !analysis.conditions?.get(condition)
  ) {
    return invalid("condition_not_analyzed");
  }
  const verifiedAnalysis = analyzeFilterDocument(
    analysis.document,
    analyticsFilterRegistry,
  );
  if (!verifiedAnalysis.conditions.has(condition)) {
    return invalid("condition_not_analyzed");
  }
  if (!builder.context.time || !temporalDomain) {
    return invalid("temporal_domain_required");
  }
  if (!temporalDomainExists(builder.context.time, temporalDomain)) {
    return invalid("invalid_temporal_domain");
  }

  const prepared = preparePrimitiveFieldCondition(condition);
  if (prepared.kind === "unsupported") return prepared;
  const { condition: loweredCondition, field, attribute } = prepared;

  if (
    attribute.evaluation === "session-fact" &&
    attribute.nativeEntity === "session" &&
    attribute.presence === "non-null"
  ) {
    const source = builder.source("session", {
      attributes: [field.id],
      temporalDomain,
    });
    const relation = builder.filter(
      source,
      primitivePredicateForSource(
        builder,
        source,
        loweredCondition,
        field,
        attribute,
      ),
    );
    return {
      kind: "supported",
      match: {
        nativeEntity: "session",
        relation,
        entitySlot: "entity",
        temporalDomain,
      },
    };
  }
  if (
    attribute.evaluation === "visitor-fact" &&
    attribute.nativeEntity === "visitor" &&
    attribute.presence === "non-null"
  ) {
    const source = builder.source("visitor", {
      attributes: [field.id],
      temporalDomain,
    });
    const relation = builder.filter(
      source,
      primitivePredicateForSource(
        builder,
        source,
        loweredCondition,
        field,
        attribute,
      ),
    );
    return {
      kind: "supported",
      match: {
        nativeEntity: "visitor",
        relation,
        entitySlot: "entity",
        temporalDomain,
      },
    };
  }
  if (attribute.evaluation === "observation") {
    return lowerObservationCondition(
      builder,
      loweredCondition,
      field,
      temporalDomain,
    );
  }
  return unsupported(
    "unsupported-evaluation",
    field.id,
    loweredCondition.operator,
  );
}
