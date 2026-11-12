import { describe, expect, it } from "vitest";

import {
  aggregate,
  antiJoin,
  count,
  distinct,
  eq,
  filter,
  gt,
  join,
  jsonScalarArray,
  limit,
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
import { inspectClosedStableSubtree } from "@/lib/db/query/complete-keyed-lookup-reuse";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

const nodeOf = (relation: { readonly node: LogicalQueryNode }) => relation.node;
const inspect = (
  relation: { readonly node: LogicalQueryNode },
  leaves = new Map<LogicalQueryNode, { containsRecursiveClosure: boolean }>(),
  options: Parameters<typeof inspectClosedStableSubtree>[2] = {},
) => inspectClosedStableSubtree(nodeOf(relation), leaves, options);

describe("closed stable subtree inspection", () => {
  it("accepts scans, stable projections, filters, joins, semi-joins and UNION ALL", () => {
    const users = scan(schema.users);
    const other = scan(schema.users);
    expect(inspect(users)).toEqual({ containsRecursiveClosure: false });
    const selected = filter(users, gt(users.columns.created_at, param(1)));
    const projected = project(selected, { id: selected.columns.id });
    expect(inspect(projected)).toEqual({ containsRecursiveClosure: false });
    const joined = join(
      users,
      other,
      eq(users.columns.id, other.columns.id),
      "left",
    );
    expect(inspect(joined)).toEqual({ containsRecursiveClosure: false });
    const semi = semiJoin(users, other, eq(users.columns.id, other.columns.id));
    expect(inspect(semi)).toEqual({ containsRecursiveClosure: false });
    const anti = antiJoin(users, other, eq(users.columns.id, other.columns.id));
    expect(inspect(anti)).toEqual({ containsRecursiveClosure: false });
    const left = project(users, { id: users.columns.id });
    const right = project(other, { id: other.columns.id });
    expect(inspect(union(left, right, true))).toEqual({
      containsRecursiveClosure: false,
    });
  });

  it("rejects set semantics, ordering, windows, limits and literal relations", () => {
    const users = scan(schema.users);
    const other = scan(schema.users);
    const left = project(users, { id: users.columns.id });
    const right = project(other, { id: other.columns.id });
    expect(inspect(union(left, right, false))).toBeUndefined();
    expect(inspect(distinct(users))).toBeUndefined();
    expect(
      inspect(
        sort(users, [{ expression: users.columns.id, direction: "ASC" }]),
      ),
    ).toBeUndefined();
    expect(inspect(limit(users, 3))).toBeUndefined();
    expect(
      inspect(
        window(users, {
          rank: rowNumber({
            orderBy: [{ expression: users.columns.id, direction: "ASC" }],
          }),
        }),
      ),
    ).toBeUndefined();
    expect(inspect(jsonScalarArray("numeric", [1]))).toBeUndefined();
  });

  it("rejects outer join kinds other than inner/left and unstable expressions", () => {
    const users = scan(schema.users);
    const other = scan(schema.users);
    const selected = filter(users, eq(users.columns.id, param("u")));
    expect(inspect(selected)).toEqual({ containsRecursiveClosure: false });
    const joined = join(users, other, eq(users.columns.id, other.columns.id));
    const forged = {
      ...joined.node,
      joinType: "full",
    } as unknown as LogicalQueryNode;
    expect(inspectClosedStableSubtree(forged)).toBeUndefined();
  });

  it("treats a cyclic plan as invalid", () => {
    const users = scan(schema.users);
    const selected = filter(users, eq(users.columns.id, param("u")));
    const node = selected.node as unknown as { input: unknown };
    const original = node.input;
    node.input = {
      node: selected.node,
      scope: selected.scope,
      fields: selected.fields,
    };
    try {
      expect(inspect(selected)).toBeUndefined();
    } finally {
      node.input = original;
    }
  });

  it("requires bounded admission leaves to be literal limits above one row", () => {
    const users = scan(schema.users);
    const bounded = limit(users, 5);
    const evidence = { containsRecursiveClosure: true };
    const leaves = new Map([[nodeOf(bounded), evidence]]);
    expect(inspect(bounded, leaves)).toEqual({
      containsRecursiveClosure: true,
    });
    const single = limit(users, 1);
    expect(
      inspect(single, new Map([[nodeOf(single), evidence]])),
    ).toBeUndefined();
    const offset = limit(users, 5, 2);
    expect(
      inspect(offset, new Map([[nodeOf(offset), evidence]])),
    ).toBeUndefined();
    const notLimit = filter(users, eq(users.columns.id, param("u")));
    expect(
      inspect(notLimit, new Map([[nodeOf(notLimit), evidence]])),
    ).toBeUndefined();
  });

  it("accepts exact COUNT(*) admission counters over a licensed bounded input", () => {
    const users = scan(schema.users);
    const bounded = limit(users, 5);
    const counter = aggregate(bounded, {
      groupBy: {},
      aggregates: { n: count() },
    });
    const evidence = { containsRecursiveClosure: false };
    const leaves = new Map([[nodeOf(bounded), evidence]]);
    const counters = new Map([[nodeOf(counter), nodeOf(bounded)]]);
    expect(inspect(counter, leaves, { admissionCounters: counters })).toEqual({
      containsRecursiveClosure: false,
    });
    // Without a licensed leaf the counter is not trusted.
    expect(
      inspect(counter, new Map(), { admissionCounters: counters }),
    ).toBeUndefined();

    const recursiveEvidence = new Map([
      [nodeOf(bounded), { containsRecursiveClosure: true }],
    ]);
    expect(
      inspect(counter, recursiveEvidence, { admissionCounters: counters }),
    ).toEqual({ containsRecursiveClosure: true });

    const grouped = aggregate(bounded, {
      groupBy: { id: bounded.columns.id },
      aggregates: { n: count() },
    });
    expect(
      inspect(grouped, leaves, {
        admissionCounters: new Map([[nodeOf(grouped), nodeOf(bounded)]]),
      }),
    ).toBeUndefined();

    const summed = aggregate(bounded, {
      groupBy: {},
      aggregates: { total: sum(bounded.columns.created_at) },
    });
    expect(
      inspect(summed, leaves, {
        admissionCounters: new Map([[nodeOf(summed), nodeOf(bounded)]]),
      }),
    ).toBeUndefined();

    const distinctCount = aggregate(bounded, {
      groupBy: {},
      aggregates: { n: count(bounded.columns.id) },
    });
    expect(
      inspect(distinctCount, leaves, {
        admissionCounters: new Map([[nodeOf(distinctCount), nodeOf(bounded)]]),
      }),
    ).toBeUndefined();
    const otherInput = limit(users, 7);
    expect(
      inspect(counter, new Map([[nodeOf(otherInput), evidence]]), {
        admissionCounters: new Map([[nodeOf(counter), nodeOf(otherInput)]]),
      }),
    ).toBeUndefined();
  });

  it("limits aggregate roots to the keyed whitelist unless root-controlled sums are allowed", () => {
    const users = scan(schema.users);
    const summed = aggregate(users, {
      groupBy: { role: users.columns.system_role },
      aggregates: { total: sum(users.columns.created_at) },
    });
    expect(inspect(summed)).toBeUndefined();
    const counted = aggregate(users, {
      groupBy: { role: users.columns.system_role },
      aggregates: { n: count() },
    });
    expect(inspect(counted)).toEqual({ containsRecursiveClosure: false });
    const scalar = aggregate(users, {
      groupBy: {},
      aggregates: { n: count() },
    });
    // A keyed-reuse root must be grouped; the same scalar aggregate is fine
    // as an interior node.
    expect(inspect(scalar)).toBeUndefined();
    const wrapped = project(scalar, { n: scalar.columns.n });
    expect(inspect(wrapped)).toEqual({ containsRecursiveClosure: false });
  });
});
