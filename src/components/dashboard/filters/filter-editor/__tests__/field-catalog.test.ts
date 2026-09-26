import { describe, expect, it } from "vitest";

import {
  allowedFields,
  directEventName,
  fieldLabel,
  filterPickerGroups,
  isSelectablePayloadFieldType,
  payloadFieldTypeLabel,
  registryFieldGroups,
} from "@/components/dashboard/filters/filter-editor/field-catalog";
import type {
  EditorCondition,
  EditorGroup,
} from "@/components/dashboard/filters/filter-editor/model";
import type { RegisteredFilterField } from "@/lib/filter-contract/filter-registry";
import type { AppMessages } from "@/lib/i18n/messages";

const messages = {
  analytics: { filters: { fields: { page: { path: "Page path" } } } },
  filterBuilder: {
    expressionHelpOtherFields: "Other fields",
    fieldGroups: { page: "Pages", event: "Events" },
    fieldLabels: {
      "page.path": "Page path fallback",
      "page.collection": "Page collection",
    },
    valueKinds: { string: "String", number: "Number", boolean: "Boolean" },
  },
} as unknown as AppMessages;

function condition(
  field: string,
  valueText: string,
  overrides: Partial<EditorCondition> = {},
): EditorCondition {
  return {
    id: field,
    kind: "condition",
    negated: false,
    notCount: 0,
    field,
    payloadPath: "",
    operator: "eq",
    value: undefined,
    listValues: undefined,
    valueText,
    scalarKind: "string",
    valueDirty: false,
    ...overrides,
  };
}

function group(children: EditorGroup["children"]): EditorGroup {
  return {
    id: "root",
    kind: "group",
    negated: false,
    notCount: 0,
    combinator: "and",
    children,
  };
}

describe("filter field catalog", () => {
  it("resolves registered labels and falls back when translations are absent", () => {
    const pagePath = allowedFields("private-dashboard").find(
      (field) => field.id === "page.path",
    )!;

    expect(fieldLabel(pagePath, messages)).toBe("Page path");
    expect(fieldLabel("page.collection", messages)).toBe("Page collection");
    expect(fieldLabel("missing.field", messages)).toBe("missing.field");
  });

  it("groups real fields and picker targets in the requested order", () => {
    const fields = allowedFields("private-dashboard").filter((field) =>
      ["page.path", "event.name"].includes(field.id),
    );

    expect(
      registryFieldGroups(fields, messages).map((item) => item.key),
    ).toEqual(["page", "event"]);
    expect(filterPickerGroups(fields, messages).slice(0, 2)).toEqual([
      {
        key: "page",
        label: "Pages",
        fields: expect.arrayContaining([
          expect.objectContaining({ id: "page", label: "Page collection" }),
          expect.objectContaining({ id: "page.path", label: "Page path" }),
        ]),
      },
      {
        key: "event",
        label: "Events",
        fields: expect.arrayContaining([
          expect.objectContaining({ id: "event" }),
          expect.objectContaining({ id: "event.name" }),
        ]),
      },
    ]);
  });

  it("uses fallback labels for unknown groups and keeps audience restrictions", () => {
    const ungrouped = {
      id: "unlisted.field",
      group: undefined,
      labelKey: "missing.translation",
    } as unknown as RegisteredFilterField;
    const groups = registryFieldGroups([ungrouped], messages);

    expect(groups).toEqual([
      {
        key: "other",
        label: "Other fields",
        fields: [ungrouped],
      },
    ]);
    expect(
      allowedFields("public-share").some((field) => field.id === "page.query"),
    ).toBe(false);
    expect(
      allowedFields("private-dashboard", true).some(
        (field) => field.id === "session.views",
      ),
    ).toBe(false);
    const emptyFieldGroups = filterPickerGroups([], messages);
    expect(emptyFieldGroups.map((item) => item.key)).toEqual([
      "page",
      "event",
      "session",
      "visitor",
      "time",
      "aggregation",
      "calculation",
      "relation",
    ]);
    expect(
      emptyFieldGroups.every((item) =>
        item.fields.every((field) => field.registeredField === undefined),
      ),
    ).toBe(true);
  });

  it("recognizes only one positive direct event-name condition", () => {
    expect(directEventName(group([condition("event.name", "signup")]))).toBe(
      "signup",
    );
    expect(directEventName(group([]))).toBeUndefined();
    expect(
      directEventName(
        group([
          condition("event.name", "signup", { negated: true }),
          condition("page.path", "/pricing"),
        ]),
      ),
    ).toBeUndefined();
    expect(
      directEventName(
        group([
          condition("event.name", "signup"),
          condition("event.name", "purchase"),
        ]),
      ),
    ).toBeUndefined();
  });

  it("labels supported payload types and leaves dynamic types explicit", () => {
    expect(isSelectablePayloadFieldType("string")).toBe(true);
    expect(isSelectablePayloadFieldType("number")).toBe(true);
    expect(isSelectablePayloadFieldType("boolean")).toBe(true);
    expect(isSelectablePayloadFieldType("object")).toBe(false);
    expect(payloadFieldTypeLabel("number", messages)).toBe("Number");
    expect(payloadFieldTypeLabel("object", messages)).toBe("object");
  });
});
