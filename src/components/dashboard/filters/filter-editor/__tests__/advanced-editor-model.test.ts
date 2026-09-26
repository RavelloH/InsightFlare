import { describe, expect, it } from "vitest";

import {
  createAdvancedFilterCondition,
  createDefaultFilterTarget,
  createFilterPickerTargetCondition,
  filterOperatorsForTarget,
  filterValueKindForTarget,
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
  normalizeFilterDocument,
  parseFilterDsl,
  validateFilterExpressionTypes,
} from "@/lib/filter-contract";
import { filterPickerTargetForValue } from "@/lib/filter-contract/filter-picker-registry";
import { FILTER_PICKER_TARGET_REGISTRY } from "@/lib/filter-contract/filter-picker-registry";

describe("advanced filter editor model", () => {
  it("round-trips every advanced target and relation through the visual tree", () => {
    const sources = [
      'count(event { event.name eq "purchase" AND event.payload("/plan") eq "pro" }) gte 2 AND last(page).time gte @now-14d',
      'sub(sum(event { event.name eq "purchase" }.payload("/amount")), sum(event { event.name eq "refund" }.payload("/amount"))) gt 0',
      "countDistinct(bucket(page.time, 1d)) gte 2",
      "count(periods(page, 1w) { count(period.items) gte 3 }) gte 2",
      'window(event { event.name eq "refund" }, first(event { event.name eq "purchase" }).time, [0d, 7d]) notExists',
      'time gte @range.start AND time lt @range.end AND sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
      'adjacent(sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }])) exists',
      'without(sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]), event { event.name eq "cancellation" }) { sequence.span lte 7d } exists',
      'NOT (page.path eq "/a" OR page.path eq "/b")',
    ];

    for (const source of sources) {
      const parsed = parseFilterDsl(source, analyticsFilterRegistry);
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
        kind: "reducer",
        reducer: "min",
        input: {
          kind: "projection",
          collection: { kind: "entity-root", entity: "page" },
          member: "durationMs",
        },
      }),
    ).toBe("number");
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

  it("uses page defaults when the audience cannot select events", () => {
    expect(createDefaultFilterTarget("selector", "public-share")).toEqual(
      expect.objectContaining({
        kind: "selector",
        collection: { kind: "entity-root", entity: "page" },
      }),
    );
  });
});
