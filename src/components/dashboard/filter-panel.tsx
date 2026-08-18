import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiFilterOffLine,
  RiSearchLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Popover } from "radix-ui";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverlayScrollbar } from "@/components/ui/overlay-scrollbar";
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
import { Spinner } from "@/components/ui/spinner";
import type { DashboardFilterOptionKey } from "@/lib/dashboard/client-data";
import {
  fetchEventTypeFieldValues,
  fetchFilterValues,
} from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  analyticsFilterRegistry,
  type CanonicalJsonPath,
  FILTER_DOCUMENT_VERSION,
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterFieldDefinition,
  type FilterFieldId,
  type FilterOperator,
  FilterValidationError,
  type FilterValue,
  type FilterValueKind,
  normalizeFilterDocument,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

type FilterPanelAudience = "private-dashboard" | "public-share";
type ScalarKind = "string" | "number" | "boolean";
type ValueSuggestion = {
  readonly value: string | number | boolean | null;
  readonly occurrences?: number;
  readonly label?: string;
};

interface EditorCondition {
  readonly id: string;
  readonly kind: "condition";
  readonly negated: boolean;
  readonly field: string;
  readonly payloadPath: string;
  readonly operator: FilterOperator;
  readonly value: FilterValue | readonly FilterValue[] | undefined;
  readonly valueText: string;
  readonly scalarKind: ScalarKind;
  readonly valueDirty: boolean;
}

interface EditorGroup {
  readonly id: string;
  readonly kind: "group";
  readonly negated: boolean;
  readonly combinator: "and" | "or";
  readonly children: readonly EditorNode[];
}

type EditorNode = EditorCondition | EditorGroup;

interface FilterPanelProps {
  readonly audience: FilterPanelAudience;
  readonly document: FilterDocument;
  readonly messages: AppMessages;
  readonly open: boolean;
  readonly siteId?: string;
  readonly window?: TimeWindow;
  readonly onApply: (document: FilterDocument) => void;
}

const VALUELESS_OPERATORS = new Set<FilterOperator>([
  "exists",
  "notExists",
  "isNull",
  "notNull",
  "isEmpty",
  "notEmpty",
]);
const LIST_OPERATORS = new Set<FilterOperator>(["in", "notIn"]);

function conditionIdFactory() {
  let sequence = 0;
  return () => `filter-node-${++sequence}`;
}

function firstOperator(definition: FilterFieldDefinition): FilterOperator {
  if (definition.operators.has("eq")) return "eq";
  return [...definition.operators][0] ?? "exists";
}

function scalarKindFor(
  value: FilterValue | readonly FilterValue[] | undefined,
): ScalarKind {
  const item = Array.isArray(value) ? value[0] : value;
  if (typeof item === "number") return "number";
  if (typeof item === "boolean") return "boolean";
  return "string";
}

function valueTextFor(
  value: FilterValue | readonly FilterValue[] | undefined,
): string {
  if (value === undefined) return "";
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item ?? "")).join(", ");
}

function defaultCondition(createId: () => string): EditorCondition {
  return {
    id: createId(),
    kind: "condition",
    negated: false,
    field: "page.path",
    payloadPath: "",
    operator: "eq",
    value: undefined,
    valueText: "",
    scalarKind: "string",
    valueDirty: true,
  };
}

function defaultGroup(createId: () => string): EditorGroup {
  return {
    id: createId(),
    kind: "group",
    negated: false,
    combinator: "and",
    children: [defaultCondition(createId)],
  };
}

function emptyEditorGroup(createId: () => string): EditorGroup {
  return {
    id: createId(),
    kind: "group",
    negated: false,
    combinator: "and",
    children: [],
  };
}

function editorNodeFromExpression(
  expression: FilterExpression,
  createId: () => string,
  negated = false,
): EditorNode {
  if (expression.kind === "not") {
    return editorNodeFromExpression(expression.child, createId, !negated);
  }
  if (expression.kind === "condition") {
    const field =
      expression.target.kind === "field"
        ? expression.target.field
        : "event.payload";
    return {
      id: createId(),
      kind: "condition",
      negated,
      field,
      payloadPath:
        expression.target.kind === "event-payload"
          ? expression.target.path
          : "",
      operator: expression.operator,
      value: expression.value,
      valueText: valueTextFor(expression.value),
      scalarKind: scalarKindFor(expression.value),
      valueDirty: false,
    };
  }
  return {
    id: createId(),
    kind: "group",
    negated,
    combinator: expression.kind,
    children: expression.children.map((child) =>
      editorNodeFromExpression(child, createId),
    ),
  };
}

function editorRootFromDocument(
  document: FilterDocument,
  createId: () => string,
): EditorGroup {
  if (!document.root) return emptyEditorGroup(createId);
  const editor = editorNodeFromExpression(document.root, createId);
  if (editor.kind === "group" && !editor.negated) return editor;
  return {
    id: createId(),
    kind: "group",
    negated: false,
    combinator: "and",
    children: [editor],
  };
}

function valueForKind(
  raw: string,
  valueKind: FilterValueKind,
  scalarKind: ScalarKind,
): FilterValue {
  if (valueKind === "number") return Number(raw);
  if (valueKind === "boolean") return raw === "true";
  if (valueKind !== "json-scalar") return raw;
  if (scalarKind === "number") return Number(raw);
  if (scalarKind === "boolean") return raw === "true";
  return raw;
}

function requireValue(condition: EditorCondition): void {
  if (VALUELESS_OPERATORS.has(condition.operator)) return;
  if (!condition.valueDirty && condition.value !== undefined) return;
  if (condition.valueText.trim()) return;
  throw new Error("missing_value");
}

function conditionFromEditor(node: EditorCondition): FilterCondition {
  const definition = analyticsFilterRegistry.get(node.field);
  if (!definition) throw new Error("unknown_field");
  const target =
    node.field === "event.payload"
      ? {
          kind: "event-payload" as const,
          path: node.payloadPath as CanonicalJsonPath,
        }
      : {
          kind: "field" as const,
          field: definition.id as FilterFieldId,
        };
  if (VALUELESS_OPERATORS.has(node.operator)) {
    return { kind: "condition", target, operator: node.operator };
  }
  requireValue(node);
  const value = node.valueDirty
    ? LIST_OPERATORS.has(node.operator) || node.operator === "between"
      ? node.valueText
          .split(",")
          .map((item) => item.trim())
          .map((item) =>
            valueForKind(item, definition.valueKind, node.scalarKind),
          )
      : valueForKind(
          node.valueText.trim(),
          definition.valueKind,
          node.scalarKind,
        )
    : node.value;
  return {
    kind: "condition",
    target,
    operator: node.operator,
    value: value as FilterValue | readonly FilterValue[],
  };
}

function expressionFromEditor(node: EditorNode): FilterExpression {
  const expression: FilterExpression =
    node.kind === "condition"
      ? conditionFromEditor(node)
      : {
          kind: node.combinator,
          children: node.children.map(expressionFromEditor),
        };
  return node.negated ? { kind: "not", child: expression } : expression;
}

function updateEditorNode(
  node: EditorNode,
  id: string,
  update: (node: EditorNode) => EditorNode,
): EditorNode {
  if (node.id === id) return update(node);
  if (node.kind === "condition") return node;
  const children = node.children.map((child) =>
    updateEditorNode(child, id, update),
  );
  return children.every((child, index) => child === node.children[index])
    ? node
    : { ...node, children };
}

function appendEditorNode(
  node: EditorNode,
  parentId: string,
  child: EditorNode,
): EditorNode {
  if (node.id === parentId && node.kind === "group") {
    return { ...node, children: [...node.children, child] };
  }
  if (node.kind === "condition") return node;
  const children = node.children.map((item) =>
    appendEditorNode(item, parentId, child),
  );
  return children.every((item, index) => item === node.children[index])
    ? node
    : { ...node, children };
}

function removeEditorNode(node: EditorNode, id: string): EditorNode | null {
  if (node.id === id) return null;
  if (node.kind === "condition") return node;
  const children = node.children
    .map((child) => removeEditorNode(child, id))
    .filter((child): child is EditorNode => child !== null);
  if (children.length === 0) return null;
  return children.length === node.children.length &&
    children.every((child, index) => child === node.children[index])
    ? node
    : { ...node, children };
}

type FilterFieldGroupKey =
  | "page"
  | "session"
  | "referrer"
  | "campaign"
  | "client"
  | "geography"
  | "event";

const FILTER_FIELD_GROUPS: readonly {
  readonly key: FilterFieldGroupKey;
  readonly fieldIds: readonly string[];
}[] = [
  {
    key: "page",
    fieldIds: [
      "page.path",
      "page.title",
      "page.hostname",
      "page.query",
      "page.hash",
    ],
  },
  {
    key: "session",
    fieldIds: ["session.entryPath", "session.exitPath"],
  },
  {
    key: "referrer",
    fieldIds: ["referrer.domain", "referrer.url"],
  },
  {
    key: "campaign",
    fieldIds: [
      "utm.source",
      "utm.medium",
      "utm.campaign",
      "utm.term",
      "utm.content",
    ],
  },
  {
    key: "client",
    fieldIds: [
      "client.browser",
      "client.browserVersion",
      "client.browserEngine",
      "client.os",
      "client.osVersion",
      "client.deviceType",
      "client.language",
      "client.screenSize",
    ],
  },
  {
    key: "geography",
    fieldIds: [
      "geo.country",
      "geo.region",
      "geo.city",
      "geo.continent",
      "geo.timeZone",
      "geo.organization",
    ],
  },
  {
    key: "event",
    fieldIds: ["event.name", "event.payload"],
  },
];

function fieldLabel(field: string, messages: AppMessages): string {
  return messages.filterBuilder.fieldLabels[field] ?? field;
}

function allowedFields(
  audience: FilterPanelAudience,
): readonly FilterFieldDefinition[] {
  return [...analyticsFilterRegistry.values()]
    .filter((field) => field.audiences.has(audience))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function directEventName(group: EditorGroup): string | undefined {
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

function SearchableValueInput({
  condition,
  document,
  eventName,
  messages,
  onChange,
  siteId,
  valueKind,
  window,
}: {
  condition: EditorCondition;
  document: FilterDocument;
  eventName: string | undefined;
  messages: AppMessages;
  onChange: (valueText: string) => void;
  siteId: string | undefined;
  valueKind: FilterValueKind;
  window: TimeWindow | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [searchToken, setSearchToken] = useState("");
  const deferredSearchToken = useDeferredValue(searchToken);
  const isPayload = condition.field === "event.payload";
  const isList = LIST_OPERATORS.has(condition.operator);
  const selectedValues = isList
    ? condition.valueText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const canSearch = Boolean(
    siteId &&
    window &&
    (isPayload
      ? eventName && condition.payloadPath.trim()
      : condition.field !== "event.payload"),
  );
  const suggestionsQuery = useQuery<ValueSuggestion[]>({
    queryKey: [
      "dashboard",
      isPayload ? "event-field-values" : "filter-values",
      siteId,
      window?.from,
      window?.to,
      window?.timeZone,
      ...(isPayload
        ? [eventName, condition.payloadPath, condition.scalarKind]
        : [condition.field]),
      deferredSearchToken,
      document,
    ],
    queryFn: ({ signal }) => {
      if (isPayload) {
        return fetchEventTypeFieldValues(
          siteId!,
          window!,
          eventName!,
          condition.payloadPath,
          condition.scalarKind,
          document,
          { limit: 12, search: deferredSearchToken, signal },
        ).then((result) => result.data);
      }
      return fetchFilterValues(
        siteId!,
        window!,
        condition.field as DashboardFilterOptionKey,
        document,
        { limit: 12, search: deferredSearchToken, signal },
      );
    },
    enabled: open && canSearch,
  });
  const suggestions = suggestionsQuery.data ?? [];
  const inputMode =
    valueKind === "number" || condition.scalarKind === "number"
      ? "decimal"
      : undefined;
  const inputType =
    valueKind === "number" || condition.scalarKind === "number"
      ? "number"
      : valueKind === "date"
        ? "date"
        : valueKind === "datetime"
          ? "datetime-local"
          : "text";
  const menuState = suggestionsQuery.isFetching
    ? "loading"
    : suggestions.length > 0
      ? "suggestions"
      : "empty";

  useEffect(() => {
    if (open) setSearchToken("");
  }, [condition.id, condition.field, condition.operator, open]);

  const addListValue = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    const nextValues = selectedValues.includes(normalized)
      ? selectedValues
      : [...selectedValues, normalized];
    onChange(nextValues.join(", "));
    setSearchToken("");
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-8 w-full justify-between text-xs font-normal"
        >
          <span className="min-w-0 truncate text-left">
            {condition.valueText || messages.filterBuilder.valueUnset}
          </span>
          <RiArrowDownSLine className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="relative z-50 w-[var(--radix-popover-trigger-width)] origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-none border border-border bg-popover text-popover-foreground shadow-md outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          {isList && selectedValues.length > 0 ? (
            <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
              {selectedValues.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="max-w-full truncate bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"
                  onClick={() =>
                    onChange(
                      selectedValues
                        .filter((selected) => selected !== value)
                        .join(", "),
                    )
                  }
                >
                  {value}
                </button>
              ))}
            </div>
          ) : null}
          <div className="relative">
            <RiSearchLine
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              className="border-0 pl-9 text-xs shadow-none focus-visible:ring-0"
              type={inputType}
              value={searchToken}
              inputMode={inputMode}
              placeholder={
                isList
                  ? messages.filterBuilder.valueListPlaceholder
                  : messages.filterBuilder.valueSearchPlaceholder
              }
              onChange={(event) => {
                const next = event.target.value;
                setSearchToken(next);
                if (!isList) onChange(next);
              }}
              onKeyDown={(event) => {
                if (isList && event.key === "Enter") {
                  event.preventDefault();
                  addListValue(searchToken);
                }
              }}
            />
          </div>
          <AutoResizer initial duration={0.18}>
            <AutoTransition transitionKey={menuState} duration={0.18}>
              {suggestionsQuery.isFetching ? (
                <div className="flex min-h-10 items-center justify-center border-t border-border text-muted-foreground">
                  <Spinner aria-label={messages.filterBuilder.valueLoading} />
                </div>
              ) : suggestions.length > 0 ? (
                <OverlayScrollbar
                  axis="vertical"
                  syncKey={suggestions.length}
                  className="max-h-56 border-t border-border pt-1"
                >
                  {suggestions.map((item) => {
                    const value = String(item.value ?? "");
                    const label = "label" in item ? item.label : value;
                    return (
                      <button
                        key={`${typeof item.value}:${value}`}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                        onClick={() => {
                          if (isList) {
                            addListValue(value);
                          } else {
                            onChange(value);
                            setSearchToken(value);
                            setOpen(false);
                          }
                        }}
                      >
                        <span className="min-w-0 truncate">{label}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {item.occurrences ?? 0}
                        </span>
                      </button>
                    );
                  })}
                </OverlayScrollbar>
              ) : null}
            </AutoTransition>
          </AutoResizer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RangeValueInput({
  condition,
  inputMode,
  messages,
  onChange,
}: {
  condition: EditorCondition;
  inputMode?: "decimal";
  messages: AppMessages;
  onChange: (valueText: string) => void;
}) {
  const [lower = "", upper = ""] = condition.valueText.split(",", 2);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Input
        value={lower.trim()}
        inputMode={inputMode}
        placeholder={messages.filterBuilder.rangeStartPlaceholder}
        onChange={(event) => onChange(`${event.target.value}, ${upper.trim()}`)}
      />
      <Input
        value={upper.trim()}
        inputMode={inputMode}
        placeholder={messages.filterBuilder.rangeEndPlaceholder}
        onChange={(event) => onChange(`${lower.trim()}, ${event.target.value}`)}
      />
    </div>
  );
}

function ConditionEditor({
  audience,
  condition,
  document,
  eventName,
  messages,
  path,
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
  path: readonly number[];
  onChange: (update: (condition: EditorCondition) => EditorCondition) => void;
  onRemove: () => void;
  siteId: string | undefined;
  window: TimeWindow | undefined;
}) {
  const definition = analyticsFilterRegistry.get(condition.field);
  const fields = useMemo(() => allowedFields(audience), [audience]);
  const operators = useMemo(
    () => [...(definition?.operators ?? [])],
    [definition],
  );
  const groupedFields = useMemo(() => {
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    return FILTER_FIELD_GROUPS.map((group) => ({
      ...group,
      fields: group.fieldIds
        .map((fieldId) => fieldsById.get(fieldId))
        .filter((field): field is FilterFieldDefinition => field !== undefined),
    })).filter((group) => group.fields.length > 0);
  }, [fields]);
  const isPayload = condition.field === "event.payload";
  const needsValue = !VALUELESS_OPERATORS.has(condition.operator);
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
      payloadPath: field === "event.payload" ? "/value" : "",
      operator: firstOperator(nextDefinition),
      value: undefined,
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
      <div className="space-y-1.5">
        <Select value={condition.field} onValueChange={setField}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {groupedFields.map((group, index) => (
              <SelectGroup key={group.key}>
                {index > 0 ? <SelectSeparator /> : null}
                <SelectLabel>
                  {messages.filterBuilder.fieldGroups[group.key]}
                </SelectLabel>
                {group.fields.map((field) => (
                  <SelectItem key={field.id} value={field.id}>
                    {fieldLabel(field.id, messages)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

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

      {isPayload ? (
        <div className="space-y-1.5">
          <Label>{messages.filterBuilder.jsonPointer}</Label>
          <Input
            value={condition.payloadPath}
            placeholder="/metadata/plan"
            onChange={(event) => {
              const payloadPath = event.target.value;
              onChange((current) => ({ ...current, payloadPath }));
            }}
          />
        </div>
      ) : null}

      {isPayload && needsValue ? (
        <div className="space-y-1.5">
          <Label>{messages.filterBuilder.valueType}</Label>
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

      {needsValue ? (
        <div className="space-y-1.5 sm:col-span-2">
          {valueIsBoolean ? (
            <Select
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
              inputMode={valueIsNumber ? "decimal" : undefined}
              messages={messages}
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
              document={document}
              eventName={eventName}
              messages={messages}
              siteId={siteId}
              valueKind={editorValueKind}
              window={window}
              onChange={(valueText) => {
                onChange((current) => ({
                  ...current,
                  valueText,
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

function GroupEditor({
  audience,
  document,
  eventName,
  group,
  isRoot,
  messages,
  path,
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
  path: readonly number[];
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
                      ? { ...node, negated: checked === true }
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

      <AutoResizer initial duration={0.18}>
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
                    path={[...path, index + 1]}
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
                    path={[...path, index + 1]}
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

export function FilterPanel({
  audience,
  document,
  messages,
  open,
  siteId,
  window,
  onApply,
}: FilterPanelProps) {
  const nextIdRef = useRef(conditionIdFactory());
  const createId = useCallback(() => nextIdRef.current(), []);
  const documentKey = JSON.stringify(document);
  const [root, setRoot] = useState<EditorGroup>(() =>
    editorRootFromDocument(document, createId),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const eventName = directEventName(root);

  useEffect(() => {
    if (!open) return;
    setRoot(editorRootFromDocument(document, createId));
    setValidationError(null);
  }, [createId, documentKey, open]);

  const updateNode = useCallback(
    (id: string, update: (node: EditorNode) => EditorNode) => {
      setRoot(
        (current) => updateEditorNode(current, id, update) as EditorGroup,
      );
      setValidationError(null);
    },
    [],
  );

  const addCondition = useCallback(
    (parentId?: string) => {
      setRoot((current) => {
        return appendEditorNode(
          current,
          parentId ?? current.id,
          defaultCondition(createId),
        ) as EditorGroup;
      });
      setValidationError(null);
    },
    [createId],
  );

  const addGroup = useCallback(
    (parentId?: string) => {
      setRoot((current) => {
        return appendEditorNode(
          current,
          parentId ?? current.id,
          defaultGroup(createId),
        ) as EditorGroup;
      });
      setValidationError(null);
    },
    [createId],
  );

  const removeNode = useCallback(
    (id: string) => {
      setRoot(
        (current) =>
          (removeEditorNode(current, id) as EditorGroup | null) ??
          emptyEditorGroup(createId),
      );
      setValidationError(null);
    },
    [createId],
  );

  const apply = useCallback(() => {
    try {
      const next = normalizeFilterDocument(
        {
          version: FILTER_DOCUMENT_VERSION,
          root: root.children.length > 0 ? expressionFromEditor(root) : null,
        },
        analyticsFilterRegistry,
      );
      onApply(next);
    } catch (error) {
      setValidationError(
        error instanceof FilterValidationError || error instanceof Error
          ? error.message === "missing_value"
            ? messages.filterBuilder.invalid
            : error.message
          : messages.filterBuilder.invalid,
      );
    }
  }, [messages.filterBuilder.invalid, onApply, root]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <GroupEditor
          audience={audience}
          document={document}
          eventName={eventName}
          group={root}
          isRoot
          messages={messages}
          path={[]}
          onAddCondition={addCondition}
          onAddGroup={addGroup}
          onChange={updateNode}
          onRemove={removeNode}
          siteId={siteId}
          window={window}
        />

        {validationError ? (
          <p className="mt-4 border-l-2 border-destructive px-2 text-xs text-destructive">
            {validationError}
          </p>
        ) : null}
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap justify-between gap-2 border-t bg-background px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setRoot(emptyEditorGroup(createId));
            setValidationError(null);
          }}
        >
          <RiFilterOffLine />
          <span>{messages.filters.clear}</span>
        </Button>
        <Button type="button" onClick={apply}>
          <RiCheckLine />
          <span>{messages.filterBuilder.apply}</span>
        </Button>
      </div>
    </div>
  );
}
