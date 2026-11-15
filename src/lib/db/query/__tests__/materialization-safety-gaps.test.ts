import { describe, expect, it } from "vitest";

import {
  aggregate,
  avg,
  callFunction,
  caseWhen,
  castInteger,
  castReal,
  coalesce,
  constant,
  count,
  distinct,
  eq,
  filter,
  gt,
  join,
  jsonScalarArray,
  limit,
  max,
  min,
  param,
  project,
  rowNumber,
  scan,
  semiJoin,
  sort,
  sum,
  union,
  window,
} from "@/lib/db";
import type { SqlExpression } from "@/lib/db/query/expression";
import {
  isMaterializationSafeAggregateExpression,
  isMaterializationSafeExpression,
  isMaterializationSafeNode,
} from "@/lib/db/query/materialization-safety";
import type { ProjectNode } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

const values = () => scan(schema.custom_event_json_values);
type Values = ReturnType<typeof values>;

// The generated relation builders are strongly typed; these cases deliberately
// assemble shapes the public typings cannot always express.
const asSql = (expression: unknown) => expression as SqlExpression;
const safeAggregate = (expression: unknown, input: unknown) =>
  isMaterializationSafeAggregateExpression(
    asSql(expression),
    input as Parameters<typeof isMaterializationSafeAggregateExpression>[1],
  );

describe("materialization safety of REAL-valued aggregates", () => {
  it("accepts SUM and AVG over REAL columns reached through row-preserving nodes", () => {
    const wrappers: Array<(source: Values) => Values> = [
      (source) => source,
      (source) =>
        filter(source, gt(source.columns.event_pk, param(0))) as never,
      (source) =>
        sort(source, [
          { expression: source.columns.event_pk, direction: "ASC" },
        ]) as never,
      (source) => limit(source, 3) as never,
      (source) => distinct(source) as never,
      (source) =>
        window(source, {
          rank: rowNumber({
            orderBy: [
              { expression: source.columns.event_pk, direction: "ASC" },
            ],
          }),
        }) as never,
      (source) =>
        semiJoin(
          source,
          values(),
          eq(source.columns.event_pk, source.columns.event_pk),
        ) as never,
    ];
    for (const wrap of wrappers) {
      const input = wrap(values());
      expect(safeAggregate(sum(input.columns.number_value), input)).toBe(true);
      expect(safeAggregate(avg(input.columns.number_value), input)).toBe(true);
      expect(safeAggregate(min(input.columns.number_value), input)).toBe(true);
      expect(safeAggregate(max(input.columns.number_value), input)).toBe(true);
    }
  });

  it("follows REAL values through projections, joins, unions, and groups", () => {
    const source = values();
    const projected = project(source, {
      castText: castReal(source.columns.event_pk),
      rounded: callFunction("round", source.columns.number_value),
      merged: coalesce(source.columns.number_value, castReal(constant(0))),
      cased: caseWhen(
        [
          {
            when: gt(source.columns.event_pk, param(1)),
            then: source.columns.number_value,
          },
        ],
        source.columns.number_value,
      ),
      scaled: source.columns.number_value,
      plain: source.columns.event_pk,
    } as never) as unknown as Record<string, any>;
    for (const name of ["castText", "rounded", "merged", "cased", "scaled"])
      expect(safeAggregate(sum(projected.columns[name]), projected), name).toBe(
        true,
      );
    expect(safeAggregate(sum(projected.columns.plain), projected)).toBe(false);

    const left = values();
    const right = values();
    const joined = join(
      left,
      right,
      eq(left.columns.event_pk, right.columns.event_pk),
    );
    expect(safeAggregate(sum(joined.columns.left_number_value), joined)).toBe(
      true,
    );
    expect(safeAggregate(sum(joined.columns.right_number_value), joined)).toBe(
      true,
    );
    expect(safeAggregate(sum(joined.columns.right_event_pk), joined)).toBe(
      false,
    );

    const merged = union(
      project(left, { v: left.columns.number_value }),
      project(right, { v: right.columns.number_value }),
      true,
    );
    expect(safeAggregate(sum(merged.columns.v), merged)).toBe(true);
    const mixed = union(
      project(left, { v: left.columns.number_value }),
      project(right, { v: castReal(right.columns.event_pk) }),
      true,
    );
    expect(safeAggregate(sum(mixed.columns.v), mixed)).toBe(true);

    const grouped = aggregate(left, {
      groupBy: { v: left.columns.number_value },
      aggregates: {
        top: max(left.columns.number_value),
        total: sum(left.columns.number_value),
        mean: avg(left.columns.number_value),
        n: count(),
        ids: sum(left.columns.event_pk),
      },
    } as never) as unknown as Record<string, any>;
    for (const name of ["v", "top", "total", "mean"])
      expect(safeAggregate(sum(grouped.columns[name]), grouped), name).toBe(
        true,
      );
    for (const name of ["n", "ids"])
      expect(safeAggregate(sum(grouped.columns[name]), grouped), name).toBe(
        false,
      );
  });
});

describe("materialization safety of bounded unit SUM aggregates", () => {
  const boundedProjection = (build: (source: Values) => unknown) => {
    const source = values();
    const projected = project(source, { unit: build(source) } as never);
    return limit(projected as never, 4) as unknown as Record<string, any>;
  };

  it("accepts SUM over [-1, 1] constants, parameters, and total predicates", () => {
    const accepted: Array<(source: Values) => unknown> = [
      () => constant(1),
      () => constant(-1),
      () => param(0),
      () => param(null),
      (source) =>
        caseWhen(
          [{ when: gt(source.columns.event_pk, param(0)), then: constant(1) }],
          constant(0),
        ),
      (source) => coalesce(castInteger(constant(1)), constant(0)),
      (source) => eq(source.columns.event_pk, param(1)),
    ];
    for (const [index, build] of accepted.entries()) {
      const input = boundedProjection(build);
      expect(
        safeAggregate(sum(input.columns.unit), input),
        `case ${index}`,
      ).toBe(true);
    }
  });

  it("rejects SUM over unbounded or unsupported inputs", () => {
    const rejected: Array<(source: Values) => unknown> = [
      () => constant(2),
      () => constant(-2),
      () => param(2),
      () => param(1.5),
      (source) => source.columns.event_pk,
      (source) =>
        caseWhen(
          [{ when: gt(source.columns.event_pk, param(0)), then: constant(5) }],
          constant(0),
        ),
      (source) => coalesce(source.columns.event_pk, constant(0)),
    ];
    for (const [index, build] of rejected.entries()) {
      const input = boundedProjection(build);
      expect(
        safeAggregate(sum(input.columns.unit), input),
        `case ${index}`,
      ).toBe(false);
    }
    const unbounded = (() => {
      const source = values();
      return project(source, {
        unit: constant(1),
      } as never) as unknown as Record<string, any>;
    })();
    expect(safeAggregate(sum(unbounded.columns.unit), unbounded)).toBe(false);
    const offsetLimit = (() => {
      const source = values();
      return limit(
        project(source, { unit: constant(1) } as never) as never,
        4,
        1,
      ) as unknown as Record<string, any>;
    })();
    expect(safeAggregate(sum(offsetLimit.columns.unit), offsetLimit)).toBe(
      false,
    );
  });

  it("rejects non-aggregate and partial aggregate arguments", () => {
    const input = values();
    expect(safeAggregate(constant(1), input)).toBe(false);
    expect(safeAggregate(count(), input)).toBe(true);
    expect(safeAggregate(count(input.columns.event_pk), input)).toBe(true);
    expect(
      safeAggregate(
        { ...sum(input.columns.event_pk), expression: undefined },
        input,
      ),
    ).toBe(false);
    expect(
      safeAggregate(
        count(callFunction("abs", input.columns.event_pk) as never),
        input,
      ),
    ).toBe(false);
  });
});

describe("expression-level materialization safety guards", () => {
  const scopes = new Map<never, number>();

  it("fails closed on non-objects and cyclic expressions", () => {
    expect(isMaterializationSafeExpression(null as never, scopes)).toBe(false);
    expect(isMaterializationSafeExpression("x" as never, scopes)).toBe(false);
    const cyclic: Record<string, unknown> = {
      kind: "boolean",
      operator: "AND",
      resultType: { affinity: "integer", nullable: false },
    };
    cyclic.expressions = [cyclic, constant(1)];
    expect(isMaterializationSafeExpression(cyclic as never, scopes)).toBe(
      false,
    );
  });
});

describe("fresh local projection safety", () => {
  it("rechecks direct-column scope and bounds after an earlier successful proof", () => {
    const input = values();
    const other = values();
    const selected = project(input, { value: input.columns.event_pk });
    const original = (selected.node as ProjectNode).projections[0]!;
    const expression = { ...input.columns.event_pk };
    const node = {
      ...selected.node,
      projections: [{ ...original, expression }],
    } as ProjectNode;
    expect(isMaterializationSafeNode(node)).toBe(true);

    for (const index of [-1, 0.5, input.fields.length, Number.NaN]) {
      expression.index = index;
      expect(isMaterializationSafeNode(node)).toBe(false);
    }
    expression.index = input.columns.event_pk.index;
    expression.scope = other.scope;
    expect(isMaterializationSafeNode(node)).toBe(false);
    expression.scope = input.scope;
    expect(isMaterializationSafeNode(node)).toBe(true);
  });

  it("retains recursive totality and malformed-expression rejection", () => {
    const input = values();
    const selected = project(input, { value: input.columns.event_pk });
    const original = (selected.node as ProjectNode).projections[0]!;
    for (const expression of [
      null,
      "column",
      callFunction("abs", input.columns.event_pk),
      eq(input.columns.event_pk, values().columns.event_pk),
    ]) {
      const node = {
        ...selected.node,
        projections: [{ ...original, expression }],
      } as ProjectNode;
      expect(isMaterializationSafeNode(node)).toBe(false);
    }
    expect(
      isMaterializationSafeNode(
        project(input, { value: castInteger(input.columns.event_pk) }).node,
      ),
    ).toBe(true);
  });
});

describe("materialization safety through unit-bounded relational nodes", () => {
  const unitSource = (value: number) => {
    const source = values();
    return limit(
      project(source, { unit: constant(value) } as never) as never,
      3,
    ) as unknown as Record<string, any>;
  };

  it("proves unit bounds through joins, semi-joins, windows, and wrappers", () => {
    const left = unitSource(1);
    const right = unitSource(-1);
    const joined = limit(
      join(
        left as never,
        right as never,
        eq(left.columns.unit, right.columns.unit),
      ) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(joined.columns.left_unit), joined)).toBe(true);
    expect(safeAggregate(sum(joined.columns.right_unit), joined)).toBe(true);

    const big = unitSource(7);
    const mixedJoin = limit(
      join(
        left as never,
        big as never,
        eq(left.columns.unit, big.columns.unit),
      ) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(mixedJoin.columns.left_unit), mixedJoin)).toBe(
      true,
    );
    expect(safeAggregate(sum(mixedJoin.columns.right_unit), mixedJoin)).toBe(
      false,
    );

    const semi = limit(
      semiJoin(
        left as never,
        right as never,
        eq(left.columns.unit, right.columns.unit),
      ) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(semi.columns.unit), semi)).toBe(true);

    const ranked = limit(
      window(left as never, {
        rank: rowNumber({
          orderBy: [{ expression: left.columns.unit, direction: "ASC" }],
        }),
      }) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(ranked.columns.unit), ranked)).toBe(true);
    expect(safeAggregate(sum(ranked.columns.rank), ranked)).toBe(false);

    for (const wrap of [
      (source: any) =>
        filter(source, gt(source.columns.unit, param(0) as never)),
      (source: any) =>
        sort(source, [{ expression: source.columns.unit, direction: "ASC" }]),
      (source: any) => distinct(source),
    ]) {
      const wrapped = limit(wrap(left) as never, 3) as unknown as Record<
        string,
        any
      >;
      expect(safeAggregate(sum(wrapped.columns.unit), wrapped)).toBe(true);
    }
  });

  it("proves unit bounds through UNION ALL but not UNION DISTINCT of unbounded sides", () => {
    const left = unitSource(1);
    const right = unitSource(0);
    const big = unitSource(9);
    const all = limit(
      union(left as never, right as never, true) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(all.columns.unit), all)).toBe(true);
    const unsafe = limit(
      union(left as never, big as never, true) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(unsafe.columns.unit), unsafe)).toBe(false);
    const dedup = limit(
      union(left as never, right as never, false) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(dedup.columns.unit), dedup)).toBe(false);
  });

  it("proves unit bounds for grouped and JSON scalar sources", () => {
    const source = unitSource(1);
    const grouped = limit(
      aggregate(
        source as never,
        {
          groupBy: { unit: source.columns.unit },
          aggregates: { n: count(), s: sum(source.columns.unit) },
        } as never,
      ) as never,
      3,
    ) as unknown as Record<string, any>;
    for (const name of ["unit", "n", "s"])
      expect(safeAggregate(sum(grouped.columns[name]), grouped), name).toBe(
        true,
      );

    const unboundedGroup = aggregate(
      values() as never,
      {
        groupBy: { id: values().columns.event_pk },
        aggregates: { n: count() },
      } as never,
    ) as unknown as Record<string, any>;
    const limited = limit(unboundedGroup as never, 3) as unknown as Record<
      string,
      any
    >;
    expect(safeAggregate(sum(limited.columns.n), limited)).toBe(false);

    const numbers = limit(
      jsonScalarArray("numeric", [-1, 0, 1]) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(numbers.columns.value), numbers)).toBe(true);
    const wide = limit(
      jsonScalarArray("numeric", [-1, 5]) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(wide.columns.value), wide)).toBe(false);
    const texts = limit(
      jsonScalarArray("text", ["a"]) as never,
      3,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(texts.columns.value), texts)).toBe(false);
  });

  it("proves SUM over count-partition columns through relational wrappers", () => {
    const source = unitSource(1);
    const grouped = aggregate(
      source as never,
      {
        groupBy: { unit: source.columns.unit },
        aggregates: { n: count() },
      } as never,
    ) as unknown as Record<string, any>;
    const wrappers: Array<(input: any) => any> = [
      (input) => input,
      (input) => filter(input, gt(input.columns.n, param(0) as never)),
      (input) =>
        sort(input, [{ expression: input.columns.n, direction: "ASC" }]),
      (input) => limit(input, 2),
      (input) => distinct(input),
      (input) =>
        window(input, {
          rank: rowNumber({
            orderBy: [{ expression: input.columns.n, direction: "ASC" }],
          }),
        }),
      (input) => semiJoin(input, input, eq(input.columns.n, input.columns.n)),
      (input) => project(input, { n: input.columns.n }),
    ];
    for (const [index, wrap] of wrappers.entries()) {
      const input = wrap(grouped);
      expect(
        safeAggregate(sum(input.columns.n), input),
        `wrapper ${index}`,
      ).toBe(true);
    }
    expect(safeAggregate(sum(grouped.columns.unit), grouped)).toBe(false);
    const ungrouped = aggregate(
      source as never,
      {
        groupBy: {},
        aggregates: { n: count() },
      } as never,
    ) as unknown as Record<string, any>;
    expect(safeAggregate(sum(ungrouped.columns.n), ungrouped)).toBe(false);
  });
});
