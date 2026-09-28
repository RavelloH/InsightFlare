import { describe, expect, it } from "vitest";

import {
  aggregate,
  compileD1Query,
  count,
  eq,
  excluded,
  filter,
  join,
  limit,
  param,
  project,
  scan,
  sort,
  union,
} from "@/lib/db";
import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type { SqlExpression } from "@/lib/db/query/expression";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";
import {
  validateLogicalQueryPlan,
  validateMutationExpression,
  validatePredicate,
  validateProjectionFields,
} from "@/lib/db/query/validator";
import { schema } from "@/lib/db/schema";

function expectInvalid(callback: () => unknown): void {
  expect(callback).toThrowError(DatabaseCompilerError);
}

describe("logical query plan validation", () => {
  it("rejects columns from outside the visible relation scope", () => {
    const users = scan(schema.users);
    const visits = scan(schema.visits);
    const invalid = filter(
      users,
      eq(users.columns.id, visits.columns.visit_id),
    );
    expectInvalid(() => compileD1Query(invalid));
  });

  it("rejects malformed expression metadata, scopes, and signatures", () => {
    const users = scan(schema.users);
    expectInvalid(() =>
      validatePredicate(
        eq(users.columns.id, param("u-1")),
        [users.scope],
        new Map([[users.scope, []]]),
      ),
    );

    expectInvalid(() =>
      validateMutationExpression(excluded(schema.users.columns.id), []),
    );

    const stringParameter = param("text");
    expectInvalid(() =>
      validateMutationExpression(
        {
          ...stringParameter,
          resultType: { affinity: "numeric", nullable: false },
        } as SqlExpression,
        [],
      ),
    );

    const validLower = {
      kind: "function",
      name: "lower",
      arguments: [param("text"), param("extra")],
      resultType: { affinity: "text", nullable: false },
    } as unknown as SqlExpression;
    expectInvalid(() => validateMutationExpression(validLower, []));

    const invalidLowerInput = {
      kind: "function",
      name: "lower",
      arguments: [param(1)],
      resultType: { affinity: "text", nullable: false },
    } as unknown as SqlExpression;
    expectInvalid(() => validateMutationExpression(invalidLowerInput, []));

    const invalidSumInput = {
      kind: "aggregate",
      name: "SUM",
      expression: param("text"),
      resultType: { affinity: "numeric", nullable: true },
    } as unknown as SqlExpression;
    expectInvalid(() => validateMutationExpression(invalidSumInput, []));

    const validCoalesce = {
      kind: "coalesce",
      expressions: [param("text")],
      resultType: { affinity: "text", nullable: false },
    } as unknown as SqlExpression;
    expectInvalid(() => validateMutationExpression(validCoalesce, []));

    const invalidUnixepoch = {
      kind: "unixepoch",
      resultType: { affinity: "integer", nullable: true },
    } as unknown as SqlExpression;
    expectInvalid(() => validateMutationExpression(invalidUnixepoch, []));
  });

  it("checks identifiers, field uniqueness, and expression forms", () => {
    expectInvalid(() =>
      validateProjectionFields([{ name: "same" }, { name: "same" }]),
    );
    expectInvalid(() => validateProjectionFields([{ name: "bad\0name" }]));

    const users = scan(schema.users);
    expectInvalid(() => project(users, { "": users.columns.id }));
    expectInvalid(() => project(users, {}));

    const filtered = filter(users, eq(users.columns.id, param("u-1")));
    const filteredNode = filtered.node as Extract<
      LogicalQueryNode,
      { kind: "filter" }
    >;
    const badBoolean = {
      ...filteredNode,
      predicate: {
        kind: "boolean",
        operator: "AND",
        expressions: [filteredNode.predicate],
      },
    } as unknown as LogicalQueryNode;
    expectInvalid(() => validateLogicalQueryPlan(badBoolean));

    const badFunction = {
      ...filteredNode,
      predicate: { kind: "function", name: "random", arguments: [] },
    } as unknown as LogicalQueryNode;
    expectInvalid(() => validateLogicalQueryPlan(badFunction));

    const badBinary = {
      ...filteredNode,
      predicate: {
        kind: "binary",
        operator: "||",
        left: users.columns.id,
        right: param("x"),
      },
    } as unknown as LogicalQueryNode;
    expectInvalid(() => validateLogicalQueryPlan(badBinary));
  });

  it("rejects malformed relational row shapes and aggregate outputs", () => {
    const users = scan(schema.users);
    const filtered = filter(users, eq(users.columns.id, param("u-1")));
    const filteredNode = filtered.node as Extract<
      LogicalQueryNode,
      { kind: "filter" }
    >;
    expectInvalid(() =>
      validateLogicalQueryPlan({ ...filteredNode, fields: [] }),
    );

    const selected = project(users, { email: users.columns.email });
    const selectedNode = selected.node as Extract<
      LogicalQueryNode,
      { kind: "project" }
    >;
    expectInvalid(() =>
      validateLogicalQueryPlan({
        ...selectedNode,
        projections: [{ name: "wrong", expression: users.columns.email }],
      } as LogicalQueryNode),
    );
    expectInvalid(() =>
      validateLogicalQueryPlan({
        ...selectedNode,
        fields: [{ name: "email", affinity: "numeric", nullable: false }],
      } as LogicalQueryNode),
    );

    const filteredPredicate = filter(users, eq(users.columns.id, param("u-1")))
      .node as Extract<LogicalQueryNode, { kind: "filter" }>;
    expectInvalid(() =>
      validateLogicalQueryPlan({
        ...filteredPredicate,
        predicate: {
          ...filteredPredicate.predicate,
          resultType: { affinity: "integer", nullable: false },
        },
      } as LogicalQueryNode),
    );

    const events = scan(schema.custom_events);
    const names = scan(schema.custom_event_names);
    const joined = join(
      events,
      names,
      eq(events.columns.event_name_id, names.columns.id),
    );
    expectInvalid(() =>
      validateLogicalQueryPlan({
        ...joined.node,
        fields: [],
      } as LogicalQueryNode),
    );

    const grouped = aggregate(users, {
      groupBy: { role: users.columns.system_role },
      aggregates: { count: count(users.columns.id) },
    });
    expectInvalid(() =>
      validateLogicalQueryPlan({
        ...grouped.node,
        aggregates: [{ name: "count", expression: users.columns.id }],
      } as unknown as LogicalQueryNode),
    );

    const sorted = sort(users, [
      { expression: users.columns.email, direction: "ASC" },
    ]);
    const sortedNode = sorted.node as Extract<
      LogicalQueryNode,
      { kind: "sort" }
    >;
    expectInvalid(() => validateLogicalQueryPlan({ ...sortedNode, keys: [] }));
    const limited = limit(users, 2);
    const limitedNode = limited.node as Extract<
      LogicalQueryNode,
      { kind: "limit" }
    >;
    expectInvalid(() =>
      validateLogicalQueryPlan({ ...limitedNode, count: param(-1) }),
    );

    const projected = project(users, { id: users.columns.id });
    const wrongShape = project(users, { email: users.columns.email });
    const united = union(projected, projected, true);
    const unionNode = united.node as Extract<
      LogicalQueryNode,
      { kind: "union" }
    >;
    expectInvalid(() =>
      validateLogicalQueryPlan({
        ...unionNode,
        right: wrongShape as unknown as QuerySource,
      }),
    );

    const textShape = project(users, { value: users.columns.email });
    const sites = scan(schema.sites);
    const numericShape = project(sites, { value: sites.columns.created_at });
    expect(() => union(textShape, numericShape, true)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });
});
