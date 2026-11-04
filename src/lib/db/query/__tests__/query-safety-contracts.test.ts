import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  aggregate,
  and,
  antiJoin,
  caseWhen,
  coalesce,
  compileD1Query,
  count,
  countDistinct,
  distinct,
  eq,
  filter,
  inList,
  isNull,
  join,
  limit,
  or,
  param,
  project,
  rowNumber,
  scalar,
  semiJoin,
  sort,
  union,
  valuesRelation,
  window,
  windowCountRows,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;
type Row = Record<string, unknown>;

const pairSchema = {
  tenant: { affinity: "text", nullable: true },
  key: { affinity: "text", nullable: true },
  label: { affinity: "text", nullable: false },
} as const;

function anyRelation<
  R extends object,
  C extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<R, C>): AnyRelation {
  return relation as unknown as AnyRelation;
}

function pairSources() {
  return {
    left: valuesRelation(pairSchema, [
      { tenant: "a", key: "1", label: "L1" },
      { tenant: "a", key: "1", label: "L2" },
      { tenant: "a", key: null, label: "L3-null-key" },
      { tenant: null, key: "1", label: "L4-null-tenant" },
      { tenant: "b", key: "2", label: "L5-unmatched" },
      { tenant: "c", key: "9", label: "L6-cross-key" },
    ]),
    right: valuesRelation(pairSchema, [
      { tenant: "a", key: "1", label: "R1" },
      { tenant: "a", key: "1", label: "R2" },
      { tenant: "a", key: null, label: "R3-null-key" },
      { tenant: null, key: "1", label: "R4-null-tenant" },
      { tenant: "b", key: "3", label: "R5-different-key" },
      { tenant: "x", key: "9", label: "R6-cross-tenant" },
    ]),
  };
}

function execute(
  db: DatabaseSync,
  query: { sql: string; bindings?: readonly unknown[] },
): Row[] {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Row[];
}

function bag(rows: readonly Row[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function runBoth(query: AnyRelation): Row[] {
  const db = new DatabaseSync(":memory:");
  try {
    const optimized = execute(db, compileD1Query(lowerLogicalPlan(query)));
    const original = execute(db, compileD1QueryUnoptimizedForTest(query));
    expect(bag(optimized)).toEqual(bag(original));
    return optimized;
  } finally {
    db.close();
  }
}

type JoinShape =
  | "inner-key"
  | "inner-tenant"
  | "inner-composite"
  | "left-key"
  | "left-composite"
  | "reverse-composite";

function joinQuery(shape: JoinShape): AnyRelation {
  const { left, right } = pairSources();
  const condition =
    shape === "inner-key" || shape === "left-key"
      ? eq(left.columns.key, right.columns.key)
      : shape === "inner-tenant"
        ? eq(left.columns.tenant, right.columns.tenant)
        : and(
            eq(left.columns.tenant, right.columns.tenant),
            eq(left.columns.key, right.columns.key),
          );
  const isLeft = shape === "left-key" || shape === "left-composite";
  const isReversed = shape === "reverse-composite";
  const joined = isReversed
    ? join(right, left, condition)
    : join(left, right, condition, isLeft ? "left" : "inner");
  return anyRelation(
    project(joined, {
      leftLabel: isReversed
        ? joined.columns.right_label
        : joined.columns.left_label,
      rightLabel: isReversed
        ? joined.columns.left_label
        : joined.columns.right_label,
    }),
  );
}

const joinCases: readonly {
  name: string;
  shape: JoinShape;
  expected: string[];
}[] = [
  {
    name: "same-named key columns remain scoped to their own relation",
    shape: "inner-key",
    expected: [
      "L1/R1",
      "L1/R2",
      "L1/R4-null-tenant",
      "L2/R1",
      "L2/R2",
      "L2/R4-null-tenant",
      "L4-null-tenant/R1",
      "L4-null-tenant/R2",
      "L4-null-tenant/R4-null-tenant",
      "L6-cross-key/R6-cross-tenant",
    ],
  },
  {
    name: "composite equality uses both relation identities",
    shape: "inner-composite",
    expected: ["L1/R1", "L1/R2", "L2/R1", "L2/R2"],
  },
  {
    name: "tenant-only equality preserves its duplicate cross product",
    shape: "inner-tenant",
    expected: [
      "L1/R1",
      "L1/R2",
      "L1/R3-null-key",
      "L2/R1",
      "L2/R2",
      "L2/R3-null-key",
      "L3-null-key/R1",
      "L3-null-key/R2",
      "L3-null-key/R3-null-key",
      "L5-unmatched/R5-different-key",
    ],
  },
  {
    name: "left composite join retains NULL-key and unmatched rows",
    shape: "left-composite",
    expected: [
      "L1/R1",
      "L1/R2",
      "L2/R1",
      "L2/R2",
      "L3-null-key/null",
      "L4-null-tenant/null",
      "L5-unmatched/null",
      "L6-cross-key/null",
    ],
  },
  {
    name: "left single-key join does not add an unrelated tenant predicate",
    shape: "left-key",
    expected: [
      "L1/R1",
      "L1/R2",
      "L1/R4-null-tenant",
      "L2/R1",
      "L2/R2",
      "L2/R4-null-tenant",
      "L3-null-key/null",
      "L4-null-tenant/R1",
      "L4-null-tenant/R2",
      "L4-null-tenant/R4-null-tenant",
      "L5-unmatched/null",
      "L6-cross-key/R6-cross-tenant",
    ],
  },
  {
    name: "reversed join inputs keep the builder's original scopes",
    shape: "reverse-composite",
    expected: ["L1/R1", "L1/R2", "L2/R1", "L2/R2"],
  },
];

describe("public query safety and relation identity contracts", () => {
  it.each(joinCases)("$name", ({ shape, expected }) => {
    const rows = runBoth(joinQuery(shape));
    expect(
      rows
        .map(({ leftLabel, rightLabel }) => `${leftLabel}/${rightLabel}`)
        .sort(),
    ).toEqual(expected.sort());
  });

  it.each([
    {
      name: "compiler rejects a predicate that reads a sibling relation scope",
      predicate: "binary" as const,
    },
    {
      name: "compiler rejects an out-of-scope column nested under CASE and COALESCE",
      predicate: "nested" as const,
    },
  ])("$name", ({ predicate }) => {
    const schema = { key: { affinity: "text", nullable: true } } as const;
    const local = valuesRelation(schema, [{ key: "local" }]);
    const sibling = valuesRelation(schema, [{ key: "sibling" }]);
    const expression =
      predicate === "binary"
        ? eq(local.columns.key, sibling.columns.key)
        : eq(
            coalesce(
              caseWhen(
                [
                  {
                    when: isNull(local.columns.key),
                    then: sibling.columns.key,
                  },
                ],
                local.columns.key,
              ),
              param("fallback"),
            ),
            param("local"),
          );
    expect(() => compileD1Query(filter(local, expression))).toThrow();
  });

  it.each([
    {
      name: "semi join preserves left multiplicity, not right multiplicity",
      kind: "semi" as const,
      expected: ["L1", "L2"],
    },
    {
      name: "anti join preserves NULL and unproved composite-key rows",
      kind: "anti" as const,
      expected: [
        "L3-null-key",
        "L4-null-tenant",
        "L5-unmatched",
        "L6-cross-key",
      ],
    },
  ])("$name", ({ kind, expected }) => {
    const { left, right } = pairSources();
    const predicate = and(
      eq(left.columns.tenant, right.columns.tenant),
      eq(left.columns.key, right.columns.key),
    );
    const result =
      kind === "semi"
        ? semiJoin(left, right, predicate)
        : antiJoin(left, right, predicate);
    const query = anyRelation(project(result, { label: result.columns.label }));
    expect(
      runBoth(query)
        .map(({ label }) => label)
        .sort(),
    ).toEqual(expected.sort());
  });

  it("CASE and COALESCE distinguish unmatched rows from matched NULL payloads", () => {
    const schema = {
      key: { affinity: "text", nullable: true },
      label: { affinity: "text", nullable: true },
    } as const;
    const left = valuesRelation(schema, [
      { key: "1", label: "left-one" },
      { key: "2", label: null },
      { key: null, label: "left-null-key" },
    ]);
    const right = valuesRelation(schema, [
      { key: "1", label: null },
      { key: "2", label: "right-two" },
      { key: null, label: "right-null-key" },
    ]);
    const joined = join(
      left,
      right,
      eq(left.columns.key, right.columns.key),
      "left",
    );
    const result = project(joined, {
      source: coalesce(joined.columns.left_label, param("missing-left")),
      value: caseWhen(
        [
          { when: isNull(joined.columns.right_key), then: param("unmatched") },
          {
            when: isNull(joined.columns.right_label),
            then: param("matched-null"),
          },
        ],
        coalesce(joined.columns.right_label, param("fallback")),
      ),
    });
    const rows = runBoth(anyRelation(result));
    expect(
      rows.map(({ source, value }) => `${source}/${value}`).sort(),
    ).toEqual([
      "left-null-key/unmatched",
      "left-one/matched-null",
      "missing-left/right-two",
    ]);
  });

  it("nested boolean predicates retain each child's source identity", () => {
    const { left, right } = pairSources();
    const joined = join(
      left,
      right,
      or(
        and(
          eq(left.columns.tenant, right.columns.tenant),
          eq(left.columns.key, right.columns.key),
        ),
        and(
          isNull(left.columns.key),
          isNull(right.columns.key),
          eq(left.columns.tenant, right.columns.tenant),
        ),
      ),
    );
    const rows = runBoth(
      anyRelation(
        project(joined, {
          leftLabel: joined.columns.left_label,
          rightLabel: joined.columns.right_label,
        }),
      ),
    );
    expect(
      rows
        .map(({ leftLabel, rightLabel }) => `${leftLabel}/${rightLabel}`)
        .sort(),
    ).toEqual(["L1/R1", "L1/R2", "L2/R1", "L2/R2", "L3-null-key/R3-null-key"]);
  });

  it("keeps wide correlated scalar results consistent across outer scopes", () => {
    const outer = valuesRelation(
      { key: { affinity: "text", nullable: false } } as const,
      [{ key: "a" }, { key: "missing" }],
    );
    const source = valuesRelation(
      {
        key: { affinity: "text", nullable: false },
        payload: { affinity: "text", nullable: false },
      } as const,
      [
        { key: "a", payload: "first" },
        { key: "a", payload: "second" },
        { key: "b", payload: "other" },
      ],
    );
    const wide = project(source, {
      field0: source.columns.key,
      field1: source.columns.payload,
      ...Object.fromEntries(
        Array.from({ length: 15 }, (_value, index) => [
          `copy${index}`,
          source.columns.payload,
        ]),
      ),
    });
    const candidate = filter(wide, eq(outer.columns.key, wide.columns.field0));
    const firstScalar = scalar(
      project(candidate, { value: candidate.columns.field1 }),
    );
    const secondScalar = scalar(
      project(candidate, { value: candidate.columns.field1 }),
    );
    const query = anyRelation(
      project(outer, {
        key: outer.columns.key,
        first: firstScalar,
        second: secondScalar,
      }),
    );
    const physical = lowerLogicalPlan(query);
    expect(
      physical.sharedRelations.some(({ node }) => node === candidate.node),
    ).toBe(false);
    const rows = runBoth(query);
    expect(
      bag(rows.map(({ key, first, second }) => ({ key, first, second }))),
    ).toEqual(
      bag([
        { key: "a", first: "first", second: "first" },
        { key: "missing", first: null, second: null },
      ]),
    );
  });

  it("COALESCE filtering keeps NULL fallback rows distinct from stored values", () => {
    const input = valuesRelation(
      {
        key: { affinity: "text", nullable: true },
        label: { affinity: "text", nullable: false },
      } as const,
      [
        { key: null, label: "null-row" },
        { key: "missing", label: "literal-row" },
        { key: "other", label: "other-row" },
      ],
    );
    const rows = runBoth(
      anyRelation(
        filter(
          input,
          eq(coalesce(input.columns.key, param("missing")), param("missing")),
        ),
      ),
    );
    expect(rows.map(({ label }) => label).sort()).toEqual([
      "literal-row",
      "null-row",
    ]);
  });

  it("IN-list does not treat a NULL input as equal to a listed value", () => {
    const input = valuesRelation(
      {
        key: { affinity: "text", nullable: true },
        label: { affinity: "text", nullable: false },
      } as const,
      [
        { key: null, label: "null-row" },
        { key: "a", label: "a-row" },
        { key: "b", label: "b-row" },
      ],
    );
    const rows = runBoth(
      anyRelation(filter(input, inList(input.columns.key, ["a"]))),
    );
    expect(rows).toEqual([{ key: "a", label: "a-row" }]);
  });

  it.each([
    {
      name: "UNION ALL keeps repeated and NULL rows",
      all: true,
      expected: ["same", "same", "same", "same", null, null],
    },
    {
      name: "UNION DISTINCT collapses equal and NULL rows across scopes",
      all: false,
      expected: ["same", null, "other"],
    },
  ])("$name", ({ all, expected }) => {
    const schema = { key: { affinity: "text", nullable: true } } as const;
    const left = valuesRelation(schema, [
      { key: "same" },
      { key: "same" },
      { key: null },
    ]);
    const result = all
      ? union(left, left, true)
      : union(
          left,
          valuesRelation(schema, [
            { key: "same" },
            { key: null },
            { key: "other" },
          ]),
          false,
        );
    const rows = runBoth(anyRelation(result));
    expect(
      rows
        .map(({ key }) => key)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(expected.sort((a, b) => String(a).localeCompare(String(b))));
  });

  it("DISTINCT collapses duplicate tuples without conflating NULL-key payloads", () => {
    const input = valuesRelation(
      {
        key: { affinity: "text", nullable: true },
        label: { affinity: "text", nullable: true },
      } as const,
      [
        { key: null, label: "null-one" },
        { key: null, label: "null-one" },
        { key: null, label: "null-two" },
        { key: "a", label: "same" },
        { key: "a", label: "same" },
      ],
    );
    const rows = runBoth(
      anyRelation(
        distinct(
          project(input, {
            key: input.columns.key,
            label: input.columns.label,
          }),
        ),
      ),
    );
    expect(bag(rows)).toEqual(
      bag([
        { key: null, label: "null-one" },
        { key: null, label: "null-two" },
        { key: "a", label: "same" },
      ]),
    );
  });

  it.each([
    {
      name: "grouped aggregates preserve NULL groups, duplicates, and COUNT NULL rules",
      build: () => {
        const input = valuesRelation(
          {
            category: { affinity: "text", nullable: true },
            value: { affinity: "text", nullable: true },
          } as const,
          [
            { category: "a", value: "x" },
            { category: "a", value: "x" },
            { category: "a", value: null },
            { category: null, value: "z" },
            { category: null, value: "z" },
          ],
        );
        return aggregate(input, {
          groupBy: { category: input.columns.category },
          aggregates: {
            rows: count(),
            nonNull: count(input.columns.value),
            unique: countDistinct(input.columns.value),
          },
        });
      },
      expected: ["a/3/2/1", "null/2/2/1"],
    },
    {
      name: "global aggregate over an empty relation remains one zero row",
      build: () => {
        const input = valuesRelation(
          { key: { affinity: "text", nullable: true } } as const,
          [],
        );
        return aggregate(input, { groupBy: {}, aggregates: { rows: count() } });
      },
      expected: ["0"],
    },
  ])("$name", ({ build, expected }) => {
    const rows = runBoth(anyRelation(build()));
    const actual = rows
      .map((row) =>
        Object.values(row)
          .map((value) => String(value ?? "null"))
          .join("/"),
      )
      .sort();
    expect(actual).toEqual(expected.sort());
  });

  it("window counts and row numbers keep NULL partitions local", () => {
    const input = valuesRelation(
      {
        partition: { affinity: "text", nullable: true },
        order: { affinity: "text", nullable: true },
        label: { affinity: "text", nullable: false },
      } as const,
      [
        { partition: "a", order: "2", label: "a2" },
        { partition: "a", order: "1", label: "a1" },
        { partition: null, order: "2", label: "n2" },
        { partition: null, order: "1", label: "n1" },
      ],
    );
    const counted = window(input, {
      size: windowCountRows({ partitionBy: [input.columns.partition] }),
      rank: rowNumber({
        partitionBy: [input.columns.partition],
        orderBy: [{ expression: input.columns.order, direction: "ASC" }],
      }),
    });
    const rows = runBoth(anyRelation(counted));
    expect(
      rows
        .map(
          ({ partition, label, size, rank }) =>
            `${partition ?? "null"}/${label}/${size}/${rank}`,
        )
        .sort(),
    ).toEqual(["a/a1/2/1", "a/a2/2/2", "null/n1/2/1", "null/n2/2/2"]);
  });

  it.each([
    {
      name: "sort limit and offset preserve the requested page boundary",
      build: () => {
        const input = valuesRelation(
          {
            key: { affinity: "text", nullable: true },
            label: { affinity: "text", nullable: false },
          } as const,
          [
            { key: "c", label: "c" },
            { key: null, label: "n" },
            { key: "a", label: "a" },
            { key: "b", label: "b" },
          ],
        );
        return anyRelation(
          limit(
            sort(input, [
              { expression: input.columns.key, direction: "ASC" },
              { expression: input.columns.label, direction: "ASC" },
            ]),
            2,
            2,
          ),
        );
      },
      expected: ["b/b", "c/c"],
    },
    {
      name: "filter above a limit cannot be pushed below its row boundary",
      build: () => {
        const input = valuesRelation(
          {
            key: { affinity: "text", nullable: false },
            label: { affinity: "text", nullable: false },
          } as const,
          [
            { key: "1", label: "drop" },
            { key: "2", label: "keep" },
            { key: "3", label: "keep" },
          ],
        );
        const ordered = sort(input, [
          { expression: input.columns.key, direction: "ASC" },
        ]);
        const page = limit(ordered, 2);
        return anyRelation(filter(page, eq(page.columns.label, param("keep"))));
      },
      expected: ["2/keep"],
    },
    {
      name: "filter below a limit keeps its independent selected set",
      build: () => {
        const input = valuesRelation(
          {
            key: { affinity: "text", nullable: false },
            label: { affinity: "text", nullable: false },
          } as const,
          [
            { key: "1", label: "drop" },
            { key: "2", label: "keep" },
            { key: "3", label: "keep" },
          ],
        );
        const selected = filter(input, eq(input.columns.label, param("keep")));
        return anyRelation(
          limit(
            sort(selected, [
              { expression: selected.columns.key, direction: "ASC" },
            ]),
            2,
          ),
        );
      },
      expected: ["2/keep", "3/keep"],
    },
  ])("$name", ({ build, expected }) => {
    const rows = runBoth(anyRelation(build()));
    expect(
      rows.map(({ key, label }) => `${key ?? "null"}/${label}`).sort(),
    ).toEqual(expected.sort());
  });
});
