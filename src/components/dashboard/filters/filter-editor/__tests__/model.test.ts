import { describe, expect, it } from "vitest";

import {
  advancedFilterFieldValue,
  advancedFilterFieldValueForTarget,
  advancedFilterTargetKindFromField,
  appendEditorNode,
  conditionIdFactory,
  defaultCondition,
  defaultGroup,
  documentFromEditor,
  editorRootFromDocument,
  emptyEditorGroup,
  expressionTextFromEditor,
  filterValueKey,
  filterValueText,
  firstOperator,
  reconcileEditorRoot,
  removeEditorNode,
  stripSuggestionFacet,
  updateEditorNode,
} from "@/components/dashboard/filters/filter-editor/model";
import {
  analyticsFilterRegistry,
  normalizeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";

describe("filter editor tree model", () => {
  it("maps registered, legacy, and advanced target selections", () => {
    expect(advancedFilterTargetKindFromField("page.path")).toBeNull();
    expect(advancedFilterTargetKindFromField("advanced:future")).toBeNull();
    expect(
      advancedFilterTargetKindFromField(advancedFilterFieldValue("time")),
    ).toBe("time");
    expect(
      advancedFilterFieldValueForTarget({
        kind: "field",
        field: "page.path" as never,
      }),
    ).toBe("page.path");
    expect(
      advancedFilterFieldValueForTarget({
        kind: "event-payload",
        path: "/amount" as never,
      }),
    ).toBe("event.payload");
    expect(
      advancedFilterFieldValueForTarget({
        kind: "entity-root",
        entity: "page",
      }),
    ).toContain("entity-root");
    expect(
      advancedFilterFieldValueForTarget({
        kind: "entity-root",
        entity: "event",
      }),
    ).toContain("entity-root");
    expect(
      advancedFilterFieldValueForTarget({
        kind: "reducer",
        reducer: "count",
        input: { kind: "entity-root", entity: "page" },
      }),
    ).toContain("reducer");
    expect(
      advancedFilterFieldValueForTarget({
        kind: "arithmetic",
        operator: "add",
        left: { kind: "duration", amount: 1, unit: "s" },
        right: { kind: "duration", amount: 1, unit: "s" },
      }),
    ).toContain("arithmetic");
    for (const targetKind of [
      "bucket",
      "window",
      "periods",
      "sequence",
      "adjacent",
      "without",
    ] as const) {
      expect(
        advancedFilterFieldValueForTarget(
          targetKind === "bucket"
            ? {
                kind: targetKind,
                input: { kind: "entity-root", entity: "page" },
                interval: { kind: "duration", amount: 1, unit: "d" },
              }
            : targetKind === "periods"
              ? {
                  kind: targetKind,
                  collection: { kind: "entity-root", entity: "page" },
                  interval: { kind: "duration", amount: 1, unit: "d" },
                }
              : targetKind === "window"
                ? {
                    kind: targetKind,
                    collection: { kind: "entity-root", entity: "page" },
                    anchor: { kind: "time-anchor", anchor: "now" },
                    startOffset: { kind: "duration", amount: 0, unit: "d" },
                    endOffset: { kind: "duration", amount: 1, unit: "d" },
                  }
                : targetKind === "sequence"
                  ? {
                      kind: targetKind,
                      steps: [
                        { kind: "entity-root", entity: "page" },
                        { kind: "entity-root", entity: "event" },
                      ],
                    }
                  : targetKind === "adjacent"
                    ? {
                        kind: targetKind,
                        sequence: {
                          kind: "sequence",
                          steps: [
                            { kind: "entity-root", entity: "page" },
                            { kind: "entity-root", entity: "event" },
                          ],
                        },
                      }
                    : {
                        kind: targetKind,
                        sequence: {
                          kind: "sequence",
                          steps: [
                            { kind: "entity-root", entity: "page" },
                            { kind: "entity-root", entity: "event" },
                          ],
                        },
                        excluded: { kind: "entity-root", entity: "event" },
                      },
        ),
      ).toContain(targetKind);
    }
    expect(filterValueText(null)).toBe("null");
    expect(filterValueKey("value")).toBe('"value"');
    expect(
      firstOperator({
        id: "metric.flag",
        valueKind: "boolean",
        operators: new Set(["exists", "notExists"]),
        audiences: new Set(["private-dashboard"]),
      }),
    ).toBe("exists");
  });

  it("strips only matching suggestion facets and preserves document metadata", () => {
    const source = parseFilterDsl(
      'page.path eq "/docs" AND NOT (geo.country eq "US" OR page.path eq "/pricing")',
      analyticsFilterRegistry,
    );
    const symbol = Symbol("scope");
    const annotated = Object.defineProperty({ ...source }, symbol, {
      value: "visitor",
      enumerable: false,
    });
    expect(stripSuggestionFacet(source, "missing.field", "")).toBe(source);
    expect(stripSuggestionFacet(source, "event.payload", "")).toBe(source);
    const stripped = stripSuggestionFacet(annotated, "page.path", "");
    expect(stripped.root).toEqual(
      parseFilterDsl('NOT geo.country eq "US"', analyticsFilterRegistry).root,
    );
    expect(stripped[symbol as never]).toBe("visitor");
    expect(stripSuggestionFacet(source, "geo.country", "").root).toMatchObject({
      kind: "and",
    });
    expect(
      stripSuggestionFacet(
        parseFilterDsl('event.payload("/id") eq "1"', analyticsFilterRegistry),
        "event.payload",
        "/id",
      ).root,
    ).toBeNull();
  });

  it("converts dirty typed values and refuses incomplete editor conditions", () => {
    const createId = conditionIdFactory();
    const root = emptyEditorGroup(createId);
    const numberCondition = {
      ...defaultCondition(createId),
      field: "page.durationMs",
      operator: "gte" as const,
      valueText: "12.5",
      scalarKind: "number" as const,
    };
    const listCondition = {
      ...defaultCondition(createId),
      field: "page.path",
      operator: "in" as const,
      valueText: "/docs, /pricing",
    };
    const booleanCondition = {
      ...defaultCondition(createId),
      field: "session.bounce",
      operator: "eq" as const,
      valueText: "true",
      scalarKind: "boolean" as const,
    };
    const withConditions = {
      ...root,
      children: [numberCondition, listCondition, booleanCondition],
    };
    const document = documentFromEditor(withConditions);
    expect(document.root).toMatchObject({
      kind: "and",
      children: expect.arrayContaining([
        expect.objectContaining({ value: 12.5 }),
        expect.objectContaining({ value: ["/docs", "/pricing"] }),
        expect.objectContaining({ value: true }),
      ]),
    });
    expect(() =>
      documentFromEditor({ ...root, children: [defaultCondition(createId)] }),
    ).toThrow("missing_value");

    const unary = {
      ...defaultCondition(createId),
      operator: "exists" as const,
    };
    expect(
      documentFromEditor({ ...root, children: [unary] }).root,
    ).toMatchObject({ operator: "exists" });
  });

  it("parses edited JSON payload values using the selected scalar type", () => {
    const createId = conditionIdFactory();
    const root = emptyEditorGroup(createId);
    const numberRange = {
      ...defaultCondition(createId),
      field: "event.payload",
      payloadPath: "/score",
      operator: "between" as const,
      valueText: "1, 3",
      scalarKind: "number" as const,
    };
    const boolean = {
      ...defaultCondition(createId),
      field: "event.payload",
      payloadPath: "/active",
      operator: "eq" as const,
      valueText: "true",
      scalarKind: "boolean" as const,
    };
    const string = {
      ...defaultCondition(createId),
      field: "event.payload",
      payloadPath: "/label",
      operator: "eq" as const,
      valueText: "ready",
      scalarKind: "string" as const,
    };
    const document = documentFromEditor({
      ...root,
      children: [numberRange, boolean, string],
    });

    expect(document.root).toMatchObject({
      kind: "and",
      children: expect.arrayContaining([
        expect.objectContaining({ value: [1, 3] }),
        expect.objectContaining({ value: true }),
        expect.objectContaining({ value: "ready" }),
      ]),
    });
  });

  it("reconciles unchanged nodes and applies recursive tree edits immutably", () => {
    const createId = conditionIdFactory();
    const original = defaultGroup(createId);
    const leaf = original.children[0]!;
    const same = reconcileEditorRoot(original, {
      ...original,
      children: [...original.children],
    });
    expect(same).toMatchObject({
      id: original.id,
      children: original.children,
    });

    const changed = updateEditorNode(original, leaf.id, (node) => ({
      ...node,
      field: "geo.country",
    }));
    expect(changed).not.toBe(original);
    expect(changed).toMatchObject({
      children: [expect.objectContaining({ field: "geo.country" })],
    });
    expect(updateEditorNode(original, "missing", (node) => node)).toBe(
      original,
    );

    const nested = defaultGroup(createId);
    const appended = appendEditorNode(original, original.id, nested);
    expect(appended).toMatchObject({ children: expect.any(Array) });
    expect((appended as typeof original).children).toHaveLength(2);
    expect(appendEditorNode(original, "missing", nested)).toBe(original);
    expect(removeEditorNode(appended, nested.id)).toMatchObject({
      children: [expect.any(Object)],
    });
    expect(removeEditorNode(original, "missing")).toBe(original);
    expect(removeEditorNode(original, original.id)).toBeNull();
    expect(
      editorRootFromDocument(
        normalizeFilterDocument(
          { version: 1, root: null },
          analyticsFilterRegistry,
        ),
        createId,
      ).children,
    ).toEqual([]);
    expect(expressionTextFromEditor(original)).toBe("");
  });

  it("preserves NOT counts while converting between document and tree", () => {
    const document = parseFilterDsl(
      'NOT (page.path eq "/private" OR page.path eq "/hidden")',
      analyticsFilterRegistry,
    );
    const root = editorRootFromDocument(document, conditionIdFactory());
    expect(documentFromEditor(root)).toEqual(
      normalizeFilterDocument(document, analyticsFilterRegistry),
    );
    expect(expressionTextFromEditor(root)).toContain("NOT");
  });

  it("reads legacy advanced text and omits invalid draft rows from the preview", () => {
    const createId = conditionIdFactory();
    const root = emptyEditorGroup(createId);
    const valid = {
      ...defaultCondition(createId),
      advancedText: 'page.path eq "/legacy"',
    };
    const validRoot = { ...root, children: [valid] };

    expect(documentFromEditor(validRoot)).toEqual(
      parseFilterDsl('page.path eq "/legacy"', analyticsFilterRegistry),
    );
    expect(expressionTextFromEditor(validRoot)).toContain("/legacy");
    expect(() =>
      documentFromEditor({
        ...root,
        children: [
          { ...valid, advancedText: 'page.path eq "/a" AND page.path eq "/b"' },
        ],
      }),
    ).toThrow("advanced_node_must_be_condition");

    const invalid = { ...valid, advancedText: "page.path eq" };
    expect(
      expressionTextFromEditor({ ...root, children: [invalid, valid] }),
    ).toContain("/legacy");
  });

  it("reconciles edited and reordered nested nodes without replacing their ids", () => {
    const createId = conditionIdFactory();
    const group = defaultGroup(createId);
    const first = { ...group.children[0]!, valueText: "/first" };
    const second = {
      ...defaultCondition(createId),
      field: "geo.region",
      valueText: "California",
    };
    const nested = { ...group, children: [first, second] };
    const editedFirst = { ...first, field: "geo.country" };
    const incoming = { ...nested, children: [second, editedFirst] };
    const reconciled = reconcileEditorRoot(nested, incoming);

    expect(reconciled.children[0]).toBe(second);
    expect(reconciled.children[1]).toMatchObject({
      id: first.id,
      field: "geo.country",
    });
    const recursivelyUpdated = updateEditorNode(nested, second.id, (node) => ({
      ...node,
      valueText: "/new",
    }));
    expect(recursivelyUpdated).toMatchObject({
      children: [expect.any(Object), { id: second.id, valueText: "/new" }],
    });
  });
});
