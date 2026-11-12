import { describe, expect, it } from "vitest";

import {
  aggregate,
  castText,
  concatText,
  constant,
  count,
  distinct,
  eq,
  filter,
  inList,
  inSubquery,
  isDistinctFrom,
  jsonScalarArray,
  limit,
  param,
  project,
  recursiveClosure,
  rowNumber,
  scan,
  sort,
  textContains,
  textLike,
  textPosition,
  textSubstring,
  trimCharacters,
  union,
  window,
} from "@/lib/db";
import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type { SqlExpression } from "@/lib/db/query/expression";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import {
  validateLogicalQueryPlan,
  validateMutationExpression,
} from "@/lib/db/query/validator";
import { schema } from "@/lib/db/schema";

function rejects(callback: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DatabaseCompilerError);
  expect((caught as Error).message).toMatch(pattern);
}

const users = scan(schema.users);
const text = { affinity: "text", nullable: false } as const;
const integer = { affinity: "integer", nullable: false } as const;

function withPatched<T>(
  target: object,
  patch: Record<string, unknown>,
  callback: () => T,
): T {
  const mutable = target as Record<string, unknown>;
  const saved = Object.fromEntries(
    Object.keys(patch).map((key) => [key, mutable[key]]),
  );
  Object.assign(mutable, patch);
  try {
    return callback();
  } finally {
    Object.assign(mutable, saved);
  }
}

function raw(value: object): SqlExpression {
  return value as unknown as SqlExpression;
}

function expression(value: object, pattern: RegExp): void {
  rejects(() => validateMutationExpression(raw(value), [users.scope]), pattern);
}

describe("validator expression diagnostics", () => {
  it("reports malformed column and binary expressions", () => {
    expression(
      { ...users.columns.id, index: -1 },
      /Invalid column index for "id"/,
    );
    expression(
      {
        kind: "binary",
        operator: "%",
        left: param(1),
        right: param(2),
        resultType: integer,
      },
      /Unsupported binary operator: %/,
    );
    expression(
      {
        kind: "binary",
        operator: "+",
        left: param("a"),
        right: param("b"),
        resultType: { affinity: "numeric", nullable: false },
      },
      /Arithmetic operands must have numeric or unknown affinity/,
    );
    expression(
      {
        kind: "binary",
        operator: "=",
        left: param("a"),
        right: param(1),
        resultType: integer,
      },
      /Comparison operands have incompatible SQL affinities/,
    );
    expression(
      {
        kind: "distinct-from",
        left: param("a"),
        right: param(1),
        resultType: integer,
      },
      /Comparison operands have incompatible SQL affinities/,
    );
    expect(() =>
      validateMutationExpression(
        isDistinctFrom(users.columns.email, param("x")),
        [users.scope],
      ),
    ).not.toThrow();
  });

  it("rejects predicate-valued SUBSTR positions", () => {
    const start = (value: object) => ({
      kind: "text-substring",
      text: param("abc"),
      start: value,
      resultType: text,
    });
    const messages = /SUBSTR\(\) start and length must be numeric expressions/;
    expression(start(eq(param(1), param(2))), messages);
    expression(start(isDistinctFrom(param(1), param(2))), messages);
    expression(start(textContains(param("a"), "b")), messages);
    expression(start(textLike(param("a"), param("b"))), messages);
    expression(start(inList(param(1), [1])), messages);
    expect(() =>
      validateMutationExpression(raw(start(constant(1))), []),
    ).not.toThrow();
  });

  it("reports malformed text expressions", () => {
    expression(
      {
        kind: "text-substring",
        text: param(1),
        start: param(1),
        resultType: text,
      },
      /SUBSTR\(\) requires a text expression/,
    );
    expression(
      {
        kind: "text-like",
        text: param(1),
        pattern: param("a"),
        resultType: integer,
      },
      /LIKE requires text expressions/,
    );
    for (const escape of ["ab", "", "\0", "\ud800", "\ud800a", "\udc00"])
      expression(
        {
          kind: "text-like",
          text: param("a"),
          pattern: param("b"),
          escape,
          resultType: integer,
        },
        /LIKE ESCAPE must be one non-NUL Unicode scalar/,
      );
    expect(() =>
      validateMutationExpression(
        textLike(param("a"), param("b"), "\u{1f600}"),
        [],
      ),
    ).not.toThrow();
    expect(() =>
      validateMutationExpression(
        raw({
          kind: "text-like",
          text: param("a"),
          pattern: param("b"),
          escape: "\ud800a",
          resultType: integer,
        }),
        [],
      ),
    ).toThrowError(/LIKE ESCAPE/);
  });

  it("reports malformed boolean, function, and concat expressions", () => {
    expression(
      {
        kind: "boolean",
        operator: "XOR",
        expressions: [],
        resultType: integer,
      },
      /Unsupported boolean operator: XOR/,
    );
    expression(
      {
        kind: "boolean",
        operator: "AND",
        expressions: [param(1)],
        resultType: integer,
      },
      /AND requires at least two predicates/,
    );
    expression(
      {
        kind: "function",
        name: "storage-class",
        arguments: [null],
        resultType: text,
      },
      /storage-class\(\) contains an invalid operand/,
    );
    expression(
      {
        kind: "function",
        name: "concat-text",
        arguments: [param("a")],
        resultType: text,
      },
      /concatText\(\) requires at least two arguments/,
    );
    expression(
      {
        kind: "function",
        name: "concat-text",
        arguments: [param("a"), null],
        resultType: text,
      },
      /concatText\(\) contains an invalid operand/,
    );
    expression(
      {
        kind: "function",
        name: "concat-text",
        arguments: [
          param("a"),
          {
            ...users.columns.id,
            resultType: { affinity: "blob", nullable: false },
          },
        ],
        resultType: text,
      },
      /concatText\(\) received an incompatible argument affinity/,
    );
    expect(() =>
      validateMutationExpression(concatText(param("a"), param(1)), []),
    ).not.toThrow();
    expression(
      {
        kind: "function",
        name: "trim-characters",
        arguments: [param("a"), null],
        resultType: text,
      },
      /trimCharacters\(\) contains an invalid operand/,
    );
    expect(() =>
      validateMutationExpression(trimCharacters(param("a"), param("b")), []),
    ).not.toThrow();
    expression(
      {
        kind: "function",
        name: "text-contains",
        arguments: [null, param("a")],
        resultType: integer,
      },
      /text-contains\(\) contains an invalid operand/,
    );
    expect(() =>
      validateMutationExpression(textContains(users.columns.email, "a"), [
        users.scope,
      ]),
    ).not.toThrow();
    rejects(
      () =>
        validateMutationExpression(
          raw({
            kind: "function",
            name: "random",
            arguments: [],
            resultType: integer,
          }),
          [],
        ),
      /Unsupported SQL function: random/,
    );
  });

  it("reports malformed aggregate, CASE, and scalar subquery expressions", () => {
    expression(
      { kind: "aggregate", name: "MEDIAN", resultType: integer },
      /Unsupported aggregate: MEDIAN/,
    );
    expression(
      {
        kind: "aggregate",
        name: "MIN",
        resultType: { affinity: "numeric", nullable: true },
      },
      /MIN\(\) requires an expression/,
    );
    expression(
      {
        kind: "aggregate",
        name: "SUM",
        resultType: { affinity: "numeric", nullable: true },
      },
      /SUM\(\) requires a numeric expression/,
    );
    expression(
      {
        kind: "case",
        branches: [{ when: null, then: null }],
        resultType: text,
      },
      /CASE contains an invalid WHEN branch/,
    );
    expression(
      {
        kind: "case",
        branches: [
          { when: eq(users.columns.id, param("u")), then: param("x") },
        ],
        else: "not-an-expression",
        resultType: { affinity: "text", nullable: true },
      },
      /CASE ELSE must be an expression/,
    );
    const two = project(users, {
      id: users.columns.id,
      email: users.columns.email,
    });
    expression(
      {
        kind: "scalar-subquery",
        query: { node: two.node, scope: two.scope, fields: two.fields },
        resultType: { affinity: "text", nullable: true },
      },
      /scalar\(\) requires a query with exactly one output field/,
    );
  });
});

describe("validator node diagnostics", () => {
  const node = (relation: { readonly node: LogicalQueryNode }) =>
    relation.node as unknown as Record<string, unknown>;
  const forged = (
    relation: { readonly node: LogicalQueryNode },
    patch: object,
  ) => ({ ...node(relation), ...patch }) as unknown as LogicalQueryNode;

  it("rejects cycles and malformed scan or JSON scalar nodes", () => {
    const filtered = filter(users, eq(users.columns.id, param("u")));
    const cyclic = { ...node(filtered) } as Record<string, unknown>;
    cyclic.input = { node: cyclic, scope: cyclic.scope, fields: cyclic.fields };
    rejects(
      () => validateLogicalQueryPlan(cyclic as unknown as LogicalQueryNode),
      /Query plan contains a cycle/,
    );

    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(users, { table: { ...schema.users, columns: null } }),
        ),
      /generated schema catalog|generated table or view reference/,
    );
    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(users, { fields: users.fields.slice(1) }),
        ),
      /Query source metadata|Scan output does not match catalog columns/,
    );
    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(users, {
            fields: users.fields.map((field, index) =>
              index === 0 ? { ...field, nullable: !field.nullable } : field,
            ),
          }),
        ),
      /Scan output metadata must match the generated catalog/,
    );

    const numbers = jsonScalarArray("numeric", [1, 2]);
    const badValues = Object.freeze([1, "two"]);
    rejects(
      () => validateLogicalQueryPlan(forged(numbers, { values: badValues })),
      /JSON scalar array contains an invalid value/,
    );
    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(numbers, { values: Object.freeze([1, Number.NaN]) }),
        ),
      /JSON scalar array contains an invalid value/,
    );
    const texts = jsonScalarArray("text", ["a"]);
    rejects(
      () =>
        validateLogicalQueryPlan(forged(texts, { values: Object.freeze([1]) })),
      /JSON scalar array contains an invalid value/,
    );
  });

  it("rejects shape drift in project, set, aggregate, distinct, sort, and limit nodes", () => {
    const selected = project(users, { email: users.columns.email });
    rejects(
      () => validateLogicalQueryPlan(forged(selected, { projections: [] })),
      /Project output does not match its projection list/,
    );
    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(selected, {
            fields: [{ name: "email", affinity: "text", nullable: true }],
          }),
        ),
      /Project output metadata must match its expression|Query source metadata/,
    );

    const grouped = aggregate(users, {
      groupBy: { role: users.columns.system_role },
      aggregates: { total: count(users.columns.id) },
    });
    rejects(
      () => validateLogicalQueryPlan(forged(grouped, { fields: [] })),
      /Aggregate output does not match its group and aggregate expressions/,
    );
    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(grouped, {
            aggregates: [{ name: "total", expression: users.columns.id }],
            fields: [
              grouped.fields[0],
              {
                name: "total",
                affinity: users.columns.id.resultType.affinity,
                nullable: users.columns.id.resultType.nullable,
              },
            ],
          }),
        ),
      /Aggregate outputs must be aggregate expressions/,
    );

    rejects(
      () => validateLogicalQueryPlan(forged(distinct(users), { fields: [] })),
      /Distinct must preserve its input row shape|Query source metadata/,
    );
    const distinctNode = node(distinct(users));
    rejects(
      () =>
        validateLogicalQueryPlan({
          ...distinctNode,
          fields: users.fields.map((field, index) =>
            index === 0 ? { ...field, name: "renamed" } : field,
          ),
        } as unknown as LogicalQueryNode),
      /Distinct must preserve its input row shape/,
    );

    const sorted = sort(users, [
      { expression: users.columns.email, direction: "ASC" },
    ]);
    rejects(
      () =>
        validateLogicalQueryPlan({
          ...node(sorted),
          fields: users.fields.map((field, index) =>
            index === 0 ? { ...field, name: "renamed" } : field,
          ),
        } as unknown as LogicalQueryNode),
      /Sort must preserve its input row shape/,
    );

    const limited = limit(users, 2, 1);
    rejects(
      () => validateLogicalQueryPlan(forged(limited, { offset: param(-1) })),
      /Limit offset must be a non-negative integer parameter/,
    );
    rejects(
      () => validateLogicalQueryPlan(forged(limited, { offset: param(1.5) })),
      /Limit offset must be a non-negative integer parameter/,
    );
    rejects(
      () =>
        validateLogicalQueryPlan({
          ...node(limited),
          fields: users.fields.map((field, index) =>
            index === 0 ? { ...field, name: "renamed" } : field,
          ),
        } as unknown as LogicalQueryNode),
      /Limit must preserve its input row shape/,
    );
  });

  it("rejects incompatible UNION shapes and metadata", () => {
    const left = project(users, { value: users.columns.email });
    const merged = union(left, left, true);
    rejects(
      () => validateLogicalQueryPlan(forged(merged, { fields: [] })),
      /UNION inputs must have compatible row shapes|Query source metadata/,
    );
    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(merged, {
            right: {
              node: project(users, { value: users.columns.id }).node,
              scope: project(users, { value: users.columns.id }).scope,
              fields: [],
            },
          }),
        ),
      /Query source metadata|UNION/,
    );
    const other = project(users, { value: users.columns.id });
    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(merged, {
            right: {
              node: other.node,
              scope: other.scope,
              fields: other.fields,
            },
          }),
        ),
      /UNION output metadata is not compatible with its inputs/,
    );
  });

  it("rejects malformed window specifications", () => {
    const ranked = window(users, {
      rank: rowNumber({
        orderBy: [{ expression: users.columns.email, direction: "ASC" }],
      }),
    });
    const windowNode = node(ranked) as unknown as {
      windows: Array<{ name: string; specification: Record<string, unknown> }>;
    };
    const item = windowNode.windows[0]!;
    const withWindows = (windows: unknown) =>
      validateLogicalQueryPlan(forged(ranked, { windows }));
    rejects(
      () => withWindows([]),
      /Window requires at least one window output/,
    );
    rejects(() => withWindows([null]), /Window output descriptor is invalid/);
    rejects(
      () => withWindows([{ ...item, name: 1 }]),
      /Window output name must be a string/,
    );
    rejects(
      () => withWindows([item, { ...item }]),
      /Window output collides with an existing field: rank/,
    );
    rejects(
      () => withWindows([{ ...item, name: "id" }]),
      /Window output collides with an existing field: id/,
    );
    rejects(
      () => withWindows([{ ...item, specification: { kind: "ntile" } }]),
      /Window contains an unsupported specification/,
    );
    rejects(
      () =>
        withWindows([
          { ...item, specification: { ...item.specification, frame: "rows" } },
        ]),
      /row-number specification contains unsupported options/,
    );
    rejects(
      () =>
        withWindows([
          {
            ...item,
            specification: { kind: "count-rows", partitionBy: [], extra: 1 },
          },
        ]),
      /count-rows specification contains unsupported options/,
    );
    rejects(
      () =>
        withWindows([
          { ...item, specification: { kind: "count-rows", partitionBy: "x" } },
        ]),
      /count-rows partition keys must be an array/,
    );
    rejects(
      () =>
        withWindows([
          { ...item, specification: { ...item.specification, orderBy: [] } },
        ]),
      /row-number requires at least one ordering key/,
    );
    rejects(
      () =>
        withWindows([
          {
            ...item,
            specification: { ...item.specification, partitionBy: [null] },
          },
        ]),
      /window contains an invalid partition expression/,
    );
    const key = { expression: users.columns.email, direction: "ASC" };
    rejects(
      () =>
        withWindows([
          {
            ...item,
            specification: { ...item.specification, orderBy: [null] },
          },
        ]),
      /row-number ordering direction is invalid/,
    );
    rejects(
      () =>
        withWindows([
          {
            ...item,
            specification: {
              ...item.specification,
              orderBy: [{ ...key, direction: "UP" }],
            },
          },
        ]),
      /row-number ordering direction is invalid/,
    );
    rejects(
      () =>
        withWindows([
          {
            ...item,
            specification: {
              ...item.specification,
              orderBy: [{ ...key, expression: null }],
            },
          },
        ]),
      /row-number contains an invalid ordering expression/,
    );
    rejects(
      () =>
        validateLogicalQueryPlan(
          forged(ranked, {
            fields: ranked.fields.map((field) =>
              field.name === "rank" ? { ...field, nullable: true } : field,
            ),
          }),
        ),
      /Window output must append non-null integer rank fields/,
    );
  });
});

describe("validator recursive closure diagnostics", () => {
  const identities = scan(schema.site_identities);
  const edge = (site: string, node: number, parent: number | null) =>
    project(filter(identities, eq(identities.columns.site_id, param(site))), {
      namespace: param("ns"),
      nodeId: param(node),
      parentNodeId: param<number | null>(parent),
    });
  const seed = edge("seed", 1, 2);
  const candidates = edge("candidates", 2, null);
  const closure = (
    left: ReturnType<typeof edge>,
    right: ReturnType<typeof edge>,
  ) =>
    recursiveClosure(left, right, (current, candidate) =>
      eq(current.parentNodeId, candidate.nodeId),
    );
  const valid = closure(seed, candidates);

  it("rejects closures nested inside any expression form of a seed", () => {
    const outerBase = filter(seed, eq(seed.columns.nodeId, param(1)));
    const outer = closure(
      outerBase as unknown as ReturnType<typeof edge>,
      candidates,
    );
    const nestedQuery = {
      kind: "in-subquery",
      expression: param(1),
      query: { node: valid.node, scope: valid.scope, fields: valid.fields },
      resultType: integer,
    };
    const harmless = param("a");
    const wrappers: object[] = [
      { kind: "cast-text", expression: nestedQuery, resultType: text },
      {
        kind: "text-position",
        text: harmless,
        needle: nestedQuery,
        resultType: integer,
      },
      {
        kind: "text-substring",
        text: harmless,
        start: harmless,
        length: nestedQuery,
        resultType: text,
      },
      {
        kind: "text-substring",
        text: nestedQuery,
        start: harmless,
        resultType: text,
      },
      {
        kind: "text-like",
        text: harmless,
        pattern: nestedQuery,
        resultType: integer,
      },
      { kind: "in-list", expression: nestedQuery, resultType: integer },
    ];
    const outerNode = outer.node as unknown as {
      seed: { scope: unknown; fields: unknown };
    };
    for (const wrapper of wrappers) {
      const poisonedSeed = {
        node: { ...outerBase.node, predicate: wrapper },
        scope: outerNode.seed.scope,
        fields: outerNode.seed.fields,
      };
      rejects(
        () =>
          withPatched(outer.node, { seed: poisonedSeed }, () =>
            validateLogicalQueryPlan(outer.node),
          ),
        /Nested recursive closures are not supported/,
      );
    }

    const grouped = aggregate(outerBase, {
      groupBy: { nodeId: outerBase.columns.nodeId },
      aggregates: {},
    } as never);
    const poisonedAggregate = {
      node: {
        ...grouped.node,
        groups: [{ name: "nodeId", expression: nestedQuery }],
        scope: outerNode.seed.scope,
        fields: outerNode.seed.fields,
      },
      scope: outerNode.seed.scope,
      fields: outerNode.seed.fields,
    };
    rejects(
      () =>
        withPatched(outer.node, { seed: poisonedAggregate }, () =>
          validateLogicalQueryPlan(outer.node),
        ),
      /Nested recursive closures are not supported/,
    );
  });

  it("rejects mismatched or incompatible closure input fields", () => {
    const closureNode = valid.node as unknown as {
      seed: { node: object; scope: unknown; fields: unknown };
    };
    const renamed = project(
      filter(identities, eq(identities.columns.site_id, param("r"))),
      {
        namespace: param("ns"),
        node: param(2),
        parentNodeId: param<number | null>(null),
      },
    );
    rejects(
      () =>
        withPatched(
          valid.node,
          {
            candidates: {
              node: renamed.node,
              scope: renamed.scope,
              fields: renamed.fields,
            },
          },
          () => validateLogicalQueryPlan(valid.node),
        ),
      /Recursive closure input fields must match in order and name/,
    );
    const retyped = project(
      filter(identities, eq(identities.columns.site_id, param("t"))),
      {
        namespace: param(5),
        nodeId: param(2),
        parentNodeId: param<number | null>(null),
      },
    );
    rejects(
      () =>
        withPatched(
          valid.node,
          {
            candidates: {
              node: retyped.node,
              scope: retyped.scope,
              fields: retyped.fields,
            },
          },
          () => validateLogicalQueryPlan(valid.node),
        ),
      /Recursive closure input fields have incompatible affinities/,
    );
    expect(closureNode.seed.node).toBeDefined();
  });

  it("keeps cast and text builders usable for unrelated plans", () => {
    expect(() =>
      validateLogicalQueryPlan(
        project(users, {
          a: castText(users.columns.id),
          b: textPosition(users.columns.email, param("@")),
          c: textSubstring(users.columns.email, constant(1), constant(2)),
          d: inList(users.columns.id, ["x"]),
          e: inSubquery(
            users.columns.id,
            project(users, { id: users.columns.id }),
          ),
        }),
      ),
    ).not.toThrow();
  });
});
