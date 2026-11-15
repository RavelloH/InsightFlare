import { preparePrimitiveFieldCondition } from "@/lib/edge/analytics/engine/filter-lowering";
import {
  countBareField,
  isQualifiedGeoBareField,
  qualifiedGeoConditionSupport,
} from "@/lib/edge/analytics/engine/semantic/count-bare-fields";
import {
  type AdvancedCountSelectorCollection,
  type AdvancedCountSelectorField,
  advancedCountSelectorField,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import { snapshotEventPayloadTopLevelPaths } from "@/lib/edge/analytics/engine/semantic/event-payload-logical";
import type {
  FilterCondition,
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

export interface CountSelectorUnsupported {
  readonly kind: "unsupported";
  readonly path: string;
  readonly code: string;
  readonly reason: string;
}

const COUNT_STRING_SELECTOR_OPERATORS = new Set([
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "exists",
  "notExists",
  "isNull",
  "notNull",
  "isEmpty",
  "notEmpty",
]);
const COUNT_NUMBER_SELECTOR_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "between",
  "isNull",
  "notNull",
  "exists",
  "notExists",
]);

function unsupported(
  path: string,
  code: string,
  reason: string,
): CountSelectorUnsupported {
  return { kind: "unsupported", path, code, reason };
}

type StringSelectorField = Extract<
  AdvancedCountSelectorField,
  { readonly kind: "string" }
>;

function stringFieldConditionSupport(
  condition: FilterCondition,
  path: string,
  selectorField: StringSelectorField,
): CountSelectorUnsupported | undefined {
  if (!COUNT_STRING_SELECTOR_OPERATORS.has(condition.operator))
    return unsupported(
      path,
      "count_sql_selector_unsupported_operator",
      `Count string predicates do not support the ${condition.operator} operator.`,
    );

  const values = Array.isArray(condition.value)
    ? condition.value
    : [condition.value];
  if (
    values.some(
      (value) => typeof value === "string" && hasUnpairedUtf16Surrogate(value),
    )
  )
    return unsupported(
      `${path}.value`,
      "count_sql_selector_unpaired_surrogate_literal",
      "The D1 string binding cannot preserve this unpaired UTF-16 surrogate; the complete Filter tree must use the compatibility evaluator.",
    );

  const prepared = preparePrimitiveFieldCondition(condition);
  if (prepared.kind === "unsupported")
    return unsupported(
      path,
      "count_sql_selector_field_unsupported",
      `The registered ${selectorField.fieldId} predicate is not supported by this string-field slice (${prepared.code}).`,
    );
  return undefined;
}

/** Shared descriptor and primitive preflight for top-level bare string leaves. */
export function bareStringFieldConditionSupport(
  condition: FilterCondition,
  path: string,
  options: { readonly allowQualifiedGeo?: boolean } = {},
): CountSelectorUnsupported | undefined {
  if (condition.target.kind !== "field")
    return unsupported(
      `${path}.target`,
      "count_sql_bare_field_requires_registered_string",
      "Top-level bare-field leaves support only the registered Page path/title/query/hash and Event name string fields.",
    );
  const field = options.allowQualifiedGeo
    ? countBareField(condition.target.field, true)
    : advancedCountSelectorField(condition.target.field);
  if (field && isQualifiedGeoBareField(field)) {
    const result = qualifiedGeoConditionSupport(condition, path, field);
    return result.kind === "unsupported"
      ? unsupported(result.path, result.code, result.reason)
      : undefined;
  }
  if (!field || field.kind !== "string")
    return unsupported(
      `${path}.target`,
      "count_sql_bare_field_requires_registered_string",
      "Top-level bare-field leaves support only the registered Page path/title/query/hash and Event name string fields.",
    );
  return stringFieldConditionSupport(condition, path, field);
}

/** Shared descriptor and primitive preflight for top-level bare numeric leaves. */
export function bareNumericFieldConditionSupport(
  condition: FilterCondition,
  path: string,
): CountSelectorUnsupported | undefined {
  if (condition.target.kind !== "field")
    return unsupported(
      `${path}.target`,
      "count_sql_bare_field_requires_registered_numeric",
      "Top-level bare numeric leaves require one of the registered Page numeric fields.",
    );
  const field = advancedCountSelectorField(condition.target.field);
  if (!field || field.kind !== "number")
    return unsupported(
      `${path}.target`,
      "count_sql_bare_field_requires_registered_numeric",
      "Top-level bare numeric leaves require one of the registered Page numeric fields.",
    );
  if (!COUNT_NUMBER_SELECTOR_OPERATORS.has(condition.operator))
    return unsupported(
      path,
      "count_sql_selector_unsupported_operator",
      `Bare numeric predicates do not support the ${condition.operator} operator.`,
    );

  const values = Array.isArray(condition.value)
    ? condition.value
    : [condition.value];
  if (
    values.some(
      (value) => typeof value === "string" && hasUnpairedUtf16Surrogate(value),
    )
  )
    return unsupported(
      `${path}.value`,
      "count_sql_selector_unpaired_surrogate_literal",
      "The D1 string binding cannot preserve this unpaired UTF-16 surrogate; the complete Filter tree must use the compatibility evaluator.",
    );

  const prepared = preparePrimitiveFieldCondition(condition);
  if (prepared.kind === "unsupported")
    return unsupported(
      path,
      "count_sql_selector_field_unsupported",
      `The registered ${field.fieldId} predicate is not supported by this numeric-field slice (${prepared.code}).`,
    );
  return undefined;
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1)
    if (value.charCodeAt(index) > 0x7f) return false;
  return true;
}

function eventPayloadConditionSupport(
  condition: FilterCondition,
  path: string,
): CountSelectorUnsupported | undefined {
  if (condition.target.kind !== "event-payload")
    return unsupported(
      `${path}.target`,
      "count_sql_payload_selector_requires_direct_path",
      "Payload count selectors support only direct top-level event.payload(path) leaves.",
    );
  try {
    snapshotEventPayloadTopLevelPaths([condition.target.path]);
  } catch {
    return unsupported(
      `${path}.target.path`,
      "count_sql_payload_selector_path_unsupported",
      "Payload count selectors require one supported top-level JSON pointer.",
    );
  }
  if (condition.operator === "isEmpty" || condition.operator === "notEmpty")
    return condition.value === undefined
      ? undefined
      : unsupported(
          `${path}.value`,
          "count_sql_payload_empty_test_has_value",
          "Payload empty tests do not carry comparison values.",
        );
  if (
    condition.operator !== "eq" &&
    condition.operator !== "neq" &&
    condition.operator !== "in" &&
    condition.operator !== "notIn"
  )
    return unsupported(
      path,
      "count_sql_payload_selector_unsupported_operator",
      `Payload count selectors do not support the ${condition.operator} operator.`,
    );
  const values =
    condition.operator === "in" || condition.operator === "notIn"
      ? condition.value
      : [condition.value];
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string")
  )
    return unsupported(
      `${path}.value`,
      "count_sql_payload_selector_requires_string_literals",
      "Payload comparison selectors require one string literal or a non-empty homogeneous string set.",
    );
  if (values.some((value) => typeof value === "string" && !isAscii(value)))
    return unsupported(
      `${path}.value`,
      "count_sql_payload_selector_non_ascii_literal",
      "Payload comparison literals must be ASCII in this count SQL slice.",
    );
  return undefined;
}

function unsupportedCountSelectorPredicate(
  expression: FilterExpression,
  collection: AdvancedCountSelectorCollection,
  path: string,
): CountSelectorUnsupported | undefined {
  if (expression.kind === "not")
    return unsupportedCountSelectorPredicate(
      expression.child,
      collection,
      `${path}.child`,
    );
  if (expression.kind === "and" || expression.kind === "or") {
    if (expression.children.length === 0)
      return unsupported(
        path,
        "count_sql_selector_requires_predicate",
        "A count selector Boolean group must contain at least one predicate.",
      );
    for (const [index, child] of expression.children.entries()) {
      const result = unsupportedCountSelectorPredicate(
        child,
        collection,
        `${path}.children[${index}]`,
      );
      if (result) return result;
    }
    return undefined;
  }
  if (expression.kind !== "condition")
    return unsupported(
      path,
      "count_sql_selector_requires_field_condition",
      "Count selectors support only registered same-entity field predicates.",
    );

  if (expression.target.kind === "event-payload")
    return collection === "event"
      ? eventPayloadConditionSupport(expression, path)
      : unsupported(
          `${path}.target`,
          "count_sql_selector_field_mismatch",
          `This count selector cannot read Event payload from its ${collection} selector slice.`,
        );

  const selectorField =
    expression.target.kind === "field"
      ? advancedCountSelectorField(expression.target.field)
      : undefined;
  if (!selectorField || selectorField.collection !== collection)
    return unsupported(
      `${path}.target`,
      "count_sql_selector_field_mismatch",
      `This count selector cannot read a field outside its ${collection} selector slice.`,
    );
  const selectorOperators =
    selectorField.kind === "string"
      ? COUNT_STRING_SELECTOR_OPERATORS
      : COUNT_NUMBER_SELECTOR_OPERATORS;
  if (!selectorOperators.has(expression.operator))
    return unsupported(
      path,
      "count_sql_selector_unsupported_operator",
      `Count selectors do not support the ${expression.operator} operator.`,
    );

  if (selectorField.kind === "string")
    return stringFieldConditionSupport(expression, path, selectorField);

  const values = Array.isArray(expression.value)
    ? expression.value
    : [expression.value];
  if (
    values.some(
      (value) => typeof value === "string" && hasUnpairedUtf16Surrogate(value),
    )
  )
    return unsupported(
      `${path}.value`,
      "count_sql_selector_unpaired_surrogate_literal",
      "The D1 string binding cannot preserve this unpaired UTF-16 surrogate; the complete Filter tree must use the compatibility evaluator.",
    );

  const prepared = preparePrimitiveFieldCondition(
    expression as FilterCondition,
  );
  if (prepared.kind === "unsupported")
    return unsupported(
      path,
      "count_sql_selector_field_unsupported",
      `The registered ${selectorField.fieldId} predicate is not supported by the count selector (${prepared.code}).`,
    );
  return undefined;
}

export function countSelectorSupport(
  input: FilterTargetExpression,
  path: string,
): CountSelectorUnsupported | undefined {
  if (
    input.kind !== "selector" ||
    input.collection.kind !== "entity-root" ||
    (input.collection.entity !== "page" && input.collection.entity !== "event")
  )
    return unsupported(
      path,
      "count_sql_selector_requires_page_or_event",
      "Count selectors require a Page or Event collection.",
    );
  return unsupportedCountSelectorPredicate(
    input.predicate,
    input.collection.entity,
    `${path}.predicate`,
  );
}
