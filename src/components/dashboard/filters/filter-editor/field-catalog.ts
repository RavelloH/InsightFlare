import type { EventField } from "@/lib/dashboard-api/client/edge";
import {
  FILTER_PICKER_GROUP_ORDER,
  FILTER_PICKER_TARGET_REGISTRY,
  type FilterPickerGroup,
  type FilterPickerTargetRegistration,
} from "@/lib/filter-contract/filter-picker-registry";
import {
  analyticsFilterFieldDisplayOrder,
  type RegisteredFilterField,
} from "@/lib/filter-contract/filter-registry";
import {
  analyticsFilterRegistry,
  type FilterFieldDefinition,
} from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";

import type {
  EditorCondition,
  EditorGroup,
  FilterPanelAudience,
} from "./model";
type MessageRecord = Record<string, unknown>;
function readMessagePath(
  messages: AppMessages,
  path: string,
): string | undefined {
  let value: unknown = messages;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as MessageRecord)[segment];
  }
  return typeof value === "string" ? value : undefined;
}
export function fieldLabel(
  field: string | FilterFieldDefinition,
  messages: AppMessages,
): string {
  const fieldId = typeof field === "string" ? field : field.id;
  const labelKey =
    typeof field === "string"
      ? undefined
      : (field as RegisteredFilterField).labelKey;
  return (
    (labelKey ? readMessagePath(messages, labelKey) : undefined) ??
    messages.filterBuilder.fieldLabels[fieldId] ??
    fieldId
  );
}
function fieldGroupLabel(messages: AppMessages, key: string): string {
  if (key === "other") return messages.filterBuilder.expressionHelpOtherFields;
  const groups = (messages.filterBuilder as unknown as MessageRecord)
    .fieldGroups;
  return groups && typeof groups === "object"
    ? (((groups as MessageRecord)[key] as string | undefined) ?? key)
    : key;
}
export function registryFieldGroups(
  fields: readonly RegisteredFilterField[],
  messages: AppMessages,
): readonly {
  readonly key: string;
  readonly label: string;
  readonly fields: readonly RegisteredFilterField[];
}[] {
  const fieldsByGroup = new Map<string, RegisteredFilterField[]>();
  for (const field of fields) {
    const key = field.group ?? "other";
    const group = fieldsByGroup.get(key);
    if (group) group.push(field);
    else fieldsByGroup.set(key, [field]);
  }
  return [...fieldsByGroup].map(([key, group]) => ({
    key,
    label: fieldGroupLabel(messages, key),
    fields: group,
  }));
}

export function filterPickerGroups(
  fields: readonly RegisteredFilterField[],
  messages: AppMessages,
): readonly {
  readonly key: FilterPickerGroup;
  readonly label: string;
  readonly fields: readonly FilterPickerEntry[];
}[] {
  const fieldsByGroup = new Map<string, RegisteredFilterField[]>();
  for (const field of fields) {
    const group = fieldsByGroup.get(field.group);
    if (group) group.push(field);
    else fieldsByGroup.set(field.group, [field]);
  }

  const targetsByGroup = new Map<
    FilterPickerGroup,
    FilterPickerTargetRegistration[]
  >();
  for (const target of FILTER_PICKER_TARGET_REGISTRY) {
    const group = targetsByGroup.get(target.group);
    if (group) group.push(target);
    else targetsByGroup.set(target.group, [target]);
  }

  return FILTER_PICKER_GROUP_ORDER.flatMap((key) => {
    const entries: FilterPickerEntry[] = [
      ...(targetsByGroup.get(key) ?? []).map((target) => {
        const label =
          messages.filterBuilder.fieldLabels[target.labelKey] ?? target.id;
        return {
          id: target.id,
          value: target.value,
          label,
          searchText: `${label} ${target.id} ${target.value}`,
        };
      }),
      ...(fieldsByGroup.get(key) ?? []).map((field) => {
        const label = fieldLabel(field, messages);
        return {
          id: field.id,
          value: field.id,
          label,
          searchText: `${label} ${field.id}`,
          registeredField: field,
        };
      }),
    ];
    return entries.length > 0
      ? [{ key, label: fieldGroupLabel(messages, key), fields: entries }]
      : [];
  });
}

export interface FilterPickerEntry {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly searchText: string;
  readonly registeredField?: RegisteredFilterField;
}
export function allowedFields(
  audience: FilterPanelAudience,
  observationOnly = false,
): readonly RegisteredFilterField[] {
  return [...analyticsFilterRegistry.values()]
    .filter(
      (field) =>
        field.audiences.has(audience) &&
        (!observationOnly ||
          field.observationKinds.has("visit") ||
          field.observationKinds.has("event")),
    )
    .sort(
      (left, right) =>
        analyticsFilterFieldDisplayOrder.get(left.id)! -
        analyticsFilterFieldDisplayOrder.get(right.id)!,
    ) as RegisteredFilterField[];
}
export function directEventName(group: EditorGroup): string | undefined {
  const matches = group.children.filter(
    (node): node is EditorCondition =>
      node.kind === "condition" &&
      !node.negated &&
      node.field === "event.name" &&
      node.operator === "eq" &&
      node.valueText.trim().length > 0,
  );
  return matches.length === 1 ? matches[0]?.valueText.trim() : undefined;
}
export function isSelectablePayloadFieldType(
  valueType: EventField["valueType"],
): valueType is "string" | "number" | "boolean" {
  return (
    valueType === "string" || valueType === "number" || valueType === "boolean"
  );
}
export function payloadFieldTypeLabel(
  valueType: EventField["valueType"],
  messages: AppMessages,
): string {
  if (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "boolean"
  ) {
    return messages.filterBuilder.valueKinds[valueType];
  }
  return valueType;
}
