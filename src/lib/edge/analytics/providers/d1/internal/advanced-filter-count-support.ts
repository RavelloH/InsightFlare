import {
  advancedCountPayloadPaths,
  advancedCountRegisteredStringLiteralsAreAscii,
} from "@/lib/edge/analytics/engine/advanced-count-payload-selector";
import {
  ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT,
  ADVANCED_FILTER_MAX_ACTIVITIES,
} from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import { slotId } from "@/lib/edge/analytics/engine/logical/ids";
import { inferLogicalExpression } from "@/lib/edge/analytics/engine/logical/validator";
import {
  type AdvancedFilterNumericCompatibilityRequirement,
  deriveAdvancedFilterNumericCompatibilityRequirements,
} from "@/lib/edge/analytics/engine/semantic/advanced-filter-field-requirements";
import {
  resolveAdvancedCountFiniteCollection,
  resolveAdvancedCountScalarField,
} from "@/lib/edge/analytics/engine/semantic/count-scalar-fields";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  analyzeFilterDocument,
  validateFilterConditionDomains,
} from "@/lib/filter-contract/filter-semantics";
import {
  type FilterRelationScope,
  validateFilterRelationDomains,
} from "@/lib/filter-contract/filter-types";
import {
  type FilterDocument,
  type FilterExpression,
  type FilterTargetExpression,
  FilterValidationError,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

import {
  bareNumericFieldConditionSupport,
  bareStringFieldConditionSupport,
  countSelectorSupport,
} from "./advanced-count-selector-support";

interface NumericEnvelope {
  readonly minimum: number;
  readonly maximum: number;
  readonly integral: boolean;
  readonly nullable: boolean;
  readonly alwaysNull: boolean;
}

const COUNT_EXPRESSION_SLOT = slotId(0);

function countLogicalExpression(target: FilterTargetExpression): LogicalExpr {
  if (
    target.kind === "reducer" &&
    ((target.reducer === "count" &&
      resolveAdvancedCountFiniteCollection(target.input)) ||
      (target.reducer === "countDistinct" &&
        resolveAdvancedCountScalarField(target.input)) ||
      ((target.reducer === "min" || target.reducer === "max") &&
        resolveAdvancedCountScalarField(target.input)) ||
      ((target.reducer === "sum" || target.reducer === "avg") &&
        resolveAdvancedCountScalarField(target.input)))
  )
    return {
      kind: "numeric-value",
      input: { kind: "slot", slot: COUNT_EXPRESSION_SLOT },
    };
  if (target.kind !== "arithmetic")
    throw new Error("count_sql_logical_target_not_supported");
  return {
    kind: "numeric-value",
    input: {
      kind: "arithmetic",
      operator:
        target.operator === "add"
          ? "add"
          : target.operator === "sub"
            ? "subtract"
            : target.operator === "mul"
              ? "multiply"
              : "divide",
      left: countLogicalExpression(target.left),
      right: countLogicalExpression(target.right),
      ...(target.operator === "div" ? { zeroDenominator: "null" } : {}),
    },
  };
}

const MAX_CONSERVATIVE_BINARY64_MAGNITUDE = Number.MAX_VALUE / 2;

function validateLogicalArithmetic(
  target: FilterTargetExpression,
  path: string,
):
  | { readonly kind: "supported" }
  | {
      readonly kind: "unsupported";
      readonly path: string;
      readonly code: string;
      readonly reason: string;
    } {
  try {
    inferLogicalExpression(
      countLogicalExpression(target),
      () => ({
        type: { kind: "scalar", scalar: "number" },
        nullable: false,
      }),
      path,
    );
    return { kind: "supported" };
  } catch (error) {
    return {
      kind: "unsupported",
      path,
      code: "count_sql_logical_arithmetic_unsupported",
      reason:
        error instanceof Error
          ? `The existing Logical expression rules reject this count arithmetic: ${error.message}`
          : "The existing Logical expression rules reject this count arithmetic.",
    };
  }
}

export type AdvancedCountFilterSupport =
  | {
      readonly kind: "supported";
      readonly path: string;
      readonly code: string;
      readonly reason: string;
      readonly document: FilterDocument;
      readonly analysis: ReturnType<typeof analyzeFilterDocument>;
      readonly numericCompatibilityFieldIds: readonly string[];
      readonly numericCompatibilityRequirements: readonly AdvancedFilterNumericCompatibilityRequirement[];
    }
  | {
      readonly kind: "unsupported";
      readonly path: string;
      readonly code: string;
      readonly reason: string;
    };

const COUNT_COMPARISONS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
const COUNT_SET_OPERATORS = new Set(["in", "notIn"]);

function unsupported(
  path: string,
  code: string,
  reason: string,
): Extract<AdvancedCountFilterSupport, { kind: "unsupported" }> {
  return { kind: "unsupported", path, code, reason };
}

function targetNumericEnvelope(
  target: FilterTargetExpression,
  analysis: ReturnType<typeof analyzeFilterDocument>,
  path: string,
):
  | { readonly kind: "supported"; readonly envelope: NumericEnvelope }
  | {
      readonly kind: "unsupported";
      readonly path: string;
      readonly code: string;
      readonly reason: string;
    } {
  const analyzedType = analysis.targetTypes.get(target);
  if (analyzedType?.kind !== "scalar" || analyzedType.scalar !== "number")
    return {
      kind: "unsupported",
      path,
      code: "count_sql_requires_numeric_target",
      reason: "The target is not a validated numeric Filter expression.",
    };

  if (target.kind === "reducer" && target.reducer === "count") {
    const collection = resolveAdvancedCountFiniteCollection(target.input);
    if (collection) {
      if (collection.kind === "selector") {
        const selectorSupport = countSelectorSupport(
          collection.selector,
          `${path}.input`,
        );
        if (selectorSupport) return selectorSupport;
      }
      return {
        kind: "supported",
        envelope: {
          minimum: 0,
          maximum: ADVANCED_FILTER_MAX_ACTIVITIES,
          integral: true,
          nullable: false,
          alwaysNull: false,
        },
      };
    }
    if (target.input.kind === "selector") {
      const selectorSupport = countSelectorSupport(
        target.input,
        `${path}.input`,
      );
      if (selectorSupport) return selectorSupport;
    }
  }

  if (
    target.kind === "reducer" &&
    (target.reducer === "countDistinct" ||
      target.reducer === "min" ||
      target.reducer === "max" ||
      target.reducer === "sum" ||
      target.reducer === "avg")
  ) {
    const scalarCollection = resolveAdvancedCountScalarField(target.input);
    if (scalarCollection) {
      if (scalarCollection.collection.kind === "selector") {
        const selectorSupport = countSelectorSupport(
          scalarCollection.collection.selector,
          `${path}.input`,
        );
        if (selectorSupport) return selectorSupport;
      }
      return {
        kind: "supported",
        envelope:
          target.reducer === "min" || target.reducer === "max"
            ? {
                minimum: -Number.MAX_SAFE_INTEGER,
                maximum: Number.MAX_SAFE_INTEGER,
                integral: false,
                nullable: true,
                alwaysNull: false,
              }
            : target.reducer === "sum"
              ? {
                  minimum: -Number.MAX_SAFE_INTEGER,
                  maximum: Number.MAX_SAFE_INTEGER,
                  integral: true,
                  nullable: false,
                  alwaysNull: false,
                }
              : target.reducer === "avg"
                ? {
                    minimum: -ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT,
                    maximum: ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT,
                    integral: false,
                    nullable: true,
                    alwaysNull: false,
                  }
                : {
                    minimum: 0,
                    maximum: ADVANCED_FILTER_MAX_ACTIVITIES,
                    integral: true,
                    nullable: false,
                    alwaysNull: false,
                  },
      };
    }
  }

  if (target.kind !== "arithmetic")
    return {
      kind: "unsupported",
      path,
      code: "count_sql_unsupported_numeric_target",
      reason:
        "Only count(page), count(event), and arithmetic composed from those counts are supported.",
    };

  const left = targetNumericEnvelope(target.left, analysis, `${path}.left`);
  if (left.kind === "unsupported") return left;
  const right = targetNumericEnvelope(target.right, analysis, `${path}.right`);
  if (right.kind === "unsupported") return right;

  const leftEnvelope = left.envelope;
  const rightEnvelope = right.envelope;
  const logicalArithmetic = validateLogicalArithmetic(target, path);
  if (logicalArithmetic.kind === "unsupported") return logicalArithmetic;
  const nullable =
    leftEnvelope.nullable ||
    rightEnvelope.nullable ||
    target.operator === "div";
  let envelope: NumericEnvelope;

  if (leftEnvelope.alwaysNull || rightEnvelope.alwaysNull) {
    envelope = {
      minimum: 0,
      maximum: 0,
      integral: false,
      nullable: true,
      alwaysNull: true,
    };
  } else if (target.operator === "div") {
    if (rightEnvelope.minimum === 0 && rightEnvelope.maximum === 0) {
      envelope = {
        minimum: 0,
        maximum: 0,
        integral: false,
        nullable: true,
        alwaysNull: true,
      };
    } else {
      const crossesZero =
        rightEnvelope.minimum <= 0 && rightEnvelope.maximum >= 0;
      if (crossesZero && !rightEnvelope.integral)
        return {
          kind: "unsupported",
          path: `${path}.right`,
          code: "count_sql_unbounded_division",
          reason:
            "A fractional arithmetic denominator can approach zero, so its quotient range is not safely bounded.",
        };
      const minimumNonZeroDenominator = crossesZero
        ? 1
        : Math.min(
            Math.abs(rightEnvelope.minimum),
            Math.abs(rightEnvelope.maximum),
          );
      const numeratorMagnitude = Math.max(
        Math.abs(leftEnvelope.minimum),
        Math.abs(leftEnvelope.maximum),
      );
      const quotientMagnitude = numeratorMagnitude / minimumNonZeroDenominator;
      envelope = {
        minimum: -quotientMagnitude,
        maximum: quotientMagnitude,
        integral: false,
        nullable,
        alwaysNull: false,
      };
    }
  } else {
    let minimum: number;
    let maximum: number;
    if (target.operator === "add") {
      minimum = leftEnvelope.minimum + rightEnvelope.minimum;
      maximum = leftEnvelope.maximum + rightEnvelope.maximum;
    } else if (target.operator === "sub") {
      minimum = leftEnvelope.minimum - rightEnvelope.maximum;
      maximum = leftEnvelope.maximum - rightEnvelope.minimum;
    } else {
      const products = [
        leftEnvelope.minimum * rightEnvelope.minimum,
        leftEnvelope.minimum * rightEnvelope.maximum,
        leftEnvelope.maximum * rightEnvelope.minimum,
        leftEnvelope.maximum * rightEnvelope.maximum,
      ];
      minimum = Math.min(...products);
      maximum = Math.max(...products);
    }
    envelope = {
      minimum,
      maximum,
      integral: leftEnvelope.integral && rightEnvelope.integral,
      nullable,
      alwaysNull: false,
    };
  }

  if (
    !Number.isFinite(envelope.minimum) ||
    !Number.isFinite(envelope.maximum) ||
    Math.max(Math.abs(envelope.minimum), Math.abs(envelope.maximum)) >=
      MAX_CONSERVATIVE_BINARY64_MAGNITUDE
  )
    return {
      kind: "unsupported",
      path,
      code: "count_sql_numeric_range_exceeds_binary64_margin",
      reason:
        "The count arithmetic can approach binary64 overflow; this whole Filter tree must use the compatibility evaluator.",
    };

  return { kind: "supported", envelope };
}

function visitExpression(
  expression: FilterExpression,
  analysis: ReturnType<typeof analyzeFilterDocument>,
  path: string,
  allowQualifiedGeoBareFields = false,
): AdvancedCountFilterSupport | undefined {
  if (expression.kind === "not")
    return visitExpression(
      expression.child,
      analysis,
      `${path}.child`,
      allowQualifiedGeoBareFields,
    );
  if (expression.kind === "and" || expression.kind === "or") {
    for (const [index, child] of expression.children.entries()) {
      const result = visitExpression(
        child,
        analysis,
        `${path}.children[${index}]`,
        allowQualifiedGeoBareFields,
      );
      if (result) return result;
    }
    return undefined;
  }
  if (expression.kind !== "condition")
    return unsupported(
      path,
      "count_sql_unknown_expression",
      "The expression kind is outside the count SQL capability.",
    );

  const condition = expression;
  const conditionPath = `${path}.target`;
  const conditionSemantics = analysis.conditions.get(condition);
  if (!conditionSemantics)
    return unsupported(
      path,
      "count_sql_condition_not_analyzed",
      "The condition is missing from the validated Filter analysis.",
    );
  if (condition.target.kind === "field") {
    if (conditionSemantics.valueType.kind !== "scalar")
      return unsupported(
        conditionPath,
        "count_sql_bare_field_requires_registered_scalar",
        "Top-level bare-field leaves require one of the supported registered scalar fields.",
      );
    if (conditionSemantics.valueType.scalar === "string")
      return bareStringFieldConditionSupport(condition, path, {
        allowQualifiedGeo: allowQualifiedGeoBareFields,
      });
    if (conditionSemantics.valueType.scalar === "number")
      return bareNumericFieldConditionSupport(condition, path);
    return unsupported(
      conditionPath,
      "count_sql_bare_field_requires_registered_scalar",
      "Top-level bare-field leaves require one of the supported registered scalar fields.",
    );
  }

  if (condition.operator === "exists" || condition.operator === "notExists") {
    if (condition.value !== undefined)
      return unsupported(
        path,
        "count_sql_presence_test_has_value",
        "Collection presence tests cannot carry a comparison value.",
      );
    const collection = resolveAdvancedCountFiniteCollection(condition.target);
    if (!collection)
      return unsupported(
        conditionPath,
        "count_sql_finite_collection_required",
        "SQL presence tests require a finite Page/Event collection, selector, or registered collection member.",
      );
    if (collection.kind === "selector") {
      const selectorSupport = countSelectorSupport(
        collection.selector,
        conditionPath,
      );
      if (selectorSupport) return selectorSupport;
    }
    return undefined;
  }

  const target = targetNumericEnvelope(
    condition.target,
    analysis,
    conditionPath,
  );
  if (target.kind === "unsupported") return target;
  if (
    conditionSemantics.valueType.kind !== "scalar" ||
    conditionSemantics.valueType.scalar !== "number"
  )
    return unsupported(
      path,
      "count_sql_requires_numeric_condition",
      "The validated condition does not compare a numeric count expression.",
    );

  if (condition.operator === "isNull" || condition.operator === "notNull") {
    if (condition.value !== undefined)
      return unsupported(
        path,
        "count_sql_null_test_has_value",
        "Null tests cannot carry a comparison value.",
      );
    return undefined;
  }

  if (COUNT_SET_OPERATORS.has(condition.operator)) {
    if (!Array.isArray(condition.value) || condition.value.length === 0)
      return unsupported(
        `${path}.value`,
        "count_sql_requires_nonempty_numeric_set",
        "Count set predicates require a non-empty numeric or all-NULL value list.",
      );
    if (condition.value.every((value) => value === null)) return undefined;
    if (
      condition.value.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    )
      return unsupported(
        `${path}.value`,
        "count_sql_requires_finite_numeric_set",
        "Count set predicates require finite numeric values or an all-NULL list.",
      );
    return undefined;
  }
  if (condition.operator === "between") {
    if (!Array.isArray(condition.value) || condition.value.length !== 2)
      return unsupported(
        `${path}.value`,
        "count_sql_requires_numeric_range",
        "Count between predicates require exactly two finite numeric endpoints.",
      );
    const [lower, upper] = condition.value;
    if (
      typeof lower !== "number" ||
      !Number.isFinite(lower) ||
      typeof upper !== "number" ||
      !Number.isFinite(upper)
    )
      return unsupported(
        `${path}.value`,
        "count_sql_requires_numeric_range",
        "Count between predicates require exactly two finite numeric endpoints.",
      );
    if (lower > upper)
      return unsupported(
        `${path}.value`,
        "count_sql_reversed_numeric_range",
        "Count between endpoints must remain ordered from lower to upper.",
      );
    return undefined;
  }
  if (!COUNT_COMPARISONS.has(condition.operator))
    return unsupported(
      path,
      "count_sql_unsupported_operator",
      `The ${condition.operator} operator is not supported by the count SQL slice.`,
    );
  if (typeof condition.value !== "number" || !Number.isFinite(condition.value))
    return unsupported(
      `${path}.value`,
      "count_sql_requires_finite_number",
      "Count comparisons require one finite numeric value.",
    );
  return undefined;
}

/** Pure whole-tree preflight; unsupported trees stay on the legacy path. */
export function classifyAdvancedCountFilter(
  input: FilterDocument,
  scope: FilterRelationScope,
  options: { readonly allowPrivateQualifiedGeoBareFields?: true } = {},
): AdvancedCountFilterSupport {
  if (scope !== "session" && scope !== "visitor")
    return unsupported(
      "root",
      "count_sql_requires_session_or_visitor_scope",
      "The SQL count slice only supports Session and Visitor scope.",
    );

  let document: FilterDocument;
  let analysis: ReturnType<typeof analyzeFilterDocument>;
  try {
    document = normalizeFilterDocument(input, analyticsFilterRegistry);
    analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
    validateFilterConditionDomains(document, scope, analyticsFilterRegistry);
    validateFilterRelationDomains(document, scope, analysis);
  } catch (error) {
    return error instanceof FilterValidationError
      ? unsupported(error.path, error.code, error.message)
      : unsupported(
          "root",
          "count_sql_invalid_analysis",
          error instanceof Error ? error.message : String(error),
        );
  }

  if (!document.root)
    return unsupported(
      "root",
      "count_sql_requires_filter_expression",
      "An empty FilterDocument has no count predicate to lower.",
    );
  const result = visitExpression(
    document.root,
    analysis,
    "root",
    options.allowPrivateQualifiedGeoBareFields === true,
  );
  if (result) return result;
  const payloadPaths = advancedCountPayloadPaths(document.root);
  if (
    payloadPaths.length > 0 &&
    !advancedCountRegisteredStringLiteralsAreAscii(document.root)
  )
    return unsupported(
      "root",
      "count_sql_payload_registered_non_ascii_literal",
      "Registered string literals in a payload count tree must be ASCII in this slice.",
    );
  const numericCompatibilityRequirements =
    deriveAdvancedFilterNumericCompatibilityRequirements(document.root);
  if (payloadPaths.length > 0 && numericCompatibilityRequirements.length > 0)
    return unsupported(
      "root",
      "count_sql_payload_numeric_proof_unsupported",
      "Payload selector counts cannot yet combine with registered numeric-proof fields.",
    );
  return {
    kind: "supported",
    path: "root",
    code: "supported_count_sql",
    reason: "The complete Filter tree fits the bounded count SQL capability.",
    document,
    analysis,
    numericCompatibilityFieldIds: numericCompatibilityRequirements.map(
      ({ fieldId }) => fieldId,
    ),
    numericCompatibilityRequirements,
  };
}
