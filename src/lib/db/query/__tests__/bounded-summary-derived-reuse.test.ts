import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  callFunction,
  compileD1Query,
  count,
  distinct,
  eq,
  filter,
  gt,
  join,
  limit,
  min,
  param,
  project,
  scalar,
  scan,
  sort,
  sum,
  union,
  unixepoch,
  valuesRelation,
  window,
  windowCountRows,
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
type Barrier = "sort" | "limit" | "window" | "distinct" | "union";
type UnsafeProjection = "abs" | "unixepoch" | "correlated-scalar";

interface ScenarioOptions {
  readonly barrier?: Barrier;
  readonly unsafeProjection?: UnsafeProjection;
  readonly extraScan?: boolean;
  readonly nonScalarJoin?: boolean;
  readonly falseConsumers?: boolean;
}

const databases = new Set<DatabaseSync>();
const siteId = "bounded-derived-site";

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function database(): DatabaseSync {
  const db = createMigratedDatabase();
  databases.add(db);
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(siteId);
  const sitePk = Number(
    (
      db
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number }
    ).site_pk,
  );
  db.exec(`
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, duration_ms, pathname, hostname, site_pk
    ) VALUES
      ('derived-min', '${siteId}', 'visitor-a', 'session-a', 'complete', 1, 1, -9223372036854775808, '/', 'example.test', ${sitePk}),
      ('derived-normal', '${siteId}', 'visitor-b', 'session-b', 'complete', 2, 2, 5, '/', 'example.test', ${sitePk})
  `);
  return db;
}

function scenario(options: ScenarioOptions = {}): {
  readonly output: AnyRelation;
  readonly derived: AnyRelation;
} {
  const visits = scan(schema.visits);
  const filteredVisits = filter(
    visits,
    eq(visits.columns.status, param("complete")),
  );
  const dimension = valuesRelation(
    { siteId: { affinity: "text", nullable: false } },
    [{ siteId }],
  );
  const joined = join(
    filteredVisits,
    dimension,
    eq(filteredVisits.columns.site_id, dimension.columns.siteId),
    "left",
  );
  const joinedColumns = joined.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const groupedInput = project(joined, {
    siteId: joinedColumns.left_site_id!,
    visitorId: joinedColumns.left_visitor_id!,
    duration: joinedColumns.left_duration_ms!,
  }) as AnyRelation;
  const boundedInput = limit(groupedInput, 100) as AnyRelation;
  const grouped = aggregate(boundedInput, {
    groupBy: {
      siteId: boundedInput.columns.siteId!,
      visitorId: boundedInput.columns.visitorId!,
    },
    aggregates: {
      rowCount: count(),
      minDuration: min(
        boundedInput.columns.duration as SqlExpression<number | null>,
      ),
    },
  }) as AnyRelation;
  const summary = aggregate(grouped, {
    groupBy: {},
    aggregates: {
      groupCount: count(),
      totalRows: sum(grouped.columns.rowCount as SqlExpression<number | null>),
    },
  });
  const detail = filter(
    grouped,
    gt(
      grouped.columns.rowCount as SqlExpression<number | null>,
      param(0) as never,
    ),
  ) as AnyRelation;
  let detailInput: AnyRelation = filter(
    detail,
    eq(
      detail.columns.siteId as SqlExpression<string | null>,
      param(siteId) as never,
    ),
  ) as AnyRelation;

  if (options.barrier === "sort")
    detailInput = awaitSort(detailInput) as AnyRelation;
  else if (options.barrier === "limit")
    detailInput = limit(detailInput, 10) as AnyRelation;
  else if (options.barrier === "window")
    detailInput = window(detailInput, {
      windowRows: windowCountRows(),
    }) as AnyRelation;
  else if (options.barrier === "distinct")
    detailInput = distinctRelation(detailInput);
  else if (options.barrier === "union")
    detailInput = union(detailInput, detailInput, true) as AnyRelation;

  if (options.falseConsumers)
    detailInput = filter(
      detailInput,
      eq(
        detailInput.columns.siteId as SqlExpression<string | null>,
        param("missing-site") as never,
      ),
    ) as AnyRelation;

  let derived: AnyRelation;
  if (options.extraScan) {
    const identities = scan(schema.site_identities);
    const extraJoin = join(
      detailInput,
      identities,
      eq(
        detailInput.columns.siteId as SqlExpression<string | null>,
        identities.columns.site_id as never,
      ),
      "inner",
    );
    const columns = extraJoin.columns as Readonly<
      Record<string, AnyExpression>
    >;
    derived = project(extraJoin, {
      siteId: columns.left_siteId!,
      rowCount: columns.left_rowCount!,
      minDuration: columns.left_minDuration!,
    }) as AnyRelation;
  } else if (options.nonScalarJoin) {
    const selfJoin = join(
      detailInput,
      detailInput,
      eq(param(1), param(1)),
      "inner",
    );
    const columns = selfJoin.columns as Readonly<Record<string, AnyExpression>>;
    derived = project(selfJoin, {
      siteId: columns.left_siteId!,
      rowCount: columns.left_rowCount!,
      minDuration: columns.left_minDuration!,
    }) as AnyRelation;
  } else {
    const projections: Record<string, AnyExpression> = {
      siteId: detailInput.columns.siteId!,
      rowCount: detailInput.columns.rowCount!,
      minDuration: detailInput.columns.minDuration!,
    };
    if (options.unsafeProjection === "abs")
      projections.unsafe = callFunction(
        "abs",
        detailInput.columns.minDuration as SqlExpression<number | null>,
      );
    else if (options.unsafeProjection === "unixepoch")
      projections.unsafe = unixepoch() as AnyExpression;
    else if (options.unsafeProjection === "correlated-scalar") {
      const identities = scan(schema.site_identities);
      const correlated = filter(
        identities,
        eq(
          detailInput.columns.siteId as SqlExpression<string | null>,
          identities.columns.site_id as never,
        ),
      );
      projections.unsafe = scalar(
        project(correlated, { siteId: correlated.columns.site_id }),
      );
    }
    derived = project(detailInput, projections) as AnyRelation;
  }

  const firstOutput = options.falseConsumers
    ? filter(
        derived,
        eq(
          derived.columns.siteId as SqlExpression<string | null>,
          param("missing-site") as never,
        ),
      )
    : project(derived, {
        siteId: derived.columns.siteId!,
        rowCount: derived.columns.rowCount!,
      });
  const secondOutput = options.falseConsumers
    ? filter(
        derived,
        eq(
          derived.columns.siteId as SqlExpression<string | null>,
          param("missing-site") as never,
        ),
      )
    : project(derived, {
        siteId: derived.columns.siteId!,
        rowCount: derived.columns.rowCount!,
      });
  const firstRows = project(firstOutput, {
    siteId: firstOutput.columns.siteId!,
    rowCount: firstOutput.columns.rowCount!,
  });
  const secondRows = project(secondOutput, {
    siteId: secondOutput.columns.siteId!,
    rowCount: secondOutput.columns.rowCount!,
  });
  const details = union(firstRows, secondRows, true);
  const summaryRow = project(summary, {
    siteId: param(siteId),
    rowCount: summary.columns.groupCount,
  });
  return {
    output: union(details, summaryRow, true) as AnyRelation,
    derived,
  };
}

function awaitSort(input: AnyRelation): AnyRelation {
  return sort(input, [
    { expression: input.columns.siteId!, direction: "ASC" },
  ]) as AnyRelation;
}

function distinctRelation(input: AnyRelation): AnyRelation {
  return distinct(input) as AnyRelation;
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

function rowBag(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

describe("bounded summary derived reuse review", () => {
  it("materializes a closed derived filter/project and preserves SQLite bag results", () => {
    const db = database();
    const { output, derived } = scenario();
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === derived.node),
    ).toMatchObject({
      materialization: "materialized",
      fields: derived.fields,
    });
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();

    const optimized = compileD1Query(physical);
    const original = compileD1QueryUnoptimizedForTest(output);
    const optimizedRows = execute(db, optimized);
    const originalRows = execute(db, original);
    expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
    expect(optimizedRows).toHaveLength(5);
  });

  it("does not share unsafe expressions, extra scans, barriers, or unbounded joins", () => {
    const controls: ScenarioOptions[] = [
      { unsafeProjection: "abs" },
      { unsafeProjection: "unixepoch" },
      { unsafeProjection: "correlated-scalar" },
      { extraScan: true },
      { nonScalarJoin: true },
      ...(["sort", "limit", "window", "distinct", "union"] as const).map(
        (barrier) => ({ barrier }),
      ),
    ];
    for (const options of controls) {
      const { output, derived } = scenario(options);
      const physical = lowerLogicalPlan(output);
      expect(
        physical.sharedRelations.some(({ node }) => node === derived.node),
        JSON.stringify(options),
      ).toBe(false);
      expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
    }
  });

  it("keeps false consumers from evaluating ABS(INT64_MIN) early", () => {
    const db = database();
    const { output, derived } = scenario({
      unsafeProjection: "abs",
      falseConsumers: true,
    });
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.some(({ node }) => node === derived.node),
    ).toBe(false);

    const optimized = compileD1Query(physical);
    const original = compileD1QueryUnoptimizedForTest(output);
    expect(rowBag(execute(db, optimized))).toEqual(
      rowBag(execute(db, original)),
    );
    expect(execute(db, optimized)).toHaveLength(1);
  });

  it("shares a scalar COUNT_ROWS control joined to two derived consumers", () => {
    const db = database();
    const source = valuesRelation(
      { siteId: { affinity: "text", nullable: false } },
      [{ siteId: "derived-site-a" }, { siteId: "derived-site-b" }],
    ) as AnyRelation;
    const derived = aggregate(source, {
      groupBy: { siteId: source.columns.siteId! },
      aggregates: { rowCount: count() },
    }) as AnyRelation;
    const controls = aggregate(derived, {
      groupBy: {},
      aggregates: { controlCount: count() },
    }) as AnyRelation;
    const firstJoin = join(derived, controls, eq(param(1), param(1)), "inner");
    const secondJoin = join(derived, controls, eq(param(1), param(1)), "inner");
    const firstColumns = firstJoin.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const secondColumns = secondJoin.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const first = project(firstJoin, {
      siteId: firstColumns.left_siteId!,
      rowCount: firstColumns.left_rowCount!,
      controlCount: firstColumns.right_controlCount!,
    }) as AnyRelation;
    const second = project(secondJoin, {
      siteId: secondColumns.left_siteId!,
      rowCount: secondColumns.left_rowCount!,
      controlCount: secondColumns.right_controlCount!,
    }) as AnyRelation;
    const output = union(first, second, true) as AnyRelation;
    const physical = lowerLogicalPlan(output);

    expect(
      physical.sharedRelations.find(({ node }) => node === controls.node),
    ).toMatchObject({
      materialization: "materialized",
      fields: controls.fields,
    });
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();

    const optimized = compileD1Query(physical);
    const original = compileD1QueryUnoptimizedForTest(output);
    const optimizedRows = execute(db, optimized);
    const originalRows = execute(db, original);
    expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
    expect(
      optimizedRows
        .filter((row) => "controlCount" in row)
        .map((row) => row.controlCount),
    ).toEqual([2, 2, 2, 2]);
  });
});
