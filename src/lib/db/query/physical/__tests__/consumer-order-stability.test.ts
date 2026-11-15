import { describe, expect, it } from "vitest";

import {
  aggregate,
  and,
  antiJoin,
  avg,
  callFunction,
  caseWhen,
  castInteger,
  coalesce,
  constant,
  count,
  distinct,
  eq,
  filter,
  isNotNull,
  isNull,
  join,
  limit,
  lt,
  min,
  not,
  or,
  param,
  project,
  scan,
  semiJoin,
  sum,
  union,
} from "@/lib/db";
import type { SqlExpression } from "@/lib/db/query/expression";
import { hasOrderStableConsumers } from "@/lib/db/query/physical/consumer-order-stability";
import { schema } from "@/lib/db/schema";

function source(marker: SqlExpression<number> = param(1)) {
  const visits = scan(schema.visits);
  return project(visits, {
    key: visits.columns.session_id,
    at: visits.columns.started_at,
    marker,
  });
}

describe("complete consumer order and representative proof", () => {
  it("accepts a full unordered bag and rejects direct selection", () => {
    const input = source();
    expect(hasOrderStableConsumers(input.node, input.node)).toBe(true);
    expect(hasOrderStableConsumers(input.node, limit(input, 1).node)).toBe(
      false,
    );
  });

  it("stops at the first stable aggregate rather than inspecting unrelated outer SUM", () => {
    const input = source();
    const groups = aggregate(input, {
      groupBy: { key: input.columns.key },
      aggregates: { n: count() },
    });
    const outer = aggregate(groups, {
      groupBy: {},
      aggregates: { n: sum(groups.columns.n) },
    });
    expect(hasOrderStableConsumers(input.node, outer.node)).toBe(true);
  });

  it("rejects a second shared path even if the first path has an aggregate fence", () => {
    const input = source();
    const stable = aggregate(input, {
      groupBy: {},
      aggregates: { n: count() },
    });
    const unsafe = project(limit(input, 1), { n: input.columns.marker });
    const combined = union(stable, unsafe, true);
    expect(hasOrderStableConsumers(input.node, combined.node)).toBe(false);
  });

  it("requires stable group values, not just a COUNT aggregate", () => {
    const input = source();
    const group = aggregate(input, {
      groupBy: { time: input.columns.at },
      aggregates: { n: count() },
    });
    expect(hasOrderStableConsumers(input.node, group.node)).toBe(false);
  });

  it("does not let DISTINCT pick an unproven raw INTEGER representative", () => {
    const input = source();
    expect(hasOrderStableConsumers(input.node, distinct(input).node)).toBe(
      false,
    );
    const visits = scan(schema.visits);
    // A stable non-null catalog key makes the complete tuple already unique.
    const nonNull = filter(visits, isNotNull(visits.columns.visit_id));
    const unique = project(nonNull, {
      id: nonNull.columns.visit_id,
      at: nonNull.columns.started_at,
    });
    expect(hasOrderStableConsumers(unique.node, distinct(unique).node)).toBe(
      true,
    );
  });

  it("allows uniform bound 0/1 indicators without claiming INTEGER storage", () => {
    const one = source(param(1));
    const zero = source(param(0));
    const rows = union(one, zero, true);
    const groups = aggregate(rows, {
      groupBy: { key: rows.columns.key },
      aggregates: { n: sum(rows.columns.marker) },
    });
    expect(hasOrderStableConsumers(one.node, groups.node)).toBe(true);
  });

  it("requires every NULL-key path to pass a strict discard before using nullable uniqueness", () => {
    const visits = scan(schema.visits);
    const input = project(visits, {
      id: visits.columns.visit_id,
      at: visits.columns.started_at,
    });
    const selected = distinct(input);
    const other = scan(schema.visits);
    const guarded = join(
      selected,
      other,
      eq(selected.columns.id, other.columns.visit_id),
    );
    expect(hasOrderStableConsumers(input.node, guarded.node)).toBe(true);
    expect(hasOrderStableConsumers(input.node, selected.node)).toBe(false);
    const preserved = join(
      selected,
      other,
      eq(selected.columns.id, other.columns.visit_id),
      "left",
    );
    expect(hasOrderStableConsumers(input.node, preserved.node)).toBe(false);
    const projected = project(guarded, {
      id: guarded.columns.left_id,
      at: guarded.columns.left_at,
    });
    expect(
      hasOrderStableConsumers(
        input.node,
        union(projected, selected, true).node,
      ),
    ).toBe(false);
  });

  it("rejects positive and negative cancellation and mixed +1 representations", () => {
    for (const other of [param(-1), constant(1), constant(0)]) {
      const one = source(param(1));
      const rows = union(one, source(other), true);
      const groups = aggregate(rows, {
        groupBy: {},
        aggregates: { n: sum(rows.columns.marker) },
      });
      expect(hasOrderStableConsumers(one.node, groups.node)).toBe(false);
    }
  });

  it("preserves nullable unique keys through aliases and strict boolean guards", () => {
    const visits = scan(schema.visits);
    const input = project(visits, {
      id: visits.columns.visit_id,
      at: visits.columns.started_at,
    });
    const selected = distinct(input);
    const alias = project(selected, {
      renamed: selected.columns.id,
      at: selected.columns.at,
    });
    for (const predicate of [
      isNotNull(alias.columns.renamed),
      and(isNotNull(alias.columns.renamed), lt(alias.columns.at, constant(10))),
      or(
        eq(alias.columns.renamed, param("a")),
        eq(alias.columns.renamed, param("b")),
      ),
    ])
      expect(
        hasOrderStableConsumers(input.node, filter(alias, predicate).node),
      ).toBe(true);
    for (const predicate of [
      isNull(alias.columns.renamed),
      or(isNotNull(alias.columns.renamed), isNull(alias.columns.renamed)),
      eq(param(1), param(1)),
    ])
      expect(
        hasOrderStableConsumers(input.node, filter(alias, predicate).node),
      ).toBe(false);
    const dropped = project(selected, { at: selected.columns.at });
    expect(hasOrderStableConsumers(input.node, dropped.node)).toBe(false);
    const other = scan(schema.visits);
    const crossed = join(
      other,
      selected,
      eq(other.columns.session_id, selected.columns.id),
    );
    expect(hasOrderStableConsumers(input.node, crossed.node)).toBe(true);
    const notYetGuarded = join(
      other,
      selected,
      eq(other.columns.session_id, other.columns.session_id),
    );
    expect(
      hasOrderStableConsumers(
        input.node,
        filter(notYetGuarded, isNotNull(notYetGuarded.columns.right_id)).node,
      ),
    ).toBe(true);
    expect(
      hasOrderStableConsumers(
        input.node,
        filter(
          selected,
          lt(callFunction("abs", selected.columns.at), constant(1)),
        ).node,
      ),
    ).toBe(false);
  });

  it("tracks uniform indicators through filters, sets, semi and anti joins", () => {
    const input = source();
    const other = source();
    const filtered = filter(input, isNotNull(input.columns.key));
    const narrowed = project(filtered, {
      key: filtered.columns.key,
      marker: filtered.columns.marker,
    });
    const selected = distinct(narrowed);
    const semi = semiJoin(
      selected,
      other,
      eq(selected.columns.key, other.columns.key),
    );
    const anti = antiJoin(
      selected,
      other,
      eq(selected.columns.key, other.columns.key),
    );
    for (const rows of [selected, semi, anti]) {
      const counted = aggregate(rows, {
        groupBy: {},
        aggregates: { n: sum(rows.columns.marker) },
      });
      expect(hasOrderStableConsumers(input.node, counted.node)).toBe(true);
    }
    const joined = join(input, other, eq(input.columns.key, other.columns.key));
    for (const marker of [
      joined.columns.left_marker,
      joined.columns.right_marker,
    ])
      expect(
        hasOrderStableConsumers(
          input.node,
          aggregate(joined, { groupBy: {}, aggregates: { n: sum(marker) } })
            .node,
        ),
      ).toBe(true);
  });

  it("checks every CASE and COALESCE indicator branch and canonical casts", () => {
    for (const marker of [
      caseWhen([{ when: eq(param(1), param(1)), then: param(1) }], param(0)),
      coalesce(param<number | null>(null), param(1)),
      castInteger(param(1)),
      castInteger(
        caseWhen([{ when: eq(param(1), param(1)), then: param(1) }], param(0)),
      ),
    ]) {
      const input = source(marker);
      expect(
        hasOrderStableConsumers(
          input.node,
          aggregate(input, {
            groupBy: {},
            aggregates: { n: sum(input.columns.marker) },
          }).node,
        ),
      ).toBe(true);
    }
    for (const marker of [
      coalesce(param<number | null>(null), param(2)),
      castInteger(param(2)),
      caseWhen([{ when: eq(param(1), param(1)), then: param(1) }], param(-1)),
    ]) {
      const input = source(marker);
      expect(
        hasOrderStableConsumers(
          input.node,
          aggregate(input, {
            groupBy: {},
            aggregates: { n: sum(input.columns.marker) },
          }).node,
        ),
      ).toBe(false);
    }
    const input = source();
    expect(
      hasOrderStableConsumers(
        input.node,
        aggregate(input, {
          groupBy: {},
          aggregates: { n: sum(input.columns.at) },
        }).node,
      ),
    ).toBe(false);
    expect(
      hasOrderStableConsumers(
        input.node,
        aggregate(input, {
          groupBy: {},
          aggregates: { n: avg(input.columns.marker) },
        }).node,
      ),
    ).toBe(false);
  });

  it("accepts canonical grouping expressions and observes aggregate keys freshly", () => {
    const input = source();
    for (const key of [
      constant(1),
      param(1),
      castInteger(input.columns.at),
      isNotNull(input.columns.at),
      not(isNull(input.columns.at)),
      caseWhen(
        [{ when: lt(input.columns.at, constant(100)), then: constant(0) }],
        constant(1),
      ),
    ]) {
      const groups = aggregate(input, {
        groupBy: { key },
        aggregates: { n: count(input.columns.at) },
      });
      expect(hasOrderStableConsumers(input.node, groups.node)).toBe(true);
      expect(hasOrderStableConsumers(groups.node, distinct(groups).node)).toBe(
        true,
      );
    }
    const partial = aggregate(input, {
      groupBy: {},
      aggregates: { n: count(callFunction("abs", input.columns.at)) },
    });
    expect(hasOrderStableConsumers(input.node, partial.node)).toBe(false);
    const badKey = aggregate(input, {
      groupBy: { key: callFunction("abs", input.columns.at) },
      aggregates: { n: count() },
    });
    expect(hasOrderStableConsumers(input.node, badKey.node)).toBe(false);
  });

  it("allows BINARY set representatives only when every path observes COUNTstar", () => {
    const visits = scan(schema.visits);
    const input = project(visits, {
      at: visits.columns.started_at,
      key: visits.columns.session_id,
    });
    const selected = distinct(input);
    const alias = project(selected, {
      at: selected.columns.at,
      key: selected.columns.key,
    });
    const other = source();
    const otherAlias = project(other, {
      at: other.columns.at,
      key: other.columns.key,
    });
    const combined = union(alias, otherAlias, false);
    const counted = aggregate(combined, {
      groupBy: {},
      aggregates: { n: count() },
    });
    expect(hasOrderStableConsumers(input.node, counted.node)).toBe(true);
    expect(hasOrderStableConsumers(input.node, combined.node)).toBe(false);
    const storage = project(combined, {
      storage: callFunction("storage-class", combined.columns.at),
    });
    const countedStorage = aggregate(distinct(storage), {
      groupBy: {},
      aggregates: { n: count() },
    });
    expect(hasOrderStableConsumers(input.node, countedStorage.node)).toBe(
      false,
    );
    const predicate = filter(combined, lt(combined.columns.at, constant(150)));
    expect(
      hasOrderStableConsumers(
        input.node,
        aggregate(predicate, { groupBy: {}, aggregates: { n: count() } }).node,
      ),
    ).toBe(false);
    const raw = project(selected, { n: selected.columns.at });
    expect(
      hasOrderStableConsumers(input.node, union(counted, raw, true).node),
    ).toBe(false);
    expect(
      hasOrderStableConsumers(
        input.node,
        aggregate(limit(combined, 1), {
          groupBy: {},
          aggregates: { n: count() },
        }).node,
      ),
    ).toBe(false);
  });

  it("allows numeric MIN only through a total numeric comparison and fixed CASE bucket", () => {
    const input = source();
    const groups = aggregate(input, {
      groupBy: { key: input.columns.key },
      aggregates: { first: min(input.columns.at) },
    });
    const alias = project(groups, { first: groups.columns.first });
    const buckets = project(alias, {
      bucket: caseWhen(
        [{ when: lt(alias.columns.first, constant(150)), then: constant(0) }],
        constant(1),
      ),
    });
    expect(hasOrderStableConsumers(input.node, buckets.node)).toBe(true);
    expect(hasOrderStableConsumers(input.node, groups.node)).toBe(false);
    const types = project(groups, {
      storage: callFunction("storage-class", groups.columns.first),
    });
    expect(hasOrderStableConsumers(input.node, types.node)).toBe(false);
  });

  it("checks every MIN observer, including aliases and a shared raw export", () => {
    const input = source();
    const groups = aggregate(input, {
      groupBy: {},
      aggregates: { first: min(input.columns.at) },
    });
    const bucket = project(groups, {
      value: caseWhen(
        [{ when: lt(groups.columns.first, constant(150)), then: constant(0) }],
        constant(1),
      ),
    });
    const raw = project(groups, { value: groups.columns.first });
    expect(
      hasOrderStableConsumers(input.node, union(bucket, raw, true).node),
    ).toBe(false);
  });

  it("allows only canonical boolean observers and fixed buckets after numeric MIN", () => {
    const input = source();
    const groups = aggregate(input, {
      groupBy: {},
      aggregates: { first: min(input.columns.at), n: count() },
    });
    const guarded = filter(
      groups,
      and(
        not(isNull(groups.columns.first)),
        lt(constant(0), groups.columns.first),
        eq(constant(1), constant(1)),
      ),
    );
    const bucket = project(guarded, {
      n: guarded.columns.n,
      bucket: caseWhen(
        [
          {
            when: or(
              isNull(guarded.columns.first),
              lt(guarded.columns.first, constant(100)),
            ),
            then: constant(0),
          },
        ],
        constant(1),
      ),
    });
    expect(hasOrderStableConsumers(input.node, bucket.node)).toBe(true);
    const nullableBucket = project(groups, {
      bucket: caseWhen([
        { when: isNull(groups.columns.first), then: constant(null) },
      ]),
    });
    expect(hasOrderStableConsumers(input.node, nullableBucket.node)).toBe(true);
    const badBucket = project(groups, {
      bucket: caseWhen(
        [{ when: lt(groups.columns.first, constant(100)), then: param(0) }],
        constant(1),
      ),
    });
    expect(hasOrderStableConsumers(input.node, badBucket.node)).toBe(false);
    const partial = filter(
      groups,
      lt(callFunction("abs", groups.columns.first), constant(100)),
    );
    expect(
      hasOrderStableConsumers(
        input.node,
        project(partial, { n: partial.columns.n }).node,
      ),
    ).toBe(false);
    const textMin = aggregate(input, {
      groupBy: {},
      aggregates: { first: min(input.columns.key) },
    });
    expect(hasOrderStableConsumers(input.node, textMin.node)).toBe(true);
  });

  it("proves BINARY text group values through distinct union and pass-through relations", () => {
    const input = source();
    const rows = union(input, source(), false);
    const filtered = filter(rows, isNotNull(rows.columns.key));
    const grouped = aggregate(filtered, {
      groupBy: { key: filtered.columns.key },
      aggregates: { n: count() },
    });
    expect(hasOrderStableConsumers(rows.node, grouped.node)).toBe(true);
    const numericGrouped = aggregate(rows, {
      groupBy: { at: rows.columns.at },
      aggregates: { n: count() },
    });
    expect(hasOrderStableConsumers(rows.node, numericGrouped.node)).toBe(false);
  });

  it("does not expose discarded BINARY set representatives through unrelated filters", () => {
    const visits = scan(schema.visits);
    const input = project(visits, {
      at: visits.columns.started_at,
      key: visits.columns.session_id,
    });
    const selected = distinct(input);
    const filtered = filter(selected, isNotNull(selected.columns.key));
    const again = distinct(filtered);
    const counted = aggregate(again, {
      groupBy: {},
      aggregates: { n: count() },
    });
    expect(hasOrderStableConsumers(input.node, counted.node)).toBe(true);
    const dropped = project(filtered, { key: filtered.columns.key });
    expect(hasOrderStableConsumers(input.node, dropped.node)).toBe(true);
  });

  it("keeps partial expressions before the first stable fence observable", () => {
    const input = source();
    const partial = filter(
      input,
      lt(callFunction("abs", input.columns.at), constant(150)),
    );
    const counted = aggregate(partial, {
      groupBy: {},
      aggregates: { n: count() },
    });
    expect(hasOrderStableConsumers(input.node, counted.node)).toBe(false);
  });
});
