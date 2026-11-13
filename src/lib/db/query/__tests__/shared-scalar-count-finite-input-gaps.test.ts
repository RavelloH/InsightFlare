import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  antiJoin,
  compileD1Query,
  constant,
  count,
  distinct,
  eq,
  filter,
  join,
  limit,
  project,
  rowNumber,
  semiJoin,
  sort,
  union,
  valuesRelation,
  window,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression, Predicate } from "@/lib/db/query/expression";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;

const databases = new Set<DatabaseSync>();
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
});

function alwaysTrue(): Predicate {
  return eq(constant(1), constant(1));
}

function values(n: number): AnyRelation {
  return valuesRelation(
    { value: { affinity: "text", nullable: false } },
    Array.from({ length: n }, (_unused, index) => ({ value: `v${index}` })),
  ) as AnyRelation;
}

function twoConsumers(input: AnyRelation): {
  readonly output: AnyRelation;
  readonly controls: AnyRelation;
} {
  const controls = aggregate(input, {
    groupBy: {},
    aggregates: { controlCount: count() },
  }) as AnyRelation;
  const markers = valuesRelation(
    { marker: { affinity: "text", nullable: false } },
    [{ marker: "one-row" }],
  ) as AnyRelation;
  const branch = () => {
    const joined = join(controls, markers, alwaysTrue(), "inner");
    return project(joined, {
      marker: joined.columns.right_marker!,
      controlCount: joined.columns.left_controlCount!,
    }) as AnyRelation;
  };
  return { output: union(branch(), branch(), true) as AnyRelation, controls };
}

function isMaterialized(input: AnyRelation): boolean {
  const { output, controls } = twoConsumers(input);
  const physical = lowerLogicalPlan(output);
  expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
  const shared = physical.sharedRelations.find(
    ({ node }) => node === controls.node,
  );
  const materialized = shared?.materialization === "materialized";

  const db = createMigratedDatabase();
  databases.add(db);
  const run = (query: {
    readonly sql: string;
    readonly bindings?: readonly unknown[];
  }) =>
    db.prepare(query.sql).all(...((query.bindings ?? []) as SQLInputValue[]));
  const optimized = run(compileD1Query(physical));
  const original = run(compileD1QueryUnoptimizedForTest(output));
  expect(optimized).toEqual(original);
  return materialized;
}

describe("shared scalar count finite closed input proofs", () => {
  it("propagates finiteness through filter, project, distinct, and grouped aggregates", () => {
    const three = values(3);
    const filtered = filter(
      three,
      eq(three.columns.value!, constant("v1") as never),
    );
    expect(isMaterialized(filtered as AnyRelation)).toBe(true);
    const projected = project(three, { x: three.columns.value! });
    expect(isMaterialized(projected as AnyRelation)).toBe(true);
    expect(isMaterialized(distinct(three) as AnyRelation)).toBe(true);
    const grouped = aggregate(three, {
      groupBy: { value: three.columns.value! },
      aggregates: { n: count() },
    });
    expect(isMaterialized(grouped as AnyRelation)).toBe(true);
  });

  it("propagates finiteness through semi and anti joins of finite inputs", () => {
    const left = values(3);
    const right = values(2);
    const on = eq(left.columns.value!, right.columns.value!);
    expect(isMaterialized(semiJoin(left, right, on) as AnyRelation)).toBe(true);
    expect(isMaterialized(antiJoin(left, right, on) as AnyRelation)).toBe(true);
  });

  it("uses scalar-side multiplicity for inner and left joins", () => {
    expect(
      isMaterialized(
        join(values(3), values(1), alwaysTrue(), "inner") as AnyRelation,
      ),
    ).toBe(true);
    expect(
      isMaterialized(
        join(values(3), values(0), alwaysTrue(), "inner") as AnyRelation,
      ),
    ).toBe(true);
    expect(
      isMaterialized(
        join(values(0), values(3), alwaysTrue(), "left") as AnyRelation,
      ),
    ).toBe(true);
    expect(
      isMaterialized(
        join(values(1), values(3), alwaysTrue(), "left") as AnyRelation,
      ),
    ).toBe(true);
    expect(
      isMaterialized(
        join(values(3), values(1), alwaysTrue(), "left") as AnyRelation,
      ),
    ).toBe(true);
  });

  it("rejects joins whose multiplicity is not bounded by a scalar side", () => {
    expect(
      isMaterialized(
        join(values(2), values(3), alwaysTrue(), "left") as AnyRelation,
      ),
    ).toBe(false);
    expect(
      isMaterialized(
        join(values(2), values(3), alwaysTrue(), "inner") as AnyRelation,
      ),
    ).toBe(false);
  });

  it("does not prove finiteness through unions, sorts, limits, or windows", () => {
    const three = values(3);
    expect(isMaterialized(union(three, values(2), true) as AnyRelation)).toBe(
      false,
    );
    const sorted = sort(three, [
      { expression: three.columns.value!, direction: "ASC" },
    ]) as AnyRelation;
    expect(isMaterialized(sorted)).toBe(false);
    expect(isMaterialized(limit(three, 2) as AnyRelation)).toBe(false);
    const windowed = window(three, {
      rank: rowNumber({
        orderBy: [{ expression: three.columns.value!, direction: "ASC" }],
      }),
    }) as AnyRelation;
    expect(isMaterialized(windowed)).toBe(false);
  });
});

function ancestorMaterialized(
  wrap: (joined: AnyRelation, controls: AnyRelation) => AnyRelation,
  markers: AnyRelation = values(1),
): boolean {
  const input = values(2);
  const controls = aggregate(input, {
    groupBy: {},
    aggregates: { controlCount: count() },
  }) as AnyRelation;
  const branch = () =>
    wrap(
      join(controls, markers, alwaysTrue(), "inner") as AnyRelation,
      controls,
    );
  const output = union(branch(), branch(), true) as AnyRelation;
  const physical = lowerLogicalPlan(output);
  expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
  const materialized =
    physical.sharedRelations.find(({ node }) => node === controls.node)
      ?.materialization === "materialized";
  const db = createMigratedDatabase();
  databases.add(db);
  const run = (query: {
    readonly sql: string;
    readonly bindings?: readonly unknown[];
  }) =>
    db.prepare(query.sql).all(...((query.bindings ?? []) as SQLInputValue[]));
  expect(run(compileD1Query(physical))).toEqual(
    run(compileD1QueryUnoptimizedForTest(output)),
  );
  return materialized;
}

function keyedMarkers(): AnyRelation {
  const base = values(3);
  return aggregate(base, {
    groupBy: { value: base.columns.value! },
    aggregates: { n: count() },
  }) as AnyRelation;
}

describe("shared scalar count ancestor row-shape proofs", () => {
  const sortBy = (rel: AnyRelation, column: string) =>
    sort(rel, [
      { expression: rel.columns[column]!, direction: "ASC" as const },
    ]) as AnyRelation;

  it("accepts scalar-bounded limits and filters over the joined count", () => {
    expect(ancestorMaterialized((j) => limit(j, 1))).toBe(true);
    expect(
      ancestorMaterialized(
        (j) =>
          filter(
            j,
            eq(j.columns.left_controlCount!, constant(2) as never),
          ) as AnyRelation,
      ),
    ).toBe(true);
  });

  it("requires a limit over multi-row ancestors to be a total Top-K", () => {
    // Unique-key group sort accepted.
    expect(
      ancestorMaterialized(
        (j) => limit(sortBy(j, "right_value"), 2),
        keyedMarkers(),
      ),
    ).toBe(true);
    // No sort under the limit.
    expect(ancestorMaterialized((j) => limit(j, 2), keyedMarkers())).toBe(
      false,
    );
    // Sort does not cover the unique key.
    expect(
      ancestorMaterialized(
        (j) => limit(sortBy(j, "left_controlCount"), 2),
        keyedMarkers(),
      ),
    ).toBe(false);
    // Sort over a relation with no proven key (multi-row values).
    expect(
      ancestorMaterialized(
        (j) => limit(sortBy(j, "right_value"), 2),
        values(2),
      ),
    ).toBe(false);
    // Offset and non-positive counts are outside the proof.
    expect(ancestorMaterialized((j) => limit(j, 1, 1), values(1))).toBe(false);
    expect(ancestorMaterialized((j) => limit(j, 0), values(1))).toBe(false);
  });

  it("maps unique keys through projections and drops unmapped keys", () => {
    expect(
      ancestorMaterialized((j) => {
        const p = project(j, {
          v: j.columns.right_value!,
          c: j.columns.left_controlCount!,
        }) as AnyRelation;
        return limit(sortBy(p, "v"), 2);
      }, keyedMarkers()),
    ).toBe(true);
    expect(
      ancestorMaterialized((j) => {
        const p = project(j, {
          c: j.columns.left_controlCount!,
        }) as AnyRelation;
        return limit(sortBy(p, "c"), 2);
      }, keyedMarkers()),
    ).toBe(false);
    // Zero-row marker relations keep the empty (at-most-one-row) key.
    expect(
      ancestorMaterialized(
        (j) => project(j, { c: j.columns.left_controlCount! }) as AnyRelation,
        values(0),
      ),
    ).toBe(true);
  });

  it("derives join shape from scalar sides and rejects unproven products", () => {
    const extra = (n: number) => values(n);
    // scalar x scalar
    expect(
      ancestorMaterialized(
        (j) => join(j, extra(1), alwaysTrue(), "inner") as AnyRelation,
      ),
    ).toBe(true);
    // scalar left, multi-row right
    expect(
      ancestorMaterialized(
        (j) => join(j, extra(2), alwaysTrue(), "inner") as AnyRelation,
      ),
    ).toBe(true);
    // multi-row left, scalar right
    expect(
      ancestorMaterialized(
        (j) => join(extra(2), j, alwaysTrue(), "inner") as AnyRelation,
      ),
    ).toBe(true);
    // neither side scalar
    expect(
      ancestorMaterialized(
        (j) => join(extra(2), j, alwaysTrue(), "inner") as AnyRelation,
        extra(2),
      ),
    ).toBe(false);
    // outer join ancestor
    expect(
      ancestorMaterialized(
        (j) => join(j, extra(1), alwaysTrue(), "left") as AnyRelation,
      ),
    ).toBe(false);
  });

  it("keeps the left shape through membership and union-all ancestors and rejects distinct", () => {
    const other = values(2);
    expect(
      ancestorMaterialized(
        (j) =>
          semiJoin(
            j,
            other,
            eq(j.columns.right_value!, other.columns.value!),
          ) as AnyRelation,
      ),
    ).toBe(true);
    expect(
      ancestorMaterialized(
        (j) =>
          antiJoin(
            j,
            other,
            eq(j.columns.right_value!, other.columns.value!),
          ) as AnyRelation,
      ),
    ).toBe(true);
    expect(ancestorMaterialized((j) => union(j, j, true) as AnyRelation)).toBe(
      true,
    );
    expect(ancestorMaterialized((j) => union(j, j, false) as AnyRelation)).toBe(
      false,
    );
    expect(ancestorMaterialized((j) => distinct(j) as AnyRelation)).toBe(false);
  });
});
