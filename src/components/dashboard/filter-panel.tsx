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
  RiChatQuoteLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiEditLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiFilterOffLine,
  RiInformationLine,
  RiSaveLine,
  RiSearchLine,
  RiUserLine,
} from "@remixicon/react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Popover } from "radix-ui";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Clickable } from "@/components/ui/clickable";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OverlayScrollbar } from "@/components/ui/overlay-scrollbar";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
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
  createSavedFilter,
  deleteSavedFilter,
  fetchEventTypeFields,
  fetchEventTypeFieldValues,
  fetchFilterValues,
  fetchSavedFilters,
  updateSavedFilter,
} from "@/lib/dashboard/client-data";
import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import { resolveSuggestionScope } from "@/lib/dashboard/filter-suggestion-scope";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  SYSTEM_FILTER_PRESETS,
  type SystemFilterPreset,
  systemFilterPresetFromOptionValue,
  type SystemFilterPresetId,
  systemFilterPresetOptionValue,
} from "@/lib/dashboard/system-filter-presets";
import type { EventField } from "@/lib/edge-client";
import {
  analyticsFilterRegistry,
  attachFilterScopePreference,
  type CanonicalJsonPath,
  FILTER_DOCUMENT_VERSION,
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterFieldDefinition,
  type FilterFieldId,
  filterFingerprint,
  type FilterOperator,
  type FilterScope,
  type FilterScopePreference,
  FilterValidationError,
  type FilterValue,
  type FilterValueKind,
  formatFilterDsl,
  normalizeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type {
  SavedFilter,
  SavedFilterInput,
  SavedFilterVisibility,
} from "@/lib/saved-filters";
import { cn } from "@/lib/utils";

export type FilterPanelAudience = "private-dashboard" | "public-share";
type ScalarKind = "string" | "number" | "boolean";
const NO_SAVED_FILTER_VALUE = "__no_saved_filter__";
const EMPTY_SAVED_FILTER_FORM = {
  name: "",
  description: "",
  visibility: "private",
  scopePreference: "auto",
} as const satisfies Omit<SavedFilterInput, "filterDsl">;
type SavedFilterForm = Omit<SavedFilterInput, "filterDsl">;
type ValueSuggestion = {
  readonly value: string | number | boolean | null;
  readonly occurrences?: number;
  readonly label?: string;
};
type ValueSuggestionPage = {
  readonly items: readonly ValueSuggestion[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
};

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

function stripSuggestionFacet(
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

function systemPresetItem(messages: AppMessages, id: SystemFilterPresetId) {
  const items = {
    directTraffic: messages.filterBuilder.systemPresetItems.directTraffic,
    externalReferrals:
      messages.filterBuilder.systemPresetItems.externalReferrals,
    organicSearchDiscovery:
      messages.filterBuilder.systemPresetItems.organicSearchDiscovery,
    organicSocialDiscovery:
      messages.filterBuilder.systemPresetItems.organicSocialDiscovery,
    campaignTaggedTraffic:
      messages.filterBuilder.systemPresetItems.campaignTaggedTraffic,
    mobileTraffic: messages.filterBuilder.systemPresetItems.mobileTraffic,
    desktopTraffic: messages.filterBuilder.systemPresetItems.desktopTraffic,
    campaignTaggedExternalAcquisition:
      messages.filterBuilder.systemPresetItems
        .campaignTaggedExternalAcquisition,
    campaignTaggedDirectEntry:
      messages.filterBuilder.systemPresetItems.campaignTaggedDirectEntry,
    untaggedExternalReferrals:
      messages.filterBuilder.systemPresetItems.untaggedExternalReferrals,
    mobileAcquiredTraffic:
      messages.filterBuilder.systemPresetItems.mobileAcquiredTraffic,
    mobileOrganicDiscovery:
      messages.filterBuilder.systemPresetItems.mobileOrganicDiscovery,
    desktopDirectAudience:
      messages.filterBuilder.systemPresetItems.desktopDirectAudience,
    geographicAttributionGap:
      messages.filterBuilder.systemPresetItems.geographicAttributionGap,
    tabletTraffic: messages.filterBuilder.systemPresetItems.tabletTraffic,
  } as const;

  return items[id];
}

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

interface FilterPanelProps {
  readonly audience: FilterPanelAudience;
  readonly document: FilterDocument;
  /** Raw DSL associated with the active query document, when available. */
  readonly expressionText?: string;
  readonly messages: AppMessages;
  readonly open: boolean;
  readonly siteId?: string;
  /** Concrete scope resolved by the parent page for the active operation. */
  readonly resolvedScope?: FilterScope;
  readonly scopePreference: FilterScopePreference;
  readonly window?: TimeWindow;
  readonly onApply: (
    document: FilterDocument,
    rawDsl?: string,
    options?: { readonly closePanel?: boolean },
  ) => void;
  readonly onScopeChange: (preference: FilterScopePreference) => void;
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

export function conditionIdFactory() {
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

function reconcileEditorRoot(
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

function SavedFilterFormFields({
  form,
  messages,
  onChange,
}: {
  form: SavedFilterForm;
  messages: AppMessages;
  onChange: (next: SavedFilterForm) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="saved-filter-name">
          {messages.filterBuilder.savedFilterName}
        </Label>
        <Input
          id="saved-filter-name"
          maxLength={120}
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="saved-filter-description">
          {messages.filterBuilder.savedFilterDescription}
        </Label>
        <textarea
          id="saved-filter-description"
          className="flex min-h-20 w-full resize-y border border-input bg-transparent px-2 py-1.5 text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          maxLength={2_000}
          value={form.description}
          onChange={(event) =>
            onChange({ ...form, description: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label>{messages.filterBuilder.scopeLabel}</Label>
        <Select
          value={form.scopePreference ?? "auto"}
          onValueChange={(scopePreference) =>
            onChange({
              ...form,
              scopePreference: scopePreference as FilterScopePreference,
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">
              {messages.filterBuilder.scopeAuto}
            </SelectItem>
            <SelectItem value="event">
              {messages.filterBuilder.scopeEvent}
            </SelectItem>
            <SelectItem value="session">
              {messages.filterBuilder.scopeSession}
            </SelectItem>
            <SelectItem value="visitor">
              {messages.filterBuilder.scopeVisitor}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{messages.filterBuilder.savedFilterVisibility}</Label>
        <Select
          value={form.visibility}
          onValueChange={(visibility) =>
            onChange({
              ...form,
              visibility: visibility as SavedFilterVisibility,
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">
              {messages.filterBuilder.savedFilterVisibilityPrivate}
            </SelectItem>
            <SelectItem value="team">
              {messages.filterBuilder.savedFilterVisibilityTeam}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
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

export function FilterPanel({
  audience,
  document,
  expressionText: restoredExpressionText,
  messages,
  open,
  resolvedScope: pageResolvedScope,
  siteId,
  scopePreference,
  window,
  onApply,
  onScopeChange,
}: FilterPanelProps) {
  const nextIdRef = useRef(conditionIdFactory());
  const createId = useCallback(() => nextIdRef.current(), []);
  const queryClient = useQueryClient();
  const documentKey = JSON.stringify(document);
  const [root, setRoot] = useState<EditorGroup>(() =>
    editorRootFromDocument(document, createId),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [expressionText, setExpressionText] = useState(() =>
    expressionTextFromEditor(root),
  );
  const [expressionError, setExpressionError] = useState<string | null>(null);
  const [expressionHelpOpen, setExpressionHelpOpen] = useState(false);
  const [createSavedFilterOpen, setCreateSavedFilterOpen] = useState(false);
  const [manageSavedFilterOpen, setManageSavedFilterOpen] = useState(false);
  const [confirmSavedFilterDeleteOpen, setConfirmSavedFilterDeleteOpen] =
    useState(false);
  const [managedSavedFilterId, setManagedSavedFilterId] = useState<
    string | undefined
  >();
  const [editingSavedFilterId, setEditingSavedFilterId] = useState<
    string | undefined
  >();
  const [savedFilterForm, setSavedFilterForm] = useState<SavedFilterForm>(
    EMPTY_SAVED_FILTER_FORM,
  );
  const [savedFilterOperationError, setSavedFilterOperationError] = useState<
    string | null
  >(null);
  const expressionUpdateRef = useRef(false);
  const preservedDocumentKeyRef = useRef<string | null>(null);
  const expressionRegistry = useMemo(
    () => new Map(allowedFields(audience).map((field) => [field.id, field])),
    [audience],
  );
  const naturalLanguageDescription = useMemo(
    () =>
      describeFilterExpression(
        displayRootExpression(root),
        expressionRegistry,
        messages,
      ),
    [expressionRegistry, messages, root],
  );
  const eventName = directEventName(root);
  const suggestionScope = resolveSuggestionScope(
    scopePreference,
    pageResolvedScope,
  );
  const savedFiltersEnabled =
    audience === "private-dashboard" && open && Boolean(siteId);
  const savedFiltersQuery = useQuery({
    queryKey: ["saved-filters", siteId],
    queryFn: ({ signal }) => fetchSavedFilters(siteId!, { signal }),
    enabled: savedFiltersEnabled,
    staleTime: 60_000,
  });
  const savedFilters = savedFiltersQuery.data?.items ?? [];
  const currentFilterFingerprint = useMemo(() => {
    try {
      return filterFingerprint(
        documentFromEditor(root),
        analyticsFilterRegistry,
      );
    } catch {
      return undefined;
    }
  }, [root]);
  const invalidateSavedFilters = useCallback(() => {
    if (!siteId) return Promise.resolve();
    return queryClient.invalidateQueries({
      queryKey: ["saved-filters", siteId],
    });
  }, [queryClient, siteId]);
  const createSavedFilterMutation = useMutation({
    mutationFn: async (form: SavedFilterForm) => {
      if (!siteId) throw new Error("missing site id");
      return createSavedFilter(siteId, { ...form, filterDsl: expressionText });
    },
    onSuccess: () => {
      setCreateSavedFilterOpen(false);
      setSavedFilterOperationError(null);
      void invalidateSavedFilters();
    },
    onError: () => {
      setSavedFilterOperationError(
        messages.filterBuilder.savedFilterOperationFailed,
      );
    },
  });
  const updateSavedFilterMutation = useMutation({
    mutationFn: async ({
      filterId,
      form,
      filterDsl,
    }: {
      filterId: string;
      form: SavedFilterForm;
      filterDsl: string;
      finishEditing?: boolean;
    }) => {
      if (!siteId) throw new Error("missing site id");
      return updateSavedFilter(siteId, filterId, { ...form, filterDsl });
    },
    onSuccess: (_result, variables) => {
      setManageSavedFilterOpen(false);
      if (variables.finishEditing) setEditingSavedFilterId(undefined);
      setSavedFilterOperationError(null);
      void invalidateSavedFilters();
    },
    onError: () => {
      setSavedFilterOperationError(
        messages.filterBuilder.savedFilterOperationFailed,
      );
    },
  });
  const deleteSavedFilterMutation = useMutation({
    mutationFn: async (filterId: string) => {
      if (!siteId) throw new Error("missing site id");
      return deleteSavedFilter(siteId, filterId);
    },
    onSuccess: () => {
      setConfirmSavedFilterDeleteOpen(false);
      setManageSavedFilterOpen(false);
      setManagedSavedFilterId(undefined);
      setEditingSavedFilterId(undefined);
      setSavedFilterOperationError(null);
      void invalidateSavedFilters();
    },
    onError: () => {
      setSavedFilterOperationError(
        messages.filterBuilder.savedFilterOperationFailed,
      );
    },
  });
  const matchedSavedFilter = useMemo(() => {
    if (expressionError || root.children.length === 0) return undefined;
    const matches = savedFilters.filter((filter) => {
      if (filter.scopePreference !== scopePreference) return false;
      if (filter.filterDsl === expressionText) return true;
      if (!currentFilterFingerprint) return false;
      try {
        return (
          filterFingerprint(
            parseFilterDsl(filter.filterDsl, analyticsFilterRegistry),
            analyticsFilterRegistry,
          ) === currentFilterFingerprint
        );
      } catch {
        return false;
      }
    });
    return matches.find((filter) => filter.isOwner) ?? matches[0];
  }, [
    currentFilterFingerprint,
    expressionError,
    expressionText,
    root.children.length,
    savedFilters,
    scopePreference,
  ]);
  const matchedSystemPreset = useMemo(() => {
    if (matchedSavedFilter || expressionError || root.children.length === 0) {
      return undefined;
    }

    return SYSTEM_FILTER_PRESETS.find((preset) => {
      if (preset.filterDsl === expressionText) return true;
      if (!currentFilterFingerprint) return false;
      try {
        return (
          filterFingerprint(
            parseFilterDsl(preset.filterDsl, analyticsFilterRegistry),
            analyticsFilterRegistry,
          ) === currentFilterFingerprint
        );
      } catch {
        return false;
      }
    });
  }, [
    currentFilterFingerprint,
    expressionError,
    expressionText,
    matchedSavedFilter,
    root.children.length,
  ]);
  const managedSavedFilter = savedFilters.find(
    (filter) => filter.id === managedSavedFilterId && filter.isOwner,
  );
  const editingSavedFilter = savedFilters.find(
    (filter) => filter.id === editingSavedFilterId && filter.isOwner,
  );
  const hasEffectiveFilter =
    !expressionError &&
    root.children.length > 0 &&
    expressionText.trim().length > 0;
  const savedFilterPrimaryAction =
    !savedFiltersEnabled || savedFiltersQuery.isFetching || !hasEffectiveFilter
      ? undefined
      : editingSavedFilter
        ? "finish"
        : matchedSavedFilter?.isOwner
          ? "manage"
          : matchedSavedFilter
            ? "save-as"
            : "save";
  const savedFilterTriggerLabel = savedFiltersQuery.isFetching
    ? messages.filterBuilder.savedFiltersLoading
    : matchedSavedFilter
      ? matchedSavedFilter.name
      : matchedSystemPreset
        ? systemPresetItem(messages, matchedSystemPreset.id).name
        : messages.filterBuilder.noSavedFilter;
  const savedFilterTriggerKey = savedFiltersQuery.isFetching
    ? "loading"
    : matchedSavedFilter
      ? `saved:${matchedSavedFilter.id}`
      : matchedSystemPreset
        ? systemFilterPresetOptionValue(matchedSystemPreset.id)
        : "none";

  useEffect(() => {
    if (!open) return;
    if (preservedDocumentKeyRef.current === documentKey) {
      preservedDocumentKeyRef.current = null;
      return;
    }
    let nextRoot = editorRootFromDocument(document, createId);
    if (restoredExpressionText !== undefined) {
      try {
        nextRoot = editorRootFromDocument(
          parseFilterDsl(restoredExpressionText, expressionRegistry),
          createId,
        );
      } catch {
        // The persisted source is advisory. The URL document remains usable.
      }
    }
    expressionUpdateRef.current = true;
    setRoot(nextRoot);
    setExpressionText(
      restoredExpressionText ?? expressionTextFromEditor(nextRoot),
    );
    setExpressionError(null);
    setValidationError(null);
  }, [
    createId,
    document,
    documentKey,
    expressionRegistry,
    open,
    restoredExpressionText,
  ]);

  useEffect(() => {
    if (expressionUpdateRef.current) {
      expressionUpdateRef.current = false;
      return;
    }
    setExpressionText(expressionTextFromEditor(root));
    setExpressionError(null);
  }, [root]);

  const rootFromExpressionText = useCallback(
    (source: string): EditorGroup | null => {
      try {
        return source.trim()
          ? editorRootFromDocument(
              parseFilterDsl(source, expressionRegistry),
              createId,
            )
          : emptyEditorGroup(createId);
      } catch {
        setExpressionError(messages.filterBuilder.expressionInvalid);
        return null;
      }
    },
    [createId, expressionRegistry, messages.filterBuilder.expressionInvalid],
  );

  const setExpressionRoot = useCallback((nextRoot: EditorGroup) => {
    setRoot((current) => {
      const reconciled = reconcileEditorRoot(current, nextRoot);
      if (reconciled !== current) expressionUpdateRef.current = true;
      return reconciled;
    });
  }, []);

  const updateFromExpressionText = useCallback(
    (source: string): EditorGroup | null => {
      const nextRoot = rootFromExpressionText(source);
      if (!nextRoot) return null;
      setExpressionRoot(nextRoot);
      setExpressionError(null);
      setValidationError(null);
      return nextRoot;
    },
    [rootFromExpressionText, setExpressionRoot],
  );

  const commitExpressionText = useCallback(() => {
    const nextRoot = rootFromExpressionText(expressionText);
    if (!nextRoot) return null;
    setExpressionError(null);
    setExpressionText(expressionTextFromEditor(nextRoot));
    setExpressionRoot(nextRoot);
    return nextRoot;
  }, [expressionText, rootFromExpressionText, setExpressionRoot]);

  const updateNode = useCallback(
    (id: string, update: (node: EditorNode) => EditorNode) => {
      setRoot(
        (current) => updateEditorNode(current, id, update) as EditorGroup,
      );
      setValidationError(null);
      setExpressionError(null);
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
      setExpressionError(null);
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
      setExpressionError(null);
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
      setExpressionError(null);
    },
    [createId],
  );

  const apply = useCallback(() => {
    const nextRoot = commitExpressionText();
    if (!nextRoot) return;
    try {
      onApply(documentFromEditor(nextRoot), expressionText);
    } catch (error) {
      setValidationError(
        error instanceof FilterValidationError || error instanceof Error
          ? error.message === "missing_value"
            ? messages.filterBuilder.invalid
            : error.message
          : messages.filterBuilder.invalid,
      );
    }
  }, [commitExpressionText, messages.filterBuilder.invalid, onApply]);

  const applyFilterDsl = useCallback(
    (
      filterDsl: string,
      scopeOverride: FilterScopePreference = scopePreference,
    ) => {
      const nextRoot = rootFromExpressionText(filterDsl);
      if (!nextRoot) return;
      try {
        const nextDocument = attachFilterScopePreference(
          documentFromEditor(nextRoot),
          scopeOverride,
        );
        preservedDocumentKeyRef.current = JSON.stringify(nextDocument);
        setExpressionText(filterDsl);
        setExpressionRoot(nextRoot);
        setExpressionError(null);
        setValidationError(null);
        onApply(nextDocument, filterDsl, { closePanel: false });
      } catch (error) {
        setValidationError(
          error instanceof FilterValidationError || error instanceof Error
            ? error.message
            : messages.filterBuilder.invalid,
        );
      }
    },
    [
      messages.filterBuilder.invalid,
      onApply,
      rootFromExpressionText,
      scopePreference,
      setExpressionRoot,
    ],
  );
  const applySavedFilter = useCallback(
    (filter: SavedFilter) => {
      onScopeChange(filter.scopePreference);
      applyFilterDsl(filter.filterDsl, filter.scopePreference);
    },
    [applyFilterDsl, onScopeChange],
  );
  const applySystemPreset = useCallback(
    (preset: SystemFilterPreset) => applyFilterDsl(preset.filterDsl),
    [applyFilterDsl],
  );

  const openSavedFilterCreate = useCallback(
    (source?: SavedFilter) => {
      setSavedFilterForm({
        name: source?.name ?? "",
        description: source?.description ?? "",
        visibility: "private",
        scopePreference: source?.scopePreference ?? scopePreference,
      });
      setSavedFilterOperationError(null);
      setCreateSavedFilterOpen(true);
    },
    [scopePreference],
  );

  const clearSavedFilter = useCallback(() => {
    const nextRoot = emptyEditorGroup(createId);
    const nextDocument = documentFromEditor(nextRoot);
    preservedDocumentKeyRef.current = JSON.stringify(nextDocument);
    setExpressionText("");
    setExpressionRoot(nextRoot);
    setExpressionError(null);
    setValidationError(null);
    onApply(nextDocument, "", { closePanel: false });
  }, [createId, onApply, setExpressionRoot]);

  const openSavedFilterManagement = useCallback((filter: SavedFilter) => {
    setManagedSavedFilterId(filter.id);
    setSavedFilterForm({
      name: filter.name,
      description: filter.description,
      visibility: filter.visibility,
      scopePreference: filter.scopePreference,
    });
    setSavedFilterOperationError(null);
    setManageSavedFilterOpen(true);
  }, []);

  const finishSavedFilterEditing = useCallback(() => {
    if (!editingSavedFilter) return;
    setSavedFilterOperationError(null);
    updateSavedFilterMutation.mutate({
      filterId: editingSavedFilter.id,
      form: {
        name: editingSavedFilter.name,
        description: editingSavedFilter.description,
        visibility: editingSavedFilter.visibility,
        scopePreference: savedFilterForm.scopePreference ?? "auto",
      },
      filterDsl: expressionText,
      finishEditing: true,
    });
  }, [
    editingSavedFilter,
    expressionText,
    savedFilterForm.scopePreference,
    updateSavedFilterMutation,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <VerticalScrollMask
        className="min-h-0 flex-1"
        contentClassName="min-h-0 pb-4"
      >
        <div className="mb-4 border-b border-border pb-4">
          <Select
            value={
              matchedSavedFilter?.id ??
              (matchedSystemPreset
                ? systemFilterPresetOptionValue(matchedSystemPreset.id)
                : NO_SAVED_FILTER_VALUE)
            }
            disabled={savedFiltersQuery.isFetching}
            onValueChange={(value) => {
              if (value === NO_SAVED_FILTER_VALUE) {
                clearSavedFilter();
                return;
              }
              const preset = systemFilterPresetFromOptionValue(value);
              if (preset) {
                applySystemPreset(preset);
                return;
              }
              const filter = savedFilters.find((item) => item.id === value);
              if (filter) applySavedFilter(filter);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                <AutoTransition
                  transitionKey={savedFilterTriggerKey}
                  type="fade"
                  duration={0.18}
                  initial={false}
                >
                  <span>{savedFilterTriggerLabel}</span>
                </AutoTransition>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={NO_SAVED_FILTER_VALUE}>
                  {messages.filterBuilder.noSavedFilter}
                </SelectItem>
              </SelectGroup>
              {audience === "private-dashboard" &&
              savedFilters.some((filter) => filter.isOwner) ? (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>
                      {messages.filterBuilder.savedFiltersPersonal}
                    </SelectLabel>
                    {savedFilters
                      .filter((filter) => filter.isOwner)
                      .map((filter) => (
                        <SelectItem key={filter.id} value={filter.id}>
                          {filter.name}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </>
              ) : null}
              {audience === "private-dashboard" &&
              savedFilters.some((filter) => !filter.isOwner) ? (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>
                      {messages.filterBuilder.savedFiltersTeam}
                    </SelectLabel>
                    {savedFilters
                      .filter((filter) => !filter.isOwner)
                      .map((filter) => (
                        <SelectItem key={filter.id} value={filter.id}>
                          {filter.name}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                </>
              ) : null}
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>
                  {messages.filterBuilder.systemPresets}
                </SelectLabel>
                {SYSTEM_FILTER_PRESETS.map((preset) => (
                  <SelectItem
                    key={preset.id}
                    value={systemFilterPresetOptionValue(preset.id)}
                  >
                    {systemPresetItem(messages, preset.id).name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          <AutoResizer initial={false} duration={0.18}>
            <AutoTransition
              transitionKey={
                matchedSavedFilter?.id ??
                (matchedSystemPreset
                  ? systemFilterPresetOptionValue(matchedSystemPreset.id)
                  : "none")
              }
              type="fade"
              duration={0.18}
              initial={false}
            >
              {matchedSavedFilter ? (
                <div className="space-y-1.5 pt-3 text-xs text-muted-foreground">
                  {matchedSavedFilter.description ? (
                    <p className="break-words">
                      {matchedSavedFilter.description}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="inline-flex items-center gap-1">
                      <RiUserLine className="size-3.5" aria-hidden />
                      {formatI18nTemplate(
                        messages.filterBuilder.savedFiltersAuthor,
                        { name: matchedSavedFilter.authorName },
                      )}
                    </span>
                    <span>
                      {matchedSavedFilter.visibility === "team"
                        ? messages.filterBuilder.savedFiltersTeamShared
                        : messages.filterBuilder.savedFiltersPrivate}
                    </span>
                  </div>
                </div>
              ) : matchedSystemPreset ? (
                <p className="pt-3 text-xs text-muted-foreground">
                  {
                    systemPresetItem(messages, matchedSystemPreset.id)
                      .description
                  }
                </p>
              ) : null}
            </AutoTransition>
          </AutoResizer>
        </div>

        <div className="mb-4 border-b border-border pb-4">
          <div className="space-y-1.5">
            <Label htmlFor="filter-panel-scope">
              {messages.filterBuilder.scopeLabel}
            </Label>
            <Select
              value={scopePreference}
              onValueChange={(value) =>
                onScopeChange(value as FilterScopePreference)
              }
            >
              <SelectTrigger id="filter-panel-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {messages.filterBuilder.scopeAuto}
                </SelectItem>
                <SelectItem value="event">
                  {messages.filterBuilder.scopeEvent}
                </SelectItem>
                <SelectItem value="session">
                  {messages.filterBuilder.scopeSession}
                </SelectItem>
                <SelectItem value="visitor">
                  {messages.filterBuilder.scopeVisitor}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <GroupEditor
          audience={audience}
          document={document}
          eventName={eventName}
          group={root}
          isRoot
          messages={messages}
          path={[]}
          resolvedScope={suggestionScope}
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
      </VerticalScrollMask>

      <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background">
        <div className="border-b border-border bg-muted/20">
          <AutoResizer initial={false} duration={0.18}>
            <AutoTransition
              transitionKey={naturalLanguageDescription}
              type="fade"
              duration={0.18}
              initial={false}
            >
              <VerticalScrollMask
                syncKey={naturalLanguageDescription}
                className="max-h-28"
                contentClassName="max-h-28"
                maskClassName="from-muted/20 via-muted/10 to-transparent"
              >
                <div
                  aria-label={messages.filterBuilder.naturalLanguageDescription}
                  className="min-h-8 px-4 py-2 text-xs leading-4 text-muted-foreground"
                >
                  <RiChatQuoteLine
                    className="mr-2 inline-block size-4 align-text-bottom"
                    aria-hidden
                  />
                  <span className="break-words">
                    {naturalLanguageDescription}
                  </span>
                </div>
              </VerticalScrollMask>
            </AutoTransition>
          </AutoResizer>
        </div>
        <div className="border-b border-border">
          <OverlayScrollbar
            axis="horizontal"
            syncKey={expressionText}
            className="w-full"
          >
            <Input
              id="filter-panel-expression"
              aria-label={messages.filterBuilder.expression}
              aria-invalid={expressionError ? true : undefined}
              className="h-8 min-w-full border-0 bg-transparent px-4 font-mono text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
              placeholder={messages.filterBuilder.expressionPlaceholder}
              style={{ width: `${Math.max(32, expressionText.length + 3)}ch` }}
              value={expressionText}
              onChange={(event) => {
                const source = event.target.value;
                setExpressionText(source);
                updateFromExpressionText(source);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commitExpressionText();
              }}
            />
          </OverlayScrollbar>
        </div>
        <AutoResizer initial={false} duration={0.18}>
          <AutoTransition
            transitionKey={expressionError ? "invalid" : "valid"}
            type="slideDown"
            duration={0.18}
            initial={false}
          >
            {expressionError ? (
              <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-destructive">
                <RiErrorWarningLine className="size-4 shrink-0" aria-hidden />
                <Clickable
                  className="justify-start text-left text-destructive"
                  hoverScale={1.05}
                  onClick={() => setExpressionHelpOpen(true)}
                >
                  {expressionError}
                </Clickable>
              </div>
            ) : null}
          </AutoTransition>
        </AutoResizer>
        <div className="flex flex-wrap justify-between gap-2 px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setRoot(emptyEditorGroup(createId));
              setValidationError(null);
              setExpressionError(null);
            }}
          >
            <RiFilterOffLine />
            <span>{messages.filters.clear}</span>
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {savedFilterPrimaryAction === "save" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => openSavedFilterCreate()}
              >
                <RiSaveLine />
                <span>{messages.filterBuilder.saveThisFilter}</span>
              </Button>
            ) : null}
            {savedFilterPrimaryAction === "save-as" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => openSavedFilterCreate(matchedSavedFilter)}
              >
                <RiFileCopyLine />
                <span>{messages.filterBuilder.saveAsThisFilter}</span>
              </Button>
            ) : null}
            {savedFilterPrimaryAction === "manage" && matchedSavedFilter ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => openSavedFilterManagement(matchedSavedFilter)}
              >
                <RiEditLine />
                <span>{messages.filterBuilder.manageThisFilter}</span>
              </Button>
            ) : null}
            {savedFilterPrimaryAction === "finish" ? (
              <Button
                type="button"
                variant="outline"
                disabled={updateSavedFilterMutation.isPending}
                onClick={finishSavedFilterEditing}
              >
                {updateSavedFilterMutation.isPending ? (
                  <Spinner />
                ) : (
                  <RiCheckLine />
                )}
                <span>{messages.filterBuilder.finishEditingFilter}</span>
              </Button>
            ) : null}
            <Button type="button" onClick={apply}>
              <RiCheckLine />
              <span>{messages.filterBuilder.apply}</span>
            </Button>
          </div>
        </div>
      </div>
      <ResponsiveDialog
        open={createSavedFilterOpen}
        onOpenChange={(nextOpen) => {
          setCreateSavedFilterOpen(nextOpen);
          if (!nextOpen) setSavedFilterOperationError(null);
        }}
      >
        <ResponsiveDialogContent desktopClassName="max-w-md">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiSaveLine}>
              {messages.filterBuilder.createSavedFilter}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {messages.filterBuilder.savedFilterCreateDescription}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <SavedFilterFormFields
              form={savedFilterForm}
              messages={messages}
              onChange={setSavedFilterForm}
            />
            {savedFilterOperationError ? (
              <p className="text-xs text-destructive">
                {savedFilterOperationError}
              </p>
            ) : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={createSavedFilterMutation.isPending}
              onClick={() => setCreateSavedFilterOpen(false)}
            >
              {messages.filterBuilder.savedFilterCancel}
            </Button>
            <Button
              type="button"
              disabled={
                createSavedFilterMutation.isPending ||
                savedFilterForm.name.trim().length === 0
              }
              onClick={() => {
                setSavedFilterOperationError(null);
                createSavedFilterMutation.mutate(savedFilterForm);
              }}
            >
              {createSavedFilterMutation.isPending ? (
                <Spinner />
              ) : (
                <RiSaveLine />
              )}
              <span>
                {createSavedFilterMutation.isPending
                  ? messages.filterBuilder.savedFilterSaving
                  : messages.filterBuilder.savedFilterSave}
              </span>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <ResponsiveDialog
        open={manageSavedFilterOpen}
        onOpenChange={(nextOpen) => {
          setManageSavedFilterOpen(nextOpen);
          if (!nextOpen) setSavedFilterOperationError(null);
        }}
      >
        <ResponsiveDialogContent desktopClassName="max-w-md">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiEditLine}>
              {messages.filterBuilder.manageSavedFilter}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {messages.filterBuilder.savedFilterManageDescription}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <SavedFilterFormFields
              form={savedFilterForm}
              messages={messages}
              onChange={setSavedFilterForm}
            />
            {savedFilterOperationError ? (
              <p className="text-xs text-destructive">
                {savedFilterOperationError}
              </p>
            ) : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="destructive"
              disabled={
                !managedSavedFilter || updateSavedFilterMutation.isPending
              }
              onClick={() => {
                setSavedFilterOperationError(null);
                setConfirmSavedFilterDeleteOpen(true);
              }}
            >
              <RiDeleteBinLine />
              <span>{messages.filterBuilder.deleteSavedFilter}</span>
            </Button>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={updateSavedFilterMutation.isPending}
                onClick={() => setManageSavedFilterOpen(false)}
              >
                {messages.filterBuilder.savedFilterCancel}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  !managedSavedFilter || updateSavedFilterMutation.isPending
                }
                onClick={() => {
                  if (!managedSavedFilter) return;
                  setEditingSavedFilterId(managedSavedFilter.id);
                  setManageSavedFilterOpen(false);
                  setSavedFilterOperationError(null);
                }}
              >
                <RiEditLine />
                <span>{messages.filterBuilder.editSavedFilter}</span>
              </Button>
              <Button
                type="button"
                disabled={
                  !managedSavedFilter ||
                  updateSavedFilterMutation.isPending ||
                  savedFilterForm.name.trim().length === 0
                }
                onClick={() => {
                  if (!managedSavedFilter) return;
                  setSavedFilterOperationError(null);
                  updateSavedFilterMutation.mutate({
                    filterId: managedSavedFilter.id,
                    form: savedFilterForm,
                    filterDsl: managedSavedFilter.filterDsl,
                    finishEditing: false,
                  });
                }}
              >
                {updateSavedFilterMutation.isPending ? (
                  <Spinner />
                ) : (
                  <RiSaveLine />
                )}
                <span>
                  {updateSavedFilterMutation.isPending
                    ? messages.filterBuilder.savedFilterSaving
                    : messages.filterBuilder.savedFilterSave}
                </span>
              </Button>
            </div>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <AlertDialog
        open={confirmSavedFilterDeleteOpen}
        onOpenChange={setConfirmSavedFilterDeleteOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle
              icon={RiDeleteBinLine}
              iconClassName="text-destructive"
            >
              {messages.filterBuilder.deleteSavedFilterTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {messages.filterBuilder.deleteSavedFilterDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSavedFilterMutation.isPending}>
              {messages.filterBuilder.savedFilterCancel}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={
                !managedSavedFilter || deleteSavedFilterMutation.isPending
              }
              onClick={(event) => {
                event.preventDefault();
                if (!managedSavedFilter) return;
                setSavedFilterOperationError(null);
                deleteSavedFilterMutation.mutate(managedSavedFilter.id);
              }}
            >
              {deleteSavedFilterMutation.isPending ? (
                <Spinner />
              ) : (
                <RiDeleteBinLine />
              )}
              <span>
                {deleteSavedFilterMutation.isPending
                  ? messages.filterBuilder.savedFilterDeleting
                  : messages.filterBuilder.savedFilterDelete}
              </span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <FilterExpressionHelpDialog
        audience={audience}
        messages={messages}
        open={expressionHelpOpen}
        onOpenChange={setExpressionHelpOpen}
      />
    </div>
  );
}
