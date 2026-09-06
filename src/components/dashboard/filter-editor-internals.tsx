import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiDeleteBinLine,
  RiInformationLine,
  RiSearchLine,
} from "@remixicon/react";
import { useInfiniteQuery } from "@tanstack/react-query";
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
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import type { DashboardFilterOptionKey } from "@/lib/dashboard/client-data";
import {
  fetchEventTypeFields,
  fetchEventTypeFieldValues,
  fetchFilterValues,
} from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { EventField } from "@/lib/edge-client";
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
  type FilterScope,
  type FilterValue,
  type FilterValueKind,
  formatFilterDsl,
  normalizeFilterDocument,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

export type FilterPanelAudience = "private-dashboard" | "public-share";
export type ScalarKind = "string" | "number" | "boolean";
type ValueSuggestion = {
  readonly value: string | number | boolean | null;
  readonly occurrences?: number;
  readonly label?: string;
};
export type ValueSuggestionPage = {
  readonly items: readonly ValueSuggestion[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
};
export interface EditorCondition {
  readonly id: string;
  readonly kind: "condition";
  readonly negated: boolean;
  readonly notCount: number;
  readonly field: string;
  readonly payloadPath: string;
  readonly operator: FilterOperator;
  readonly value: FilterValue | readonly FilterValue[] | undefined;
  readonly listValues: readonly FilterValue[] | undefined;
  readonly valueText: string;
  readonly scalarKind: ScalarKind;
  readonly valueDirty: boolean;
}

export interface EditorGroup {
  readonly id: string;
  readonly kind: "group";
  readonly negated: boolean;
  readonly notCount: number;
  readonly combinator: "and" | "or";
  readonly children: readonly EditorNode[];
}

export type EditorNode = EditorCondition | EditorGroup;

const VALUELESS_OPERATORS = new Set<FilterOperator>([
  "exists",
  "notExists",
  "isNull",
  "notNull",
  "isEmpty",
  "notEmpty",
]);
const LIST_OPERATORS = new Set<FilterOperator>(["in", "notIn"]);

export function conditionIdFactory() {
  let sequence = 0;
  return () => `filter-node-${++sequence}`;
}
function filterDocumentWithRoot(
  document: FilterDocument,
  root: FilterExpression | null,
): FilterDocument {
  const result = { version: document.version, root } as FilterDocument;
  for (const key of Reflect.ownKeys(document)) {
    if (typeof key !== "symbol") continue;
    const descriptor = Object.getOwnPropertyDescriptor(document, key);
    if (descriptor) Object.defineProperty(result, key, descriptor);
  }
  return result;
}

export function stripSuggestionFacet(
  document: FilterDocument,
  field: string,
  payloadPath: string,
): FilterDocument {
  const matchesFacet = (expression: FilterExpression): boolean => {
    if (expression.kind !== "condition") return false;
    if (field === "event.payload") {
      return (
        expression.target.kind === "event-payload" &&
        Boolean(payloadPath) &&
        expression.target.path === payloadPath
      );
    }
    return (
      expression.target.kind === "field" && expression.target.field === field
    );
  };
  const hasFacet = (expression: FilterExpression | null): boolean => {
    if (!expression) return false;
    if (matchesFacet(expression)) return true;
    if (expression.kind === "not") return hasFacet(expression.child);
    if (expression.kind === "condition") return false;
    return expression.children.some(hasFacet);
  };
  const removeFacet = (
    expression: FilterExpression,
  ): FilterExpression | null => {
    if (matchesFacet(expression)) return null;
    if (expression.kind === "condition") return expression;
    if (expression.kind === "not") {
      const child = removeFacet(expression.child);
      return child ? { kind: "not", child } : null;
    }
    const children = expression.children
      .map(removeFacet)
      .filter((child): child is FilterExpression => child !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return { kind: expression.kind, children };
  };

  if (!hasFacet(document.root)) return document;
  return filterDocumentWithRoot(
    document,
    document.root ? removeFacet(document.root) : null,
  );
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

function filterValueText(value: FilterValue): string {
  return value === null ? "null" : String(value);
}

function filterValueKey(value: FilterValue): string {
  return JSON.stringify(value);
}

export function defaultCondition(createId: () => string): EditorCondition {
  return {
    id: createId(),
    kind: "condition",
    negated: false,
    notCount: 0,
    field: "page.path",
    payloadPath: "",
    operator: "eq",
    value: undefined,
    listValues: undefined,
    valueText: "",
    scalarKind: "string",
    valueDirty: true,
  };
}

export function defaultGroup(createId: () => string): EditorGroup {
  return {
    id: createId(),
    kind: "group",
    negated: false,
    notCount: 0,
    combinator: "and",
    children: [defaultCondition(createId)],
  };
}

export function emptyEditorGroup(createId: () => string): EditorGroup {
  return {
    id: createId(),
    kind: "group",
    negated: false,
    notCount: 0,
    combinator: "and",
    children: [],
  };
}

function editorNodeFromExpression(
  expression: FilterExpression,
  createId: () => string,
  notCount = 0,
): EditorNode {
  if (expression.kind === "not") {
    return editorNodeFromExpression(expression.child, createId, notCount + 1);
  }
  if (expression.kind === "condition") {
    const field =
      expression.target.kind === "field"
        ? expression.target.field
        : "event.payload";
    return {
      id: createId(),
      kind: "condition",
      negated: notCount % 2 === 1,
      notCount,
      field,
      payloadPath:
        expression.target.kind === "event-payload"
          ? expression.target.path
          : "",
      operator: expression.operator,
      value: expression.value,
      listValues: Array.isArray(expression.value)
        ? expression.value
        : undefined,
      valueText: valueTextFor(expression.value),
      scalarKind: scalarKindFor(expression.value),
      valueDirty: false,
    };
  }
  return {
    id: createId(),
    kind: "group",
    negated: notCount % 2 === 1,
    notCount,
    combinator: expression.kind,
    children: expression.children.map((child) =>
      editorNodeFromExpression(child, createId),
    ),
  };
}

export function editorRootFromDocument(
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
    notCount: 0,
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
      ? (LIST_OPERATORS.has(node.operator)
          ? (node.listValues ??
            node.valueText.split(",").map((item) => item.trim()))
          : node.valueText.split(",").map((item) => item.trim())
        ).map((item) =>
          item === null
            ? null
            : valueForKind(String(item), definition.valueKind, node.scalarKind),
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
  return Array.from({ length: node.notCount }).reduce<FilterExpression>(
    (child) => ({ kind: "not", child }),
    expression,
  );
}

function displayExpressionFromEditor(
  node: EditorNode,
): FilterExpression | null {
  if (node.kind === "condition") {
    try {
      return expressionFromEditor(node);
    } catch {
      return null;
    }
  }
  const children = node.children
    .map(displayExpressionFromEditor)
    .filter((child): child is FilterExpression => child !== null);
  if (children.length === 0) return null;
  const expression: FilterExpression = { kind: node.combinator, children };
  return Array.from({ length: node.notCount }).reduce<FilterExpression>(
    (child) => ({ kind: "not", child }),
    expression,
  );
}

export function displayRootExpression(
  root: EditorGroup,
): FilterExpression | null {
  const children = root.children
    .map(displayExpressionFromEditor)
    .filter((child): child is FilterExpression => child !== null);
  if (children.length === 0) return null;
  return children.length === 1
    ? children[0]!
    : { kind: root.combinator, children };
}

export function documentFromEditor(root: EditorGroup): FilterDocument {
  return normalizeFilterDocument(
    {
      version: FILTER_DOCUMENT_VERSION,
      root: root.children.length > 0 ? expressionFromEditor(root) : null,
    },
    analyticsFilterRegistry,
  );
}

export function expressionTextFromEditor(root: EditorGroup): string {
  try {
    // Do not normalize before formatting. Normalization is required when a
    // filter is applied, but it sorts and deduplicates equivalent branches.
    // The expression field should instead mirror the editor's current tree.
    return formatFilterDsl({
      version: FILTER_DOCUMENT_VERSION,
      root: displayRootExpression(root),
    });
  } catch {
    return "";
  }
}

function editorNodeFingerprint(node: EditorNode): string | null {
  try {
    return JSON.stringify(expressionFromEditor(node));
  } catch {
    return null;
  }
}

function reconcileEditorNode(
  current: EditorNode,
  incoming: EditorNode,
): EditorNode {
  const currentFingerprint = editorNodeFingerprint(current);
  const incomingFingerprint = editorNodeFingerprint(incoming);
  if (
    currentFingerprint !== null &&
    currentFingerprint === incomingFingerprint
  ) {
    return current;
  }
  if (current.kind !== incoming.kind) return incoming;
  if (current.kind === "condition" && incoming.kind === "condition") {
    return { ...incoming, id: current.id };
  }
  if (current.kind === "condition" || incoming.kind === "condition") {
    return incoming;
  }

  const consumed = new Set<number>();
  const children = incoming.children.map((nextChild, index) => {
    const nextFingerprint = editorNodeFingerprint(nextChild);
    const exactIndex = current.children.findIndex(
      (currentChild, childIndex) =>
        !consumed.has(childIndex) &&
        nextFingerprint !== null &&
        editorNodeFingerprint(currentChild) === nextFingerprint,
    );
    if (exactIndex >= 0) {
      consumed.add(exactIndex);
      return current.children[exactIndex]!;
    }

    const indexedChild = current.children[index];
    if (
      indexedChild &&
      !consumed.has(index) &&
      indexedChild.kind === nextChild.kind
    ) {
      consumed.add(index);
      return reconcileEditorNode(indexedChild, nextChild);
    }
    return nextChild;
  });
  const unchanged =
    current.combinator === incoming.combinator &&
    current.notCount === incoming.notCount &&
    current.children.length === children.length &&
    children.every((child, index) => child === current.children[index]);
  return unchanged ? current : { ...incoming, id: current.id, children };
}

export function reconcileEditorRoot(
  current: EditorGroup,
  incoming: EditorGroup,
): EditorGroup {
  return reconcileEditorNode(current, incoming) as EditorGroup;
}

export function updateEditorNode(
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

export function appendEditorNode(
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

export function removeEditorNode(
  node: EditorNode,
  id: string,
): EditorNode | null {
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
    fieldIds: ["traffic.channel", "referrer.domain", "referrer.url"],
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

const GENERIC_FILTER_HIDDEN_FIELDS = new Set<string>();

function fieldLabel(field: string, messages: AppMessages): string {
  return messages.filterBuilder.fieldLabels[field] ?? field;
}

export function FilterExpressionHelpDialog({
  audience,
  messages,
  open,
  onOpenChange,
}: {
  audience: FilterPanelAudience;
  messages: AppMessages;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fields = useMemo(() => allowedFields(audience), [audience]);
  const fieldGroups = useMemo(() => {
    const grouped = FILTER_FIELD_GROUPS.map((group) => ({
      key: group.key,
      label: messages.filterBuilder.fieldGroups[group.key],
      fields: group.fieldIds
        .map((fieldId) => fields.find((field) => field.id === fieldId))
        .filter((field): field is FilterFieldDefinition => field !== undefined),
    })).filter((group) => group.fields.length > 0);
    const knownFieldIds = new Set(grouped.flatMap((group) => group.fields));
    const otherFields = fields.filter((field) => !knownFieldIds.has(field));
    return otherFields.length > 0
      ? [
          ...grouped,
          {
            key: "other",
            label: messages.filterBuilder.expressionHelpOtherFields,
            fields: otherFields,
          },
        ]
      : grouped;
  }, [fields, messages]);
  const operators = useMemo(() => {
    const available = new Set<FilterOperator>();
    fields.forEach((field) =>
      field.operators.forEach((operator) => available.add(operator)),
    );
    return [...available];
  }, [fields]);
  const unaryOperators = operators.filter((operator) =>
    VALUELESS_OPERATORS.has(operator),
  );
  const valueKindLabel = (valueKind: FilterValueKind) =>
    messages.filterBuilder.valueKinds[valueKind];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="gap-0 p-0"
        desktopClassName="max-w-4xl"
        drawerClassName="overflow-hidden"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-5">
          <ResponsiveDialogTitle icon={RiInformationLine}>
            {messages.filterBuilder.expressionHelpTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {messages.filterBuilder.expressionHelpDescription}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="flex flex-col overflow-hidden p-0">
          <VerticalScrollMask
            syncKey={`${audience}:${fields.length}:${operators.length}`}
            className="min-h-0 flex-1 max-h-[min(calc(80dvh-5rem),46rem)]"
          >
            <div className="space-y-6 p-4 sm:p-5">
              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  {messages.filterBuilder.expressionHelpSyntax}
                </h3>
                <div className="space-y-2 border-y border-border py-3 font-mono text-xs">
                  <p>&lt;field&gt; &lt;operator&gt; &lt;value&gt;</p>
                  <p>&lt;expression&gt; AND | OR &lt;expression&gt;</p>
                  <p>NOT &lt;expression&gt; · (&lt;expression&gt;)</p>
                  <p>AND(&lt;expression&gt;) · OR(&lt;expression&gt;)</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {messages.filterBuilder.expressionHelpLogicDescription}
                </p>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  {messages.filterBuilder.expressionHelpValues}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {messages.filterBuilder.expressionHelpValuesDescription}
                </p>
                <div className="flex flex-wrap gap-2 font-mono text-xs">
                  {[
                    '"text"',
                    "42",
                    "true",
                    '["a", "b"]',
                    "between [10, 20]",
                  ].map((example) => (
                    <code key={example} className="bg-muted px-2 py-1">
                      {example}
                    </code>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  {messages.filterBuilder.expressionHelpOperators}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {operators.map((operator) => (
                    <span
                      key={operator}
                      className="inline-flex items-center gap-1 bg-muted px-2 py-1 text-xs"
                    >
                      <code className="font-mono">{operator}</code>
                      <span className="text-muted-foreground">
                        {messages.filterBuilder.operatorLabels[operator] ??
                          operator}
                      </span>
                    </span>
                  ))}
                </div>
                {unaryOperators.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {messages.filterBuilder.expressionHelpUnaryOperators}:{" "}
                    <span className="font-mono">
                      {unaryOperators.join(", ")}
                    </span>
                  </p>
                ) : null}
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  {messages.filterBuilder.expressionHelpFields}
                </h3>
                <div className="divide-y divide-border border-y border-border">
                  {fieldGroups.map((group) => (
                    <div key={group.key}>
                      <h4 className="bg-muted px-3 py-2 text-xs font-medium">
                        {group.label}
                      </h4>
                      {group.fields.map((field) => (
                        <div
                          key={field.id}
                          className="grid gap-2 px-3 py-2 sm:grid-cols-[minmax(13rem,0.75fr)_minmax(0,1fr)]"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium">
                              {fieldLabel(field.id, messages)}
                            </div>
                            <code className="block truncate font-mono text-xs text-muted-foreground">
                              {field.id}
                            </code>
                          </div>
                          <div className="min-w-0 space-y-1">
                            <div className="text-xs text-muted-foreground">
                              {messages.filterBuilder.expressionHelpFieldType}:{" "}
                              {valueKindLabel(field.valueKind)}
                            </div>
                            <div className="break-words text-xs text-muted-foreground">
                              {
                                messages.filterBuilder
                                  .expressionHelpFieldOperators
                              }
                              :{" "}
                              <span className="font-mono">
                                {[...field.operators].join(", ")}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </VerticalScrollMask>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

export function allowedFields(
  audience: FilterPanelAudience,
): readonly FilterFieldDefinition[] {
  return [...analyticsFilterRegistry.values()]
    .filter(
      (field) =>
        field.audiences.has(audience) &&
        !GENERIC_FILTER_HIDDEN_FIELDS.has(field.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
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

function isSelectablePayloadFieldType(
  valueType: EventField["valueType"],
): valueType is "string" | "number" | "boolean" {
  return (
    valueType === "string" || valueType === "number" || valueType === "boolean"
  );
}

function payloadFieldTypeLabel(
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

function SearchablePayloadPathInput({
  condition,
  document,
  eventName,
  messages,
  needsValue,
  onChange,
  onSelect,
  resolvedScope,
  siteId,
  window,
}: {
  condition: EditorCondition;
  document: FilterDocument;
  eventName: string | undefined;
  messages: AppMessages;
  needsValue: boolean;
  onChange: (payloadPath: string) => void;
  onSelect: (field: EventField) => void;
  resolvedScope?: FilterScope;
  siteId: string | undefined;
  window: TimeWindow | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [searchToken, setSearchToken] = useState("");
  const deferredSearchToken = useDeferredValue(searchToken);
  const canSearch = Boolean(siteId && window && resolvedScope);
  const suggestionFilters = useMemo(
    () =>
      stripSuggestionFacet(document, condition.field, condition.payloadPath),
    [condition.field, condition.payloadPath, document],
  );
  const fieldsQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "event-field-paths",
      siteId,
      window?.from,
      window?.to,
      window?.timeZone,
      eventName,
      resolvedScope ?? "unresolved",
      suggestionFilters,
      needsValue,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchEventTypeFields(siteId!, window!, eventName, suggestionFilters, {
        limit: 100,
        cursor: pageParam,
        signal,
        resolvedScope,
      }),
    enabled: open && canSearch,
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
  });
  const fields =
    fieldsQuery.data?.pages.flatMap((page) => page.data.items) ?? [];
  const suggestions = useMemo(() => {
    const search = deferredSearchToken.trim().toLocaleLowerCase();
    return fields
      .filter(
        (field) =>
          field.path &&
          (!needsValue || isSelectablePayloadFieldType(field.valueType)) &&
          (!search || field.path.toLocaleLowerCase().includes(search)),
      )
      .slice(0, 12);
  }, [deferredSearchToken, fields, needsValue]);
  const menuState = fieldsQuery.isFetching
    ? "loading"
    : suggestions.length > 0
      ? "suggestions"
      : "empty";

  useEffect(() => {
    if (open) setSearchToken("");
  }, [condition.field, condition.id, eventName, open]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-8 w-full justify-between pr-2 text-xs font-normal"
        >
          <span className="min-w-0 truncate text-left">
            {condition.payloadPath || messages.filterBuilder.valueUnset}
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
          <div className="relative">
            <RiSearchLine
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              className="border-0 pl-9 font-mono text-xs shadow-none focus-visible:ring-0"
              value={searchToken}
              placeholder={messages.filterBuilder.jsonPointerPlaceholder}
              onChange={(event) => {
                const next = event.target.value;
                setSearchToken(next);
                onChange(next);
              }}
            />
          </div>
          <AutoResizer initial duration={0.18}>
            <AutoTransition transitionKey={menuState} duration={0.18}>
              {fieldsQuery.isFetching ? (
                <div className="flex min-h-10 items-center justify-center border-t border-border text-muted-foreground">
                  <Spinner aria-label={messages.filterBuilder.valueLoading} />
                </div>
              ) : suggestions.length > 0 ? (
                <OverlayScrollbar
                  axis="vertical"
                  syncKey={suggestions.length}
                  className="max-h-56 border-t border-border pt-1"
                >
                  {suggestions.map((field) => (
                    <button
                      key={`${field.valueType}:${field.path}`}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                      onClick={() => {
                        onSelect(field);
                        setSearchToken("");
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0 truncate font-mono">
                        {field.path}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {payloadFieldTypeLabel(field.valueType, messages)}
                      </span>
                    </button>
                  ))}
                </OverlayScrollbar>
              ) : null}
            </AutoTransition>
          </AutoResizer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SearchableValueInput({
  condition,
  disabled = false,
  document,
  eventName,
  messages,
  onChange,
  onListChange,
  resolvedScope,
  siteId,
  valueKind,
  window,
}: {
  condition: EditorCondition;
  disabled?: boolean;
  document: FilterDocument;
  eventName: string | undefined;
  messages: AppMessages;
  onChange: (valueText: string) => void;
  onListChange: (values: readonly FilterValue[]) => void;
  resolvedScope?: FilterScope;
  siteId: string | undefined;
  valueKind: FilterValueKind;
  window: TimeWindow | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [searchToken, setSearchToken] = useState("");
  const deferredSearchToken = useDeferredValue(searchToken);
  const isPayload = condition.field === "event.payload";
  const suggestionFilters = useMemo(
    () =>
      stripSuggestionFacet(document, condition.field, condition.payloadPath),
    [condition.field, condition.payloadPath, document],
  );
  const isList = LIST_OPERATORS.has(condition.operator);
  const selectedValues = isList
    ? (condition.listValues ??
      (Array.isArray(condition.value) ? condition.value : []))
    : [];
  const canSearch = Boolean(
    siteId &&
    window &&
    resolvedScope &&
    (isPayload
      ? condition.payloadPath.trim()
      : condition.field !== "event.payload"),
  );
  const suggestionsQuery = useInfiniteQuery<ValueSuggestionPage>({
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
      resolvedScope ?? "unresolved",
      suggestionFilters,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => {
      if (isPayload) {
        return fetchEventTypeFieldValues(
          siteId!,
          window!,
          eventName,
          condition.payloadPath,
          condition.scalarKind,
          suggestionFilters,
          {
            limit: 12,
            cursor: pageParam as string | null,
            search: deferredSearchToken,
            signal,
            resolvedScope,
          },
        ).then((result) => ({
          items: result.data.items.map((item) => ({
            value: item.value,
            occurrences: item.occurrences,
            label: String(item.value ?? ""),
          })),
          pagination: result.data.pagination,
        }));
      }
      return fetchFilterValues(
        siteId!,
        window!,
        condition.field as DashboardFilterOptionKey,
        suggestionFilters,
        {
          limit: 12,
          cursor: pageParam as string | null,
          search: deferredSearchToken,
          signal,
          resolvedScope,
        },
      ).then((result) => ({
        items: result.items,
        pagination: result.pagination,
      }));
    },
    enabled: open && canSearch && !disabled,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.nextCursor : undefined,
  });
  const suggestions =
    suggestionsQuery.data?.pages.flatMap((page) => page.items) ?? [];
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

  const addListValue = (value: FilterValue) => {
    if (typeof value === "string" && !value.trim()) return;
    const nextValues = selectedValues.some(
      (selected) => filterValueKey(selected) === filterValueKey(value),
    )
      ? selectedValues
      : [...selectedValues, value];
    onListChange(nextValues);
    setSearchToken("");
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-8 w-full justify-between pr-2 text-xs font-normal"
        >
          <span className="min-w-0 truncate text-left">
            {isList
              ? selectedValues.map(filterValueText).join(", ") ||
                messages.filterBuilder.valueUnset
              : condition.valueText || messages.filterBuilder.valueUnset}
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
              {selectedValues.map((value) => {
                const removeValueLabel = formatI18nTemplate(
                  messages.filterBuilder.removeValue,
                  { value: filterValueText(value) },
                );

                return (
                  <Tooltip key={filterValueKey(value)}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="max-w-full truncate bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"
                        aria-label={removeValueLabel}
                        onClick={() =>
                          onListChange(
                            selectedValues.filter(
                              (selected) =>
                                filterValueKey(selected) !==
                                filterValueKey(value),
                            ),
                          )
                        }
                      >
                        {filterValueText(value)}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{removeValueLabel}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ) : null}
          <div className="relative">
            <RiSearchLine
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              disabled={disabled}
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
                    const value = item.value;
                    const label = "label" in item ? item.label : value;
                    return (
                      <button
                        key={`${typeof value}:${filterValueKey(value)}`}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                        onClick={() => {
                          if (isList) {
                            addListValue(value);
                          } else {
                            const valueText = filterValueText(value);
                            onChange(valueText);
                            setSearchToken(valueText);
                            setOpen(false);
                          }
                        }}
                      >
                        <span className="min-w-0 truncate">
                          {label ?? filterValueText(value)}
                        </span>
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
  disabled = false,
  inputMode,
  messages,
  onChange,
}: {
  condition: EditorCondition;
  disabled?: boolean;
  inputMode?: "decimal";
  messages: AppMessages;
  onChange: (valueText: string) => void;
}) {
  const [lower = "", upper = ""] = condition.valueText.split(",", 2);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Input
        disabled={disabled}
        value={lower.trim()}
        inputMode={inputMode}
        placeholder={messages.filterBuilder.rangeStartPlaceholder}
        onChange={(event) => onChange(`${event.target.value}, ${upper.trim()}`)}
      />
      <Input
        disabled={disabled}
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
  path: readonly number[];
  resolvedScope?: FilterScope;
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
