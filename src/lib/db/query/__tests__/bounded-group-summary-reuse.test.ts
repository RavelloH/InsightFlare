import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  antiJoin,
  callFunction,
  castReal,
  compileD1Query,
  count,
  eq,
  filter,
  gt,
  join,
  limit,
  max,
  param,
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
  valuesRelation,
  window,
  windowCountRows,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type {
  AnyExpression,
  ColumnExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;
type GroupedRelation = Relation<
  object,
  Readonly<Record<string, AnyExpression>> & {
    readonly rowCount: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    readonly durationSum: ColumnExpression<
      number | null,
      ExpressionResultType<"numeric", true>
    >;
    readonly durationMax: ColumnExpression<
      number | null,
      ExpressionResultType<"numeric", true>
    >;
  }
>;

interface QueryOptions {
  readonly cap?: number;
  readonly offset?: number;
  readonly detailMinimum?: number;
  readonly siteId?: string;
  readonly inputBarrier?: "sort" | "window" | "recursive" | "subquery";
  readonly outerLimit?: boolean;
  readonly detailSort?: boolean;
  readonly outerWindow?: "unique" | "ties" | "count-rows";
  readonly outerDetailWindow?: boolean;
  readonly wideGroups?: boolean;
  readonly unsafeBoundaryAbs?: boolean;
  readonly consumers?: "both" | "summary-only" | "project" | "different-nodes";
}

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
    .run("bounded-group-site");
  const { site_pk: sitePk } = result
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get("bounded-group-site") as { site_pk: number };
  const insertVisit = result.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, ended_at, duration_ms, duration_source, exit_reason,
      pathname, hostname, site_pk
    ) VALUES (?, 'bounded-group-site', ?, ?, ?, ?, ?, ?, ?, ?, ?, '/', 'example.test', ?)`,
  );
  const rows = [
    [
      "bounded-a",
      "visitor-a",
      "session-null",
      "complete",
      1,
      1,
      null,
      null,
      null,
      null,
    ],
    [
      "bounded-b",
      "visitor-b",
      "session-null",
      "complete",
      2,
      2,
      null,
      null,
      null,
      null,
    ],
    [
      "bounded-c",
      "visitor-c",
      "session-null",
      "complete",
      3,
      3,
      null,
      10,
      "timer",
      null,
    ],
    [
      "bounded-d",
      "visitor-d",
      "session-timer",
      "complete",
      4,
      4,
      null,
      5,
      "timer",
      null,
    ],
    [
      "bounded-e",
      "visitor-e",
      "session-empty",
      "complete",
      5,
      5,
      null,
      null,
      "all-null",
      null,
    ],
    [
      "bounded-f",
      "visitor-f",
      "session-ignored",
      "failed",
      6,
      6,
      null,
      90,
      "timer",
      null,
    ],
  ] as const;
  for (const [
    visitId,
    visitorId,
    sessionId,
    status,
    startedAt,
    lastAt,
    endedAt,
    duration,
    source,
    exitReason,
  ] of rows)
    insertVisit.run(
      visitId,
      visitorId,
      sessionId,
      status,
      startedAt,
      lastAt,
      endedAt,
      duration,
      source,
      exitReason,
      sitePk,
    );
  return result;
}

function branch(siteId: string, unsafeBoundaryAbs = false) {
  const visits = scan(schema.visits);
  const selectedVisits = filter(
    visits,
    eq(visits.columns.status, param("complete")),
  );
  const identities = scan(schema.site_identities);
  const selectedIdentities = filter(
    identities,
    eq(identities.columns.site_id, param(siteId)),
  );
  const joined = join(
    selectedVisits,
    selectedIdentities,
    eq(selectedVisits.columns.site_pk, selectedIdentities.columns.site_pk),
  );
  return project(joined, {
    siteId: joined.columns.right_site_id,
    sessionId: joined.columns.left_session_id,
    durationSource: joined.columns.left_duration_source,
    duration: unsafeBoundaryAbs
      ? (callFunction(
          "abs",
          joined.columns.left_duration_ms as SqlExpression<number | null>,
        ) as SqlExpression<number | null>)
      : castReal(joined.columns.left_duration_ms),
  });
}

function aggregateGroups(
  input: AnyRelation,
  wideGroups = false,
): GroupedRelation {
  const columns = input.columns as Readonly<Record<string, AnyExpression>>;
  const groupBy: Record<string, AnyExpression> = wideGroups
    ? Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [
          `key${index}`,
          columns.sessionId!,
        ]),
      )
    : {
        sessionId: columns.sessionId!,
        durationSource: columns.durationSource!,
      };
  return aggregate(input, {
    groupBy,
    aggregates: {
      rowCount: count(),
      durationSum: sum(columns.duration! as SqlExpression<number | null>),
      durationMax: max(columns.duration! as SqlExpression<number | null>),
    },
  }) as unknown as GroupedRelation;
}

function summaryProjection(grouped: GroupedRelation): AnyRelation {
  const columns = grouped.columns as Readonly<Record<string, AnyExpression>>;
  const summary = aggregate(grouped, {
    groupBy: {},
    aggregates: {
      groupCount: count(),
      rowCount: sum(columns.rowCount! as SqlExpression<number | null>),
      durationSum: sum(columns.durationSum! as SqlExpression<number | null>),
    },
  });
  return project(summary, {
    rowKind: param("summary"),
    sessionId: param<string | null>(null),
    durationSource: param<string | null>(null),
    rowCount: summary.columns.rowCount,
    durationSum: summary.columns.durationSum,
    groupCount: summary.columns.groupCount,
  }) as unknown as AnyRelation;
}

function detailProjection(
  grouped: GroupedRelation,
  minimum: number,
  useFilter = true,
): AnyRelation {
  const filtered = useFilter
    ? filter(grouped, gt(grouped.columns.rowCount, param(minimum)))
    : grouped;
  const columns = filtered.columns as Readonly<Record<string, AnyExpression>>;
  return project(filtered, {
    rowKind: param("detail"),
    sessionId: columns.sessionId ?? columns.key0!,
    durationSource: columns.durationSource ?? param<string | null>(null),
    rowCount: columns.rowCount!,
    durationSum: columns.durationSum!,
    groupCount: param<number | null>(null),
  }) as unknown as AnyRelation;
}

function buildQuery(options: QueryOptions = {}): {
  readonly grouped: AnyRelation;
  readonly output: AnyRelation;
} {
  const siteId = options.siteId ?? "bounded-group-site";
  let leftBranch = branch(siteId, options.unsafeBoundaryAbs);
  const rightBranch = branch(siteId, options.unsafeBoundaryAbs);
  let left = leftBranch as unknown as AnyRelation;
  let right = rightBranch as unknown as AnyRelation;
  if (options.inputBarrier === "sort") {
    left = sort(left, [
      {
        expression: (left.columns as Readonly<Record<string, AnyExpression>>)
          .sessionId!,
        direction: "ASC",
      },
    ]) as unknown as AnyRelation;
  } else if (options.inputBarrier === "window") {
    left = window(left, {
      rowCount: windowCountRows(),
    }) as unknown as AnyRelation;
    right = window(right, {
      rowCount: windowCountRows(),
    }) as unknown as AnyRelation;
  } else if (options.inputBarrier === "recursive") {
    left = recursiveClosure(leftBranch, leftBranch, (current, candidate) =>
      eq(current.sessionId, candidate.sessionId),
    ) as unknown as AnyRelation;
  } else if (options.inputBarrier === "subquery") {
    const identities = scan(schema.site_identities);
    const correlated = filter(
      identities,
      eq(identities.columns.site_id, leftBranch.columns.siteId),
    );
    const scalarSiteId = scalar(
      project(correlated, { siteId: correlated.columns.site_id }),
    );
    leftBranch = filter(
      leftBranch,
      eq(leftBranch.columns.siteId, scalarSiteId),
    );
    left = leftBranch as unknown as AnyRelation;
  }

  const unioned = union(left, right, true) as unknown as AnyRelation;
  const capped = limit(
    unioned,
    options.cap ?? 100,
    options.offset,
  ) as unknown as AnyRelation;
  const grouped = aggregateGroups(capped, options.wideGroups);
  const summary = summaryProjection(grouped);
  let output: AnyRelation;
  if (options.consumers === "summary-only") output = summary;
  else if (options.outerDetailWindow) {
    const detail = detailProjection(grouped, options.detailMinimum ?? 0);
    const detailColumns = detail.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const ranked = window(detail, {
      rank: rowNumber({
        orderBy: [
          { expression: detailColumns.sessionId!, direction: "ASC" },
          { expression: detailColumns.durationSource!, direction: "ASC" },
        ],
      }),
    }) as AnyRelation;
    const rankedColumns = ranked.columns as Readonly<
      Record<string, AnyExpression>
    >;
    output = union(
      summary,
      project(ranked, {
        rowKind: rankedColumns.rowKind!,
        sessionId: rankedColumns.sessionId!,
        durationSource: rankedColumns.durationSource!,
        rowCount: rankedColumns.rank!,
        durationSum: rankedColumns.durationSum!,
        groupCount: rankedColumns.groupCount!,
      }) as AnyRelation,
      true,
    ) as AnyRelation;
  } else if (options.consumers === "project")
    output = union(
      summary,
      detailProjection(grouped, options.detailMinimum ?? 0, false),
      true,
    ) as unknown as AnyRelation;
  else if (options.consumers === "different-nodes") {
    const otherGrouped = aggregateGroups(capped);
    output = union(
      summary,
      detailProjection(otherGrouped, options.detailMinimum ?? 0),
      true,
    ) as unknown as AnyRelation;
  } else {
    const detail = detailProjection(grouped, options.detailMinimum ?? 0);
    const orderedDetail = options.detailSort
      ? (sort(detail, [
          {
            expression: (
              detail.columns as Readonly<Record<string, AnyExpression>>
            ).sessionId!,
            direction: "ASC",
          },
        ]) as unknown as AnyRelation)
      : detail;
    output = union(summary, orderedDetail, true) as unknown as AnyRelation;
  }

  if (options.outerWindow) {
    const columns = output.columns as Readonly<Record<string, AnyExpression>>;
    if (options.outerWindow === "count-rows") {
      output = window(output, {
        rank: windowCountRows(),
      }) as unknown as AnyRelation;
    } else {
      const orderBy =
        options.outerWindow === "unique"
          ? ([
              { expression: columns.rowKind!, direction: "ASC" },
              { expression: columns.sessionId!, direction: "ASC" },
              { expression: columns.durationSource!, direction: "ASC" },
            ] as const)
          : ([{ expression: columns.rowKind!, direction: "ASC" }] as const);
      output = window(output, {
        rank: rowNumber({ orderBy }),
      }) as unknown as AnyRelation;
    }
  }

  if (options.outerLimit) output = limit(output, 1) as unknown as AnyRelation;
  return { grouped, output };
}

interface MembershipWindowOptions {
  readonly anti?: boolean;
  readonly rightEmpty?: boolean;
  readonly duplicateRight?: boolean;
  readonly directBranch?: "window" | "limit";
}

function membershipWindowQuery(options: MembershipWindowOptions = {}): {
  readonly grouped: AnyRelation;
  readonly output: AnyRelation;
} {
  const { grouped } = buildQuery();
  const summary = summaryProjection(grouped as GroupedRelation);
  const detail = detailProjection(grouped as GroupedRelation, 0);
  const detailColumns = detail.columns as Readonly<
    Record<string, AnyExpression>
  >;
  let right = detail;
  if (options.rightEmpty)
    right = filter(
      right,
      eq(
        detailColumns.sessionId!,
        param<string>("no-qualified-session") as never,
      ),
    ) as AnyRelation;
  if (options.duplicateRight) right = union(right, right, true) as AnyRelation;

  const left = valuesRelation(
    {
      sessionId: { affinity: "text", nullable: false },
      rowToken: { affinity: "text", nullable: false },
    },
    [
      { sessionId: "session-null", rowToken: "duplicate" },
      { sessionId: "session-null", rowToken: "duplicate" },
      { sessionId: "no-qualified-session", rowToken: "unmatched" },
      { sessionId: "no-qualified-session", rowToken: "unmatched" },
    ],
  ) as AnyRelation;
  const leftColumns = left.columns as Readonly<Record<string, AnyExpression>>;
  const rightColumns = right.columns as Readonly<Record<string, AnyExpression>>;
  const membership = options.anti
    ? antiJoin(left, right, eq(leftColumns.sessionId!, rightColumns.sessionId!))
    : semiJoin(
        left,
        right,
        eq(leftColumns.sessionId!, rightColumns.sessionId!),
      );
  const membershipColumns = membership.columns as Readonly<
    Record<string, AnyExpression>
  >;

  const pageRows = (source: AnyRelation): AnyRelation => {
    const columns = source.columns as Readonly<Record<string, AnyExpression>>;
    return project(source, {
      rowKind: param("page"),
      sessionId: columns.sessionId!,
      durationSource: param<string | null>(null),
      rowCount: columns.rank!,
      durationSum: param<number | null>(null),
      groupCount: param<number | null>(null),
    }) as AnyRelation;
  };
  const rankedMembership = window(membership, {
    rank: rowNumber({
      orderBy: [
        {
          expression: membershipColumns.sessionId!,
          direction: "ASC",
        },
      ],
    }),
  }) as AnyRelation;
  let reportRows = pageRows(rankedMembership);
  if (options.directBranch === "window") {
    const directlyRanked = window(detail, {
      rank: rowNumber({
        orderBy: [{ expression: detailColumns.sessionId!, direction: "ASC" }],
      }),
    }) as AnyRelation;
    reportRows = union(
      reportRows,
      pageRows(directlyRanked),
      true,
    ) as AnyRelation;
  } else if (options.directBranch === "limit") {
    const limited = limit(detail, 1) as AnyRelation;
    const columns = limited.columns as Readonly<Record<string, AnyExpression>>;
    reportRows = union(
      reportRows,
      project(limited, {
        rowKind: param("direct-limit"),
        sessionId: columns.sessionId!,
        durationSource: columns.durationSource!,
        rowCount: columns.rowCount!,
        durationSum: columns.durationSum!,
        groupCount: param<number | null>(null),
      }) as AnyRelation,
      true,
    ) as AnyRelation;
  }

  return { grouped, output: union(summary, reportRows, true) as AnyRelation };
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

function rowBag(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

describe("bounded grouped summary reuse", () => {
  it("materializes one complete grouped result and preserves SQLite bag semantics", () => {
    const db = database();
    const { grouped, output } = buildQuery({ cap: 100 });
    const physical = lowerLogicalPlan(output);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === grouped.node,
    );
    expect(physical.sharedRelations).toHaveLength(1);
    expect(definition).toMatchObject({ materialization: "materialized" });

    const optimized = compileD1Query(physical);
    const unoptimized = compileD1QueryUnoptimizedForTest(output);
    expect(optimized.sql).toContain("AS MATERIALIZED (");
    expect(rowBag(execute(db, optimized))).toEqual(
      rowBag(execute(db, unoptimized)),
    );
    const rows = execute(db, optimized);
    expect(
      rows.some(
        (row) => row.rowKind === "detail" && row.durationSource === null,
      ),
    ).toBe(true);
    expect(
      rows.some((row) => row.rowKind === "detail" && row.durationSum === null),
    ).toBe(true);
    expect(
      rows.filter((row) => row.rowKind === "detail").length,
    ).toBeGreaterThan(0);
  });

  it("preserves the grouped summary for empty input and distinct parameter bindings", () => {
    const db = database();
    for (const options of [
      { siteId: "missing-site", cap: 100, detailMinimum: 0 },
      { siteId: "bounded-group-site", cap: 200, detailMinimum: 1 },
      { siteId: "bounded-group-site", cap: 150, detailMinimum: 3 },
    ]) {
      const { grouped, output } = buildQuery(options);
      const physical = lowerLogicalPlan(output);
      expect(
        physical.sharedRelations.some(({ node }) => node === grouped.node),
      ).toBe(true);
      expect(rowBag(execute(db, compileD1Query(physical)))).toEqual(
        rowBag(execute(db, compileD1QueryUnoptimizedForTest(output))),
      );
    }
    const empty = execute(
      db,
      compileD1Query(
        lowerLogicalPlan(buildQuery({ siteId: "missing-site" }).output),
      ),
    );
    expect(empty).toEqual([
      expect.objectContaining({
        rowKind: "summary",
        groupCount: 0,
        rowCount: null,
        durationSum: null,
      }),
    ]);
  });

  it("reuses a stable window parent above a bounded materialized boundary", () => {
    const db = database();
    const sitePk = (
      db
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get("bounded-group-site") as { site_pk: number }
    ).site_pk;
    const insertExtraGroup = db.prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, ended_at, duration_ms, duration_source, exit_reason,
        pathname, hostname, site_pk
      ) VALUES (?, 'bounded-group-site', ?, ?, 'complete', ?, ?, NULL, ?, 'timer', NULL, '/', 'example.test', ?)`,
    );
    for (const [visitId, visitorId, sessionId, time, duration] of [
      ["boundary-extra-a", "boundary-visitor-a", "session-extra-a", 7, 7],
      ["boundary-extra-b", "boundary-visitor-b", "session-extra-b", 8, 8],
    ] as const)
      insertExtraGroup.run(
        visitId,
        visitorId,
        sessionId,
        time,
        time,
        duration,
        sitePk,
      );
    insertExtraGroup.run(
      "boundary-abs-min",
      "boundary-abs-min-visitor",
      "session-null",
      9,
      9,
      "-9223372036854775808",
      sitePk,
    );
    expect(
      (
        db
          .prepare(
            "SELECT typeof(duration_ms) AS storage_class FROM visits WHERE visit_id = ?",
          )
          .get("boundary-abs-min") as { storage_class: string }
      ).storage_class,
    ).toBe("integer");
    const totalGroups = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT session_id) AS group_count FROM visits WHERE site_id = ? AND status = ?",
        )
        .get("bounded-group-site", "complete") as { group_count: number }
    ).group_count;
    expect(totalGroups).toBeGreaterThan(3);

    const buildWindowQuery = (
      options: {
        readonly parentLimit?: boolean;
        readonly parentSort?: boolean;
        readonly externalProjection?: boolean;
        readonly candidateWidth?: number;
        readonly aliasCandidateFields?: boolean;
        readonly cap?: number;
        readonly unsafeBoundaryExpression?: boolean;
        readonly unsafeExpression?: "clock" | "abs-int64-min";
      } = {},
    ) => {
      const { grouped } = buildQuery({
        cap: options.cap ?? 3,
        unsafeBoundaryAbs: options.unsafeBoundaryExpression,
      });
      const groupedRelation = grouped as GroupedRelation;
      const summary = summaryProjection(groupedRelation);
      const detail = detailProjection(groupedRelation, 0);
      const candidateInput = options.parentLimit
        ? (limit(detail, 3) as AnyRelation)
        : options.parentSort
          ? (sort(detail, [
              { expression: detail.columns.sessionId!, direction: "ASC" },
            ]) as AnyRelation)
          : detail;
      let candidateSource = candidateInput;
      if (options.unsafeExpression === "abs-int64-min") {
        const visits = scan(schema.visits);
        const minRow = filter(
          visits,
          eq(visits.columns.visit_id, param("boundary-abs-min")),
        );
        candidateSource = join(
          candidateInput,
          minRow,
          eq(
            candidateInput.columns.sessionId! as never,
            minRow.columns.session_id as never,
          ),
        ) as AnyRelation;
      }
      const candidateInputColumns = candidateSource.columns as Readonly<
        Record<string, AnyExpression>
      >;
      const candidateSourceColumn = (name: string) =>
        candidateInputColumns[
          options.unsafeExpression === "abs-int64-min" ? `left_${name}` : name
        ]!;
      const externalSource = options.externalProjection
        ? scan(schema.site_identities)
        : undefined;
      const correlatedExternal = externalSource
        ? filter(
            externalSource,
            eq(
              externalSource.columns.site_id,
              candidateInputColumns.sessionId!,
            ),
          )
        : undefined;
      const externalValue =
        externalSource && correlatedExternal
          ? scalar(
              project(correlatedExternal, {
                value: correlatedExternal.columns.site_pk,
              }),
            )
          : undefined;
      const fieldName = (index: number) =>
        `${options.aliasCandidateFields ? "alias" : "field"}${index}`;
      const candidateProjections: Record<string, AnyExpression> = {
        [fieldName(0)]: candidateSourceColumn("sessionId"),
        [fieldName(1)]: candidateSourceColumn("rowCount"),
        [fieldName(2)]: candidateSourceColumn("durationSource"),
        [fieldName(3)]: candidateSourceColumn("rowCount"),
        [fieldName(4)]: candidateSourceColumn("sessionId"),
        [fieldName(5)]: candidateSourceColumn("rowCount"),
      };
      const width = options.candidateWidth ?? 7;
      for (let index = 6; index < width; index++)
        candidateProjections[fieldName(index)] =
          index === 6 && options.unsafeExpression === "clock"
            ? unixepoch()
            : index === 6 && options.unsafeExpression === "abs-int64-min"
              ? callFunction(
                  "abs",
                  candidateInputColumns.right_duration_ms! as SqlExpression<
                    number | null
                  >,
                )
              : index === 6
                ? (externalValue ?? candidateSourceColumn("sessionId"))
                : candidateSourceColumn("sessionId");
      const candidate = project(
        candidateSource,
        candidateProjections,
      ) as AnyRelation;
      const candidateColumns = candidate.columns as Readonly<
        Record<string, AnyExpression>
      >;
      const candidateField = (index: number) =>
        candidateColumns[fieldName(index)]!;
      const ascending = window(candidate, {
        rank: rowNumber({
          partitionBy: [candidateField(0)],
          orderBy: [
            { expression: candidateField(0), direction: "ASC" },
            { expression: candidateField(1), direction: "ASC" },
            { expression: candidateField(2), direction: "ASC" },
          ],
        }),
      }) as AnyRelation;
      const descending = window(candidate, {
        rank: rowNumber({
          partitionBy: [candidateField(0)],
          orderBy: [
            { expression: candidateField(0), direction: "DESC" },
            { expression: candidateField(1), direction: "DESC" },
            { expression: candidateField(2), direction: "DESC" },
          ],
        }),
      }) as AnyRelation;
      const ascendingColumns = ascending.columns as Readonly<
        Record<string, AnyExpression>
      >;
      const descendingColumns = descending.columns as Readonly<
        Record<string, AnyExpression>
      >;
      const windowOutput = (relation: AnyRelation): AnyRelation => {
        const columns = relation.columns as Readonly<
          Record<string, AnyExpression>
        >;
        return project(relation, {
          rowKind: param("detail"),
          sessionId: columns[fieldName(0)]!,
          durationSource: columns[fieldName(2)]!,
          rowCount: columns.rank!,
          durationSum:
            options.unsafeExpression === "abs-int64-min"
              ? columns[fieldName(6)]!
              : param<number | null>(null),
          groupCount: param<number | null>(null),
        }) as AnyRelation;
      };
      const ascendingOutput = windowOutput(ascending);
      const descendingOutput = windowOutput(descending);
      const simpleOutput = project(candidate, {
        rowKind: param("detail"),
        sessionId: candidateField(0),
        durationSource: candidateField(2),
        rowCount: candidateField(1),
        durationSum:
          options.unsafeExpression === "abs-int64-min"
            ? candidateField(6)
            : param<number | null>(null),
        groupCount: param<number | null>(null),
      }) as AnyRelation;
      const windowOutputs = union(
        ascendingOutput,
        descendingOutput,
        true,
      ) as AnyRelation;
      const candidateOutputs = union(
        windowOutputs,
        simpleOutput,
        true,
      ) as AnyRelation;
      return {
        candidate,
        grouped,
        output: union(summary, candidateOutputs, true) as AnyRelation,
      };
    };
    const assertEquivalent = (query: AnyRelation) => {
      const physical = lowerLogicalPlan(query);
      const optimized = compileD1Query(physical);
      const unoptimized = compileD1QueryUnoptimizedForTest(query);
      expect(rowBag(execute(db, optimized))).toEqual(
        rowBag(execute(db, unoptimized)),
      );
      return { physical, optimized, unoptimized };
    };

    const accepted = buildWindowQuery();
    const acceptedResult = assertEquivalent(accepted.output);
    const acceptedRows = execute(db, acceptedResult.optimized);
    const summaryRow = acceptedRows.find((row) => row.rowKind === "summary");
    const selectedGroupCount = new Set(
      acceptedRows
        .filter((row) => row.rowKind === "detail")
        .map((row) => JSON.stringify([row.sessionId, row.durationSource])),
    ).size;
    expect(selectedGroupCount).toBeGreaterThan(0);
    expect(selectedGroupCount).toBeLessThan(totalGroups);
    const unboundedRows = execute(
      db,
      compileD1QueryUnoptimizedForTest(buildWindowQuery({ cap: 100 }).output),
    );
    const unboundedGroupCount = new Set(
      unboundedRows
        .filter((row) => row.rowKind === "detail")
        .map((row) => JSON.stringify([row.sessionId, row.durationSource])),
    ).size;
    expect(unboundedGroupCount).toBeGreaterThan(selectedGroupCount);
    expect(summaryRow?.groupCount).toBe(selectedGroupCount);
    const boundary = acceptedResult.physical.sharedRelations.find(
      ({ node }) => node === accepted.grouped.node,
    );
    const parent = acceptedResult.physical.sharedRelations.find(
      ({ node }) => node === accepted.candidate.node,
    );
    expect(boundary).toMatchObject({ materialization: "materialized" });
    expect(parent).toMatchObject({ materialization: "materialized" });
    expect(parent?.dependencies).toContain(boundary?.name);

    const boundaryCteIndex = acceptedResult.optimized.sql.indexOf(
      `${boundary!.name} AS MATERIALIZED (`,
    );
    const parentCteIndex = acceptedResult.optimized.sql.indexOf(
      `${parent!.name} AS MATERIALIZED (`,
    );
    const boundaryLimitIndex = acceptedResult.optimized.sql
      .toUpperCase()
      .indexOf("LIMIT", boundaryCteIndex);
    expect(boundaryCteIndex).toBeGreaterThanOrEqual(0);
    expect(parentCteIndex).toBeGreaterThan(boundaryCteIndex);
    expect(boundaryLimitIndex).toBeGreaterThan(boundaryCteIndex);
    expect(boundaryLimitIndex).toBeLessThan(parentCteIndex);
    expect(acceptedResult.optimized.sql.match(/\bLIMIT\b/giu)).toHaveLength(1);
    expect(
      acceptedResult.unoptimized.sql.match(/\bLIMIT\b/giu)?.length,
    ).toBeGreaterThan(1);
    expect(
      acceptedResult.optimized.sql.match(/\bOFFSET\b/giu) ?? [],
    ).toHaveLength(0);

    for (const options of [
      { parentLimit: true },
      { parentSort: true },
      { externalProjection: true },
      { unsafeExpression: "clock" as const },
      { candidateWidth: 17 },
    ] as const) {
      const rejected = buildWindowQuery(options);
      const rejectedResult = assertEquivalent(rejected.output);
      expect(
        rejectedResult.physical.sharedRelations.some(
          ({ node }) => node === rejected.candidate.node,
        ),
      ).toBe(false);
      const forged = {
        ...rejectedResult.physical,
        sharedRelations: [
          ...rejectedResult.physical.sharedRelations,
          {
            name: "_d1_forged_boundary",
            node: rejected.candidate.node,
            scope: rejected.candidate.scope,
            fields: rejected.candidate.fields,
            dependencies: [],
            materialization: "materialized" as const,
          },
        ],
      };
      expect(() => compileD1Query(forged)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );
    }

    const absAtIntegerBoundary = buildWindowQuery({
      unsafeExpression: "abs-int64-min",
    });
    const absPhysical = lowerLogicalPlan(absAtIntegerBoundary.output);
    expect(
      absPhysical.sharedRelations.some(
        ({ node }) => node === absAtIntegerBoundary.candidate.node,
      ),
    ).toBe(false);
    const optimizedAbs = compileD1Query(absPhysical);
    const unoptimizedAbs = compileD1QueryUnoptimizedForTest(
      absAtIntegerBoundary.output,
    );
    expect(() => execute(db, optimizedAbs)).toThrow(/integer overflow/i);
    expect(() => execute(db, unoptimizedAbs)).toThrow(/integer overflow/i);

    const absInsideBoundary = buildWindowQuery({
      cap: 100,
      unsafeBoundaryExpression: true,
    });
    const absInsideBoundaryPhysical = lowerLogicalPlan(
      absInsideBoundary.output,
    );
    expect(
      absInsideBoundaryPhysical.sharedRelations.some(
        ({ node }) => node === absInsideBoundary.candidate.node,
      ),
    ).toBe(false);
    const optimizedBoundaryAbs = compileD1Query(absInsideBoundaryPhysical);
    const unoptimizedBoundaryAbs = compileD1QueryUnoptimizedForTest(
      absInsideBoundary.output,
    );
    expect(() => execute(db, optimizedBoundaryAbs)).toThrow(
      /integer overflow/i,
    );
    expect(() => execute(db, unoptimizedBoundaryAbs)).toThrow(
      /integer overflow/i,
    );

    for (const options of [
      { candidateWidth: 6 },
      { candidateWidth: 9, aliasCandidateFields: true },
    ] as const) {
      const accepted = buildWindowQuery(options);
      const acceptedResult = assertEquivalent(accepted.output);
      const boundary = acceptedResult.physical.sharedRelations.find(
        ({ node }) => node === accepted.grouped.node,
      );
      const parent = acceptedResult.physical.sharedRelations.find(
        ({ node }) => node === accepted.candidate.node,
      );
      expect(boundary).toMatchObject({ materialization: "materialized" });
      expect(parent).toMatchObject({ materialization: "materialized" });
      expect(parent?.dependencies).toContain(boundary?.name);
    }
  });
  it("reuses the bounded summary across an output ordering branch", () => {
    const { grouped, output } = buildQuery({ detailSort: true });
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === grouped.node),
    ).toMatchObject({ materialization: "materialized" });
  });

  it("requires a proven key and does not trust union branch tags", () => {
    const safe = buildQuery({ outerDetailWindow: true });
    expect(
      lowerLogicalPlan(safe.output).sharedRelations.find(
        ({ node }) => node === safe.grouped.node,
      ),
    ).toMatchObject({ materialization: "materialized" });

    for (const outerWindow of ["unique", "ties", "count-rows"] as const) {
      const unsafe = buildQuery({ outerWindow });
      expect(
        lowerLogicalPlan(unsafe.output).sharedRelations.some(
          ({ node }) => node === unsafe.grouped.node,
        ),
      ).toBe(false);
    }
  });

  it("isolates semi/anti right membership from the external left window", () => {
    for (const [options, expectedPageRows] of [
      [{ duplicateRight: true }, 2],
      [{ rightEmpty: true }, 0],
      [{ anti: true, duplicateRight: true }, 2],
    ] as const) {
      const db = database();
      const { grouped, output } = membershipWindowQuery(options);
      const physical = lowerLogicalPlan(output);
      expect(
        physical.sharedRelations.find(({ node }) => node === grouped.node),
      ).toMatchObject({ materialization: "materialized" });

      const optimizedRows = execute(db, compileD1Query(physical));
      const originalRows = execute(
        db,
        compileD1QueryUnoptimizedForTest(output),
      );
      expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
      expect(
        optimizedRows.filter((row) => row.rowKind === "page"),
      ).toHaveLength(expectedPageRows);
    }
  });

  it("does not let a membership edge hide another direct window or limit", () => {
    for (const directBranch of ["window", "limit"] as const) {
      const { grouped, output } = membershipWindowQuery({
        duplicateRight: true,
        directBranch,
      });
      expect(
        lowerLogicalPlan(output).sharedRelations.some(
          ({ node }) => node === grouped.node,
        ),
      ).toBe(false);
    }
  });

  it("checks truncated results only through summary/details invariants", () => {
    const db = database();
    const { grouped, output } = buildQuery({ cap: 3 });
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.some(({ node }) => node === grouped.node),
    ).toBe(true);
    const rows = execute(db, compileD1Query(physical));
    const summary = rows.find((row) => row.rowKind === "summary");
    const details = rows.filter((row) => row.rowKind === "detail");
    expect(
      details.reduce((total, row) => total + Number(row.rowCount), 0),
    ).toBeLessThanOrEqual(3);
    expect(summary?.groupCount).toBe(details.length);
    expect(summary?.rowCount).toBe(
      details.reduce((total, row) => total + Number(row.rowCount), 0),
    );
    const detailDuration = details.reduce(
      (total, row) =>
        total + (typeof row.durationSum === "number" ? row.durationSum : 0),
      0,
    );
    expect(summary?.durationSum).toBe(
      detailDuration === 0 ? null : detailDuration,
    );
  });

  it("rejects structurally similar groups without the exact consumer pair", () => {
    for (const consumers of [
      "summary-only",
      "project",
      "different-nodes",
    ] as const) {
      const { grouped, output } = buildQuery({ consumers });
      expect(
        lowerLogicalPlan(output).sharedRelations.some(
          ({ node }) => node === grouped.node,
        ),
      ).toBe(false);
    }
  });

  it("rejects over-wide, offset, outer-barrier, and unsafe input shapes", () => {
    for (const options of [
      { wideGroups: true },
      { offset: 1 },
      { outerLimit: true },
      { inputBarrier: "sort" as const },
      { inputBarrier: "window" as const },
      { inputBarrier: "recursive" as const },
      { inputBarrier: "subquery" as const },
    ]) {
      const { grouped, output } = buildQuery(options);
      expect(
        lowerLogicalPlan(output).sharedRelations.some(
          ({ node }) => node === grouped.node,
        ),
      ).toBe(false);
    }
  });
});
