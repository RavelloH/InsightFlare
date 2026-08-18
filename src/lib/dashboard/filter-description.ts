import {
  type ConditionDescriptionNode,
  describeConditionTree,
} from "@/lib/conditions/description";
import {
  type FilterCondition,
  type FilterExpression,
  type FilterFieldRegistry,
  type FilterValue,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";

type FilterDescriptionMessages = Pick<
  AppMessages,
  "conditionDescription" | "filterBuilder"
>;

function descriptionNode(
  expression: FilterExpression,
): ConditionDescriptionNode<FilterCondition> {
  if (expression.kind === "condition") {
    return { kind: "condition", condition: expression };
  }
  if (expression.kind === "not") {
    return { kind: "not", child: descriptionNode(expression.child) };
  }
  return {
    kind: expression.kind,
    children: expression.children.map(descriptionNode),
  };
}

function formatValue(value: FilterValue): string {
  return JSON.stringify(value);
}

function isFilterValueList(
  value: FilterCondition["value"],
): value is readonly FilterValue[] {
  return Array.isArray(value);
}

function formatValues(
  value: readonly FilterValue[],
  messages: FilterDescriptionMessages,
): string {
  return value.map(formatValue).join(` ${messages.conditionDescription.or} `);
}

function fieldDescription(
  condition: FilterCondition,
  registry: FilterFieldRegistry,
  messages: FilterDescriptionMessages,
): string {
  if (condition.target.kind === "event-payload") {
    const label =
      messages.filterBuilder.fieldLabels["event.payload"] ?? "event.payload";
    return `${label} (${condition.target.path})`;
  }
  const field = registry.get(condition.target.field);
  return (
    messages.filterBuilder.fieldLabels[field?.id ?? condition.target.field] ??
    condition.target.field
  );
}

function conditionDescription(
  condition: FilterCondition,
  registry: FilterFieldRegistry,
  messages: FilterDescriptionMessages,
): string {
  const field = fieldDescription(condition, registry, messages);
  const operator =
    messages.filterBuilder.operatorLabels[condition.operator] ??
    condition.operator;
  if (condition.value === undefined) return `${field} ${operator}`;
  const value = condition.value;
  if (condition.operator === "eq" && !isFilterValueList(value)) {
    return formatI18nTemplate(messages.conditionDescription.filterEquals, {
      field,
      value: formatValue(value),
    });
  }
  if (condition.operator === "neq" && !isFilterValueList(value)) {
    return formatI18nTemplate(messages.conditionDescription.filterNotEquals, {
      field,
      value: formatValue(value),
    });
  }
  if (condition.operator === "startsWith" && !isFilterValueList(value)) {
    return formatI18nTemplate(messages.conditionDescription.filterStartsWith, {
      field,
      value: formatValue(value),
    });
  }
  if (condition.operator === "endsWith" && !isFilterValueList(value)) {
    return formatI18nTemplate(messages.conditionDescription.filterEndsWith, {
      field,
      value: formatValue(value),
    });
  }
  if (isFilterValueList(value)) {
    if (condition.operator === "in") {
      return formatI18nTemplate(messages.conditionDescription.filterAnyOf, {
        field,
        values: formatValues(value, messages),
      });
    }
    if (condition.operator === "notIn") {
      return formatI18nTemplate(messages.conditionDescription.filterNoneOf, {
        field,
        values: formatValues(value, messages),
      });
    }
    if (condition.operator === "between" && value.length === 2) {
      return formatI18nTemplate(messages.conditionDescription.filterBetween, {
        field,
        from: formatValue(value[0]!),
        to: formatValue(value[1]!),
      });
    }
    return `${field} ${operator} ${formatValues(value, messages)}`;
  }
  return `${field} ${operator} ${formatValue(value)}`;
}

export function describeFilterExpression(
  expression: FilterExpression | null | undefined,
  registry: FilterFieldRegistry,
  messages: FilterDescriptionMessages,
): string {
  return describeConditionTree(
    expression ? descriptionNode(expression) : null,
    {
      empty: messages.conditionDescription.emptyFilter,
      conjunction: messages.conditionDescription.and,
      disjunction: messages.conditionDescription.or,
      describeCondition: (condition) =>
        conditionDescription(condition, registry, messages),
      negate: (description) =>
        formatI18nTemplate(messages.conditionDescription.not, { description }),
    },
  );
}
