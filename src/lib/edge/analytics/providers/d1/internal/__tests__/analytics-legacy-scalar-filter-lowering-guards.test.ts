import { describe, expect, it } from "vitest";

import {
  compileD1Query,
  filter,
  param,
  project,
  scan,
  type SqlExpression,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import {
  type LegacyScalarFilterContext,
  LegacyScalarFilterLoweringError,
  lowerLegacyScalarContextCondition,
  lowerLegacyScalarFilterCondition,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scalar-filter-lowering";

const visits = scan(schema.visits);
const context: LegacyScalarFilterContext = {
  visitColumns: visits.columns,
  facts: { "fact.session_views": param(2) },
};

function condition(field: string, operator: string, value?: unknown) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator,
    ...(value === undefined ? {} : { value }),
  } as never;
}

function compile(predicate: unknown) {
  const filtered = filter(visits, predicate as never);
  return compileD1Query(project(filtered, { id: filtered.columns.visit_id }));
}

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the lowering to fail.");
}

function loweringFailure(run: () => unknown): LegacyScalarFilterLoweringError {
  const error = failure(run);
  expect(error).toBeInstanceOf(LegacyScalarFilterLoweringError);
  return error as LegacyScalarFilterLoweringError;
}

describe("legacy scalar filter lowering guard rails", () => {
  it.each([
    ["gt", ">"],
    ["gte", ">="],
    ["lt", "<"],
    ["lte", "<="],
  ] as const)(
    "lowers the text %s comparison over the trimmed value",
    (operator, sqlOperator) => {
      const compiled = compile(
        lowerLegacyScalarFilterCondition(
          condition("page.path", operator, "/m"),
          visits.columns.pathname,
        ),
      );
      expect(compiled.sql).toContain(
        `TRIM(COALESCE(q0."_c1", '')) ${sqlOperator} ?`,
      );
      expect(compiled.bindings).toEqual(["/m"]);
    },
  );

  it("rejects condition values outside the legacy scalar value domain", () => {
    const error = loweringFailure(() =>
      lowerLegacyScalarFilterCondition(
        condition("page.path", "eq", { kind: "field", field: "page.title" }),
        visits.columns.pathname,
      ),
    );
    expect(error.code).toBe("unsupported_value");
    expect(error.location).toBe("page.path.value");
  });

  it("does not pretend a numeric expression is text for emptiness checks", () => {
    const error = failure(() =>
      lowerLegacyScalarFilterCondition(
        condition("session.views", "isEmpty"),
        param(1) as SqlExpression,
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "A text-derived filter dependency must have text affinity.",
    );
  });
});

describe("lowerLegacyScalarContextCondition", () => {
  it("resolves the registered strategy and lowers the leaf", () => {
    const compiled = compile(
      lowerLegacyScalarContextCondition(
        condition("page.path", "eq", "/pricing"),
        context,
      ),
    );
    expect(compiled.sql).toContain(`TRIM(COALESCE(q0."_c1", '')) = ?`);
    expect(compiled.bindings).toEqual(["/pricing"]);
  });

  it("lowers registered fact fields in entity-fact mode", () => {
    const compiled = compile(
      lowerLegacyScalarContextCondition(
        condition("session.views", "gte", 2),
        context,
        "entity-fact-v1",
      ),
    );
    expect(compiled.sql).toContain(">=");
    expect(compiled.bindings).toEqual([2, 2]);
  });

  it("rejects non-fact fields in entity-fact mode", () => {
    const error = loweringFailure(() =>
      lowerLegacyScalarContextCondition(
        condition("page.path", "eq", "/"),
        context,
        "entity-fact-v1",
      ),
    );
    expect(error.code).toBe("unsupported_target");
    expect(error.location).toBe("page.path.target.field");
  });

  it("reports session-boundary strategies as unsupported by the scalar resolver", () => {
    const error = loweringFailure(() =>
      lowerLegacyScalarContextCondition(
        condition("session.entryPath", "eq", "/"),
        context,
        "session-boundary-v1",
      ),
    );
    expect(error.code).toBe("unsupported_strategy");
    expect(error.location).toBe("session.entryPath.target.field");
  });

  it("reports non-field targets with the condition location", () => {
    const error = loweringFailure(() =>
      lowerLegacyScalarContextCondition(
        {
          kind: "condition",
          target: { kind: "entity-root", entity: "event" },
          operator: "exists",
        } as never,
        context,
      ),
    );
    expect(error.code).toBe("unsupported_target");
    expect(error.location).toBe("condition.target.target");
  });
});
