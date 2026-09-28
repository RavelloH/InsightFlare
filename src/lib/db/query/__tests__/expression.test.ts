import { describe, expect, it } from "vitest";

import {
  add,
  aggregate,
  and,
  callFunction,
  coalesce,
  compileD1Query,
  count,
  div,
  eq,
  filter,
  gt,
  gte,
  inList,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  min,
  mul,
  neq,
  not,
  or,
  param,
  project,
  scan,
  sub,
  sum,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";

describe("typed SQL expressions", () => {
  it("compiles predicates, null checks, lists, functions, and arithmetic", () => {
    const visits = scan(schema.visits);
    const where = or(
      and(
        eq(visits.columns.site_pk, param(4)),
        gte(visits.columns.started_at, param(100)),
        lt(visits.columns.started_at, param(200)),
      ),
      not(isNull(visits.columns.ended_at)),
    );
    const query = compileD1Query(filter(visits, where));
    expect(query.sql).toContain(" OR ");
    expect(query.sql).toContain("AND");
    expect(query.sql).toContain("IS NULL");
    expect(query.bindings).toEqual([4, 100, 200]);

    const users = scan(schema.users);
    const textPredicates = compileD1Query(
      filter(
        users,
        and(
          neq(users.columns.email, param("hidden@example.test")),
          isNotNull(users.columns.name),
          inList(users.columns.id, ["u1", "u2"]),
          gt(users.columns.email, param("a@example.test")),
          lte(users.columns.email, param("z@example.test")),
          lte(users.columns.id, param("z")),
        ),
      ),
    );
    expect(textPredicates.sql).toContain("IN (?, ?)");
    expect(textPredicates.sql).toContain("IS NOT NULL");
    expect(textPredicates.bindings).toEqual([
      "hidden@example.test",
      "u1",
      "u2",
      "a@example.test",
      "z@example.test",
      "z",
    ]);
    expect(
      compileD1Query(filter(users, inList(users.columns.id, []))).sql,
    ).toContain("(0)");

    const calculated = project(visits, {
      next_start: add(visits.columns.started_at, param(1)),
      previous_start: sub(visits.columns.started_at, param(1)),
      scaled_start: mul(visits.columns.started_at, param(2)),
      divided_start: div(visits.columns.started_at, param(2)),
      site_text: callFunction("lower", param("SITE")),
      maybe_country: coalesce(visits.columns.country, param("unknown")),
    });
    const calculatedSql = compileD1Query(calculated);
    expect(calculatedSql.sql).toContain("COALESCE(");
    expect(calculatedSql.sql).toContain("LOWER(");
    expect(calculatedSql.bindings).toEqual([1, 1, 2, 2, "SITE", "unknown"]);
  });

  it("keeps aggregate expressions in the aggregate plan", () => {
    const visits = scan(schema.visits);
    const summary = aggregate(visits, {
      groupBy: { country: visits.columns.country },
      aggregates: {
        total: count(),
        distinctVisitors: max(visits.columns.started_at),
        minimum: min(visits.columns.started_at),
        sum: sum(visits.columns.started_at),
      },
    });
    const compiled = compileD1Query(summary);
    expect(compiled.sql).toContain("COUNT(*)");
    expect(compiled.sql).toContain("MAX(");
    expect(compiled.sql).toContain("MIN(");
    expect(compiled.sql).toContain("SUM(");
  });
});
