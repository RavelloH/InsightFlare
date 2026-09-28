import { describe, expect, it } from "vitest";

import {
  add,
  aggregate,
  and,
  avg,
  callFunction,
  caseWhen,
  coalesce,
  compileD1Query,
  count,
  div,
  eq,
  filter,
  gt,
  gte,
  inList,
  inSubquery,
  isNotNull,
  isNull,
  limit,
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
  scalar,
  scan,
  sort,
  sub,
  sum,
  union,
  unixepoch,
} from "@/lib/db";
import { expressionResultType } from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";

describe("typed SQL expressions", () => {
  it("attaches SQL affinity and nullability metadata to every expression", () => {
    const sites = scan(schema.sites);

    expect(param("site-a").resultType).toEqual({
      affinity: "text",
      nullable: false,
    });
    expect(param(42).resultType).toEqual({
      affinity: "numeric",
      nullable: false,
    });
    expect(param(new Uint8Array([1])).resultType).toEqual({
      affinity: "blob",
      nullable: false,
    });
    expect(param(null).resultType).toEqual({
      affinity: "unknown",
      nullable: true,
    });
    expect(expressionResultType(param("site-a"))).toEqual({
      affinity: "text",
      nullable: false,
    });
    expect(callFunction("round", param(2.5)).resultType).toEqual({
      affinity: "numeric",
      nullable: false,
    });
    expect(eq(sites.columns.public_slug, param("slug")).resultType).toEqual({
      affinity: "integer",
      nullable: true,
    });
    expect(isNull(sites.columns.public_slug).resultType).toEqual({
      affinity: "integer",
      nullable: false,
    });
    expect(inList(sites.columns.public_slug, ["slug"]).resultType).toEqual({
      affinity: "integer",
      nullable: true,
    });
    expect(inList(sites.columns.public_slug, []).resultType).toEqual({
      affinity: "integer",
      nullable: false,
    });
    const siteIds = project(sites, { id: sites.columns.id });
    expect(inSubquery(sites.columns.id, siteIds).resultType).toEqual({
      affinity: "integer",
      nullable: true,
    });
    const nullableSlugs = project(sites, { slug: sites.columns.public_slug });
    expect(inSubquery(sites.columns.name, nullableSlugs).resultType).toEqual({
      affinity: "integer",
      nullable: true,
    });
    expect(() => inSubquery(sites.columns.id, sites)).toThrowError(
      /exactly one output field/,
    );
    expect(add(sites.columns.created_at, param(1)).resultType).toEqual({
      affinity: "numeric",
      nullable: false,
    });
    expect(div(param(1), param(0)).resultType).toEqual({
      affinity: "numeric",
      nullable: true,
    });
    expect(callFunction("lower", sites.columns.public_slug).resultType).toEqual(
      {
        affinity: "text",
        nullable: true,
      },
    );
    expect(
      callFunction("length", param(new Uint8Array([1]))).resultType,
    ).toEqual({
      affinity: "integer",
      nullable: false,
    });
    expect(
      coalesce(sites.columns.public_slug, param("fallback")).resultType,
    ).toEqual({
      affinity: "text",
      nullable: false,
    });
    expect(
      coalesce(sites.columns.public_slug, sites.columns.created_at).resultType,
    ).toEqual({ affinity: "unknown", nullable: false });
    const mixedFallback = coalesce(param("text"), param(1), param("text"));
    expect(mixedFallback.resultType).toEqual({
      affinity: "unknown",
      nullable: false,
    });
    expect(() =>
      compileD1Query(project(sites, { fallback: mixedFallback })),
    ).not.toThrow();
    expect(count().resultType).toEqual({
      affinity: "integer",
      nullable: false,
    });
    expect(sum(sites.columns.created_at).resultType).toEqual({
      affinity: "numeric",
      nullable: true,
    });
    expect(avg(sites.columns.created_at).resultType).toEqual({
      affinity: "numeric",
      nullable: true,
    });
    expect(min(sites.columns.public_slug).resultType).toEqual({
      affinity: "text",
      nullable: true,
    });
    expect(unixepoch().resultType).toEqual({
      affinity: "integer",
      nullable: false,
    });
    expect(
      scalar(project(sites, { created_at: sites.columns.created_at }))
        .resultType,
    ).toEqual({ affinity: "integer", nullable: true });
    expect(() =>
      scalar(
        project(sites, {
          id: sites.columns.id,
          name: sites.columns.name,
        }),
      ),
    ).toThrowError(/exactly one output field/);

    const required = project(sites, { label: sites.columns.name });
    const optional = project(sites, { label: sites.columns.public_slug });
    const combined = union(required, optional, true);
    expect(combined.fields).toEqual([
      { name: "label", affinity: "text", nullable: true },
    ]);
    expect(compileD1Query(combined).sql).toContain("UNION ALL");
  });

  it("derives CASE affinity and nullability and rejects invalid result branches", () => {
    const sites = scan(schema.sites);
    const requiredText = caseWhen(
      [
        {
          when: isNotNull(sites.columns.name),
          then: param("matched"),
        },
        {
          when: eq(sites.columns.id, param("site-a")),
          then: param("also matched"),
        },
      ],
      param("fallback"),
    );
    expect(requiredText.resultType).toEqual({
      affinity: "text",
      nullable: false,
    });

    const noElse = caseWhen([
      { when: isNotNull(sites.columns.name), then: sites.columns.name },
    ]);
    expect(noElse.resultType).toEqual({ affinity: "text", nullable: true });

    const nullableThen = caseWhen(
      [
        {
          when: isNotNull(sites.columns.name),
          then: sites.columns.public_slug,
        },
      ],
      param("fallback"),
    );
    expect(nullableThen.resultType).toEqual({
      affinity: "text",
      nullable: true,
    });

    const nullableElse = caseWhen(
      [
        {
          when: isNotNull(sites.columns.name),
          then: param("matched"),
        },
      ],
      param(null),
    );
    expect(nullableElse.resultType).toEqual({
      affinity: "text",
      nullable: true,
    });

    expect(() => caseWhen([] as never)).toThrowError(/at least one WHEN/);
    expect(() =>
      caseWhen([
        { when: isNotNull(sites.columns.name), then: param("text") },
        { when: isNotNull(sites.columns.name), then: param(1) },
      ] as never),
    ).toThrowError(/incompatible SQL affinities/);
  });

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

  it("rejects empty query builder shapes", () => {
    const visits = scan(schema.visits);
    expect(() => aggregate(visits, { groupBy: {}, aggregates: {} })).toThrow(
      /groups or aggregates/,
    );
    expect(() => sort(visits, [])).toThrow(/at least one sort key/);
    expect(() => limit(visits, -1)).toThrow(/non-negative safe integer/);

    const sites = scan(schema.sites);
    const byId = project(sites, { value: sites.columns.created_at });
    const byName = project(sites, { value: sites.columns.name });
    expect(() => union(byId, byName)).toThrow(/incompatible affinities/);
    const namedById = project(sites, { id: sites.columns.id });
    const namedByName = project(sites, { name: sites.columns.name });
    expect(() =>
      union(namedById, namedByName as unknown as typeof namedById),
    ).toThrow(/matching output fields/);
  });
});
