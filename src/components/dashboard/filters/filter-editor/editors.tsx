import { useMemo, useState } from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiSearchLine,
} from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverlayScrollbar } from "@/components/ui/overlay-scrollbar";
import { Popover } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
import { filterPickerTargetForValue } from "@/lib/filter-contract/filter-picker-registry";
import {
  analyticsFilterRegistry,
  type FilterCondition,
  type FilterDocument,
  type FilterDurationTarget,
  type FilterOperator,
  type FilterScope,
  type FilterTimeAnchorTarget,
  type FilterValue,
  type FilterValueKind,
} from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import {
  createAdvancedFilterCondition,
  createFilterPickerTargetCondition,
  filterOperatorsForTarget,
  filterValueKindForTarget,
} from "./advanced-editor-model";
import {
  dateTimeInputValueToLiteral,
  dateTimeLiteralToInputValue,
} from "./datetime-input";
import {
  allowedFields,
  filterPickerGroups,
  isSelectablePayloadFieldType,
} from "./field-catalog";
import type {
  EditorCondition,
  EditorGroup,
  EditorNode,
  FilterPanelAudience,
} from "./model";
import {
  advancedFilterFieldValue,
  advancedFilterFieldValueForTarget,
  advancedFilterTargetKindFromField,
  filterValueText,
  firstOperator,
  VALUELESS_OPERATORS,
} from "./model";
import {
  RangeValueInput,
  SearchablePayloadPathInput,
  SearchableValueInput,
} from "./value-inputs";

function advancedConditionForEditor(
  condition: EditorCondition,
): FilterCondition | undefined {
  if (condition.advancedExpression?.kind === "condition")
    return condition.advancedExpression;
  if (!condition.advancedText) return undefined;
  try {
    const parsed = parseFilterDsl(
      condition.advancedText,
      analyticsFilterRegistry,
    );
    return parsed.root?.kind === "condition" ? parsed.root : undefined;
  } catch {
    return undefined;
  }
}

function isFilterTargetExpression(
  value: FilterCondition["value"],
): value is FilterDurationTarget | FilterTimeAnchorTarget {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value,
  );
}

function editorTextFromFilterValue(
  value: FilterValue | readonly FilterValue[],
): string {
  return Array.isArray(value)
    ? value.map(filterValueText).join(", ")
    : value === null
      ? "null"
      : String(value);
}

function parseAdvancedLiteral(
  raw: string,
  valueKind: FilterValueKind,
  scalarKind: EditorCondition["scalarKind"],
): FilterValue {
  if (valueKind === "number" || scalarKind === "number") return Number(raw);
  if (valueKind === "boolean" || scalarKind === "boolean")
    return raw === "true";
  if (valueKind === "json-scalar" && raw === "null") return null;
  return raw;
}

function ConditionEditor({
  audience,
  condition,
  document,
  eventName,
  messages,
  observationOnly = false,
  path,
  resolvedScope,
  onChange,
  onRemove,
  siteId,
  window,
}: {
  audience: FilterPanelAudience;
  condition: EditorCondition;
  document: FilterDocument;
  eventName: string | undefined;
  messages: AppMessages;
  observationOnly?: boolean;
  path: readonly number[];
  resolvedScope?: FilterScope;
  onChange: (update: (condition: EditorCondition) => EditorCondition) => void;
  onRemove: () => void;
  siteId: string | undefined;
  window: TimeWindow | undefined;
}) {
  const advancedCondition = advancedConditionForEditor(condition);
  const advancedTarget = advancedCondition?.target;
  const advancedField = advancedCondition
    ? advancedFilterFieldValueForTarget(advancedCondition.target)
    : condition.field;
  const field =
    advancedCondition?.target.kind === "field"
      ? advancedCondition.target.field
      : advancedCondition?.target.kind === "event-payload"
        ? "event.payload"
        : condition.field;
  const definition = analyticsFilterRegistry.get(field);
  const fields = useMemo(
    () => allowedFields(audience, observationOnly),
    [audience, observationOnly],
  );
  const operators = advancedCondition
    ? filterOperatorsForTarget(advancedCondition.target)
    : [...(definition?.operators ?? [])];
  const groupedFields = useMemo(
    () =>
      filterPickerGroups(fields, messages).flatMap((group) => {
        const selectableFields = observationOnly
          ? group.fields.filter((option) => option.registeredField)
          : group.fields;
        return selectableFields.length > 0
          ? [{ ...group, fields: selectableFields }]
          : [];
      }),
    [fields, messages, observationOnly],
  );
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const [fieldSearch, setFieldSearch] = useState("");
  const normalizedFieldSearch = fieldSearch.trim().toLocaleLowerCase();
  const filteredFieldGroups = useMemo(
    () =>
      groupedFields.flatMap((group) => {
        const groupMatches =
          normalizedFieldSearch.length === 0 ||
          group.label.toLocaleLowerCase().includes(normalizedFieldSearch) ||
          group.key.toLocaleLowerCase().includes(normalizedFieldSearch);
        const matchingFields = groupMatches
          ? group.fields
          : group.fields.filter((field) =>
              field.searchText
                .toLocaleLowerCase()
                .includes(normalizedFieldSearch),
            );
        return matchingFields.length > 0
          ? [{ ...group, fields: matchingFields }]
          : [];
      }),
    [groupedFields, messages, normalizedFieldSearch],
  );
  const advancedFieldKind = advancedFilterTargetKindFromField(advancedField);
  const selectedPickerField = groupedFields
    .flatMap((group) => group.fields)
    .find((pickerField) => pickerField.value === advancedField);
  const selectedFieldLabel =
    selectedPickerField?.label ??
    (advancedFieldKind
      ? messages.filterBuilder.advancedEditor.targetKinds[advancedFieldKind]
      : advancedField);
  const operator = advancedCondition?.operator ?? condition.operator;
  const needsValue = !VALUELESS_OPERATORS.has(operator);
  const isPayload = field === "event.payload";
  const valueDisabled = isPayload && !condition.payloadPath.trim();
  const advancedValue = advancedCondition?.value;
  const valueIsExpression = isFilterTargetExpression(advancedValue);
  const literalValue = advancedCondition
    ? valueIsExpression
      ? undefined
      : (advancedValue as FilterValue | readonly FilterValue[] | undefined)
    : condition.value;
  const listValues = Array.isArray(literalValue)
    ? literalValue
    : condition.listValues;
  const scalarValue = Array.isArray(literalValue)
    ? literalValue[0]
    : literalValue;
  const scalarKind =
    typeof scalarValue === "number"
      ? "number"
      : typeof scalarValue === "boolean"
        ? "boolean"
        : condition.scalarKind;
  const editorValueKind: FilterValueKind = advancedTarget
    ? filterValueKindForTarget(advancedTarget)
    : isPayload
      ? scalarKind
      : (definition?.valueKind ?? "string");
  const valueText = advancedCondition
    ? literalValue === undefined
      ? ""
      : editorValueKind === "datetime"
        ? (Array.isArray(literalValue) ? literalValue : [literalValue])
            .map((value) =>
              dateTimeLiteralToInputValue(value, window?.timeZone),
            )
            .join(", ")
        : editorTextFromFilterValue(literalValue)
    : condition.valueText;
  const controlCondition: EditorCondition = advancedCondition
    ? {
        ...condition,
        field,
        operator,
        value: literalValue,
        listValues,
        valueText,
        scalarKind,
        valueDirty: false,
      }
    : condition;
  const valueIsBoolean =
    needsValue &&
    ((advancedTarget
      ? filterValueKindForTarget(advancedTarget) === "boolean"
      : definition?.valueKind === "boolean") ||
      (isPayload && scalarKind === "boolean"));
  const valueIsNumber =
    (advancedTarget
      ? filterValueKindForTarget(advancedTarget) === "number"
      : definition?.valueKind === "number") ||
    (isPayload && scalarKind === "number");
  const valueIsRange = operator === "between";
  const patchAdvanced = (update: Partial<FilterCondition>) => {
    if (!advancedCondition) return;
    onChange((current) => ({
      ...current,
      advancedExpression: { ...advancedCondition, ...update },
      advancedText: undefined,
    }));
  };

  const setField = (field: string) => {
    const registeredTarget = filterPickerTargetForValue(field);
    const advancedTargetKind = advancedFilterTargetKindFromField(field);
    if (registeredTarget || advancedTargetKind || field === "__advanced__") {
      const nextCondition = registeredTarget
        ? createFilterPickerTargetCondition(
            registeredTarget.selection,
            audience,
          )
        : createAdvancedFilterCondition(
            advancedTargetKind ?? "reducer",
            audience,
          );
      const nextValue = isFilterTargetExpression(nextCondition.value)
        ? undefined
        : (nextCondition.value as
            FilterValue | readonly FilterValue[] | undefined);
      onChange((current) => ({
        ...current,
        field:
          registeredTarget || advancedTargetKind
            ? field
            : advancedFilterFieldValue("reducer"),
        operator: nextCondition.operator,
        value: nextValue,
        listValues: Array.isArray(nextValue) ? nextValue : undefined,
        valueText:
          nextValue === undefined ? "" : editorTextFromFilterValue(nextValue),
        scalarKind:
          typeof (Array.isArray(nextValue) ? nextValue[0] : nextValue) ===
          "number"
            ? "number"
            : typeof (Array.isArray(nextValue) ? nextValue[0] : nextValue) ===
                "boolean"
              ? "boolean"
              : "string",
        valueDirty: false,
        payloadPath: "",
        advancedExpression: nextCondition,
        advancedText: undefined,
      }));
      return;
    }
    const nextDefinition = analyticsFilterRegistry.get(field);
    if (!nextDefinition) return;
    onChange((current) => {
      const {
        advancedExpression: _advancedExpression,
        advancedText: _advancedText,
        ...basic
      } = current;
      return {
        ...basic,
        field,
        payloadPath: "",
        operator: firstOperator(nextDefinition),
        value: undefined,
        listValues: undefined,
        valueText: "",
        scalarKind: "string",
        valueDirty: true,
      };
    });
  };

  const setOperator = (operator: string) => {
    if (!operators.includes(operator as FilterOperator)) return;
    if (advancedCondition) {
      const nextOperator = operator as FilterOperator;
      patchAdvanced({
        operator: nextOperator,
        ...(VALUELESS_OPERATORS.has(nextOperator) ? { value: undefined } : {}),
      });
      return;
    }
    onChange((current) => ({
      ...current,
      operator: operator as FilterOperator,
      value: VALUELESS_OPERATORS.has(operator as FilterOperator)
        ? undefined
        : current.value,
      valueDirty: !VALUELESS_OPERATORS.has(operator as FilterOperator),
    }));
  };

  const setValue = (value: FilterCondition["value"]) => {
    if (advancedCondition) {
      patchAdvanced({ value });
      return;
    }
    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) &&
        value.every(
          (item) =>
            item === null ||
            ["string", "number", "boolean"].includes(typeof item),
        ))
    ) {
      onChange((current) => ({
        ...current,
        value: value as FilterValue | readonly FilterValue[] | undefined,
        listValues: Array.isArray(value)
          ? (value as readonly FilterValue[])
          : undefined,
        valueText:
          value === undefined
            ? ""
            : editorTextFromFilterValue(
                value as FilterValue | readonly FilterValue[],
              ),
        valueDirty: true,
      }));
    }
  };

  const setValueText = (nextValueText: string) => {
    if (advancedCondition) {
      const scalar = (raw: string) =>
        editorValueKind === "datetime"
          ? dateTimeInputValueToLiteral(raw.trim(), window?.timeZone)
          : parseAdvancedLiteral(raw.trim(), editorValueKind, scalarKind);
      const values =
        valueIsRange || operator === "in" || operator === "notIn"
          ? nextValueText.split(",").map(scalar)
          : undefined;
      patchAdvanced({
        value:
          values ??
          ((nextValueText === ""
            ? undefined
            : scalar(nextValueText)) as FilterCondition["value"]),
      });
      return;
    }
    onChange((current) => ({
      ...current,
      valueText: nextValueText,
      valueDirty: true,
    }));
  };

  return (
    <div className="grid gap-2 border-l border-border pl-3 pb-3 sm:grid-cols-2">
      <div className="text-xs font-medium text-muted-foreground sm:col-span-2">
        {formatI18nTemplate(messages.filterBuilder.condition, {
          index: path.join("."),
        })}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:col-span-2 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Popover.Root
            open={fieldPickerOpen}
            onOpenChange={(open) => {
              setFieldPickerOpen(open);
              if (open) setFieldSearch("");
            }}
          >
            <Popover.Trigger asChild>
              <Button
                type="button"
                variant="outline"
                className="h-8 w-full justify-between gap-1.5 border-input bg-transparent py-2 pr-2 pl-2.5 text-xs font-normal whitespace-nowrap dark:bg-input/30"
              >
                <span className="min-w-0 truncate text-left">
                  {selectedFieldLabel}
                </span>
                <RiArrowDownSLine className="size-4 shrink-0 text-muted-foreground" />
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="start"
                sideOffset={4}
                className="relative w-[var(--radix-popover-trigger-width)] origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-none bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
              >
                <div className="relative">
                  <RiSearchLine
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    autoFocus
                    className="border-0 pl-9 text-xs shadow-none focus-visible:ring-0"
                    value={fieldSearch}
                    placeholder={messages.common.search}
                    onChange={(event) => setFieldSearch(event.target.value)}
                  />
                </div>
                <OverlayScrollbar
                  axis="vertical"
                  syncKey={`${normalizedFieldSearch}:${filteredFieldGroups
                    .map((group) => group.fields.length)
                    .join(",")}`}
                  className="max-h-72 border-t border-border"
                >
                  <div>
                    {filteredFieldGroups.map((group, index) => (
                      <div key={group.key}>
                        {index > 0 ? (
                          <div
                            role="separator"
                            className="pointer-events-none -mx-1 h-px bg-border"
                          />
                        ) : null}
                        <div className="px-2 py-2 text-xs text-muted-foreground">
                          {group.label}
                        </div>
                        {group.fields.map((pickerField) => (
                          <button
                            key={pickerField.value}
                            type="button"
                            aria-pressed={advancedField === pickerField.value}
                            className="relative flex w-full cursor-default items-center gap-2 rounded-none py-2 pr-8 pl-2 text-left text-xs outline-hidden transition-colors select-none hover:bg-accent hover:text-accent-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                            onClick={() => {
                              setField(pickerField.value);
                              setFieldSearch("");
                              setFieldPickerOpen(false);
                            }}
                          >
                            <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                              {advancedField === pickerField.value ? (
                                <RiCheckLine className="pointer-events-none" />
                              ) : null}
                            </span>
                            <span className="min-w-0 truncate">
                              {pickerField.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                    {filteredFieldGroups.length === 0 ? (
                      <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                        {messages.common.noData}
                      </div>
                    ) : null}
                  </div>
                </OverlayScrollbar>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
        <div className="min-w-0 space-y-2">
          <Select value={operator} onValueChange={setOperator}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operators.map((operator) => (
                <SelectItem key={operator} value={operator}>
                  {messages.filterBuilder.operatorLabels[operator] ?? operator}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isPayload ? (
        <div className="space-y-2 sm:col-span-2">
          <SearchablePayloadPathInput
            condition={condition}
            document={document}
            eventName={eventName}
            messages={messages}
            needsValue={needsValue}
            resolvedScope={resolvedScope}
            siteId={siteId}
            window={window}
            onChange={(payloadPath) => {
              onChange((current) => ({
                ...current,
                payloadPath,
                ...(advancedCondition?.target.kind === "event-payload"
                  ? {
                      advancedExpression: {
                        ...advancedCondition,
                        target: {
                          ...advancedCondition.target,
                          path: payloadPath as never,
                        },
                        value: undefined,
                      },
                      advancedText: undefined,
                    }
                  : {}),
              }));
            }}
            onSelect={(field) => {
              onChange((current) => ({
                ...current,
                payloadPath: field.path,
                ...(isSelectablePayloadFieldType(field.valueType)
                  ? {
                      scalarKind: field.valueType,
                      value: undefined,
                      listValues: undefined,
                      valueText: "",
                      valueDirty: true,
                    }
                  : {}),
                ...(advancedCondition?.target.kind === "event-payload"
                  ? {
                      advancedExpression: {
                        ...advancedCondition,
                        target: {
                          ...advancedCondition.target,
                          path: field.path as never,
                        },
                        value: undefined,
                      },
                      advancedText: undefined,
                    }
                  : {}),
              }));
            }}
          />
        </div>
      ) : null}

      {isPayload && needsValue ? (
        <div className="space-y-2">
          <Select
            value={controlCondition.scalarKind}
            onValueChange={(value) => {
              if (
                value !== "string" &&
                value !== "number" &&
                value !== "boolean"
              ) {
                return;
              }
              onChange((current) => ({
                ...current,
                scalarKind: value,
                value: undefined,
                listValues: undefined,
                valueText: "",
                valueDirty: true,
              }));
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="string">
                {messages.filterBuilder.valueKinds.string}
              </SelectItem>
              <SelectItem value="number">
                {messages.filterBuilder.valueKinds.number}
              </SelectItem>
              <SelectItem value="boolean">
                {messages.filterBuilder.valueKinds.boolean}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {needsValue && !(advancedCondition && valueIsExpression) ? (
        <div className="space-y-2 sm:col-span-2">
          {valueIsBoolean ? (
            <Select
              disabled={valueDisabled}
              value={valueText || undefined}
              onValueChange={(value) => setValue(value === "true")}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={messages.filterBuilder.valueUnset} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">
                  {messages.filterBuilder.booleanTrue}
                </SelectItem>
                <SelectItem value="false">
                  {messages.filterBuilder.booleanFalse}
                </SelectItem>
              </SelectContent>
            </Select>
          ) : valueIsRange ? (
            <RangeValueInput
              condition={controlCondition}
              disabled={valueDisabled}
              inputMode={valueIsNumber ? "decimal" : undefined}
              messages={messages}
              numberMetadata={definition?.number}
              numberUnit={valueIsNumber ? definition?.unit : undefined}
              onChange={setValueText}
            />
          ) : (
            <SearchableValueInput
              condition={controlCondition}
              disabled={valueDisabled}
              document={document}
              eventName={eventName}
              messages={messages}
              siteId={siteId}
              resolvedScope={resolvedScope}
              valueKind={editorValueKind}
              window={window}
              onChange={setValueText}
              onListChange={setValue}
            />
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        <label className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={condition.negated}
            onCheckedChange={(checked) => {
              onChange((current) => ({
                ...current,
                negated: checked === true,
                notCount: checked === true ? 1 : 0,
              }));
            }}
          />
          {messages.filterBuilder.invertCondition}
        </label>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          aria-label={messages.teamManagement.notifications.removeCondition}
          onClick={onRemove}
        >
          <RiDeleteBinLine className="size-4" />
          <span className="sr-only">
            {messages.teamManagement.notifications.removeCondition}
          </span>
        </Button>
      </div>
    </div>
  );
}
export function GroupEditor({
  audience,
  document,
  eventName,
  group,
  isRoot,
  messages,
  observationOnly = false,
  path,
  resolvedScope,
  onAddCondition,
  onAddGroup,
  onChange,
  onRemove,
  siteId,
  window,
}: {
  audience: FilterPanelAudience;
  document: FilterDocument;
  eventName: string | undefined;
  group: EditorGroup;
  isRoot: boolean;
  messages: AppMessages;
  observationOnly?: boolean;
  path: readonly number[];
  resolvedScope?: FilterScope;
  onAddCondition: (groupId: string) => void;
  onAddGroup: (groupId: string) => void;
  onChange: (id: string, update: (node: EditorNode) => EditorNode) => void;
  onRemove: (id: string) => void;
  siteId: string | undefined;
  window: TimeWindow | undefined;
}) {
  return (
    <div
      className={cn("space-y-2", isRoot ? "" : "border-l border-border pl-3")}
    >
      <div className="space-y-2">
        <div className="max-w-[15rem] space-y-2">
          <Label>{messages.filterBuilder.match}</Label>
          <Select
            value={group.combinator}
            onValueChange={(value) => {
              if (value !== "and" && value !== "or") return;
              onChange(group.id, (node) =>
                node.kind === "group" ? { ...node, combinator: value } : node,
              );
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="and">
                {messages.filterBuilder.allConditions}
              </SelectItem>
              <SelectItem value="or">
                {messages.filterBuilder.anyCondition}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {!isRoot ? (
          <div className="text-xs font-medium text-muted-foreground">
            {formatI18nTemplate(messages.filterBuilder.group, {
              index: path.join("."),
            })}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 sm:col-span-2">
          {!isRoot ? (
            <label className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={group.negated}
                onCheckedChange={(checked) => {
                  onChange(group.id, (node) =>
                    node.kind === "group"
                      ? {
                          ...node,
                          negated: checked === true,
                          notCount: checked === true ? 1 : 0,
                        }
                      : node,
                  );
                }}
              />
              {messages.filterBuilder.exclude}
            </label>
          ) : null}
          {!isRoot ? (
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              aria-label={messages.teamManagement.notifications.removeCondition}
              onClick={() => onRemove(group.id)}
            >
              <RiDeleteBinLine className="size-4" />
              <span className="sr-only">
                {messages.teamManagement.notifications.removeCondition}
              </span>
            </Button>
          ) : null}
        </div>
      </div>

      <AutoResizer initial={false} duration={0.18}>
        <div className="space-y-2">
          <AnimatePresence initial={false} mode="popLayout">
            {group.children.map((child, index) => (
              <motion.div
                key={child.id}
                layout="position"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
              >
                {child.kind === "condition" ? (
                  <ConditionEditor
                    audience={audience}
                    condition={child}
                    document={document}
                    eventName={eventName}
                    messages={messages}
                    observationOnly={observationOnly}
                    path={[...path, index + 1]}
                    resolvedScope={resolvedScope}
                    siteId={siteId}
                    window={window}
                    onChange={(update) => {
                      onChange(child.id, (node) =>
                        node.kind === "condition" ? update(node) : node,
                      );
                    }}
                    onRemove={() => onRemove(child.id)}
                  />
                ) : (
                  <GroupEditor
                    audience={audience}
                    document={document}
                    eventName={eventName}
                    group={child}
                    isRoot={false}
                    messages={messages}
                    observationOnly={observationOnly}
                    path={[...path, index + 1]}
                    resolvedScope={resolvedScope}
                    onAddCondition={onAddCondition}
                    onAddGroup={onAddGroup}
                    onChange={onChange}
                    onRemove={onRemove}
                    siteId={siteId}
                    window={window}
                  />
                )}
              </motion.div>
            ))}
            <motion.div
              key="filter-actions"
              layout="position"
              transition={{ duration: 0.18 }}
              className="flex flex-wrap gap-2"
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => onAddCondition(group.id)}
              >
                <RiAddLine />
                <span>
                  {messages.teamManagement.notifications.addCondition}
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => onAddGroup(group.id)}
              >
                <RiAddLine />
                <span>{messages.filterBuilder.addGroup}</span>
              </Button>
            </motion.div>
          </AnimatePresence>
        </div>
      </AutoResizer>
    </div>
  );
}
