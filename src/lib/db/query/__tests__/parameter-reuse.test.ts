import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  compileD1Query,
  eq,
  filter,
  inList,
  param,
  project,
  scan,
  union,
  valuesRelation,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";
import type { SqlBinding } from "@/lib/db/types";

function parameterProjection(values: readonly SqlBinding[]) {
  const source = valuesRelation(
    { seed: { affinity: "text", nullable: false } } as const,
    [{ seed: "seed" }] as const,
  );
  const projections: Record<string, AnyExpression> = {};
  values.forEach((value, index) => {
    projections[`value_${index}`] = param(value);
  });
  return project(source, projections);
}

function sharedCandidate(key: string) {
  const source = valuesRelation(
    { seed: { affinity: "text", nullable: false } } as const,
    [{ seed: key }] as const,
  );
  const selected = filter(source, eq(source.columns.seed, param("keep")));
  return project(selected, {
    first: param("shared-value"),
    second: param("shared-value"),
    third: param("shared-value"),
    fourth: param("shared-value"),
  });
}

function expectBindingBudgetError(run: () => unknown, actual: number) {
  expect(run).toThrowError(
    expect.objectContaining({
      code: "d1_statement_budget_exceeded",
      item: "bindings",
      actual,
      limit: 100,
    }),
  );
}

describe("physical parameter slot reuse", () => {
  it("keeps exactly 100 occurrences anonymous and executes numbered slots above the cap", () => {
    const exactlyOneHundred = compileD1Query(
      parameterProjection(Array<string>(99).fill("reused-value")),
    );
    expect(exactlyOneHundred.bindings).toHaveLength(100);
    expect(exactlyOneHundred.sql.match(/\?/gu)).toHaveLength(100);
    expect(exactlyOneHundred.physicalPlanShape?.version).toBe(2);

    const reused = compileD1Query(
      parameterProjection(Array<string>(100).fill("reused-value")),
    );
    expect(reused.bindings).toEqual(["reused-value", "seed"]);
    expect(reused.sql.match(/\?\d+/gu)).toHaveLength(101);
    expect(reused.sql.match(/\?1\b/gu)).toHaveLength(100);
    expect(reused.sql.match(/\?2\b/gu)).toHaveLength(1);
    expect(reused.physicalPlanShape).toMatchObject({
      version: 3,
      parameterStrategy: "numbered-reuse",
      parameterOccurrenceCount: 101,
      parameterSlotCount: 2,
    });

    const database = new DatabaseSync(":memory:");
    try {
      const namedBindings = Object.fromEntries(
        (reused.bindings ?? []).map((value, index) => [
          `?${index + 1}`,
          value as SQLInputValue,
        ]),
      );
      const rows = database.prepare(reused.sql).all(namedBindings);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value_0).toBe("reused-value");
    } finally {
      database.close();
    }
  });

  it("keeps primitive types and negative zero in separate slots", () => {
    const cycle: readonly SqlBinding[] = ["1", 1, true, null, -0, 0];
    const values = Array.from(
      { length: 100 },
      (_unused, index) => cycle[index % cycle.length]!,
    );
    const query = compileD1Query(parameterProjection(values));

    expect(query.bindings).toHaveLength(7);
    expect(query.bindings).toContain("1");
    expect(query.bindings).toContain(1);
    expect(query.bindings).toContain(true);
    expect(query.bindings).toContain(null);
    expect(query.bindings?.some((value) => Object.is(value, -0))).toBe(true);
    expect(query.bindings?.some((value) => Object.is(value, 0))).toBe(true);
    expect(query.physicalPlanShape).toMatchObject({
      version: 3,
      parameterOccurrenceCount: 101,
      parameterSlotCount: 7,
    });
  });

  it("counts the final numbered SQL length in UTF-8 bytes", () => {
    const source = valuesRelation(
      { seed: { affinity: "text", nullable: false } } as const,
      [{ seed: "seed" }] as const,
    );
    const projections: Record<string, AnyExpression> = {};
    for (let index = 0; index < 100; index += 1)
      projections[`${"界".repeat(350)}_${index}`] = param("same-value");

    let failure: unknown;
    try {
      compileD1Query(project(source, projections));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "d1_statement_budget_exceeded",
      item: "sql_bytes",
      limit: 100_000,
    });
    expect((failure as { readonly actual: number }).actual).toBeGreaterThan(
      100_000,
    );
  });

  it("reuses equal values emitted in separate shared CTEs", () => {
    const candidates = Array.from({ length: 17 }, (_unused, index) => {
      const candidate = sharedCandidate(`source-${index}`);
      return union(union(candidate, candidate, true), candidate, true);
    });
    const query = compileD1Query(
      candidates
        .slice(1)
        .reduce(
          (combined, candidate) => union(combined, candidate, true),
          candidates[0]!,
        ),
    );

    expect(query.physicalPlanShape?.cteCount).toBeGreaterThanOrEqual(17);
    expect(query.physicalPlanShape).toMatchObject({
      version: 3,
      parameterOccurrenceCount: 102,
      parameterSlotCount: 19,
    });
    expect(query.bindings).toHaveLength(19);
  });

  it("works with JSON-packed membership and leaves unique or binary values unmerged", () => {
    const visits = scan(schema.visits);
    const selected = filter(
      visits,
      inList(
        visits.columns.site_pk,
        Array.from({ length: 101 }, (_unused, index) => index) as never,
      ),
    );
    const projections: Record<string, AnyExpression> = {
      visitId: selected.columns.visit_id,
    };
    for (let index = 0; index < 100; index += 1)
      projections[`repeated_${index}`] = param("same");
    const packedAndReused = compileD1Query(project(selected, projections));
    expect(packedAndReused.sql).toContain("json_each(?");
    expect(packedAndReused.physicalPlanShape).toMatchObject({
      version: 3,
      jsonMembershipCount: 1,
      parameterOccurrenceCount: 101,
      parameterSlotCount: 2,
    });

    expectBindingBudgetError(
      () =>
        compileD1Query(
          parameterProjection(
            Array.from({ length: 100 }, (_unused, index) => `unique-${index}`),
          ),
        ),
      101,
    );

    const binary = new Uint8Array([7, 8]);
    expectBindingBudgetError(
      () =>
        compileD1Query(
          parameterProjection(Array<SqlBinding>(100).fill(binary)),
        ),
      101,
    );
  });
  it("packs a 150,000 value text membership list through JSON within the existing byte guard", () => {
    const visits = scan(schema.visits);
    const values = Array<string>(150_000).fill("x");
    const selected = filter(visits, inList(visits.columns.pathname, values));
    const query = compileD1Query(
      project(selected, { visitId: selected.columns.visit_id }),
    );
    expect(query.sql).toContain("json_each(?");
    expect(query.bindings).toEqual([JSON.stringify(values)]);
    expect(
      new TextEncoder().encode(query.bindings?.[0] as string).length,
    ).toBeLessThanOrEqual(1_000_000);
    expect(query.physicalPlanShape).toMatchObject({
      jsonMembershipCount: 1,
    });
  });
});
