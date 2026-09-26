import {
  FILTER_PICKER_TARGET_VALUE_PREFIX,
  filterPickerValueForSelection,
} from "@/lib/filter-contract/filter-picker-registry";
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
  type FilterTargetExpression,
  type FilterValue,
  type FilterValueKind,
  formatFilterDsl,
  isLegacyFilterTarget,
  legacyConditionValue,
  normalizeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract/index";
export type FilterPanelAudience = "private-dashboard" | "public-share";
export type ScalarKind = "string" | "number" | "boolean";
export const ADVANCED_FILTER_FIELD_PREFIX = FILTER_PICKER_TARGET_VALUE_PREFIX;
export const ADVANCED_FILTER_TARGET_KINDS = [
  "time",
  "entity-root",
  "context-root",
  "member",
  "selector",
  "projection",
  "reducer",
  "arithmetic",
  "duration",
  "time-anchor",
  "bucket",
  "window",
  "periods",
  "sequence",
  "adjacent",
  "without",
] as const;
export type AdvancedFilterTargetKind =
  (typeof ADVANCED_FILTER_TARGET_KINDS)[number];
export const FILTER_TARGET_EDITOR_KINDS = [
  "time",
  "field",
  "event-payload",
  "entity-root",
  "context-root",
  "member",
  "selector",
  "projection",
  "reducer",
  "arithmetic",
  "duration",
  "time-anchor",
  "bucket",
  "window",
  "periods",
  "sequence",
  "adjacent",
  "without",
] as const;
export type FilterTargetEditorKind =
  (typeof FILTER_TARGET_EDITOR_KINDS)[number];
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
  /** Typed advanced filter condition represented by the outer condition row. */
  readonly advancedExpression?: FilterExpression;
  /** Legacy fallback retained for drafts created by older editor state. */
  readonly advancedText?: string;
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

export function advancedFilterFieldValue(
  kind: AdvancedFilterTargetKind,
): string {
  return `${ADVANCED_FILTER_FIELD_PREFIX}${kind}`;
}

export function advancedFilterFieldValueForTarget(
  target: FilterTargetExpression,
): string {
  if (
    target.kind === "member" &&
    target.object.kind === "context-root" &&
    target.object.context === "current" &&
    target.member === "time"
  )
    return advancedFilterFieldValue("time");
  if (
    target.kind === "selector" &&
    target.collection.kind === "entity-root" &&
    (target.collection.entity === "session" ||
      target.collection.entity === "visitor") &&
    target.predicate.kind === "condition" &&
    (target.predicate.target.kind === "sequence" ||
      target.predicate.target.kind === "adjacent" ||
      target.predicate.target.kind === "without")
  )
    return advancedFilterFieldValue(target.predicate.target.kind);
  if (target.kind === "field") return target.field;
  if (target.kind === "event-payload") return "event.payload";
  if (target.kind === "entity-root")
    return (
      filterPickerValueForSelection({
        kind: "entity-root",
        entity: target.entity,
      }) ?? advancedFilterFieldValue("entity-root")
    );
  if (target.kind === "reducer")
    return (
      filterPickerValueForSelection({
        kind: "reducer",
        reducer: target.reducer,
      }) ?? advancedFilterFieldValue("reducer")
    );
  if (target.kind === "arithmetic")
    return (
      filterPickerValueForSelection({
        kind: "arithmetic",
        operator: target.operator,
      }) ?? advancedFilterFieldValue("arithmetic")
    );
  if (
    target.kind === "bucket" ||
    target.kind === "window" ||
    target.kind === "periods" ||
    target.kind === "sequence" ||
    target.kind === "adjacent" ||
    target.kind === "without"
  )
    return (
      filterPickerValueForSelection({
        kind: "target",
        targetKind: target.kind,
      }) ?? advancedFilterFieldValue(target.kind)
    );
  return advancedFilterFieldValue(target.kind);
}

export function advancedFilterTargetKindFromField(
  field: string,
): AdvancedFilterTargetKind | null {
  if (!field.startsWith(ADVANCED_FILTER_FIELD_PREFIX)) return null;
  const kind = field.slice(ADVANCED_FILTER_FIELD_PREFIX.length);
  return (ADVANCED_FILTER_TARGET_KINDS as readonly string[]).includes(kind)
    ? (kind as AdvancedFilterTargetKind)
    : null;
}
export const VALUELESS_OPERATORS = new Set<FilterOperator>([
  "exists",
  "notExists",
  "isNull",
  "notNull",
  "isEmpty",
  "notEmpty",
]);
export const LIST_OPERATORS = new Set<FilterOperator>(["in", "notIn"]);
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
export function firstOperator(
  definition: FilterFieldDefinition,
): FilterOperator {
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
export function filterValueText(value: FilterValue): string {
  return value === null ? "null" : String(value);
}
export function filterValueKey(value: FilterValue): string {
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
    const isAdvancedValue = Boolean(
      expression.value &&
      typeof expression.value === "object" &&
      !Array.isArray(expression.value) &&
      "kind" in expression.value,
    );
    if (!isLegacyFilterTarget(expression.target) || isAdvancedValue) {
      const value = isAdvancedValue
        ? undefined
        : legacyConditionValue(expression.value);
      return {
        id: createId(),
        kind: "condition",
        negated: notCount % 2 === 1,
        notCount,
        field: advancedFilterFieldValueForTarget(expression.target),
        payloadPath: "",
        operator: expression.operator,
        value,
        listValues: Array.isArray(value) ? value : undefined,
        valueText: value === undefined ? "" : valueTextFor(value),
        scalarKind: scalarKindFor(value),
        valueDirty: false,
        advancedExpression: expression,
      };
    }
    const value = legacyConditionValue(expression.value);
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
      value,
      listValues: Array.isArray(value) ? value : undefined,
      valueText: valueTextFor(value),
      scalarKind: scalarKindFor(value),
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
  if (node.advancedExpression?.kind === "condition") {
    return node.advancedExpression;
  }
  if (node.advancedText !== undefined) {
    const parsed = parseFilterDsl(node.advancedText, analyticsFilterRegistry);
    if (parsed.root?.kind !== "condition")
      throw new Error("advanced_node_must_be_condition");
    return parsed.root;
  }
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
