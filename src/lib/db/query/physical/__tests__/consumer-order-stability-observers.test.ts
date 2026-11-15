import { describe, expect, it } from "vitest";

import {
  add,
  aggregate,
  and,
  callFunction,
  caseWhen,
  castInteger,
  castReal,
  castText,
  coalesce,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  inList,
  inSubquery,
  isDistinctFrom,
  isNull,
  join,
  limit,
  not,
  param,
  project,
  recursiveClosure,
  rowNumber,
  scalar,
  scan,
  sort,
  type SqlExpression,
  sum,
  textLike,
  textPosition,
  textSubstring,
  union,
  window,
  windowCountRows,
} from "@/lib/db";
import { hasOrderStableConsumers } from "@/lib/db/query/physical/consumer-order-stability";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

function compileObserver(
  output: Relation<object, Readonly<Record<string, SqlExpression>>>,
) {
  return compileD1Query(output);
}

function numericSource() {
  const visits = scan(schema.visits);
  return project(visits, { value: visits.columns.started_at });
}

function textSource() {
  const visits = scan(schema.visits);
  return project(visits, { value: visits.columns.session_id });
}

describe("consumer order observers in complete legal query trees", () => {
  it("rejects scalar first-row selection through nested numeric expressions", () => {
    const input = numericSource();
    const value = scalar(input);
    const expressions = [
      value,
      add(value, constant(1)),
      isDistinctFrom(value, constant(1)),
      and(eq(value, constant(1)), not(isNull(value))),
      coalesce(value, constant(0)),
      castInteger(value),
      castReal(value),
      castText(value),
      callFunction("abs", value),
      inList(value, [1, 2]),
      caseWhen([{ when: eq(value, constant(1)), then: constant(2) }]),
      caseWhen(
        [{ when: eq(constant(1), constant(1)), then: value }],
        constant(0),
      ),
      caseWhen(
        [{ when: eq(constant(1), constant(0)), then: constant(0) }],
        value,
      ),
    ];
    for (const expression of expressions) {
      const output = project(scan(schema.visits), { observed: expression });
      expect(() => compileObserver(output)).not.toThrow();
      expect(hasOrderStableConsumers(input.node, output.node)).toBe(false);
    }
  });

  it("finds scalar queries in text operands and optional substring lengths", () => {
    const input = textSource();
    const text = scalar(input);
    const numeric = numericSource();
    const value = scalar(numeric);
    const cases = [
      { input, expression: textPosition(text, param("x")) },
      { input, expression: textPosition(param("prefix"), text) },
      { input, expression: textSubstring(text, constant(1)) },
      { input, expression: textLike(text, param("x%")) },
      { input, expression: textLike(param("prefix"), text) },
      { input: numeric, expression: textSubstring(param("prefix"), value) },
      {
        input: numeric,
        expression: textSubstring(param("prefix"), constant(1), value),
      },
    ];
    for (const { input: candidate, expression } of cases) {
      const output = project(scan(schema.visits), { observed: expression });
      expect(() => compileObserver(output)).not.toThrow();
      expect(hasOrderStableConsumers(candidate.node, output.node)).toBe(false);
    }
  });

  it("tracks both the membership query and scalar query nested in its operand", () => {
    const input = numericSource();
    const members = numericSource();
    const visits = scan(schema.visits);
    const output = filter(visits, inSubquery(scalar(input), members));
    expect(() => compileD1Query(output)).not.toThrow();
    expect(hasOrderStableConsumers(input.node, output.node)).toBe(false);
    expect(hasOrderStableConsumers(members.node, output.node)).toBe(false);
  });

  it("does not hide a scalar observation inside an outer aggregate or join predicate", () => {
    const input = numericSource();
    const other = scan(schema.visits);
    const grouped = aggregate(other, {
      groupBy: {},
      aggregates: { observed: sum(scalar(input)) },
    });
    const joined = join(
      other,
      scan(schema.visits),
      eq(other.columns.started_at, scalar(input)),
    );
    for (const output of [grouped, joined]) {
      expect(() => compileObserver(output)).not.toThrow();
      expect(hasOrderStableConsumers(input.node, output.node)).toBe(false);
    }
  });

  it("rejects direct sort, selection with offset, and window observations", () => {
    const input = numericSource();
    const outputs = [
      sort(input, [{ expression: input.columns.value, direction: "ASC" }]),
      limit(input, 1, 2),
      window(input, {
        rank: rowNumber({
          partitionBy: [input.columns.value],
          orderBy: [{ expression: input.columns.value, direction: "ASC" }],
        }),
      }),
      window(input, {
        count: windowCountRows({ partitionBy: [input.columns.value] }),
      }),
    ];
    for (const output of outputs) {
      expect(() => compileObserver(output)).not.toThrow();
      expect(hasOrderStableConsumers(input.node, output.node)).toBe(false);
    }
  });

  it("walks scalar subqueries in sort and both window specification expressions", () => {
    const input = numericSource();
    const other = numericSource();
    const outputs = [
      sort(other, [{ expression: scalar(input), direction: "ASC" }]),
      window(other, {
        rank: rowNumber({
          partitionBy: [scalar(input)],
          orderBy: [{ expression: scalar(input), direction: "ASC" }],
        }),
      }),
      window(other, {
        count: windowCountRows({ partitionBy: [scalar(input)] }),
      }),
    ];
    for (const output of outputs) {
      expect(() => compileObserver(output)).not.toThrow();
      expect(hasOrderStableConsumers(input.node, output.node)).toBe(false);
    }
  });

  it("rejects both inputs to a legal recursive closure", () => {
    const input = numericSource();
    const candidates = numericSource();
    const closure = recursiveClosure(input, candidates, (current, candidate) =>
      eq(current.value, candidate.value),
    );
    expect(() => compileD1Query(closure)).not.toThrow();
    expect(hasOrderStableConsumers(input.node, closure.node)).toBe(false);
    expect(hasOrderStableConsumers(candidates.node, closure.node)).toBe(false);
  });

  it("allows later first-row and window observations after a stable COUNT fence", () => {
    const input = numericSource();
    const counted = aggregate(input, {
      groupBy: {},
      aggregates: { value: count() },
    });
    const outputs = [
      project(scan(schema.visits), { observed: scalar(counted) }),
      limit(counted, 1, 0),
      sort(counted, [{ expression: counted.columns.value, direction: "DESC" }]),
      window(counted, { count: windowCountRows() }),
    ];
    for (const output of outputs) {
      expect(() => compileObserver(output)).not.toThrow();
      expect(hasOrderStableConsumers(input.node, output.node)).toBe(true);
    }
  });

  it("checks every shared consumer and rejects candidates outside the root", () => {
    const input = numericSource();
    const counted = aggregate(input, {
      groupBy: {},
      aggregates: { value: count() },
    });
    const first = limit(input, 1);
    const combined = union(counted, first, true);
    expect(() => compileD1Query(combined)).not.toThrow();
    expect(hasOrderStableConsumers(input.node, combined.node)).toBe(false);
    expect(hasOrderStableConsumers(numericSource().node, counted.node)).toBe(
      false,
    );
  });
});
