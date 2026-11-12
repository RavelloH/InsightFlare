import { describe, expect, it } from "vitest";

import {
  constant,
  eq,
  filter,
  lowerLogicalPlan,
  param,
  scan,
  semiJoin,
} from "@/lib/db";
import {
  type PhysicalSemiMembershipCostSelection,
  sameSemiMembershipCostSelections,
} from "@/lib/db/query/physical/semi-membership-cost";
import { schema } from "@/lib/db/schema";

const choice = { marker: "choice" };
const always = () => true;
const never = () => false;

function canonical(
  extra: Partial<PhysicalSemiMembershipCostSelection> & {
    readonly evidence?: unknown;
  } = {},
): readonly PhysicalSemiMembershipCostSelection[] {
  return [
    {
      choice,
      strategy: "exists",
      reason: "left-source-is-not-an-unfiltered-catalog-scan",
      ...extra,
    } as unknown as PhysicalSemiMembershipCostSelection,
  ];
}

function actualEntry(extra: object = {}): object {
  return {
    choice,
    strategy: "exists",
    reason: "left-source-is-not-an-unfiltered-catalog-scan",
    ...extra,
  };
}

function same(
  actual: unknown,
  expected = canonical(),
  sameChoices: (a: unknown, e: never) => boolean = always,
): boolean {
  return sameSemiMembershipCostSelections(
    actual,
    expected,
    sameChoices as never,
  );
}

describe("semi membership cost selection comparison", () => {
  it("accepts an exact structural match and delegates choice comparison", () => {
    expect(same([actualEntry()])).toBe(true);
    const seen: unknown[] = [];
    expect(
      same([actualEntry()], canonical(), (actualChoices, expectedChoices) => {
        seen.push(actualChoices, expectedChoices);
        return true;
      }),
    ).toBe(true);
    expect(seen).toEqual([[choice], [choice]]);
    expect(same([actualEntry()], canonical(), never)).toBe(false);
  });

  it("rejects non-dense, decorated, accessor-backed, or wrongly sized arrays", () => {
    expect(same(undefined)).toBe(false);
    expect(same({ length: 1, 0: actualEntry() })).toBe(false);
    expect(same([])).toBe(false);
    expect(same([actualEntry(), actualEntry()])).toBe(false);
    // eslint-disable-next-line no-sparse-arrays
    expect(same([,] as unknown)).toBe(false);
    const decorated = Object.assign([actualEntry()], { extra: true });
    expect(same(decorated)).toBe(false);
    const accessor: object[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => actualEntry(),
    });
    expect(same(accessor)).toBe(false);
  });

  it("rejects entries whose shape, strategy, or reason is forged", () => {
    expect(same([null])).toBe(false);
    expect(same(["text"])).toBe(false);
    expect(same([actualEntry({ extra: 1 })])).toBe(false);
    expect(same([actualEntry({ strategy: "in" })])).toBe(false);
    expect(same([actualEntry({ reason: "other" })])).toBe(false);
    const withoutReason: Record<string, unknown> = actualEntry() as Record<
      string,
      unknown
    >;
    delete withoutReason.reason;
    expect(same([withoutReason])).toBe(false);
    const prototyped = Object.create(
      { inherited: true },
      {
        choice: { value: choice, enumerable: true },
        strategy: { value: "exists", enumerable: true },
        reason: {
          value: "left-source-is-not-an-unfiltered-catalog-scan",
          enumerable: true,
        },
      },
    );
    expect(same([prototyped])).toBe(false);
    const symbolKeyed = actualEntry();
    Object.defineProperty(symbolKeyed, Symbol("hidden"), { value: 1 });
    expect(same([symbolKeyed])).toBe(false);
    const accessorEntry = {
      choice,
      strategy: "exists",
      get reason() {
        return "left-source-is-not-an-unfiltered-catalog-scan";
      },
    };
    expect(same([accessorEntry])).toBe(false);
    expect(same([Object.assign(Object.create(null), actualEntry())])).toBe(
      true,
    );
  });

  it("compares evidence by stable key-order-independent JSON", () => {
    const expected = canonical({
      strategy: "in",
      reason: "selected-unique-right-point-lookup-with-left-index",
      evidence: { b: [1, "x", null, true], a: { z: 1, y: false } },
    } as never);
    const entry = (evidence: unknown) =>
      actualEntry({
        strategy: "in",
        reason: "selected-unique-right-point-lookup-with-left-index",
        evidence,
      });
    expect(
      same(
        [entry({ a: { y: false, z: 1 }, b: [1, "x", null, true] })],
        expected,
      ),
    ).toBe(true);
    expect(
      same(
        [entry({ a: { y: false, z: 2 }, b: [1, "x", null, true] })],
        expected,
      ),
    ).toBe(false);
    // Missing evidence versus present evidence in either direction.
    expect(same([actualEntry()], expected)).toBe(false);
    const missing = actualEntry({
      strategy: "in",
      reason: "selected-unique-right-point-lookup-with-left-index",
    });
    expect(same([missing], expected)).toBe(false);
  });

  it("rejects unserializable evidence payloads", () => {
    const base = {
      strategy: "in",
      reason: "selected-unique-right-point-lookup-with-left-index",
    };
    const expected = (evidence: unknown) =>
      canonical({ ...base, evidence } as never);
    const entry = (evidence: unknown) => actualEntry({ ...base, evidence });
    const bad: unknown[] = [
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { f: () => 1 },
      { u: undefined },
      { s: Symbol("x") },
      { list: new Array(2) },
      { date: new Date(0) },
      { [Symbol("k")]: 1 },
      {
        get g() {
          return 1;
        },
      },
    ];
    for (const evidence of bad)
      expect(same([entry(evidence)], expected(evidence))).toBe(false);
    // Finite numbers, nested arrays, and null-prototype objects are fine.
    const nested = { n: 1.5, list: [[1], []], bare: Object.create(null) };
    expect(same([entry(nested)], expected(nested))).toBe(true);
  });
});

describe("semi membership cost selection for integer lookups", () => {
  const select = (
    value: unknown,
    column: "site_pk" | "site_id" = "site_pk",
  ) => {
    const left = scan(schema.site_identities);
    const rightScan = scan(schema.site_identities);
    const right = filter(
      rightScan,
      eq(rightScan.columns[column], value as never),
    );
    return lowerLogicalPlan(
      semiJoin(left, right, eq(left.columns.site_id, right.columns.site_id)),
    ).semiMembershipCostSelections;
  };

  it("selects IN for an integer rowid point lookup", () => {
    const [selection] = select(param(37));
    expect(selection?.strategy).toBe("in");
    expect(selection?.evidence?.right).toMatchObject({
      access: "rowid",
      constraint: "parameter",
      valueClass: "integer",
    });
    const [constantSelection] = select(constant(37));
    expect(constantSelection?.evidence?.right).toMatchObject({
      constraint: "constant",
      valueClass: "integer",
    });
  });

  it("falls back to EXISTS for lookups that cannot prove a unique class", () => {
    for (const value of [
      param(null),
      param(2 ** 60),
      param(1.5),
      constant(null),
    ]) {
      const [selection] = select(value);
      expect(selection?.strategy).toBe("exists");
    }
    const [textOnInteger] = select(param("site-1"), "site_id");
    expect(textOnInteger?.strategy).toBe("in");
  });
});
