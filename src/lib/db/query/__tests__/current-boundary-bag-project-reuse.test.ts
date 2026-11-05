import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  antiJoin,
  avg,
  callFunction,
  caseWhen,
  castReal,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  join,
  limit,
  lte,
  or,
  project,
  rowNumber,
  scalar,
  scan,
  semiJoin,
  sort,
  sum,
  union,
  valuesRelation,
  window,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression, SqlExpression } from "@/lib/db/query/expression";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type { Relation, SemiJoinNode } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;

interface CandidateOptions {
  readonly width?: number;
  readonly computedProject?: boolean;
  readonly barrier?: "limit" | "sort" | "window";
  readonly singleParent?: boolean;
  readonly rawRootReader?: boolean;
  readonly expressionReader?: boolean;
  readonly realSumReader?: boolean;
  readonly averageReader?: boolean;
  readonly unsafeSideBranch?: boolean;
  readonly unsafeProducer?: boolean;
  readonly sameSourceMembershipRoles?: boolean;
  readonly sameNodeSortReader?: boolean;
}

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function database(): DatabaseSync {
  const result = createMigratedDatabase();
  databases.add(result);
  const siteId = "bag-project-site";
  result
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const sitePk = Number(
    (
      result
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number }
    ).site_pk,
  );
  const insertVisit = result.prepare(
    `INSERT INTO visits (
       visit_id, site_id, visitor_id, session_id, status, started_at,
       last_activity_at, duration_source, duration_ms, pathname, hostname,
       site_pk
     ) VALUES (?, ?, ?, ?, 'complete', ?, ?, 'timer', ?, ?, 'example.test', ?)`,
  );
  for (const [index, duration] of [2, 3, 4].entries())
    insertVisit.run(
      `bag-project-visit-${index}`,
      siteId,
      `bag-project-visitor-${index}`,
      `bag-project-session-${index}`,
      index + 1,
      index + 1,
      duration,
      `path-${index}`,
      sitePk,
    );
  return result;
}

function admissionRows(): {
  readonly rows: AnyRelation;
  readonly control: AnyRelation;
} {
  const visits = scan(schema.visits) as AnyRelation;
  const scopedVisits = filter(
    visits,
    eq(visits.columns.site_id!, constant("bag-project-site") as never),
  ) as AnyRelation;
  const identities = scan(schema.site_identities) as AnyRelation;
  const joined = join(
    scopedVisits,
    identities,
    eq(scopedVisits.columns.site_pk!, identities.columns.site_pk!),
  ) as AnyRelation;
  const joinedColumns = joined.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const eligible = filter(
    joined,
    eq(joinedColumns.right_site_id!, constant("bag-project-site") as never),
  ) as AnyRelation;
  const eligibleColumns = eligible.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const bounded = limit(
    project(eligible, {
      keyA: eligibleColumns.right_site_id!,
      keyB: eligibleColumns.left_visit_id!,
      token: eligibleColumns.left_pathname!,
      duration: eligibleColumns.left_duration_ms!,
    }) as AnyRelation,
    32,
  ) as AnyRelation;
  const counter = aggregate(bounded, {
    groupBy: {},
    aggregates: { rowCount: count() },
  }) as AnyRelation;
  const admission = filter(
    counter,
    lte(counter.columns.rowCount!, constant(31) as never),
  ) as AnyRelation;
  const boundedRowsJoin = join(
    bounded,
    admission,
    eq(constant(1), constant(1)),
  ) as AnyRelation;
  const boundedRowsColumns = boundedRowsJoin.columns as Readonly<
    Record<string, AnyExpression>
  >;
  return {
    rows: project(boundedRowsJoin, {
      keyA: boundedRowsColumns.left_keyA!,
      keyB: boundedRowsColumns.left_keyB!,
      token: boundedRowsColumns.left_token!,
      duration: boundedRowsColumns.left_duration!,
    }) as AnyRelation,
    control: project(counter, {
      rowCount: counter.columns.rowCount!,
    }) as AnyRelation,
  };
}

function shapeCandidate(
  source: AnyRelation,
  options: CandidateOptions,
): AnyRelation {
  if (options.unsafeProducer) {
    source = filter(
      source,
      eq(
        callFunction("abs", source.columns.duration as SqlExpression<number>),
        constant(7) as never,
      ),
    ) as AnyRelation;
  }
  const width = options.width ?? 2;
  const columns: Record<string, AnyExpression> = {};
  for (let index = 0; index < width; index++) {
    if (options.computedProject && index === 0)
      columns[`field${index}`] = callFunction(
        "lower",
        source.columns.keyA as SqlExpression<string | null>,
      );
    else
      columns[`field${index}`] =
        index === 1 && width === 2
          ? source.columns.duration!
          : source.columns.keyA!;
  }
  return project(source, columns) as AnyRelation;
}

function terminalOutputs(
  candidate: AnyRelation,
  options: CandidateOptions,
  control?: AnyRelation,
): AnyRelation {
  const candidateColumns = candidate.columns as Readonly<
    Record<string, AnyExpression>
  >;
  if (options.singleParent) {
    const selfJoin = join(
      candidate,
      candidate,
      eq(candidateColumns.field0!, candidateColumns.field0!),
    ) as AnyRelation;
    const countRows = aggregate(selfJoin, {
      groupBy: {},
      aggregates: { metric: count() },
    }) as AnyRelation;
    return project(countRows, {
      kind: constant("single"),
      key: constant(null),
      metric: countRows.columns.metric!,
    }) as AnyRelation;
  }

  let countInput = candidate;
  if (options.barrier === "limit")
    countInput = limit(candidate, 8) as AnyRelation;
  else if (options.barrier === "sort")
    countInput = sort(candidate, [
      { expression: candidateColumns.field0!, direction: "ASC" },
    ]) as AnyRelation;
  else if (options.barrier === "window")
    countInput = window(candidate, {
      rank: rowNumber({
        orderBy: [{ expression: candidateColumns.field0!, direction: "ASC" }],
      }),
    }) as AnyRelation;
  const countColumns = countInput.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const groupedCount = aggregate(countInput, {
    groupBy: { key: countColumns.field0! },
    aggregates: { metric: count() },
  }) as AnyRelation;
  const countOutput = project(groupedCount, {
    kind: constant("count"),
    key: groupedCount.columns.key!,
    metric: groupedCount.columns.metric!,
  }) as AnyRelation;

  const unitSum = aggregate(candidate, {
    groupBy: {},
    aggregates: {
      metric: sum(
        caseWhen(
          [
            {
              when: eq(
                candidateColumns.field0!,
                constant("bag-project-site") as never,
              ),
              then: constant(1),
            },
          ],
          constant(0),
        ) as SqlExpression<number>,
      ),
    },
  }) as AnyRelation;
  const sumOutput = project(unitSum, {
    kind: constant("sum"),
    key: constant(null),
    metric: unitSum.columns.metric!,
  }) as AnyRelation;

  const membershipRows = valuesRelation(
    {
      key: { affinity: "text", nullable: true },
      marker: { affinity: "text", nullable: false },
    },
    [
      { key: "bag-project-site", marker: "match-a" },
      { key: "bag-project-site", marker: "match-b" },
      { key: null, marker: "null-row" },
      { key: null, marker: "null-row" },
      { key: "missing", marker: "missing-row" },
      { key: "missing", marker: "missing-row" },
    ],
  ) as AnyRelation;
  const membershipColumns = membershipRows.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const membershipCondition = or(
    eq(membershipColumns.key!, candidateColumns.field0!),
    eq(candidateColumns.field0!, constant("never") as never),
  );
  const semi = semiJoin(
    membershipRows,
    candidate,
    membershipCondition,
  ) as AnyRelation;
  const semiOutput = project(semi, {
    kind: constant("semi"),
    key: semi.columns.key!,
    metric: constant(1),
  }) as AnyRelation;
  const anti = antiJoin(
    membershipRows,
    candidate,
    membershipCondition,
  ) as AnyRelation;
  const antiOutput = project(anti, {
    kind: constant("anti"),
    key: anti.columns.key!,
    metric: constant(1),
  }) as AnyRelation;

  const unionCandidate = project(candidate, {
    field0: candidateColumns.field0!,
  }) as AnyRelation;
  const unionInput = valuesRelation(
    { field0: { affinity: "text", nullable: false } },
    [{ field0: "bag-project-site" }],
  ) as AnyRelation;
  const unioned = union(unionCandidate, unionInput, true) as AnyRelation;
  const unionCount = aggregate(unioned, {
    groupBy: {},
    aggregates: { metric: count() },
  }) as AnyRelation;
  const unionOutput = project(unionCount, {
    kind: constant("union"),
    key: constant(null),
    metric: unionCount.columns.metric!,
  }) as AnyRelation;

  const scalarInput = valuesRelation(
    { marker: { affinity: "text", nullable: false } },
    [],
  ) as AnyRelation;
  const scalarSide = aggregate(scalarInput, {
    groupBy: {},
    aggregates: { markerCount: count() },
  }) as AnyRelation;
  const joined = join(
    candidate,
    scalarSide,
    eq(constant(1), constant(1)),
    "left",
  ) as AnyRelation;
  const joinedCount = aggregate(joined, {
    groupBy: {},
    aggregates: { metric: count() },
  }) as AnyRelation;
  const joinedOutput = project(joinedCount, {
    kind: constant("join"),
    key: constant(null),
    metric: joinedCount.columns.metric!,
  }) as AnyRelation;

  let output = union(countOutput, sumOutput, true) as AnyRelation;
  for (const next of [semiOutput, antiOutput, unionOutput, joinedOutput])
    output = union(output, next, true) as AnyRelation;

  if (options.sameSourceMembershipRoles || options.sameNodeSortReader) {
    const selfMembership = semiJoin(
      candidate,
      candidate,
      eq(candidateColumns.field0!, candidateColumns.field0!),
    ) as AnyRelation;
    if (options.sameSourceMembershipRoles)
      Reflect.set(
        selfMembership.node,
        "right",
        (selfMembership.node as SemiJoinNode).left,
      );
    const membershipInput = options.sameNodeSortReader
      ? (sort(selfMembership, [
          {
            expression: selfMembership.columns.field0!,
            direction: "ASC",
          },
        ]) as AnyRelation)
      : selfMembership;
    const selfCount = aggregate(membershipInput, {
      groupBy: {},
      aggregates: { metric: count() },
    }) as AnyRelation;
    output = union(
      output,
      project(selfCount, {
        kind: constant(
          options.sameSourceMembershipRoles
            ? "same-source-membership"
            : "same-node-sorted-left",
        ),
        key: constant(null),
        metric: selfCount.columns.metric!,
      }) as AnyRelation,
      true,
    ) as AnyRelation;
  }

  if (control) {
    const controlOutput = project(control, {
      kind: constant("control"),
      key: constant(null),
      metric: control.columns.rowCount!,
    }) as AnyRelation;
    output = union(output, controlOutput, true) as AnyRelation;
  }

  if (options.realSumReader || options.averageReader) {
    const numeric = candidateColumns.field1 as SqlExpression<number | null>;
    const aggregateReader = aggregate(candidate, {
      groupBy: {},
      aggregates: {
        metric: options.averageReader
          ? avg(castReal(numeric))
          : sum(castReal(numeric)),
      },
    }) as AnyRelation;
    output = union(
      output,
      project(aggregateReader, {
        kind: constant(options.averageReader ? "avg" : "real-sum"),
        key: constant(null),
        metric: aggregateReader.columns.metric!,
      }) as AnyRelation,
      true,
    ) as AnyRelation;
  }

  if (options.unsafeSideBranch) {
    const side = scan(schema.site_identities) as AnyRelation;
    const unsafeSide = project(side, {
      value: callFunction("abs", side.columns.site_pk as SqlExpression<number>),
    }) as AnyRelation;
    const unsafeJoin = join(
      candidate,
      unsafeSide,
      eq(constant(1), constant(1)),
    ) as AnyRelation;
    const unsafeCount = aggregate(unsafeJoin, {
      groupBy: {},
      aggregates: { metric: count() },
    }) as AnyRelation;
    output = union(
      output,
      project(unsafeCount, {
        kind: constant("unsafe-side"),
        key: constant(null),
        metric: unsafeCount.columns.metric!,
      }) as AnyRelation,
      true,
    ) as AnyRelation;
  }

  if (options.expressionReader) {
    const scalarRows = project(candidate, {
      value: candidateColumns.field0!,
    }) as AnyRelation;
    const scalarValue = scalar(scalarRows) as AnyExpression;
    const seed = valuesRelation(
      { marker: { affinity: "text", nullable: false } },
      [{ marker: "bag-project-site" }],
    ) as AnyRelation;
    const expressionReader = filter(
      seed,
      eq(scalarValue, constant("bag-project-site") as never),
    ) as AnyRelation;
    output = union(
      output,
      project(expressionReader, {
        kind: constant("expression"),
        key: constant(null),
        metric: constant(1),
      }) as AnyRelation,
      true,
    ) as AnyRelation;
  }

  if (options.rawRootReader) {
    output = union(
      output,
      project(candidate, {
        kind: constant("raw"),
        key: candidateColumns.field0!,
        metric: constant(1),
      }) as AnyRelation,
      true,
    ) as AnyRelation;
  }
  return output;
}

function buildCandidateQuery(options: CandidateOptions = {}): {
  readonly candidate: AnyRelation;
  readonly output: AnyRelation;
} {
  const admitted = admissionRows();
  const candidate = shapeCandidate(admitted.rows, options);
  return {
    candidate,
    output: terminalOutputs(candidate, options, admitted.control),
  };
}

function buildUnanchoredCandidateQuery(): {
  readonly candidate: AnyRelation;
  readonly output: AnyRelation;
} {
  const input = valuesRelation({ keyA: { affinity: "text", nullable: true } }, [
    { keyA: "bag-project-site" },
    { keyA: "bag-project-site" },
    { keyA: null },
  ]) as AnyRelation;
  const candidate = project(input, {
    field0: input.columns.keyA!,
  }) as AnyRelation;
  return { candidate, output: terminalOutputs(candidate, {}) };
}

function rowBag(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function execute(
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

function expectEquivalent(output: AnyRelation, db = database()) {
  const physical = lowerLogicalPlan(output);
  const optimized = compileD1Query(physical);
  const unoptimized = compileD1QueryUnoptimizedForTest(output);
  const optimizedRows = execute(db, optimized);
  const unoptimizedRows = execute(db, unoptimized);
  expect(rowBag(optimizedRows)).toEqual(rowBag(unoptimizedRows));
  return { physical, optimizedRows };
}

function expectInvalidPlan(operation: () => unknown): void {
  try {
    operation();
    throw new Error("expected invalid_plan");
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_plan" });
  }
}

describe("current-boundary bag project reuse", () => {
  it.each([1, 4, 16])(
    "materializes a %i-column direct projection for count, unit SUM, and membership readers",
    (width) => {
      const built = buildCandidateQuery({ width });
      const { physical, optimizedRows } = expectEquivalent(built.output);
      const definition = physical.sharedRelations.find(
        ({ node }) => node === built.candidate.node,
      );
      expect(definition).toMatchObject({ materialization: "materialized" });
      expect(definition?.dependencies.length).toBeGreaterThan(0);

      const fresh = validatePhysicalQueryPlan(physical);
      expect(
        fresh.interfaces.find(
          ({ definition: current }) => current.node === built.candidate.node,
        ),
      ).toMatchObject({
        license: { kind: "strict-generic-facts" },
        closure: { kind: "scope-and-exported-columns-closed" },
        totality: { kind: "checked-through-current-boundaries" },
      });
      expect(
        optimizedRows.some(
          ({ kind, key, metric }) =>
            kind === "count" && key === "bag-project-site" && metric === 3,
        ),
      ).toBe(true);
      expect(
        optimizedRows.some(
          ({ kind, metric }) => kind === "sum" && metric === 3,
        ),
      ).toBe(true);
      expect(
        optimizedRows.some(({ kind, key }) => kind === "anti" && key === null),
      ).toBe(true);
      expect(new Set(rowBag(optimizedRows)).size).toBeLessThan(
        optimizedRows.length,
      );

      const forged = {
        ...physical,
        sharedRelations: physical.sharedRelations.map((item) =>
          item.node === built.candidate.node
            ? { ...item, scope: Symbol("stale-candidate-scope") as never }
            : item,
        ),
      };
      expectInvalidPlan(() => validatePhysicalQueryPlan(forged));

      const rawOutput = project(built.candidate, {
        kind: constant("raw"),
        key: (
          built.candidate.columns as Readonly<Record<string, AnyExpression>>
        ).field0!,
        metric: constant(1),
      }) as AnyRelation;
      const rawRoot = union(built.output, rawOutput, true) as AnyRelation;
      const rawRootPlan = lowerLogicalPlan(rawRoot);
      expect(rawRootPlan.root.fields).toEqual(physical.root.fields);
      expectInvalidPlan(() =>
        validatePhysicalQueryPlan({
          ...physical,
          root: rawRootPlan.root,
          scope: rawRootPlan.scope,
          fields: rawRootPlan.fields,
        }),
      );
    },
  );

  it.each([
    ["a repeated edge from one parent", { singleParent: true }],
    ["a 17-field project", { width: 17 }],
    ["a computed project", { computedProject: true }],
    ["a raw Limit data path", { barrier: "limit" as const }],
    ["a raw Sort data path", { barrier: "sort" as const }],
    ["a raw Window data path", { barrier: "window" as const }],
    ["a raw root-row reader", { rawRootReader: true }],
    ["an expression-query reader", { expressionReader: true }],
    ["an unsafe producer body", { unsafeProducer: true }],
    ["an unsafe join side branch", { unsafeSideBranch: true }],
    [
      "the same QuerySource object in both membership roles",
      { sameSourceMembershipRoles: true },
    ],
    [
      "a same-node left membership path through Sort",
      { sameNodeSortReader: true },
    ],
    ["a real SUM reader", { realSumReader: true }],
    ["an AVG reader", { averageReader: true }],
  ] as const)("does not certify %s", (_label, options) => {
    const built = buildCandidateQuery(options);
    const { physical } = expectEquivalent(built.output);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === built.candidate.node,
    );
    expect(definition?.materialization).not.toBe("materialized");
    const fresh = validatePhysicalQueryPlan(physical);
    expect(
      fresh.interfaces.some(
        ({ definition: current }) => current.node === built.candidate.node,
      ),
    ).toBe(false);
  });

  it("does not infer a current boundary from an unanchored relation", () => {
    const built = buildUnanchoredCandidateQuery();
    const { physical } = expectEquivalent(built.output);
    expect(
      physical.sharedRelations.find(({ node }) => node === built.candidate.node)
        ?.materialization,
    ).not.toBe("materialized");
    const fresh = validatePhysicalQueryPlan(physical);
    expect(
      fresh.interfaces.some(
        ({ definition }) => definition.node === built.candidate.node,
      ),
    ).toBe(false);
  });

  it("rejects a projection whose body contains an external column scope", () => {
    const source = valuesRelation(
      { key: { affinity: "text", nullable: false } },
      [{ key: "value" }],
    ) as AnyRelation;
    const foreign = scan(schema.site_identities) as AnyRelation;
    const external = filter(
      source,
      eq(foreign.columns.site_pk!, constant(1) as never),
    ) as AnyRelation;
    const candidate = project(external, {
      field0: external.columns.key!,
    }) as AnyRelation;
    const output = aggregate(candidate, {
      groupBy: {},
      aggregates: { rowCount: count() },
    }) as AnyRelation;
    expectInvalidPlan(() => lowerLogicalPlan(output));
  });
});
