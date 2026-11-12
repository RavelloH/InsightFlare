import { describe, expect, it } from "vitest";

import {
  aggregate,
  and,
  compileD1Query,
  distinct,
  eq,
  filter,
  gt,
  join,
  limit,
  param,
  project,
  rowNumber,
  scan,
  semiJoin,
  sort,
  union,
  window,
} from "@/lib/db";
import { analyzeConditionalLookupChoices } from "@/lib/db/query/physical/conditional-lookup";
import { schema } from "@/lib/db/schema";

function archive() {
  return scan(schema.archive_objects);
}

type Archive = ReturnType<typeof archive>;

function leftJoinOver(left: {
  columns: Archive["columns"];
  node: Archive["node"];
}) {
  const right = archive();
  const joined = join(
    left as never,
    right,
    and(
      eq(left.columns.site_pk, right.columns.site_pk),
      eq(left.columns.start_hour, right.columns.start_hour),
      gt(left.columns.created_at, param(10)),
    ),
    "left",
  );
  return project(joined, {
    leftKey: joined.columns.left_archive_key,
    rightKey: joined.columns.right_archive_key,
  });
}

describe("conditional lookup proof through wrapped left inputs", () => {
  const wrappers: Record<string, () => Archive> = {
    filter: () => {
      const s = archive();
      return filter(s, gt(s.columns.size_bytes, param(0))) as never;
    },
    distinct: () => distinct(archive()) as never,
    sort: () => {
      const s = archive();
      return sort(s, [
        { expression: s.columns.archive_key, direction: "ASC" },
      ]) as never;
    },
    limit: () => limit(archive(), 5) as never,
    semiJoin: () => {
      const left = archive();
      const other = archive();
      return semiJoin(
        left,
        other,
        eq(left.columns.archive_key, other.columns.archive_key),
      ) as never;
    },
    window: () => {
      const left = archive();
      return window(left, {
        rank: rowNumber({
          orderBy: [{ expression: left.columns.archive_key, direction: "ASC" }],
        }),
      }) as never;
    },
    union: () => union(archive(), archive(), true) as never,
    aggregate: () => {
      const left = archive();
      return aggregate(left, {
        groupBy: {
          archive_key: left.columns.archive_key,
          site_pk: left.columns.site_pk,
          start_hour: left.columns.start_hour,
          created_at: left.columns.created_at,
        },
        aggregates: {},
      } as never) as never;
    },
  };

  for (const [name, build] of Object.entries(wrappers))
    it(`analyzes a LEFT JOIN over ${name}`, () => {
      const query = leftJoinOver(build() as never);
      const choices = analyzeConditionalLookupChoices(query.node);
      expect(choices).toHaveLength(1);
      expect(choices[0]).toMatchObject({
        tableName: "archive_objects",
        indexName: "idx_archive_objects_site_pk_hour",
      });
      expect(choices[0]?.keyColumns.map(({ name }) => name)).toEqual([
        "site_pk",
        "start_hour",
      ]);
      expect(choices[0]?.guardConjuncts).toHaveLength(1);
      const compiled = compileD1Query(query);
      expect(compiled.sql).toContain("CASE WHEN");
      expect(compiled.physicalPlanShape).toMatchObject({
        conditionalLookupCount: 1,
      });
    });
});

describe("conditional lookup proof through join inputs", () => {
  it.each(["left", "right"] as const)(
    "proves keys that arrive through the %s side of an inner join",
    (side) => {
      const a = archive();
      const b = archive();
      const inner = join(
        a,
        b,
        eq(a.columns.archive_key, b.columns.archive_key),
      );
      const pick = (name: "site_pk" | "start_hour" | "created_at") =>
        inner.columns[`${side}_${name}` as keyof typeof inner.columns] as never;
      const right = archive();
      const joined = join(
        inner,
        right,
        and(
          eq(pick("site_pk"), right.columns.site_pk),
          eq(pick("start_hour"), right.columns.start_hour),
          gt(pick("created_at"), param(10)),
        ),
        "left",
      );
      const query = project(joined, {
        rightKey: joined.columns.right_archive_key,
      });
      const choices = analyzeConditionalLookupChoices(query.node);
      expect(choices).toHaveLength(1);
      expect(choices[0]?.selectedKey.name).toBe("site_pk");
      expect(compileD1Query(query).sql).toContain("CASE WHEN");
    },
  );
});
