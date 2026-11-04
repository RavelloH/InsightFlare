import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  and,
  antiJoin,
  avg,
  callFunction,
  caseWhen,
  castInteger,
  castReal,
  coalesce,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  gt,
  isNotNull,
  join,
  limit,
  max,
  or,
  project,
  recursiveClosure,
  rowNumber,
  scalar,
  scan,
  semiJoin,
  sort,
  sum,
  union,
  unixepoch,
  window,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import { completeKeyedLookupReuseCandidates } from "@/lib/db/query/complete-keyed-lookup-reuse";
import type {
  AnyExpression,
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { QuerySource, Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;

function numericExpression(
  expression: AnyExpression,
): SqlExpression<number | null, ExpressionResultType<"numeric", true>> {
  return expression as SqlExpression<
    number | null,
    ExpressionResultType<"numeric", true>
  >;
}

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function database(): DatabaseSync {
  const result = createMigratedDatabase();
  databases.add(result);
  return result;
}

function runAll(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Record<string, unknown>[] {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
}

function normalizeRows(rows: readonly Record<string, unknown>[]) {
  return rows
    .map((row) => JSON.stringify(row))
    .sort()
    .map((row) => JSON.parse(row!) as Record<string, unknown>);
}

interface QueryOptions {
  readonly outerLimit?: number;
  readonly outerOffset?: number;
  readonly controlBarrier?:
    | "filter"
    | "limit"
    | "singleton-cross-join"
    | "many-row-cross-join"
    | "false-singleton-cross-join"
    | "left-singleton-cross-join"
    | "filtered-singleton-cross-join"
    | "limited-singleton-cross-join"
    | "volatile-singleton-cross-join";
  readonly candidateBarrier?:
    "sort" | "limit" | "offset" | "window" | "volatile" | "subquery";
  readonly joinShape?:
    | "complete"
    | "partial"
    | "or"
    | "residual"
    | "inner"
    | "driver"
    | "extra-consumer"
    | "wrong-consumer";
  readonly aggregateShape?:
    | "normal"
    | "no-groups"
    | "wide"
    | "float-sum"
    | "avg"
    | "root-control-sum"
    | "coalesced-control-sum"
    | "coalesced-nonnullable-control-sum";
  readonly rootShape?:
    | "filter"
    | "limit"
    | "sort"
    | "window"
    | "project"
    | "aggregate"
    | "control-aggregate-empty-cross-join"
    | "control-aggregate-multirow-cross-join"
    | "distinct-union";
  readonly membershipShape?:
    | "both"
    | "empty-semi"
    | "null-semi"
    | "null-anti"
    | "abs-left"
    | "abs-right"
    | "abs-predicate"
    | "abs-case";
}

interface BuiltQuery {
  readonly root: AnyRelation;
  readonly candidate: AnyRelation;
  readonly database: DatabaseSync;
}

function allRows(relations: readonly AnyRelation[]): AnyRelation {
  if (relations.length === 0)
    throw new Error("A recursive test relation needs at least one source");
  return relations
    .slice(1)
    .reduce((result, relation) => union(result, relation, true), relations[0]!);
}

function relationNodes(root: AnyRelation["node"]): AnyRelation["node"][] {
  const nodes: AnyRelation["node"][] = [];
  const visited = new Set<object>();
  const visit = (node: AnyRelation["node"]): void => {
    if (visited.has(node)) return;
    visited.add(node);
    nodes.push(node);
    const current = node as unknown as Record<string, unknown>;
    for (const key of ["input", "left", "right", "seed", "candidates"]) {
      const child = current[key];
      if (child && typeof child === "object" && "node" in child)
        visit((child as { readonly node: AnyRelation["node"] }).node);
    }
  };
  visit(root);
  return nodes;
}

function expectSharedDependenciesAcyclic(
  definitions: readonly {
    readonly name: string;
    readonly dependencies: readonly string[];
  }[],
): void {
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (active.has(name)) throw new Error(`shared_relation_cycle:${name}`);
    if (visited.has(name)) return;
    const definition = byName.get(name);
    if (!definition)
      throw new Error(`shared_relation_dependency_missing:${name}`);
    active.add(name);
    for (const dependency of definition.dependencies) visit(dependency);
    active.delete(name);
    visited.add(name);
  };
  for (const definition of definitions) visit(definition.name);
}

function typedTextNull() {
  return caseWhen(
    [{ when: eq(constant(1), constant(0)), then: constant("unused") }],
    constant(null),
  );
}

function typedNumericNull() {
  return caseWhen(
    [{ when: eq(constant(1), constant(0)), then: constant(0) }],
    constant(null),
  );
}

function forgedEquality(left: AnyExpression, right: AnyExpression): Predicate {
  return {
    kind: "binary",
    operator: "=",
    left,
    right,
    resultType: { affinity: "integer", nullable: true },
  } as unknown as Predicate;
}

function buildQuery(options: QueryOptions = {}): BuiltQuery {
  const db = database();
  const nodeIds = [
    "alpha-1",
    "alpha-2",
    "alpha-3",
    "alpha-4",
    "beta-1",
    "beta-2",
    "null-1",
    "null-2",
    "missing-1",
    ...(options.membershipShape?.startsWith("abs-") ? ["abs-probe"] : []),
  ];
  const insertIdentity = db.prepare(
    "INSERT INTO site_identities (site_id) VALUES (?)",
  );
  for (const id of nodeIds) insertIdentity.run(id);
  const primaryKeys = new Map(
    (
      db.prepare("SELECT site_id, site_pk FROM site_identities").all() as {
        site_id: string;
        site_pk: number;
      }[]
    ).map(({ site_id, site_pk }) => [site_id, site_pk]),
  );
  const pk = (id: string) => {
    const value = primaryKeys.get(id);
    if (value === undefined) throw new Error(`Missing fixture identity ${id}`);
    return value;
  };
  if (options.membershipShape?.startsWith("abs-"))
    db.prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, site_pk
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, '/', 'abs.example.test', ?)`,
    ).run(
      "abs-probe-visit",
      "abs-probe",
      "abs-probe-visitor",
      "abs-probe-session",
      -9_223_372_036_854_775_808n,
      -9_223_372_036_854_775_808n,
      pk("abs-probe"),
    );
  const edge = (
    sourceId: string,
    namespace: string | null,
    parentId: string | null,
  ): AnyRelation => {
    const identities = scan(schema.site_identities);
    const selected = filter(
      identities,
      eq(identities.columns.site_id, constant(sourceId)),
    );
    return project(selected, {
      namespace: namespace === null ? typedTextNull() : constant(namespace),
      nodeId: selected.columns.site_pk,
      parentNodeId:
        parentId === null ? typedNumericNull() : constant(pk(parentId)),
    }) as AnyRelation;
  };

  const seedBase = allRows([
    edge("alpha-1", "alpha", "alpha-2"),
    edge("alpha-1", "alpha", "alpha-2"),
    edge("beta-1", "beta", "beta-2"),
    edge("null-1", null, "null-2"),
  ]);
  const candidateBase = allRows([
    edge("alpha-1", "alpha", "alpha-2"),
    edge("alpha-2", "alpha", "alpha-3"),
    edge("alpha-2", "alpha", "alpha-4"),
    edge("alpha-3", "alpha", "alpha-4"),
    edge("alpha-4", "alpha", "alpha-1"),
    edge("beta-1", "beta", "beta-2"),
    edge("beta-2", "beta", null),
    edge("null-1", null, "null-2"),
    edge("null-2", null, null),
  ]);
  const addCandidateBarrier = (input: AnyRelation): AnyRelation => {
    if (options.candidateBarrier === "sort")
      return sort(input, [
        { expression: input.columns.nodeId!, direction: "ASC" },
      ]) as AnyRelation;
    if (options.candidateBarrier === "limit")
      return limit(input, 100) as AnyRelation;
    if (options.candidateBarrier === "offset")
      return limit(input, 100, 1) as AnyRelation;
    if (options.candidateBarrier === "window")
      return window(input, {
        rank: rowNumber({
          orderBy: [{ expression: input.columns.nodeId!, direction: "ASC" }],
        }),
      }) as AnyRelation;
    if (options.candidateBarrier === "volatile")
      return project(input, {
        namespace: input.columns.namespace!,
        nodeId: input.columns.nodeId!,
        parentNodeId: input.columns.parentNodeId!,
        sampledAt: unixepoch(),
      }) as AnyRelation;
    if (options.candidateBarrier === "subquery") {
      const scalarInput = aggregate(scan(schema.site_identities), {
        groupBy: {},
        aggregates: { identityCount: count() },
      });
      return filter(
        input,
        eq(input.columns.nodeId!, scalar(scalarInput) as AnyExpression),
      ) as AnyRelation;
    }
    return input;
  };
  let seedEdges = addCandidateBarrier(seedBase);
  let candidateEdges = addCandidateBarrier(candidateBase);
  const namespaceRows = (
    siteId: string,
    namespace: string | null,
  ): AnyRelation => {
    const identities = scan(schema.site_identities);
    const selected = filter(
      identities,
      eq(identities.columns.site_id, constant(siteId)),
    );
    return project(selected, {
      namespace: namespace === null ? typedTextNull() : constant(namespace),
    }) as AnyRelation;
  };
  const duplicateRows = (input: AnyRelation): AnyRelation =>
    allRows([input, input]);

  if (options.membershipShape === "both") {
    const allowed = duplicateRows(namespaceRows("alpha-1", "alpha"));
    seedEdges = semiJoin(
      seedEdges,
      allowed,
      eq(seedEdges.columns.namespace!, allowed.columns.namespace!),
    ) as AnyRelation;
    const denied = duplicateRows(namespaceRows("beta-1", "beta"));
    candidateEdges = antiJoin(
      candidateEdges,
      denied,
      eq(candidateEdges.columns.namespace!, denied.columns.namespace!),
    ) as AnyRelation;
  } else if (options.membershipShape === "empty-semi") {
    const empty = namespaceRows("not-present-site", "alpha");
    seedEdges = semiJoin(
      seedEdges,
      empty,
      eq(seedEdges.columns.namespace!, empty.columns.namespace!),
    ) as AnyRelation;
  } else if (options.membershipShape === "null-semi") {
    const nullKeys = namespaceRows("alpha-1", null);
    seedEdges = semiJoin(
      seedEdges,
      nullKeys,
      eq(seedEdges.columns.namespace!, nullKeys.columns.namespace!),
    ) as AnyRelation;
  } else if (options.membershipShape === "null-anti") {
    const nullKeys = namespaceRows("alpha-1", null);
    candidateEdges = antiJoin(
      candidateEdges,
      nullKeys,
      eq(candidateEdges.columns.namespace!, nullKeys.columns.namespace!),
    ) as AnyRelation;
  } else if (options.membershipShape?.startsWith("abs-")) {
    const visits = scan(schema.visits);
    const selectedVisit = filter(
      visits,
      eq(visits.columns.site_id, constant("abs-probe")),
    );
    const absValue = callFunction("abs", selectedVisit.columns.started_at);
    const absCase = caseWhen(
      [{ when: eq(constant(1), constant(1)), then: absValue }],
      constant(0),
    );
    if (options.membershipShape === "abs-left") {
      const absVisit = project(selectedVisit, { probe: absValue });
      const leftWithProbeJoin = join(
        seedEdges,
        absVisit,
        eq(constant(1), constant(1)),
      );
      const leftWithProbe = project(leftWithProbeJoin, {
        namespace: leftWithProbeJoin.columns.left_namespace!,
        nodeId: leftWithProbeJoin.columns.left_nodeId!,
        parentNodeId: leftWithProbeJoin.columns.left_parentNodeId!,
        probe: leftWithProbeJoin.columns.right_probe!,
      }) as AnyRelation;
      const allowed = duplicateRows(namespaceRows("alpha-1", "alpha"));
      const matched = semiJoin(
        leftWithProbe,
        allowed,
        and(
          eq(leftWithProbe.columns.namespace!, allowed.columns.namespace!),
          gt(numericExpression(leftWithProbe.columns.probe!), constant(0)),
        ),
      ) as AnyRelation;
      seedEdges = project(matched, {
        namespace: matched.columns.namespace!,
        nodeId: matched.columns.nodeId!,
        parentNodeId: matched.columns.parentNodeId!,
      }) as AnyRelation;
    } else {
      const right = project(selectedVisit, {
        namespace: constant("alpha"),
        rawProbe: selectedVisit.columns.started_at,
        probe:
          options.membershipShape === "abs-right"
            ? absValue
            : options.membershipShape === "abs-case"
              ? absCase
              : selectedVisit.columns.started_at,
      }) as AnyRelation;
      const members = duplicateRows(right as AnyRelation);
      const probe =
        options.membershipShape === "abs-predicate"
          ? callFunction("abs", numericExpression(members.columns.rawProbe!))
          : members.columns.probe!;
      seedEdges = semiJoin(
        seedEdges,
        members,
        and(
          eq(seedEdges.columns.namespace!, members.columns.namespace!),
          gt(numericExpression(probe), constant(0)),
        ),
      ) as AnyRelation;
    }
  }

  const closure = recursiveClosure(seedEdges, candidateEdges, (current, row) =>
    and(
      eq(current.namespace, row.namespace),
      eq(current.parentNodeId, row.nodeId),
    ),
  );
  const groupBy: Record<string, AnyExpression> =
    options.aggregateShape === "no-groups"
      ? {}
      : {
          namespace: closure.columns.namespace,
          nodeId: closure.columns.nodeId,
        };
  if (options.aggregateShape === "wide") {
    for (let index = 0; index < 14; index += 1)
      groupBy[`extra${index}`] =
        index % 2 === 0 ? closure.columns.namespace : closure.columns.nodeId;
  }
  const hasNestedControlSum =
    options.aggregateShape === "normal" ||
    options.aggregateShape === "wide" ||
    options.aggregateShape === "coalesced-control-sum" ||
    options.aggregateShape === "coalesced-nonnullable-control-sum";
  const hasCoalescedControlSum =
    options.aggregateShape === "coalesced-control-sum" ||
    options.aggregateShape === "coalesced-nonnullable-control-sum";
  const nullableControlCase =
    options.aggregateShape === "coalesced-control-sum";
  const aggregateInput = hasNestedControlSum
    ? (aggregate(closure, {
        groupBy,
        aggregates: {
          controlFlags: sum(
            hasCoalescedControlSum
              ? coalesce(
                  castInteger(
                    caseWhen(
                      [
                        {
                          when: eq(
                            numericExpression(closure.columns.nodeId),
                            constant(-1),
                          ),
                          then: constant(1),
                        },
                      ],
                      nullableControlCase ? undefined : constant(0),
                    ),
                  ),
                  constant(0),
                )
              : caseWhen(
                  [
                    {
                      when: gt(
                        numericExpression(closure.columns.nodeId),
                        constant(0),
                      ),
                      then: constant(1),
                    },
                  ],
                  constant(0),
                ),
          ),
        },
      }) as AnyRelation)
    : closure;
  const candidateGroupBy: Record<string, AnyExpression> = hasNestedControlSum
    ? Object.fromEntries(
        Object.keys(groupBy).map((name) => [
          name,
          (aggregateInput.columns as Record<string, AnyExpression>)[name]!,
        ]),
      )
    : groupBy;
  const aggregates: Record<string, AnyExpression> = {
    rowCount: hasNestedControlSum
      ? max(aggregateInput.columns.controlFlags!)
      : count(),
  };
  if (options.aggregateShape === "float-sum")
    aggregates.floatTotal = sum(
      castReal(numericExpression(aggregateInput.columns.nodeId)),
    );
  else if (options.aggregateShape === "avg")
    aggregates.average = avg(
      castReal(numericExpression(aggregateInput.columns.nodeId)),
    );
  else if (options.aggregateShape === "root-control-sum")
    aggregates.controlFlags = sum(
      caseWhen(
        [
          {
            when: gt(
              numericExpression(aggregateInput.columns.nodeId!),
              constant(0),
            ),
            then: constant(1),
          },
        ],
        constant(0),
      ),
    );
  const candidate = aggregate(aggregateInput, {
    groupBy: candidateGroupBy,
    aggregates,
  }) as AnyRelation;
  const candidateColumns = candidate.columns as Record<string, AnyExpression>;
  const groupNames = Object.keys(groupBy);

  const controlColumns: Record<string, AnyExpression> = {};
  for (const name of Object.keys(candidateColumns))
    controlColumns[name] = candidateColumns[name]!;
  let controlInput = project(candidate, controlColumns) as AnyRelation;
  if (options.controlBarrier === "filter")
    controlInput = filter(
      controlInput,
      gt(numericExpression(controlInput.columns.rowCount!), constant(-1)),
    ) as AnyRelation;
  else if (options.controlBarrier === "limit")
    controlInput = limit(controlInput, 1) as AnyRelation;
  else if (options.controlBarrier === "singleton-cross-join") {
    const identities = scan(schema.site_identities);
    const emptyGateInput = filter(
      identities,
      eq(identities.columns.site_id, constant("missing-scalar-gate")),
    );
    const scalarGate = aggregate(emptyGateInput, {
      groupBy: {},
      aggregates: { identityCount: count() },
    });
    controlInput = join(
      controlInput,
      scalarGate,
      eq(constant(1), constant(1)),
    ) as AnyRelation;
  } else if (
    options.controlBarrier === "many-row-cross-join" ||
    options.controlBarrier === "false-singleton-cross-join" ||
    options.controlBarrier === "left-singleton-cross-join" ||
    options.controlBarrier === "filtered-singleton-cross-join" ||
    options.controlBarrier === "limited-singleton-cross-join" ||
    options.controlBarrier === "volatile-singleton-cross-join"
  ) {
    const identities = scan(schema.site_identities);
    const scalarGate = aggregate(identities, {
      groupBy: {},
      aggregates: { identityCount: count() },
    });
    let right: AnyRelation = scalarGate as AnyRelation;
    let condition = eq(constant(1), constant(1));
    let joinType: "inner" | "left" = "inner";
    if (options.controlBarrier === "many-row-cross-join")
      right = identities as AnyRelation;
    else if (options.controlBarrier === "false-singleton-cross-join")
      condition = eq(constant(1), constant(0));
    else if (options.controlBarrier === "left-singleton-cross-join")
      joinType = "left";
    else if (options.controlBarrier === "filtered-singleton-cross-join")
      right = filter(
        scalarGate,
        gt(scalarGate.columns.identityCount, constant(0)),
      ) as AnyRelation;
    else if (options.controlBarrier === "limited-singleton-cross-join")
      right = limit(scalarGate, 1) as AnyRelation;
    else
      right = project(scalarGate, {
        identityCount: scalarGate.columns.identityCount,
        sampledAt: unixepoch(),
      }) as AnyRelation;
    controlInput = join(
      controlInput,
      right,
      condition,
      joinType,
    ) as AnyRelation;
  }
  const controlSummary = aggregate(controlInput, {
    groupBy: {},
    aggregates: { groupCount: count() },
  });
  let controlOutputInput = controlSummary as AnyRelation;
  if (
    options.rootShape === "control-aggregate-empty-cross-join" ||
    options.rootShape === "control-aggregate-multirow-cross-join"
  ) {
    const identities = scan(schema.site_identities);
    const opposite =
      options.rootShape === "control-aggregate-empty-cross-join"
        ? filter(
            identities,
            eq(identities.columns.site_id, constant("missing-control-side")),
          )
        : identities;
    controlOutputInput = join(
      controlOutputInput,
      opposite,
      eq(constant(1), constant(1)),
    ) as AnyRelation;
  }
  const controlCount =
    options.rootShape === "control-aggregate-empty-cross-join" ||
    options.rootShape === "control-aggregate-multirow-cross-join"
      ? controlOutputInput.columns.left_groupCount!
      : controlSummary.columns.groupCount;
  const controlOutput = project(controlOutputInput, {
    kind: constant("control"),
    namespace: typedTextNull(),
    nodeId: typedNumericNull(),
    value: controlCount,
  }) as AnyRelation;

  const leftRows = [
    ["alpha-1", "alpha"],
    ["alpha-1", "alpha"],
    ["beta-1", "beta"],
    ["missing-1", "alpha"],
    ["null-1", null],
  ].map(([id, namespace]) => {
    const identities = scan(schema.site_identities);
    const selected = filter(
      identities,
      eq(identities.columns.site_id, constant(id!)),
    );
    return project(selected, {
      namespace: namespace === null ? typedTextNull() : constant(namespace),
      nodeId: selected.columns.site_pk,
      leftId: selected.columns.site_id,
    }) as AnyRelation;
  });
  const left = allRows(leftRows);
  const predicates: AnyExpression[] = [];
  if (options.aggregateShape === "no-groups") {
    predicates.push(eq(left.columns.nodeId!, candidateColumns.rowCount!));
  } else {
    for (let index = 0; index < groupNames.length; index += 1) {
      const candidateKey = candidateColumns[groupNames[index]!]!;
      const leftKey =
        index % 2 === 0 ? left.columns.namespace! : left.columns.nodeId!;
      predicates.push(eq(leftKey, candidateKey));
    }
    if (options.joinShape === "partial") predicates.splice(1);
    if (options.joinShape === "or" && predicates.length > 1)
      predicates.splice(0, predicates.length, predicates[0]!, predicates[1]!);
  }
  let joinCondition =
    predicates.length > 1
      ? and(
          predicates[0]! as Predicate,
          ...(predicates.slice(1) as Predicate[]),
        )
      : (predicates[0] ?? eq(constant(1), constant(1)));
  if (options.joinShape === "or" && predicates.length > 1)
    joinCondition = or(predicates[0] as never, predicates[1] as never);
  if (options.joinShape === "residual" && groupNames.length > 1)
    joinCondition = and(
      joinCondition as never,
      gt(numericExpression(left.columns.nodeId!), constant(0)),
    );
  const lookupType = options.joinShape === "inner" ? "inner" : "left";
  const lookupJoin =
    options.joinShape === "driver"
      ? join(
          candidate,
          left,
          eq(
            candidateColumns[groupNames[0] ?? "rowCount"]!,
            left.columns.namespace!,
          ),
          "left",
        )
      : join(left, candidate, joinCondition as never, lookupType);
  let lookupRows = lookupJoin as AnyRelation;
  if (options.outerLimit !== undefined)
    lookupRows = limit(
      lookupRows,
      options.outerLimit,
      options.outerOffset,
    ) as AnyRelation;
  const lookupColumns = lookupRows.columns as Record<string, AnyExpression>;
  const lookupOutput = project(lookupRows, {
    kind: constant("lookup"),
    namespace:
      options.joinShape === "driver"
        ? lookupColumns.right_namespace!
        : lookupColumns.left_namespace!,
    nodeId:
      options.joinShape === "driver"
        ? lookupColumns.right_nodeId!
        : lookupColumns.left_nodeId!,
    value:
      options.joinShape === "driver"
        ? lookupColumns.left_rowCount!
        : lookupColumns.right_rowCount!,
  }) as AnyRelation;

  let root = union(
    controlOutput,
    lookupOutput,
    options.rootShape !== "distinct-union",
  ) as AnyRelation;
  if (options.joinShape === "extra-consumer") {
    const secondJoin = join(left, candidate, joinCondition as never, "left");
    const secondOutput = project(secondJoin, {
      kind: constant("second"),
      namespace: secondJoin.columns.left_namespace,
      nodeId: secondJoin.columns.left_nodeId,
      value: secondJoin.columns.right_rowCount,
    }) as AnyRelation;
    root = union(root, secondOutput, true) as AnyRelation;
  } else if (options.joinShape === "wrong-consumer") {
    const selectedCandidate = filter(
      candidate,
      isNotNull(candidateColumns[groupNames[0] ?? "rowCount"]!),
    );
    const wrongOutput = project(selectedCandidate, {
      kind: constant("filtered"),
      namespace: selectedCandidate.columns[groupNames[0] ?? "rowCount"]!,
      nodeId: typedNumericNull(),
      value: selectedCandidate.columns.rowCount!,
    }) as AnyRelation;
    root = union(root, wrongOutput, true) as AnyRelation;
  }
  const rootColumns = root.columns as Record<string, AnyExpression>;
  if (options.rootShape === "filter")
    root = filter(
      root,
      gt(numericExpression(rootColumns.value!), constant(-1)),
    ) as AnyRelation;
  else if (options.rootShape === "limit")
    root = limit(root, 100) as AnyRelation;
  else if (options.rootShape === "sort")
    root = sort(root, [
      { expression: rootColumns.value!, direction: "ASC" },
    ]) as AnyRelation;
  else if (options.rootShape === "window")
    root = window(root, {
      rank: rowNumber({
        orderBy: [{ expression: rootColumns.value!, direction: "ASC" }],
      }),
    }) as AnyRelation;
  else if (options.rootShape === "project")
    root = project(root, rootColumns) as AnyRelation;
  else if (options.rootShape === "aggregate")
    root = aggregate(root, {
      groupBy: {},
      aggregates: { rowCount: count() },
    }) as AnyRelation;
  return { root, candidate, database: db };
}

describe("complete keyed lookup reuse", () => {
  it("reuses a closed complete fact across duplicate-safe semi/anti membership", () => {
    const {
      root,
      candidate,
      database: db,
    } = buildQuery({
      outerLimit: 20_001,
      membershipShape: "both",
    });
    const physical = lowerLogicalPlan(root);
    const candidateDefinition = physical.sharedRelations.find(
      ({ node }) => node === candidate.node,
    );
    expect(candidateDefinition?.materialization).toBe("materialized");
    expect(candidateDefinition?.fields).toHaveLength(3);
    expectSharedDependenciesAcyclic(physical.sharedRelations);

    const optimized = compileD1Query(physical);
    const unoptimized = compileD1QueryUnoptimizedForTest(root);
    const optimizedRows = runAll(db, optimized);
    expect(normalizeRows(optimizedRows)).toEqual(
      normalizeRows(runAll(db, unoptimized)),
    );
    const lookupRows = optimizedRows.filter(({ kind }) => kind === "lookup");
    const alphaPrimaryKey = db
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("alpha-1") as { readonly site_pk: number };
    expect(
      lookupRows.filter(
        ({ namespace, nodeId }) =>
          namespace === "alpha" && nodeId === alphaPrimaryKey.site_pk,
      ),
    ).toHaveLength(2);
    expect(
      lookupRows
        .filter(({ namespace }) => namespace === "beta")
        .every(({ value }) => value === null),
    ).toBe(true);
  });

  it.each(["empty-semi", "null-semi", "null-anti"] as const)(
    "preserves EXISTS/NOT EXISTS bag semantics with %s",
    (membershipShape) => {
      const {
        root,
        candidate,
        database: db,
      } = buildQuery({
        outerLimit: 20_001,
        membershipShape,
      });
      const physical = lowerLogicalPlan(root);
      expect(
        physical.sharedRelations.some(({ node }) => node === candidate.node),
      ).toBe(true);
      const optimized = compileD1Query(physical);
      const unoptimized = compileD1QueryUnoptimizedForTest(root);
      expect(normalizeRows(runAll(db, optimized))).toEqual(
        normalizeRows(runAll(db, unoptimized)),
      );
    },
  );

  it("preserves semi/anti left bags with duplicate, NULL, empty, and unmatched keys", () => {
    const db = database();
    const ids = [
      "bag-left-alpha",
      "bag-left-null",
      "bag-left-beta",
      "bag-right-alpha-1",
      "bag-right-alpha-2",
      "bag-right-null",
    ];
    const insert = db.prepare(
      "INSERT INTO site_identities (site_id) VALUES (?)",
    );
    for (const id of ids) insert.run(id);
    const keyedIdentity = (siteId: string, key: string | null): AnyRelation => {
      const identities = scan(schema.site_identities);
      const selected = filter(
        identities,
        eq(identities.columns.site_id, constant(siteId)),
      );
      return project(selected, {
        key: key === null ? typedTextNull() : constant(key),
        id: selected.columns.site_id,
      }) as AnyRelation;
    };
    const leftAlpha = keyedIdentity("bag-left-alpha", "alpha");
    const left = allRows([
      leftAlpha,
      leftAlpha,
      keyedIdentity("bag-left-null", null),
      keyedIdentity("bag-left-beta", "beta"),
    ]);
    const rightAlpha = allRows([
      keyedIdentity("bag-right-alpha-1", "alpha"),
      keyedIdentity("bag-right-alpha-2", "alpha"),
    ]);
    const rightWithNull = allRows([
      rightAlpha,
      keyedIdentity("bag-right-null", null),
    ]);
    const emptyRight = keyedIdentity("bag-no-such-right", "alpha");
    const semi = semiJoin(
      left,
      rightWithNull,
      eq(left.columns.key!, rightWithNull.columns.key!),
    ) as AnyRelation;
    const anti = antiJoin(
      left,
      rightWithNull,
      eq(left.columns.key!, rightWithNull.columns.key!),
    ) as AnyRelation;
    const emptySemi = semiJoin(
      left,
      emptyRight,
      eq(left.columns.key!, emptyRight.columns.key!),
    ) as AnyRelation;
    const emptyAnti = antiJoin(
      left,
      emptyRight,
      eq(left.columns.key!, emptyRight.columns.key!),
    ) as AnyRelation;
    const rows = (relation: AnyRelation) =>
      normalizeRows(runAll(db, compileD1Query(lowerLogicalPlan(relation))));

    expect(rows(semi)).toEqual(
      normalizeRows([
        { key: "alpha", id: "bag-left-alpha" },
        { key: "alpha", id: "bag-left-alpha" },
      ]),
    );
    expect(rows(anti)).toEqual(
      normalizeRows([
        { key: null, id: "bag-left-null" },
        { key: "beta", id: "bag-left-beta" },
      ]),
    );
    expect(rows(emptySemi)).toEqual([]);
    expect(rows(emptyAnti)).toEqual(
      normalizeRows([
        { key: "alpha", id: "bag-left-alpha" },
        { key: "alpha", id: "bag-left-alpha" },
        { key: null, id: "bag-left-null" },
        { key: "beta", id: "bag-left-beta" },
      ]),
    );
  });

  it.each(["abs-left", "abs-right", "abs-predicate", "abs-case"] as const)(
    "keeps a potentially throwing ABS expression in the original membership scope: %s",
    (membershipShape) => {
      const {
        root,
        candidate,
        database: db,
      } = buildQuery({
        outerLimit: 20_001,
        membershipShape,
      });
      const physical = lowerLogicalPlan(root);
      expect(
        physical.sharedRelations.some(({ node }) => node === candidate.node),
      ).toBe(false);
      const optimized = compileD1Query(physical);
      const unoptimized = compileD1QueryUnoptimizedForTest(root);
      expect(() => runAll(db, optimized)).toThrow(/integer overflow/);
      expect(() => runAll(db, unoptimized)).toThrow(/integer overflow/);
    },
  );

  it.each([
    "external-scope",
    "volatile-predicate",
    "scalar-subquery",
    "illegal-field-index",
    "leaked-right-field-schema",
    "unvalidated-relation-kind",
  ] as const)("rejects unsafe membership proof input: %s", (failure) => {
    const { root, candidate } = buildQuery({ membershipShape: "both" });
    const forged = relationNodes(candidate.node).find(
      (node) => node.kind === "semi-join" || node.kind === "anti-join",
    ) as
      | Extract<AnyRelation["node"], { kind: "semi-join" | "anti-join" }>
      | undefined;
    expect(forged).toBeDefined();
    if (!forged) throw new Error("membership_fixture_node_missing");
    if (failure === "external-scope") {
      const external = scan(schema.site_identities);
      (forged as unknown as { condition: Predicate }).condition =
        forgedEquality(external.columns.site_id, external.columns.site_id);
    } else if (failure === "volatile-predicate") {
      (forged as unknown as { condition: Predicate }).condition =
        forgedEquality(unixepoch(), unixepoch());
    } else if (failure === "scalar-subquery") {
      const scalarInput = aggregate(scan(schema.site_identities), {
        groupBy: {},
        aggregates: { identityCount: count() },
      });
      (forged as unknown as { condition: Predicate }).condition =
        forgedEquality(scalar(scalarInput) as AnyExpression, constant(1));
    } else if (failure === "illegal-field-index") {
      const original = forged.left.fields[0]!;
      const illegal = {
        kind: "column",
        scope: forged.left.scope,
        index: forged.left.fields.length,
        name: original.name,
        resultType: {
          affinity: original.affinity,
          nullable: original.nullable,
        },
      } as unknown as AnyExpression;
      (forged as unknown as { condition: Predicate }).condition =
        forgedEquality(illegal, illegal);
    } else if (failure === "leaked-right-field-schema") {
      (forged as unknown as { fields: readonly unknown[] }).fields = [
        ...forged.left.fields,
        ...forged.right.fields.slice(0, 1),
      ];
    } else {
      (forged as unknown as { right: QuerySource }).right = {
        node: {
          kind: "unknown-relation-kind",
          scope: forged.right.scope,
          fields: forged.right.fields,
        } as unknown as AnyRelation["node"],
        scope: forged.right.scope,
        fields: forged.right.fields,
      };
    }
    expect(
      completeKeyedLookupReuseCandidates(root.node).has(candidate.node),
    ).toBe(false);
  });

  it("materializes one closed grouped fact for full controls and a complete LEFT lookup", () => {
    const {
      root,
      candidate,
      database: db,
    } = buildQuery({
      outerLimit: 20_001,
    });
    const physical = lowerLogicalPlan(root);
    expect(
      physical.sharedRelations.filter(({ node }) => node === candidate.node),
    ).toMatchObject([
      { materialization: "materialized", fields: expect.any(Array) },
    ]);
    expect(
      physical.sharedRelations.find(({ node }) => node === candidate.node)
        ?.fields,
    ).toHaveLength(3);

    const optimized = compileD1Query(physical);
    const repeated = compileD1Query(lowerLogicalPlan(root));
    const unoptimized = compileD1QueryUnoptimizedForTest(root);
    expect(optimized.sql).toContain("AS MATERIALIZED (");
    expect(repeated.sql).toBe(optimized.sql);
    expect(repeated.bindings).toEqual(optimized.bindings);
    expect(repeated.physicalPlanShape).toEqual(optimized.physicalPlanShape);
    expect(Buffer.byteLength(optimized.sql, "utf8")).toBeLessThanOrEqual(
      100_000,
    );
    expect(optimized.bindings?.length ?? 0).toBeLessThanOrEqual(100);
    expect(normalizeRows(runAll(db, optimized))).toEqual(
      normalizeRows(runAll(db, unoptimized)),
    );
    expect(
      runAll(db, optimized).filter(({ kind }) => kind === "lookup"),
    ).toHaveLength(5);
  });

  it.each([
    ["nullable CASE", "coalesced-control-sum" as const],
    ["nonnullable CASE", "coalesced-nonnullable-control-sum" as const],
  ])(
    "preserves the keyed lookup and zero fallback for a COALESCE-wrapped %s control SUM",
    (_name, aggregateShape) => {
      const {
        root,
        candidate,
        database: db,
      } = buildQuery({
        outerLimit: 20_001,
        aggregateShape,
      });
      const physical = lowerLogicalPlan(root);
      const eligible = completeKeyedLookupReuseCandidates(root.node).has(
        candidate.node,
      );
      const candidateParents = relationNodes(root.node)
        .flatMap((node) => {
          if (node.kind === "project" && node.input.node === candidate.node)
            return ["control-project"];
          if (node.kind === "join" && node.right.node === candidate.node)
            return ["lookup-right-left-join"];
          return [];
        })
        .sort();
      const isPhysicallyShared = physical.sharedRelations.some(
        ({ node }) => node === candidate.node,
      );
      const optimized = compileD1Query(physical);
      const unoptimized = compileD1QueryUnoptimizedForTest(root);
      const optimizedRows = runAll(db, optimized);
      const matchedLookups = optimizedRows.filter(
        ({ kind, value }) => kind === "lookup" && value !== null,
      );

      expect(candidateParents).toEqual([
        "control-project",
        "lookup-right-left-join",
      ]);
      expect(isPhysicallyShared).toBe(eligible);
      expect(normalizeRows(optimizedRows)).toEqual(
        normalizeRows(runAll(db, unoptimized)),
      );
      expect(
        optimizedRows.filter(({ kind }) => kind === "lookup"),
      ).toHaveLength(5);
      expect(matchedLookups.length).toBeGreaterThan(0);
      expect(matchedLookups.every(({ value }) => value === 0)).toBe(true);
    },
  );

  it("preserves a small outer Limit without asserting an unordered prefix", () => {
    const { root, candidate, database: db } = buildQuery({ outerLimit: 1 });
    const physical = lowerLogicalPlan(root);
    expect(
      physical.sharedRelations.some(({ node }) => node === candidate.node),
    ).toBe(true);
    const optimized = compileD1Query(physical);
    const rows = runAll(db, optimized);
    expect(rows.filter(({ kind }) => kind === "control")).toHaveLength(1);
    expect(
      rows.filter(({ kind }) => kind === "lookup").length,
    ).toBeLessThanOrEqual(1);
  });

  it.each([
    ["partial grouping key", { joinShape: "partial" }],
    ["OR join condition", { joinShape: "or" }],
    ["residual join condition", { joinShape: "residual" }],
    ["inner lookup", { joinShape: "inner" }],
    ["candidate as join driver", { joinShape: "driver" }],
    ["third direct consumer", { joinShape: "extra-consumer" }],
    ["non-lookup consumer", { joinShape: "wrong-consumer" }],
    ["scalar limit on controls", { controlBarrier: "limit" }],
    ["filter on controls", { controlBarrier: "filter" }],
    ["inner sort", { candidateBarrier: "sort" }],
    ["inner limit", { candidateBarrier: "limit" }],
    ["inner offset", { candidateBarrier: "offset" }],
    ["inner window", { candidateBarrier: "window" }],
    ["volatile subtree", { candidateBarrier: "volatile" }],
    ["query expression subtree", { candidateBarrier: "subquery" }],
    ["ungrouped aggregate", { aggregateShape: "no-groups" }],
    ["width seventeen", { aggregateShape: "wide" }],
    ["floating SUM", { aggregateShape: "float-sum" }],
    ["AVG", { aggregateShape: "avg" }],
    ["root control SUM", { aggregateShape: "root-control-sum" }],
    ["root Filter", { rootShape: "filter", outerLimit: 20_001 }],
    ["root Limit", { rootShape: "limit", outerLimit: 20_001 }],
    ["root Sort", { rootShape: "sort", outerLimit: 20_001 }],
    ["root Window", { rootShape: "window", outerLimit: 20_001 }],
  ] as const)(
    "rejects %s without admitting the candidate",
    (_name, options) => {
      const { root, candidate } = buildQuery(options);
      expect(
        lowerLogicalPlan(root).sharedRelations.some(
          ({ node }) => node === candidate.node,
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["Project", { rootShape: "project", outerLimit: 20_001 }],
    ["stable scalar Aggregate", { rootShape: "aggregate", outerLimit: 20_001 }],
  ] as const)("admits a complete final %s path", (_name, options) => {
    const { root, candidate } = buildQuery(options);
    expect(
      lowerLogicalPlan(root).sharedRelations.some(
        ({ node }) => node === candidate.node,
      ),
    ).toBe(true);
  });

  it("admits a stable singleton cross join on the control path", () => {
    const {
      root,
      candidate,
      database: db,
    } = buildQuery({
      controlBarrier: "singleton-cross-join",
      outerLimit: 20_001,
    });
    const physical = lowerLogicalPlan(root);
    expect(
      physical.sharedRelations.some(({ node }) => node === candidate.node),
    ).toBe(true);
    expect(normalizeRows(runAll(db, compileD1Query(physical)))).toEqual(
      normalizeRows(runAll(db, compileD1QueryUnoptimizedForTest(root))),
    );
  });

  it.each([
    ["a multirow opposite side", "many-row-cross-join"],
    ["a nontrue condition", "false-singleton-cross-join"],
    ["a LEFT join", "left-singleton-cross-join"],
    ["a filtered singleton side", "filtered-singleton-cross-join"],
    ["a limited singleton side", "limited-singleton-cross-join"],
    ["a volatile singleton projection", "volatile-singleton-cross-join"],
  ] as const)(
    "rejects a control cross join with %s",
    (_name, controlBarrier) => {
      const { root, candidate } = buildQuery({
        controlBarrier,
        outerLimit: 20_001,
      });
      expect(
        lowerLogicalPlan(root).sharedRelations.some(
          ({ node }) => node === candidate.node,
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["an empty opposite side", "control-aggregate-empty-cross-join"],
    ["a multirow opposite side", "control-aggregate-multirow-cross-join"],
  ] as const)(
    "rejects a cross join after the control scalar aggregate with %s",
    (_name, rootShape) => {
      const { root, candidate } = buildQuery({ rootShape });
      expect(
        lowerLogicalPlan(root).sharedRelations.some(
          ({ node }) => node === candidate.node,
        ),
      ).toBe(false);
    },
  );

  it("rejects the singleton control proof under a root UNION DISTINCT", () => {
    const { root, candidate } = buildQuery({
      controlBarrier: "singleton-cross-join",
      outerLimit: 20_001,
      rootShape: "distinct-union",
    });
    expect(
      lowerLogicalPlan(root).sharedRelations.some(
        ({ node }) => node === candidate.node,
      ),
    ).toBe(false);
  });

  it("rejects a forged recursive working scope in the local proof", () => {
    const { root, candidate } = buildQuery();
    const closure = (() => {
      const visited = new Set<object>();
      let found:
        Extract<AnyRelation["node"], { kind: "recursive-closure" }> | undefined;
      const visit = (node: AnyRelation["node"]): void => {
        if (visited.has(node)) return;
        visited.add(node);
        if (node.kind === "recursive-closure") found = node;
        if (
          node.kind === "filter" ||
          node.kind === "project" ||
          node.kind === "aggregate" ||
          node.kind === "distinct" ||
          node.kind === "window" ||
          node.kind === "sort" ||
          node.kind === "limit"
        )
          visit(node.input.node);
        else if (node.kind === "recursive-closure") {
          visit(node.seed.node);
          visit(node.candidates.node);
        } else if (
          node.kind === "join" ||
          node.kind === "semi-join" ||
          node.kind === "anti-join" ||
          node.kind === "union"
        ) {
          visit(node.left.node);
          visit(node.right.node);
        }
      };
      visit(candidate.node);
      return found;
    })();
    expect(closure).toBeDefined();
    (closure as unknown as { currentScope: object }).currentScope = {};
    expect(
      completeKeyedLookupReuseCandidates(root.node).has(candidate.node),
    ).toBe(false);
  });

  it("rejects an external scope referenced from a recursive predicate", () => {
    const { root, candidate } = buildQuery();
    const external = scan(schema.site_identities);
    const visited = new Set<object>();
    const findClosure = (
      node: AnyRelation["node"],
    ):
      | Extract<AnyRelation["node"], { kind: "recursive-closure" }>
      | undefined => {
      if (visited.has(node)) return undefined;
      visited.add(node);
      if (node.kind === "recursive-closure") return node;
      if (
        node.kind === "filter" ||
        node.kind === "project" ||
        node.kind === "aggregate" ||
        node.kind === "distinct" ||
        node.kind === "window" ||
        node.kind === "sort" ||
        node.kind === "limit"
      )
        return findClosure(node.input.node);
      if (
        node.kind === "join" ||
        node.kind === "semi-join" ||
        node.kind === "anti-join" ||
        node.kind === "union"
      )
        return findClosure(node.left.node) ?? findClosure(node.right.node);
      return undefined;
    };
    const closure = findClosure(candidate.node);
    expect(closure).toBeDefined();
    (closure as unknown as { predicate: AnyExpression }).predicate = eq(
      external.columns.site_id,
      external.columns.site_id,
    );
    expect(
      completeKeyedLookupReuseCandidates(root.node).has(candidate.node),
    ).toBe(false);
  });

  it.each([
    ["offset lookup limit", { outerLimit: 10, outerOffset: 1 }],
    ["zero lookup limit", { outerLimit: 0 }],
  ] as const)("rejects %s as a lookup ancestor", (_name, options) => {
    const { root, candidate } = buildQuery(options);
    expect(
      lowerLogicalPlan(root).sharedRelations.some(
        ({ node }) => node === candidate.node,
      ),
    ).toBe(false);
  });
});
