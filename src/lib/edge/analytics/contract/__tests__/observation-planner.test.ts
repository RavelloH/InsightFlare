import { describe, expect, it } from "vitest";

import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import {
  type FilterExpression,
  FilterValidationError,
} from "@/lib/edge/analytics/contract/filters";
import {
  assertObservationFilterCompatible,
  planObservationFilter,
} from "@/lib/edge/analytics/contract/observation-planner";
import { parseFilterDsl } from "@/lib/filter-contract";

function field(field: string, value: string): FilterExpression {
  return {
    kind: "condition",
    target: { kind: "field", field: field as never },
    operator: "eq",
    value,
  };
}

function projected(
  expression: FilterExpression | null,
  observationKind: "visit" | "event",
) {
  return planObservationFilter(expression)[observationKind];
}

describe("observation filter planner", () => {
  it("accepts empty, page, event, and event-payload filters", () => {
    for (const source of [
      "   ",
      'page.path eq "/pricing"',
      'event.name eq "purchase"',
      'event.payload("/plan") eq "pro"',
    ]) {
      expect(() =>
        assertObservationFilterCompatible(
          parseFilterDsl(source, analyticsFilterRegistry),
        ),
      ).not.toThrow();
    }
  });

  it("rejects fact fields and observation/fact boolean mixtures", () => {
    const incompatible = [
      "session.durationMs gt 1000",
      "visitor.sessions gte 2",
      'page.path eq "/pricing" AND session.durationMs gt 1000',
      'event.name eq "purchase" OR visitor.sessions gte 2',
    ];

    for (const source of incompatible) {
      try {
        assertObservationFilterCompatible(
          parseFilterDsl(source, analyticsFilterRegistry),
        );
        throw new Error(`Expected ${source} to be incompatible.`);
      } catch (error) {
        expect(error).toBeInstanceOf(FilterValidationError);
        expect((error as FilterValidationError).code).toBe(
          "observation_incompatible",
        );
      }
    }
  });

  it("treats an empty filter as all observations", () => {
    expect(planObservationFilter(null)).toEqual({
      visit: { kind: "all" },
      event: { kind: "all" },
    });
  });

  it.each([
    ["page", field("page.path", "/pricing")],
    ["event", field("event.name", "purchase")],
  ] as const)(
    "projects a %s condition by observation domain",
    (_, expression) => {
      const plan = planObservationFilter(expression);
      expect(plan.visit.kind).toBe(_ === "page" ? "expression" : "none");
      expect(plan.event.kind).toBe("expression");
    },
  );

  it("keeps AND strict and OR domain-aware", () => {
    const page = field("page.path", "/pricing");
    const event = field("event.name", "purchase");

    expect(
      projected({ kind: "and", children: [page, event] }, "visit"),
    ).toEqual({ kind: "none" });
    expect(
      projected({ kind: "and", children: [page, event] }, "event"),
    ).toEqual({
      kind: "expression",
      expression: { kind: "and", children: [page, event] },
    });
    expect(projected({ kind: "or", children: [page, event] }, "visit")).toEqual(
      { kind: "expression", expression: page },
    );
    expect(projected({ kind: "or", children: [page, event] }, "event")).toEqual(
      {
        kind: "expression",
        expression: { kind: "or", children: [page, event] },
      },
    );
  });

  it("keeps NOT inside the child observation domain", () => {
    const page = field("page.path", "/pricing");
    const event = field("event.name", "purchase");
    const pageOrEvent: FilterExpression = {
      kind: "or",
      children: [page, event],
    };
    const pageAndEvent: FilterExpression = {
      kind: "and",
      children: [page, event],
    };

    expect(projected({ kind: "not", child: page }, "visit")).toEqual({
      kind: "expression",
      expression: { kind: "not", child: page },
    });
    expect(projected({ kind: "not", child: event }, "visit")).toEqual({
      kind: "none",
    });
    expect(projected({ kind: "not", child: event }, "event")).toEqual({
      kind: "expression",
      expression: { kind: "not", child: event },
    });
    expect(projected({ kind: "not", child: pageOrEvent }, "visit")).toEqual({
      kind: "expression",
      expression: { kind: "not", child: page },
    });
    expect(projected({ kind: "not", child: pageOrEvent }, "event")).toEqual({
      kind: "expression",
      expression: { kind: "not", child: pageOrEvent },
    });
    expect(projected({ kind: "not", child: pageAndEvent }, "visit")).toEqual({
      kind: "none",
    });
    expect(projected({ kind: "not", child: pageAndEvent }, "event")).toEqual({
      kind: "expression",
      expression: { kind: "not", child: pageAndEvent },
    });
  });

  it("projects nested AND/OR/NOT without widening domains", () => {
    const page = field("page.path", "/pricing");
    const event = field("event.name", "purchase");
    const nested: FilterExpression = {
      kind: "and",
      children: [
        {
          kind: "or",
          children: [page, event],
        },
        { kind: "not", child: event },
      ],
    };

    expect(projected(nested, "visit")).toEqual({ kind: "none" });
    expect(projected(nested, "event")).toEqual({
      kind: "expression",
      expression: nested,
    });
  });
});
