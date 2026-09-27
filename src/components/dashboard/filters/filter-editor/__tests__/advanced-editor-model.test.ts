import { describe, expect, it } from "vitest";

import {
  createAdvancedFilterCondition,
  createDefaultFilterTarget,
  createFilterPickerTargetCondition,
  filterOperatorsForTarget,
  filterValueKindForTarget,
  findContextIntrinsic,
  findOccurrenceTimeTarget,
  replaceTargetReference,
  updateConditionWhere,
} from "@/components/dashboard/filters/filter-editor/advanced-editor-model";
import {
  ADVANCED_FILTER_TARGET_KINDS,
  advancedFilterFieldValueForTarget,
  advancedFilterTargetKindFromField,
  conditionIdFactory,
  documentFromEditor,
  editorRootFromDocument,
  expressionTextFromEditor,
} from "@/components/dashboard/filters/filter-editor/model";
import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  type FilterExpression,
  type FilterTargetExpression,
  normalizeFilterDocument,
  parseFilterDsl,
  validateFilterExpressionTypes,
} from "@/lib/filter-contract";
import { filterPickerTargetForValue } from "@/lib/filter-contract/filter-picker-registry";
import { FILTER_PICKER_TARGET_REGISTRY } from "@/lib/filter-contract/filter-picker-registry";

const eventRoot: FilterTargetExpression = {
  kind: "entity-root",
  entity: "event",
};
const pageRoot: FilterTargetExpression = {
  kind: "entity-root",
  entity: "page",
};
const eventName: FilterTargetExpression = {
  kind: "field",
  field: "event.name" as never,
};
const intrinsic: FilterTargetExpression = {
  kind: "context-intrinsic",
  context: "sequence",
  intrinsic: "span",
};
const occurrenceTime: FilterTargetExpression = {
  kind: "occurrence-time",
  input: eventRoot,
};

function condition(target: FilterTargetExpression): FilterExpression {
  return { kind: "condition", target, operator: "exists" };
}

function wrappersAround(
  child: FilterTargetExpression,
): FilterTargetExpression[] {
  const sequence: FilterTargetExpression = {
    kind: "sequence",
    steps: [eventRoot, child],
  };
  return [
    { kind: "member", object: child, member: "name" },
    {
      kind: "context-intrinsic",
      context: "sequence",
      intrinsic: "same",
      input: child,
    },
    { kind: "occurrence-time", input: child },
    {
      kind: "selector",
      collection: child,
      predicate: condition(child),
    },
    { kind: "projection", collection: child, member: "name" },
    { kind: "reducer", reducer: "first", input: child },
    { kind: "arithmetic", operator: "add", left: eventRoot, right: child },
    {
      kind: "bucket",
      input: child,
      interval: { kind: "duration", amount: 1, unit: "d" },
    },
    {
      kind: "window",
      collection: eventRoot,
      anchor: child,
      startOffset: { kind: "duration", amount: 0, unit: "d" },
      endOffset: { kind: "duration", amount: 1, unit: "d" },
    },
    {
      kind: "periods",
      collection: child,
      interval: { kind: "duration", amount: 1, unit: "w" },
    },
    sequence,
    { kind: "adjacent", sequence },
    { kind: "without", sequence, excluded: child },
  ];
}

describe("advanced filter editor model", () => {
  it("round-trips every advanced target and relation through the visual tree", () => {
    const sources = [
      'count(event { event.name eq "purchase" AND event.payload("/plan") eq "pro" }) gte 2 AND last(page).path exists',
      'sub(sum(event { event.name eq "purchase" }.payload("/amount")), sum(event { event.name eq "refund" }.payload("/amount"))) gt 0',
      "countDistinct(bucket(page, 1d)) gte 2",
      "count(periods(page, 1w) { count($items) gte 3 }) gte 2",
      'time(nth(event { event.name eq "signup" }, 3)) gte @now-30d',
      'sequence([event { event.name eq "view" }, event { event.name eq "purchase" }]) { $gap(1, 2) lte 7d AND $same(event.payload("/productId")) } exists',
      'window(event { event.name eq "refund" }, first(event { event.name eq "purchase" }), [0d, 7d]) notExists',
      'time gte @range.start AND time lt @range.end AND sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
      'adjacent(sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }])) exists',
      'without(sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]), event { event.name eq "cancellation" }) { $span lte 7d } exists',
      'NOT (page.path eq "/a" OR page.path eq "/b")',
    ];

    for (const source of sources) {
      const parsed = parseFilterDsl(source, analyticsFilterRegistry);
      analyzeFilterDocument(parsed, analyticsFilterRegistry);
      const root = editorRootFromDocument(parsed, conditionIdFactory());
      expect(
        parseFilterDsl(expressionTextFromEditor(root), analyticsFilterRegistry),
        source,
      ).toEqual(parsed);
      expect(documentFromEditor(root)).toEqual(
        normalizeFilterDocument(parsed, analyticsFilterRegistry),
      );
    }
  });

  it("registers each advanced target or preserves its legacy picker value", () => {
    for (const kind of ADVANCED_FILTER_TARGET_KINDS) {
      const condition = createAdvancedFilterCondition(
        kind,
        "private-dashboard",
      );
      const field = advancedFilterFieldValueForTarget(condition.target);
      expect(
        filterPickerTargetForValue(field) !== undefined ||
          advancedFilterTargetKindFromField(field) === kind,
      ).toBe(true);

      const completeCondition =
        kind === "time" || kind === "time-anchor"
          ? { ...condition, value: "2024-01-01T00:00:00Z" }
          : condition;
      const document = normalizeFilterDocument(
        { version: 1, root: completeCondition },
        analyticsFilterRegistry,
      );
      expect(() =>
        validateFilterExpressionTypes(document, analyticsFilterRegistry),
      ).not.toThrow();
    }
  });

  it("creates a registered starter expression for every picker target", () => {
    for (const registration of FILTER_PICKER_TARGET_REGISTRY) {
      const condition = createFilterPickerTargetCondition(
        registration.selection,
        "private-dashboard",
      );
      expect(advancedFilterFieldValueForTarget(condition.target)).toBe(
        registration.value,
      );
    }
  });

  it("infers scalar kinds across registered fields and computed targets", () => {
    const field = createDefaultFilterTarget("field", "private-dashboard");
    const payload = createDefaultFilterTarget(
      "event-payload",
      "private-dashboard",
    );
    const currentTime = createDefaultFilterTarget("time", "private-dashboard");
    const duration = createDefaultFilterTarget("duration", "private-dashboard");
    const anchor = createDefaultFilterTarget(
      "time-anchor",
      "private-dashboard",
    );
    const bucket = createDefaultFilterTarget("bucket", "private-dashboard");
    const count = createDefaultFilterTarget("reducer", "private-dashboard");
    const arithmetic = createDefaultFilterTarget(
      "arithmetic",
      "private-dashboard",
    );
    const member = createDefaultFilterTarget("member", "private-dashboard");
    const context = createDefaultFilterTarget(
      "context-root",
      "private-dashboard",
    );

    expect(filterValueKindForTarget(field)).toBe("string");
    expect(filterValueKindForTarget(payload)).toBe("json-scalar");
    expect(filterValueKindForTarget(currentTime)).toBe("datetime");
    expect(filterValueKindForTarget(duration)).toBe("number");
    expect(filterValueKindForTarget(anchor)).toBe("datetime");
    expect(filterValueKindForTarget(bucket)).toBe("datetime");
    expect(filterValueKindForTarget(count)).toBe("number");
    expect(filterValueKindForTarget(arithmetic)).toBe("number");
    expect(filterValueKindForTarget(member)).toBe("string");
    expect(filterValueKindForTarget(context)).toBe("json-scalar");
    expect(
      filterValueKindForTarget({
        kind: "occurrence-time",
        input: {
          kind: "reducer",
          reducer: "first",
          input: { kind: "entity-root", entity: "event" },
        },
      }),
    ).toBe("datetime");
    expect(
      filterValueKindForTarget({
        kind: "reducer",
        reducer: "min",
        input: {
          kind: "projection",
          collection: { kind: "entity-root", entity: "page" },
          member: "durationMs",
        },
      }),
    ).toBe("number");

    const nestedMember = parseFilterDsl(
      'first(page).geo.country eq "US"',
      analyticsFilterRegistry,
    ).root;
    if (nestedMember?.kind !== "condition")
      throw new Error("expected_condition");
    expect(filterValueKindForTarget(nestedMember.target)).toBe("enum");
  });

  it("selects temporal, field-specific, collection, and generic operators", () => {
    const currentTime = createDefaultFilterTarget("time", "private-dashboard");
    const anchor = createDefaultFilterTarget(
      "time-anchor",
      "private-dashboard",
    );
    const field = createDefaultFilterTarget("field", "private-dashboard");
    const pageCollection = createDefaultFilterTarget(
      "entity-root",
      "private-dashboard",
    );
    const arithmetic = createDefaultFilterTarget(
      "arithmetic",
      "private-dashboard",
    );

    expect(filterOperatorsForTarget(currentTime)).toContain("between");
    expect(filterOperatorsForTarget(anchor)).toContain("between");
    expect(filterOperatorsForTarget(field)).toContain("contains");
    expect(filterOperatorsForTarget(pageCollection)).toEqual([
      "exists",
      "notExists",
    ]);
    expect(filterOperatorsForTarget(arithmetic)).toContain("gte");
  });

  it("infers a registered member through a selected positional Entity", () => {
    const target: FilterTargetExpression = {
      kind: "member",
      object: {
        kind: "reducer",
        reducer: "first",
        input: {
          kind: "selector",
          collection: { kind: "entity-root", entity: "event" },
          predicate: {
            kind: "condition",
            target: { kind: "field", field: "event.name" as never },
            operator: "eq",
            value: "purchase",
          } satisfies FilterExpression,
        },
      },
      member: "name",
    };

    expect(filterValueKindForTarget(target)).toBe("string");
  });

  it("offers presence operators for sequence and period contexts", () => {
    for (const target of [
      { kind: "context-root", context: "sequence" },
      { kind: "context-root", context: "period" },
    ] as const) {
      expect(filterOperatorsForTarget(target)).toEqual(["exists", "notExists"]);
    }
  });

  it("uses page defaults when the audience cannot select events", () => {
    expect(createDefaultFilterTarget("selector", "public-share")).toEqual(
      expect.objectContaining({
        kind: "selector",
        collection: { kind: "entity-root", entity: "page" },
      }),
    );
  });

  it("finds context intrinsics throughout target and selector structures", () => {
    for (const target of wrappersAround(intrinsic)) {
      expect(findContextIntrinsic(target)?.target).toBe(
        target.kind === "context-intrinsic" ? target : intrinsic,
      );
    }
    expect(findContextIntrinsic(eventRoot)).toBeUndefined();

    const sequence: FilterTargetExpression = {
      kind: "sequence",
      steps: [eventRoot],
    };
    for (const collection of [
      sequence,
      { kind: "adjacent", sequence } satisfies FilterTargetExpression,
      {
        kind: "without",
        sequence,
        excluded: eventRoot,
      } satisfies FilterTargetExpression,
      {
        kind: "selector",
        collection: sequence,
        predicate: condition(eventRoot),
      } satisfies FilterTargetExpression,
    ]) {
      const selector: FilterTargetExpression = {
        kind: "selector",
        collection,
        predicate: condition(intrinsic),
      };
      expect(findContextIntrinsic(selector)).toEqual({
        target: intrinsic,
        sequence,
      });
    }

    const nestedIntrinsic: FilterTargetExpression = {
      kind: "sequence",
      steps: [intrinsic],
    };
    expect(
      findContextIntrinsic({
        kind: "selector",
        collection: nestedIntrinsic,
        predicate: condition(eventRoot),
      })?.target,
    ).toBe(intrinsic);

    const intrinsicValue = {
      kind: "condition",
      target: eventRoot,
      operator: "eq",
      value: intrinsic,
    } as unknown as FilterExpression;
    expect(
      findContextIntrinsic({
        kind: "selector",
        collection: eventRoot,
        predicate: {
          kind: "not",
          child: {
            kind: "and",
            children: [condition(eventName), intrinsicValue],
          },
        },
      })?.target,
    ).toBe(intrinsic);
  });

  it("finds occurrence-time targets through nested targets and expressions", () => {
    for (const target of wrappersAround(occurrenceTime)) {
      expect(findOccurrenceTimeTarget(target)).toBe(
        target.kind === "occurrence-time" ? target : occurrenceTime,
      );
    }
    expect(findOccurrenceTimeTarget(eventRoot)).toBeUndefined();
    expect(
      findOccurrenceTimeTarget({
        kind: "context-intrinsic",
        context: "sequence",
        intrinsic: "span",
      }),
    ).toBeUndefined();

    const occurrenceValue = {
      kind: "condition",
      target: eventName,
      operator: "eq",
      value: occurrenceTime,
    } as unknown as FilterExpression;
    const nested: FilterTargetExpression = {
      kind: "selector",
      collection: eventRoot,
      predicate: {
        kind: "not",
        child: {
          kind: "or",
          children: [condition(eventName), occurrenceValue],
        },
      },
    };
    expect(findOccurrenceTimeTarget(nested)).toBe(occurrenceTime);
  });

  it("replaces target references and updates matching nested conditions", () => {
    const expression: FilterExpression = {
      kind: "and",
      children: [
        ...wrappersAround(eventName).map(condition),
        {
          kind: "not",
          child: {
            kind: "and",
            children: [
              condition({
                kind: "selector",
                collection: eventRoot,
                predicate: condition(eventName),
              }),
            ],
          },
        },
      ],
    };
    const replaced = replaceTargetReference(expression, eventName, pageRoot);
    expect(JSON.stringify(replaced)).not.toContain('"field":"event.name"');

    let updatedCount = 0;
    const updated = updateConditionWhere(
      replaced,
      (candidate) => candidate.target === pageRoot,
      (candidate) => {
        updatedCount += 1;
        return { ...candidate, operator: "eq", value: "/replacement" };
      },
    );
    expect(updatedCount).toBeGreaterThan(1);
    expect(JSON.stringify(updated)).toContain("/replacement");

    expect(
      updateConditionWhere(
        replaced,
        () => false,
        (candidate) => candidate,
      ),
    ).toEqual(replaced);
  });
});
