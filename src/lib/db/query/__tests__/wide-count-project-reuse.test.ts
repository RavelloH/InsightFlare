import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  and,
  antiJoin,
  callFunction,
  castReal,
  coalesce,
  compileD1Query,
  constant,
  count,
  distinct,
  eq,
  filter,
  join,
  limit,
  lt,
  lte,
  neq,
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
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;
type ReaderBarrier = "limit" | "sort" | "window";
type DistinctObservation =
  "function" | "non-equality" | "or" | "extra-reader" | "left-role";

const SITE_ID = "wide-count-project-site";
const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function database(): DatabaseSync {
  const result = createMigratedDatabase();
  databases.add(result);
  result
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  result
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(`${SITE_ID}-second`);
  const sitePk = Number(
    (
      result
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
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
      `wide-count-visit-${index}`,
      SITE_ID,
      `wide-count-visitor-${index}`,
      `wide-count-session-${index}`,
      index + 1,
      index + 1,
      duration,
      `path-${index}`,
      sitePk,
    );
  return result;
}

function insertToken(
  database: DatabaseSync,
  id: string,
  email: string | Uint8Array | null,
): void {
  database
    .prepare(
      `INSERT INTO account_action_tokens
         (id, type, token_hash, email, payload_json, expires_at)
       VALUES (?, 'team_invite', ?, ?, '{}', 2000000000)`,
    )
    .run(id, `${id}-hash`, email as SQLInputValue);
}

function columns(relation: AnyRelation): Record<string, AnyExpression> {
  return relation.columns as Record<string, AnyExpression>;
}

function currentBoundaryRows(): {
  readonly rows: AnyRelation;
  readonly control: AnyRelation;
} {
  const identities = scan(schema.site_identities) as AnyRelation;
  const eligible = filter(
    identities,
    neq(identities.columns.site_id!, constant("excluded-site") as never),
  ) as AnyRelation;
  const eligibleColumns = columns(eligible);
  const bounded = limit(
    project(eligible, {
      keyA: constant(SITE_ID),
      keyB: eligibleColumns.site_id!,
      token: eligibleColumns.site_id!,
      duration: eligibleColumns.site_pk!,
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
  const boundedColumns = columns(boundedRowsJoin);
  return {
    rows: project(boundedRowsJoin, {
      keyA: boundedColumns.left_keyA!,
      keyB: boundedColumns.left_keyB!,
      token: boundedColumns.left_token!,
      duration: boundedColumns.left_duration!,
    }) as AnyRelation,
    control: project(counter, {
      kind: constant("control"),
      key: constant(null),
      metric: columns(counter).rowCount!,
    }) as AnyRelation,
  };
}

function wideProject(
  source: AnyRelation,
  width: number,
  key: AnyExpression = columns(source).keyA!,
): AnyRelation {
  const projections: Record<string, AnyExpression> = {};
  for (let index = 0; index < width; index++)
    projections[`field${index}`] = key;
  return project(source, projections) as AnyRelation;
}

function taggedCount(source: AnyRelation, label: string): AnyRelation {
  const result = aggregate(source, {
    groupBy: {},
    aggregates: { metric: count() },
  }) as AnyRelation;
  return project(result, {
    kind: constant(label),
    key: constant(null),
    metric: columns(result).metric!,
  }) as AnyRelation;
}

function countFanout(
  source: AnyRelation,
  readers: number,
  label = "count",
  computedFirstReader = false,
): AnyRelation {
  let output: AnyRelation | undefined;
  for (let index = 0; index < readers; index++) {
    const input =
      index === 0 && computedFirstReader
        ? (project(source, {
            normalized: coalesce(
              columns(source).field0!,
              constant("") as never,
            ),
          }) as AnyRelation)
        : source;
    const next = taggedCount(input, `${label}-${index}`);
    output = output ? (union(output, next, true) as AnyRelation) : next;
  }
  if (!output) throw new Error("wide_count_test_requires_a_reader");
  return output;
}

function appendOutput(left: AnyRelation, right: AnyRelation): AnyRelation {
  return union(left, right, true) as AnyRelation;
}

function addBarrierReader(
  output: AnyRelation,
  candidate: AnyRelation,
  barrier: ReaderBarrier,
): AnyRelation {
  let input: AnyRelation = candidate;
  if (barrier === "limit") input = limit(candidate, 8) as AnyRelation;
  else if (barrier === "sort")
    input = sort(candidate, [
      { expression: columns(candidate).field0!, direction: "ASC" },
    ]) as AnyRelation;
  else
    input = window(candidate, {
      rank: rowNumber({
        orderBy: [{ expression: columns(candidate).field0!, direction: "ASC" }],
      }),
    }) as AnyRelation;
  return appendOutput(output, taggedCount(input, `barrier-${barrier}`));
}

function buildCountQuery(
  options: {
    readonly width?: number;
    readonly readers?: number;
    readonly sumReader?: boolean;
    readonly barrier?: ReaderBarrier;
    readonly rawReader?: boolean;
    readonly expressionReader?: boolean;
    readonly computedReader?: boolean;
    readonly orderedSideReader?: boolean;
    readonly complexProducer?: boolean;
  } = {},
): { readonly candidate: AnyRelation; readonly output: AnyRelation } {
  const { rows, control } = currentBoundaryRows();
  let source = rows;
  if (options.complexProducer) {
    const firstVisits = scan(schema.visits) as AnyRelation;
    const first = join(
      source,
      firstVisits,
      eq(columns(source).keyA!, columns(firstVisits).site_id!),
    ) as AnyRelation;
    const secondVisits = scan(schema.visits) as AnyRelation;
    source = join(
      first,
      secondVisits,
      eq(columns(first).right_visit_id!, columns(secondVisits).visit_id!),
    ) as AnyRelation;
  }
  const candidate = wideProject(
    source,
    options.width ?? 23,
    options.complexProducer
      ? columns(source).right_site_id!
      : columns(source).keyA!,
  );
  let output = appendOutput(
    countFanout(
      candidate,
      options.readers ?? 8,
      "count",
      options.computedReader,
    ),
    control,
  );
  if (options.orderedSideReader) {
    const sideRows = valuesRelation(
      { marker: { affinity: "text", nullable: false } },
      [{ marker: "z" }, { marker: "a" }],
    ) as AnyRelation;
    const side = sort(sideRows, [
      { expression: columns(sideRows).marker!, direction: "ASC" },
    ]) as AnyRelation;
    const paired = join(
      candidate,
      side,
      eq(constant(1), constant(1)),
    ) as AnyRelation;
    output = appendOutput(output, taggedCount(paired, "independent-side-sort"));
  }
  if (options.sumReader) {
    const result = aggregate(candidate, {
      groupBy: {},
      aggregates: { metric: sum(constant(1)) },
    }) as AnyRelation;
    output = appendOutput(
      output,
      project(result, {
        kind: constant("sum"),
        key: constant(null),
        metric: columns(result).metric!,
      }) as AnyRelation,
    );
  }
  if (options.barrier)
    output = addBarrierReader(output, candidate, options.barrier);
  if (options.rawReader) {
    output = appendOutput(
      output,
      project(candidate, {
        kind: constant("raw"),
        key: columns(candidate).field0!,
        metric: constant(1),
      }) as AnyRelation,
    );
  }
  if (options.expressionReader) {
    const scalarRows = project(candidate, {
      value: columns(candidate).field0!,
    }) as AnyRelation;
    const scalarValue = scalar(scalarRows) as AnyExpression;
    const seed = valuesRelation(
      { marker: { affinity: "text", nullable: false } },
      [{ marker: "keep" }],
    ) as AnyRelation;
    const expressionReader = filter(
      seed,
      eq(scalarValue, constant("wide-count-site") as never),
    ) as AnyRelation;
    output = appendOutput(
      output,
      project(expressionReader, {
        kind: constant("expression"),
        key: constant(null),
        metric: constant(1),
      }) as AnyRelation,
    );
  }
  return { candidate, output };
}

function buildDistinctQuery(observation?: DistinctObservation): {
  readonly candidate: AnyRelation;
  readonly output: AnyRelation;
} {
  const { rows: anchor, control } = currentBoundaryRows();
  const tokenRows = scan(schema.account_action_tokens) as AnyRelation;
  const joined = join(
    anchor,
    tokenRows,
    eq(constant(1), constant(1)),
  ) as AnyRelation;
  const candidate = wideProject(joined, 23, columns(joined).right_email!);
  const distinctRows = distinct(candidate) as AnyRelation;
  const left = scan(schema.account_action_tokens) as AnyRelation;
  const leftEmail = columns(left).email!;
  const rightKey = columns(distinctRows).field0!;
  const equality = eq(leftEmail, rightKey);
  let condition: SqlExpression = equality;
  if (observation === "function")
    condition = and(
      equality,
      eq(callFunction("storage-class", leftEmail), constant("text") as never),
    );
  else if (observation === "non-equality") condition = lt(leftEmail, rightKey);
  else if (observation === "or")
    condition = or(equality, eq(rightKey, leftEmail));

  const countOutput = countFanout(candidate, 8);
  let membershipOutput: AnyRelation;
  if (observation === "left-role") {
    const membership = semiJoin(
      distinctRows,
      left,
      eq(rightKey, leftEmail),
    ) as AnyRelation;
    membershipOutput = taggedCount(membership, "left-membership");
  } else {
    const semi = semiJoin(
      left,
      distinctRows,
      condition as never,
    ) as AnyRelation;
    const anti = antiJoin(
      left,
      distinctRows,
      condition as never,
    ) as AnyRelation;
    membershipOutput = appendOutput(
      project(semi, {
        kind: constant("semi"),
        key: columns(semi).email!,
        metric: constant(1),
      }) as AnyRelation,
      project(anti, {
        kind: constant("anti"),
        key: columns(anti).email!,
        metric: constant(1),
      }) as AnyRelation,
    );
  }
  let output = appendOutput(
    appendOutput(countOutput, membershipOutput),
    control,
  );
  if (observation === "extra-reader")
    output = appendOutput(output, taggedCount(distinctRows, "distinct-count"));
  return { candidate, output };
}

function buildMembershipReaderWindowQuery(
  mixCandidateRowsIntoWindow: boolean,
): { readonly candidate: AnyRelation; readonly output: AnyRelation } {
  const { rows: anchor, control } = currentBoundaryRows();
  const tokenRows = scan(schema.account_action_tokens) as AnyRelation;
  const candidateSource = join(
    anchor,
    tokenRows,
    eq(constant(1), constant(1)),
  ) as AnyRelation;
  const candidate = wideProject(
    candidateSource,
    23,
    columns(candidateSource).right_email!,
  );
  const distinctRows = distinct(candidate) as AnyRelation;
  const left = scan(schema.account_action_tokens) as AnyRelation;
  const membership = semiJoin(
    left,
    distinctRows,
    eq(columns(left).email!, columns(distinctRows).field0! as never),
  ) as AnyRelation;
  const windowInput = mixCandidateRowsIntoWindow
    ? (join(membership, candidate, eq(constant(1), constant(1))) as AnyRelation)
    : membership;
  const orderColumn = mixCandidateRowsIntoWindow
    ? columns(windowInput).left_email!
    : columns(windowInput).email!;
  const ranked = window(windowInput, {
    rank: rowNumber({
      orderBy: [{ expression: orderColumn, direction: "ASC" }],
    }),
  }) as AnyRelation;
  const countInput = mixCandidateRowsIntoWindow
    ? ranked
    : (join(candidate, ranked, eq(constant(1), constant(1))) as AnyRelation);
  return {
    candidate,
    output: appendOutput(
      appendOutput(
        countFanout(candidate, 8),
        taggedCount(countInput, "membership-reader-window"),
      ),
      control,
    ),
  };
}

function buildNumericDistinctQuery(): {
  readonly candidate: AnyRelation;
  readonly output: AnyRelation;
} {
  const { rows: anchor, control } = currentBoundaryRows();
  const realSeed = valuesRelation(
    { key: { affinity: "text", nullable: false } },
    [{ key: "seed" }],
  ) as AnyRelation;
  const integerOne = project(realSeed, { key: constant(1) }) as AnyRelation;
  const realOne = project(realSeed, {
    key: castReal(constant(1)),
  }) as AnyRelation;
  const numericValues = union(integerOne, realOne, true) as AnyRelation;
  const joined = join(
    anchor,
    numericValues,
    eq(constant(1), constant(1)),
  ) as AnyRelation;
  const candidate = wideProject(joined, 23, columns(joined).right_key!);
  const distinctRows = distinct(candidate) as AnyRelation;
  const left = realOne;
  const membership = semiJoin(
    left,
    distinctRows,
    eq(columns(left).key!, columns(distinctRows).field0! as never),
  ) as AnyRelation;
  return {
    candidate,
    output: appendOutput(
      appendOutput(
        countFanout(candidate, 8),
        taggedCount(membership, "numeric-membership"),
      ),
      control,
    ),
  };
}

function rowBag(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function execute(
  database: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Record<string, unknown>[] {
  return database
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
}

function equivalentRows(
  output: AnyRelation,
  database: DatabaseSync,
): {
  readonly physical: ReturnType<typeof lowerLogicalPlan>;
  readonly optimized: ReturnType<typeof compileD1Query>;
  readonly optimizedRows: Record<string, unknown>[];
} {
  const physical = lowerLogicalPlan(output);
  const optimized = compileD1Query(physical);
  const unoptimized = compileD1QueryUnoptimizedForTest(output);
  const optimizedRows = execute(database, optimized);
  const unoptimizedRows = execute(database, unoptimized);
  expect(rowBag(optimizedRows)).toEqual(rowBag(unoptimizedRows));
  return { physical, optimized, optimizedRows };
}

function expectInvalidPlan(operation: () => unknown): void {
  try {
    operation();
    throw new Error("expected invalid_plan");
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_plan" });
  }
}

describe("wide COUNT project reuse", () => {
  it.each([2, 3])(
    "cost-gates an expensive producer with %i COUNT readers",
    (readers) => {
      const databaseHandle = database();
      const built = buildCountQuery({
        width: 24,
        readers,
        complexProducer: true,
      });
      const { physical } = equivalentRows(built.output, databaseHandle);
      const selected = validatePhysicalQueryPlan(physical).interfaces.some(
        ({ definition, license }) =>
          definition.node === built.candidate.node &&
          license.kind === "wide-count-project-reuse",
      );
      expect(selected).toBe(readers === 3);
    },
  );
  it.each([17, 23, 32])(
    "materializes a %i-column current direct project for eight COUNT readers",
    (width) => {
      const databaseHandle = database();
      const built = buildCountQuery({
        width,
        computedReader: width === 23,
        orderedSideReader: width === 23,
      });
      const { physical } = equivalentRows(built.output, databaseHandle);
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
        license: { kind: "wide-count-project-reuse" },
        closure: { kind: "scope-and-exported-columns-closed" },
        totality: { kind: "checked-through-current-boundaries" },
      });
    },
  );

  it.each([
    ["a 17-column project with seven readers", { width: 17, readers: 7 }],
    ["a 17-column ordinary bag project", { width: 17, readers: 2 }],
    ["a project wider than the 32-column cap", { width: 33, readers: 8 }],
    ["a 17-column project with a SUM reader", { width: 17, sumReader: true }],
    [
      "a 17-column project observed at the root",
      { width: 17, rawReader: true },
    ],
    [
      "a 17-column project observed by an expression subquery",
      { width: 17, expressionReader: true },
    ],
  ] as const)(
    "does not apply the wide COUNT license to %s",
    (_label, options) => {
      const databaseHandle = database();
      const built = buildCountQuery(options);
      const { physical } = equivalentRows(built.output, databaseHandle);
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
    },
  );

  it("leaves the existing 1–16-column bag policy intact", () => {
    const databaseHandle = database();
    const built = buildCountQuery({ width: 16, readers: 8 });
    const { physical } = equivalentRows(built.output, databaseHandle);
    expect(
      physical.sharedRelations.find(
        ({ node }) => node === built.candidate.node,
      ),
    ).toMatchObject({ materialization: "materialized" });
    expect(
      validatePhysicalQueryPlan(physical).interfaces.find(
        ({ definition }) => definition.node === built.candidate.node,
      )?.license.kind,
    ).not.toBe("wide-count-project-reuse");
  });

  it.each(["limit", "sort", "window"] as const)(
    "rejects a raw %s path even when every other reader ends at COUNT",
    (barrier) => {
      const databaseHandle = database();
      const built = buildCountQuery({ width: 23, barrier });
      const { physical } = equivalentRows(built.output, databaseHandle);
      expect(
        physical.sharedRelations.find(
          ({ node }) => node === built.candidate.node,
        )?.materialization,
      ).not.toBe("materialized");
    },
  );

  it("preserves full-tuple DISTINCT for strict text EXISTS with TEXT, NULL, and BLOB values", () => {
    const databaseHandle = database();
    const blob = new Uint8Array([0x61, 0x00, 0xff]);
    insertToken(databaseHandle, "wide-token-text-a", "repeat");
    insertToken(databaseHandle, "wide-token-text-b", "repeat");
    insertToken(databaseHandle, "wide-token-null-a", null);
    insertToken(databaseHandle, "wide-token-null-b", null);
    insertToken(databaseHandle, "wide-token-blob-a", blob);
    insertToken(databaseHandle, "wide-token-blob-b", blob);
    const built = buildDistinctQuery();
    const { physical, optimized } = equivalentRows(
      built.output,
      databaseHandle,
    );
    expect(optimized.sql).toMatch(/SELECT DISTINCT/i);
    expect(
      physical.sharedRelations.find(
        ({ node }) => node === built.candidate.node,
      ),
    ).toMatchObject({ materialization: "materialized" });
    expect(
      validatePhysicalQueryPlan(physical).interfaces.find(
        ({ definition }) => definition.node === built.candidate.node,
      ),
    ).toMatchObject({ license: { kind: "wide-count-project-reuse" } });
  });

  it("allows a total ROW_NUMBER after candidate-only text EXISTS before an ordinary join", () => {
    const databaseHandle = database();
    insertToken(databaseHandle, "wide-window-text-a", "repeat");
    insertToken(databaseHandle, "wide-window-text-b", "repeat");
    insertToken(databaseHandle, "wide-window-null", null);
    insertToken(
      databaseHandle,
      "wide-window-blob",
      new Uint8Array([0x72, 0x00, 0xfe]),
    );
    const built = buildMembershipReaderWindowQuery(false);
    const { physical } = equivalentRows(built.output, databaseHandle);
    expect(
      physical.sharedRelations.find(
        ({ node }) => node === built.candidate.node,
      ),
    ).toMatchObject({ materialization: "materialized" });
    expect(
      validatePhysicalQueryPlan(physical).interfaces.find(
        ({ definition }) => definition.node === built.candidate.node,
      ),
    ).toMatchObject({ license: { kind: "wide-count-project-reuse" } });
  });

  it("rejects a reader window whose input mixes candidate membership and row data", () => {
    const databaseHandle = database();
    insertToken(databaseHandle, "wide-window-mixed-a", "repeat");
    insertToken(databaseHandle, "wide-window-mixed-b", "repeat");
    const built = buildMembershipReaderWindowQuery(true);
    const { physical } = equivalentRows(built.output, databaseHandle);
    expect(
      physical.sharedRelations.find(({ node }) => node === built.candidate.node)
        ?.materialization,
    ).not.toBe("materialized");
  });

  it.each([
    "function",
    "non-equality",
    "or",
    "extra-reader",
    "left-role",
  ] as const)("rejects a DISTINCT observer with %s", (observation) => {
    const databaseHandle = database();
    insertToken(databaseHandle, "wide-token-text", "repeat");
    insertToken(databaseHandle, "wide-token-null", null);
    const built = buildDistinctQuery(observation);
    const { physical } = equivalentRows(built.output, databaseHandle);
    expect(
      physical.sharedRelations.find(({ node }) => node === built.candidate.node)
        ?.materialization,
    ).not.toBe("materialized");
    expect(
      validatePhysicalQueryPlan(physical).interfaces.some(
        ({ definition }) => definition.node === built.candidate.node,
      ),
    ).toBe(false);
  });

  it("rejects mixed numeric DISTINCT domains and preserves the TEXT-affinity counterexample", () => {
    const databaseHandle = database();
    insertToken(databaseHandle, "wide-numeric-integer", "1");
    insertToken(databaseHandle, "wide-numeric-real", "1.0");
    const comparison = databaseHandle
      .prepare(
        `
      WITH raw_values(value) AS (VALUES (1), (1.0))
      SELECT email,
        EXISTS (SELECT 1 FROM raw_values WHERE email = value) AS rawMatch,
        EXISTS (SELECT 1 FROM (SELECT DISTINCT value FROM raw_values) AS keys
                WHERE email = keys.value) AS distinctMatch
      FROM account_action_tokens ORDER BY id
    `,
      )
      .all();
    expect(comparison).toEqual([
      { email: "1", rawMatch: 1, distinctMatch: 1 },
      { email: "1.0", rawMatch: 1, distinctMatch: 0 },
    ]);
    const built = buildNumericDistinctQuery();
    const { physical } = equivalentRows(built.output, databaseHandle);
    expect(
      physical.sharedRelations.find(({ node }) => node === built.candidate.node)
        ?.materialization,
    ).not.toBe("materialized");
    expect(
      validatePhysicalQueryPlan(physical).interfaces.some(
        ({ definition }) => definition.node === built.candidate.node,
      ),
    ).toBe(false);
  });

  it("recomputes the wide license when its input fields, reader graph, or dependencies change", () => {
    const databaseHandle = database();
    const built = buildCountQuery({ width: 23 });
    const { physical } = equivalentRows(built.output, databaseHandle);
    const forgedDependencies = {
      ...physical,
      sharedRelations: physical.sharedRelations.map((definition) =>
        definition.node === built.candidate.node
          ? {
              ...definition,
              dependencies: [
                ...definition.dependencies,
                "_stale_wide_dependency",
              ],
            }
          : definition,
      ),
    };
    expectInvalidPlan(() => validatePhysicalQueryPlan(forgedDependencies));

    const changedRoot = appendOutput(
      built.output,
      project(built.candidate, {
        kind: constant("raw-reader"),
        key: columns(built.candidate).field0!,
        metric: constant(1),
      }) as AnyRelation,
    );
    const changedPhysical = lowerLogicalPlan(changedRoot);
    expectInvalidPlan(() =>
      validatePhysicalQueryPlan({
        ...physical,
        root: changedPhysical.root,
        scope: changedPhysical.scope,
        fields: changedPhysical.fields,
      }),
    );

    Reflect.set(built.candidate.node, "fields", [
      ...built.candidate.node.fields.slice(0, -1),
    ]);
    expectInvalidPlan(() => validatePhysicalQueryPlan(physical));
  });
});
