import { useMemo } from "react";
import { RiAddLine, RiDeleteBinLine } from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  type FilterOperator,
  type FilterScope,
  type FilterValueKind,
} from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import {
  allowedFields,
  fieldLabel,
  isSelectablePayloadFieldType,
  registryFieldGroups,
} from "./field-catalog";
import type {
  EditorCondition,
  EditorGroup,
  EditorNode,
  FilterPanelAudience,
} from "./model";
import { filterValueText, firstOperator, VALUELESS_OPERATORS } from "./model";
import {
  RangeValueInput,
  SearchablePayloadPathInput,
  SearchableValueInput,
} from "./value-inputs";
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
  const definition = analyticsFilterRegistry.get(condition.field);
  const fields = useMemo(
    () => allowedFields(audience, observationOnly),
    [audience, observationOnly],
  );
  const operators = useMemo(
    () => [...(definition?.operators ?? [])],
    [definition],
  );
  const groupedFields = useMemo(
    () => registryFieldGroups(fields, messages),
    [fields, messages],
  );
  const isPayload = condition.field === "event.payload";
  const needsValue = !VALUELESS_OPERATORS.has(condition.operator);
  const valueDisabled = isPayload && !condition.payloadPath.trim();
  const valueIsBoolean =
    needsValue &&
    (definition?.valueKind === "boolean" ||
      (isPayload && condition.scalarKind === "boolean"));
  const valueIsNumber =
    definition?.valueKind === "number" ||
    (isPayload && condition.scalarKind === "number");
  const editorValueKind: FilterValueKind = isPayload
    ? condition.scalarKind
    : (definition?.valueKind ?? "string");
  const valueIsRange = condition.operator === "between";

  const setField = (field: string) => {
    const nextDefinition = analyticsFilterRegistry.get(field);
    if (!nextDefinition) return;
    onChange((current) => ({
      ...current,
      field,
      payloadPath: "",
      operator: firstOperator(nextDefinition),
      value: undefined,
      listValues: undefined,
      valueText: "",
      scalarKind: "string",
      valueDirty: true,
    }));
  };

  const setOperator = (operator: string) => {
    if (!operators.includes(operator as FilterOperator)) return;
    onChange((current) => ({
      ...current,
      operator: operator as FilterOperator,
      value: VALUELESS_OPERATORS.has(operator as FilterOperator)
        ? undefined
        : current.value,
      valueDirty: !VALUELESS_OPERATORS.has(operator as FilterOperator),
    }));
  };

  return (
    <div className="grid gap-2 border-l border-border pl-3 pb-3 sm:grid-cols-2">
      <div className="text-xs font-medium text-muted-foreground sm:col-span-2">
        {formatI18nTemplate(messages.filterBuilder.condition, {
          index: path.join("."),
        })}
      </div>
      <div className={cn("space-y-1.5", isPayload && "sm:col-span-2")}>
        <Select value={condition.field} onValueChange={setField}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {groupedFields.map((group, index) => (
              <SelectGroup key={group.key}>
                {index > 0 ? <SelectSeparator /> : null}
                <SelectLabel>{group.label}</SelectLabel>
                {group.fields.map((field) => (
                  <SelectItem key={field.id} value={field.id}>
                    {fieldLabel(field, messages)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isPayload ? (
        <div className="space-y-1.5 sm:col-span-2">
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
              onChange((current) => ({ ...current, payloadPath }));
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
              }));
            }}
          />
        </div>
      ) : null}

      {isPayload && needsValue ? (
        <div className="space-y-1.5">
          <Select
            value={condition.scalarKind}
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

      {!isPayload ? (
        <div className="space-y-1.5">
          <Select value={condition.operator} onValueChange={setOperator}>
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
      ) : null}

      {isPayload ? (
        <div className={cn("space-y-1.5", !needsValue && "sm:col-span-2")}>
          <Select value={condition.operator} onValueChange={setOperator}>
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
      ) : null}

      {needsValue ? (
        <div className="space-y-1.5 sm:col-span-2">
          {valueIsBoolean ? (
            <Select
              disabled={valueDisabled}
              value={condition.valueText || undefined}
              onValueChange={(value) => {
                onChange((current) => ({
                  ...current,
                  valueText: value,
                  valueDirty: true,
                }));
              }}
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
              condition={condition}
              disabled={valueDisabled}
              inputMode={valueIsNumber ? "decimal" : undefined}
              messages={messages}
              numberMetadata={definition?.number}
              numberUnit={valueIsNumber ? definition?.unit : undefined}
              onChange={(valueText) => {
                onChange((current) => ({
                  ...current,
                  valueText,
                  valueDirty: true,
                }));
              }}
            />
          ) : (
            <SearchableValueInput
              condition={condition}
              disabled={valueDisabled}
              document={document}
              eventName={eventName}
              messages={messages}
              siteId={siteId}
              resolvedScope={resolvedScope}
              valueKind={editorValueKind}
              window={window}
              onChange={(valueText) => {
                onChange((current) => ({
                  ...current,
                  valueText,
                  valueDirty: true,
                }));
              }}
              onListChange={(listValues) => {
                onChange((current) => ({
                  ...current,
                  listValues,
                  valueText: listValues.map(filterValueText).join(", "),
                  valueDirty: true,
                }));
              }}
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
      className={cn("space-y-3", isRoot ? "" : "border-l border-border pl-3")}
    >
      <div className="space-y-2">
        <div className="max-w-[15rem] space-y-1.5">
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
        <div className="space-y-3">
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
