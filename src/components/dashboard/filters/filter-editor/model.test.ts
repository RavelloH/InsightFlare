import { describe, expect, it } from "vitest";

import {
  appendEditorNode,
  conditionIdFactory,
  defaultCondition,
  defaultGroup,
  displayRootExpression,
  documentFromEditor,
  editorRootFromDocument,
  emptyEditorGroup,
  expressionTextFromEditor,
  filterValueKey,
  filterValueText,
  firstOperator,
  LIST_OPERATORS,
  reconcileEditorRoot,
  removeEditorNode,
  stripSuggestionFacet,
  updateEditorNode,
  VALUELESS_OPERATORS,
} from "@/components/dashboard/filters/filter-editor/model";
import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract/index";

const ids = conditionIdFactory();
const parsed = (source: string) =>
  parseFilterDsl(source, analyticsFilterRegistry);

describe("filter editor tree model", () => {
  it("creates defaults and strips matching suggestions through nested expressions", () => {
    expect(ids()).toBe("filter-node-1");
    expect(ids()).toBe("filter-node-2");
    expect(VALUELESS_OPERATORS.has("exists")).toBe(true);
    expect(LIST_OPERATORS.has("in")).toBe(true);
    expect(firstOperator(analyticsFilterRegistry.get("page.path")!)).toBe("eq");
    expect(firstOperator({ operators: new Set(["gte", "lt"]) } as never)).toBe(
      "gte",
    );
    expect(filterValueText(null)).toBe("null");
    expect(filterValueKey("value")).toBe('"value"');
    expect(defaultCondition(ids)).toMatchObject({
      kind: "condition",
      field: "page.path",
    });
    expect(defaultGroup(ids).children).toHaveLength(1);
    expect(emptyEditorGroup(ids).children).toEqual([]);

    const document = parsed('page.path eq "/pricing" AND geo.country eq "US"');
    expect(stripSuggestionFacet(document, "missing.field", "")).toBe(document);
    const stripped = stripSuggestionFacet(document, "page.path", "");
    expect(stripped.root).not.toBeNull();
    expect(JSON.stringify(stripped.root)).not.toContain("page.path");
    const nested = parsed(
      'NOT(event.payload("/cart/id") eq "x" OR page.path eq "/")',
    );
    const payloadStripped = stripSuggestionFacet(
      nested,
      "event.payload",
      "/cart/id",
    );
    expect(JSON.stringify(payloadStripped.root)).not.toContain("/cart/id");
    expect(stripSuggestionFacet(nested, "event.payload", "")).toBe(nested);
    expect(
      stripSuggestionFacet(EMPTY_DASHBOARD_FILTER_DOCUMENT, "page.path", ""),
    ).toBe(EMPTY_DASHBOARD_FILTER_DOCUMENT);
  });

  it("round-trips editor trees and keeps invalid display nodes out of expressions", () => {
    const empty = editorRootFromDocument(EMPTY_DASHBOARD_FILTER_DOCUMENT, ids);
    expect(empty.children).toEqual([]);
    expect(displayRootExpression(empty)).toBeNull();
    expect(expressionTextFromEditor(empty)).toBe("");
    expect(documentFromEditor(empty).root).toBeNull();

    const document = parsed(
      'NOT(page.path eq "/pricing") AND geo.country in ["US", "GB"]',
    );
    const editor = editorRootFromDocument(document, ids);
    expect(editor.children).toHaveLength(2);
    expect(displayRootExpression(editor)).not.toBeNull();
    expect(expressionTextFromEditor(editor)).toContain("page.path");
    expect(documentFromEditor(editor).root).not.toBeNull();

    const group = emptyEditorGroup(ids);
    const missingValue = defaultCondition(ids);
    const invalidGroup = { ...group, children: [missingValue] };
    expect(displayRootExpression(invalidGroup)).toBeNull();
    expect(expressionTextFromEditor(invalidGroup)).toBe("");
    expect(() => documentFromEditor(invalidGroup)).toThrow("missing_value");

    const valueless = {
      ...defaultCondition(ids),
      operator: "exists" as const,
      valueDirty: true,
    };
    const noValueGroup = { ...group, children: [valueless] };
    expect(displayRootExpression(noValueGroup)).not.toBeNull();
    expect(documentFromEditor(noValueGroup).root).not.toBeNull();

    const listCondition = {
      ...defaultCondition(ids),
      operator: "in" as const,
      valueDirty: true,
      valueText: "US, GB",
      scalarKind: "string" as const,
    };
    const listDoc = documentFromEditor({ ...group, children: [listCondition] });
    expect(JSON.stringify(listDoc.root)).toContain("US");
  });

  it("reconciles nodes, updates, appends, and removes by stable ids", () => {
    const current = editorRootFromDocument(parsed('page.path eq "/a"'), ids);
    const same = editorRootFromDocument(parsed('page.path eq "/a"'), ids);
    expect(reconcileEditorRoot(current, same)).toBe(current);

    const changed = editorRootFromDocument(parsed('page.path eq "/b"'), ids);
    const reconciled = reconcileEditorRoot(current, changed);
    expect(reconciled.id).toBe(current.id);
    expect((reconciled.children[0] as { id: string }).id).toBe(
      (current.children[0] as { id: string }).id,
    );

    const leaf = current.children[0]!;
    expect(updateEditorNode(current, "absent", (node) => node)).toBe(current);
    const updated = updateEditorNode(current, leaf.id, (node) => ({
      ...node,
      negated: true,
    }));
    expect(updated).toMatchObject({
      children: [expect.objectContaining({ negated: true })],
    });

    const child = defaultCondition(ids);
    const appended = appendEditorNode(current, current.id, child);
    expect(appended.kind).toBe("group");
    if (appended.kind === "group") {
      expect(appended.children).toHaveLength(current.children.length + 1);
    }
    expect(appendEditorNode(leaf, leaf.id, child)).toBe(leaf);
    const withSibling = appendEditorNode(
      current,
      current.id,
      defaultCondition(ids),
    );
    expect(removeEditorNode(withSibling, leaf.id)?.kind).toBe("group");
    expect(removeEditorNode(current, current.id)).toBeNull();
    expect(removeEditorNode(leaf, "absent")).toBe(leaf);

    const malformed = {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "missing" },
        operator: "eq",
        value: "x",
      },
    } as unknown as FilterDocument;
    const invalidEditor = editorRootFromDocument(malformed, ids);
    expect(displayRootExpression(invalidEditor)).toBeNull();
    expect(expressionTextFromEditor(invalidEditor)).toBe("");
  });
});
