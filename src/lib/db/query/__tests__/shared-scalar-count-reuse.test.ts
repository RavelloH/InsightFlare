import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  callFunction,
  caseWhen,
  coalesce,
  compileD1Query,
  constant,
  count,
  countDistinct,
  eq,
  filter,
  gt,
  isNull,
  join,
  jsonScalarArray,
  limit,
  param,
  project,
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
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type {
  AnyExpression,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import {
  inspectTotalMaterializationSubtree,
  isMaterializationSafeAggregateExpression,
  isMaterializationSafeExpression,
} from "@/lib/db/query/materialization-safety";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type { LogicalQueryNode, Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;
type TopKMutation =
  | "missing-group-key"
  | "transformed-group-key"
  | "wrong-index-group-key"
  | "unordered-limit"
  | "left-join"
  | "left-join-ancestor"
  | "non-scalar-join"
  | "window-sibling"
  | "window-ancestor"
  | "union-pseudo-tag";

interface OverviewOptions {
  readonly allowedSiteId?: string;
  readonly mutation?: TopKMutation;
  readonly volatileCountInput?: boolean;
  readonly correlatedCountInput?: boolean;
}

interface OverviewPlan {
  readonly output: AnyRelation;
  readonly controls: AnyRelation;
  readonly countInput: AnyRelation;
}

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function database(): DatabaseSync {
  const db = createMigratedDatabase();
  databases.add(db);
  return db;
}

function equals(left: AnyExpression, right: AnyExpression): Predicate {
  return eq(left, right as never);
}

function alwaysTrue(): Predicate {
  return eq(constant(1), constant(1));
}

function eventsForOverview(): AnyRelation {
  const rows = [
    { groupValue: null },
    ...Array.from({ length: 8 }, (_unused, index) => ({
      groupValue: `value-${String(index + 1).padStart(2, "0")}`,
    })),
    { groupValue: "excluded-group" },
  ];

  return valuesRelation(
    {
      groupValue: { affinity: "text", nullable: true },
    },
    rows,
  ) as AnyRelation;
}

function buildOverview(options: OverviewOptions = {}): OverviewPlan {
  const events = eventsForOverview();
  const lookupSeed = valuesRelation(
    { seed: { affinity: "text", nullable: false } },
    [],
  ) as AnyRelation;
  const lookupRow = aggregate(lookupSeed, {
    groupBy: {},
    aggregates: { rowCount: count() },
  }) as AnyRelation;
  const lookups = project(lookupRow, {
    lookupKey: constant("value-01"),
  }) as AnyRelation;
  const leftLookup = join(
    events,
    lookups,
    equals(events.columns.groupValue!, lookups.columns.lookupKey!),
    "left",
  ) as AnyRelation;
  const lookupColumns = leftLookup.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const withResourceKey = project(leftLookup, {
    groupValue: lookupColumns.left_groupValue!,
    lookupKey: lookupColumns.right_lookupKey!,
    siteId: caseWhen(
      [
        {
          when: equals(
            lookupColumns.left_groupValue!,
            constant("excluded-group"),
          ),
          then: constant("excluded-site"),
        },
      ],
      constant("admitted-site"),
    ),
  }) as AnyRelation;
  let countInput = filter(
    withResourceKey,
    equals(
      withResourceKey.columns.siteId!,
      constant(options.allowedSiteId ?? "admitted-site"),
    ),
  ) as AnyRelation;
  if (options.volatileCountInput) {
    countInput = filter(
      countInput,
      equals(unixepoch() as AnyExpression, param(0)),
    ) as AnyRelation;
  } else if (options.correlatedCountInput) {
    const correlated = filter(
      lookups,
      equals(lookups.columns.lookupKey!, countInput.columns.groupValue!),
    );
    const scalarSite = scalar(
      project(correlated, { lookupKey: correlated.columns.lookupKey! }),
    ) as AnyExpression;
    countInput = filter(
      countInput,
      equals(scalarSite, param("value-01")),
    ) as AnyRelation;
  }
  const countColumns = countInput.columns as Readonly<
    Record<string, AnyExpression>
  >;

  const controls = aggregate(countInput, {
    groupBy: {},
    aggregates: { scopedEvents: count() },
  }) as AnyRelation;
  const summarySeed = valuesRelation(
    { seed: { affinity: "text", nullable: false } },
    [],
  ) as AnyRelation;
  const summaryDecoration = aggregate(summarySeed, {
    groupBy: {},
    aggregates: { rowCount: count() },
  }) as AnyRelation;
  const summaryJoin = join(controls, summaryDecoration, alwaysTrue(), "inner");
  const summaryColumns = summaryJoin.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const summary = project(summaryJoin, {
    cardType: constant("summary"),
    value: constant(null),
    events: summaryColumns.left_scopedEvents!,
    sessions: summaryColumns.left_scopedEvents!,
    scopedEvents: summaryColumns.left_scopedEvents!,
  }) as AnyRelation;

  const dimensions = [
    { label: "page", field: countColumns.groupValue! },
    { label: "country", field: countColumns.groupValue! },
    { label: "device", field: countColumns.groupValue! },
    { label: "browser", field: countColumns.groupValue! },
  ];
  const topK = dimensions.map(({ label, field }) => {
    const grouped = aggregate(countInput, {
      groupBy: { value: field },
      aggregates: {
        events: count(),
        sessions: countDistinct(
          coalesce(
            countColumns.groupValue as SqlExpression<string | null>,
            constant("null-session"),
          ),
        ),
      },
    }) as AnyRelation;
    let groupRows = grouped;
    if (options.mutation === "window-sibling" && label === "page") {
      groupRows = window(grouped, {
        rank: rowNumber({
          orderBy: [{ expression: grouped.columns.value!, direction: "ASC" }],
        }),
      }) as AnyRelation;
    }
    const joinType =
      options.mutation === "left-join" && label === "page" ? "left" : "inner";
    const countJoin = join(
      groupRows,
      controls,
      alwaysTrue(),
      joinType,
    ) as AnyRelation;
    let displaySource = countJoin;
    let valueColumn = (
      countJoin.columns as Readonly<Record<string, AnyExpression>>
    ).left_value!;
    if (options.mutation === "non-scalar-join" && label === "page") {
      displaySource = join(
        countJoin,
        grouped,
        alwaysTrue(),
        "inner",
      ) as AnyRelation;
      valueColumn = (
        displaySource.columns as Readonly<Record<string, AnyExpression>>
      ).left_left_value!;
    }
    const columns = displaySource.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const nested = options.mutation === "non-scalar-join" && label === "page";
    const prefix = nested ? "left_left_" : "left_";
    if (options.mutation === "transformed-group-key" && label === "page")
      valueColumn = callFunction(
        "lower",
        valueColumn as SqlExpression<string | null>,
      );
    let display = project(displaySource, {
      cardType: constant(label),
      value: valueColumn,
      events: columns[`${prefix}events`]!,
      sessions: columns[`${prefix}sessions`]!,
      scopedEvents:
        columns[nested ? "left_right_scopedEvents" : "right_scopedEvents"]!,
    }) as AnyRelation;

    if (options.mutation === "left-join-ancestor" && label === "page") {
      const extra = valuesRelation(
        { tag: { affinity: "text", nullable: false } },
        [{ tag: "left-join-ancestor" }],
      ) as AnyRelation;
      const outerJoin = join(
        display,
        extra,
        alwaysTrue(),
        "left",
      ) as AnyRelation;
      const columns = outerJoin.columns as Readonly<
        Record<string, AnyExpression>
      >;
      display = project(outerJoin, {
        cardType: columns.left_cardType!,
        value: columns.left_value!,
        events: columns.left_events!,
        sessions: columns.left_sessions!,
        scopedEvents: columns.left_scopedEvents!,
      }) as AnyRelation;
    }

    if (options.mutation === "wrong-index-group-key" && label === "page") {
      const displayColumns = display.columns as Readonly<
        Record<string, AnyExpression>
      >;
      display = project(display, {
        cardType: displayColumns.cardType!,
        value: displayColumns.cardType!,
        events: displayColumns.events!,
        sessions: displayColumns.sessions!,
        scopedEvents: displayColumns.scopedEvents!,
      }) as AnyRelation;
    }

    if (options.mutation === "window-ancestor" && label === "page") {
      const windowed = window(display, {
        rank: rowNumber({
          orderBy: [{ expression: display.columns.value!, direction: "ASC" }],
        }),
      }) as AnyRelation;
      const columns = windowed.columns as Readonly<
        Record<string, AnyExpression>
      >;
      display = project(windowed, {
        cardType: columns.cardType!,
        value: columns.value!,
        events: columns.events!,
        sessions: columns.sessions!,
        scopedEvents: columns.scopedEvents!,
      }) as AnyRelation;
    }

    if (options.mutation === "union-pseudo-tag" && label === "page") {
      const tagged = project(display, {
        cardType: param("pseudo-branch-tag"),
        value: display.columns.value!,
        events: display.columns.events!,
        sessions: display.columns.sessions!,
        scopedEvents: display.columns.scopedEvents!,
      }) as AnyRelation;
      display = union(display, tagged, true) as AnyRelation;
    }

    if (options.mutation === "unordered-limit" && label === "page")
      return limit(display, 8) as AnyRelation;

    const keys =
      options.mutation === "missing-group-key" && label === "page"
        ? [
            { expression: display.columns.events!, direction: "DESC" as const },
            {
              expression: display.columns.sessions!,
              direction: "DESC" as const,
            },
          ]
        : [
            { expression: display.columns.events!, direction: "DESC" as const },
            {
              expression: display.columns.sessions!,
              direction: "DESC" as const,
            },
            { expression: display.columns.value!, direction: "ASC" as const },
          ];
    return limit(sort(display, keys) as AnyRelation, 8) as AnyRelation;
  });

  let output = summary;
  for (const branch of topK)
    output = union(output, branch, true) as AnyRelation;
  output = sort(output, [
    { expression: output.columns.cardType!, direction: "ASC" },
    { expression: output.columns.value!, direction: "ASC" },
  ]) as AnyRelation;
  return { output, controls, countInput };
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

function assertCountNotMaterialized(
  output: AnyRelation,
  countNode: LogicalQueryNode,
) {
  const physical = lowerLogicalPlan(output);
  expect(physical.sharedRelations.some(({ node }) => node === countNode)).toBe(
    false,
  );
  expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
  return physical;
}

function seedVisit(db: DatabaseSync, siteId: string, visitId: string): void {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(siteId);
  const sitePk = Number(
    (
      db
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number }
    ).site_pk,
  );
  db.prepare(
    `
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, duration_ms, pathname, hostname, site_pk
    ) VALUES (?, ?, 'visitor-a', 'session-a', 'complete', 1, 1, 1, '/', 'example.test', ?)
  `,
  ).run(visitId, siteId, sitePk);
}

function boundedAdmissionControl(siteId: string): AnyRelation {
  const source = scan(schema.visits) as AnyRelation;
  const completed = filter(
    source,
    equals(source.columns.status!, param("complete")),
  ) as AnyRelation;
  const admittedSite = valuesRelation(
    { siteId: { affinity: "text", nullable: false } },
    [{ siteId }],
  ) as AnyRelation;
  const admittedVisits = join(
    completed,
    admittedSite,
    equals(completed.columns.site_id!, admittedSite.columns.siteId!),
    "inner",
  );
  const admittedColumns = admittedVisits.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const boundedInput = limit(
    project(admittedVisits, {
      siteId: admittedColumns.right_siteId!,
    }) as AnyRelation,
    100,
  ) as AnyRelation;
  const grouped = aggregate(boundedInput, {
    groupBy: { siteId: boundedInput.columns.siteId! },
    aggregates: { rowCount: count() },
  }) as AnyRelation;
  const summary = aggregate(grouped, {
    groupBy: {},
    aggregates: { groupCount: count() },
  }) as AnyRelation;
  const details = filter(
    grouped,
    gt(
      grouped.columns.rowCount as SqlExpression<number | null>,
      param(0) as never,
    ),
  ) as AnyRelation;
  const detailSummary = aggregate(details, {
    groupBy: {},
    aggregates: { detailCount: count() },
  }) as AnyRelation;
  const paired = join(summary, detailSummary, alwaysTrue(), "inner");
  const pairedColumns = paired.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const projected = project(paired, {
    siteId: constant(siteId),
    groupCount: pairedColumns.left_groupCount!,
    detailCount: pairedColumns.right_detailCount!,
  }) as AnyRelation;
  return filter(
    projected,
    gt(
      projected.columns.groupCount as SqlExpression<number | null>,
      param(0) as never,
    ),
  ) as AnyRelation;
}

function scalarCountWithTwoConsumers(countInput: AnyRelation): {
  readonly output: AnyRelation;
  readonly count: AnyRelation;
} {
  const controls = aggregate(countInput, {
    groupBy: {},
    aggregates: { controlCount: count() },
  }) as AnyRelation;
  const markers = valuesRelation(
    { marker: { affinity: "text", nullable: false } },
    [{ marker: "one-row" }],
  ) as AnyRelation;
  const firstJoin = join(controls, markers, alwaysTrue(), "inner");
  const secondJoin = join(controls, markers, alwaysTrue(), "inner");
  const first = project(firstJoin, {
    marker: firstJoin.columns.right_marker!,
    controlCount: firstJoin.columns.left_controlCount!,
  }) as AnyRelation;
  const second = project(secondJoin, {
    marker: secondJoin.columns.right_marker!,
    controlCount: secondJoin.columns.left_controlCount!,
  }) as AnyRelation;
  return { output: union(first, second, true) as AnyRelation, count: controls };
}

function scalarCountFromNumericSumInput(
  values: readonly number[],
  expression: (value: SqlExpression<number>) => SqlExpression<number>,
) {
  const bounded = limit(jsonScalarArray("numeric", values), 16);
  const aggregateExpression = sum(expression(bounded.columns.value));
  const summed = aggregate(bounded, {
    groupBy: {},
    aggregates: { total: aggregateExpression },
  }) as AnyRelation;
  return {
    ...scalarCountWithTwoConsumers(summed),
    input: bounded,
    aggregateExpression,
  };
}

describe("shared scalar COUNT_ROWS reuse review", () => {
  it("shares one qualified global count across summary and four complete-key Top-K branches", () => {
    const db = database();
    const { output, controls, countInput } = buildOverview();
    const physical = lowerLogicalPlan(output);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === controls.node,
    );
    expect(definition).toMatchObject({
      materialization: "materialized",
      fields: controls.fields,
    });
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();

    const optimizedRows = execute(db, compileD1Query(physical));
    const originalRows = execute(db, compileD1QueryUnoptimizedForTest(output));
    expect(optimizedRows).toEqual(originalRows);
    expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
    const inputRows = execute(db, compileD1QueryUnoptimizedForTest(countInput));
    expect(inputRows.some((row) => row.lookupKey === "value-01")).toBe(true);
    expect(inputRows.some((row) => row.lookupKey === null)).toBe(true);
    expect(optimizedRows.filter((row) => row.cardType === "summary")).toEqual([
      {
        cardType: "summary",
        value: null,
        events: 9,
        sessions: 9,
        scopedEvents: 9,
      },
    ]);
    for (const cardType of ["page", "country", "device", "browser"]) {
      const rows = optimizedRows.filter((row) => row.cardType === cardType);
      expect(rows).toHaveLength(8);
      expect(rows[0]?.value).toBeNull();
      expect(rows.every((row) => row.events === 1 && row.sessions === 1)).toBe(
        true,
      );
      expect(rows.every((row) => row.scopedEvents === 9)).toBe(true);
    }
  });

  it("keeps COUNT_ROWS at zero for an empty admitted resource domain", () => {
    const db = database();
    const { output, controls } = buildOverview({
      allowedSiteId: "no-matching-site",
    });
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === controls.node),
    ).toMatchObject({ materialization: "materialized" });
    const optimizedRows = execute(db, compileD1Query(physical));
    const originalRows = execute(db, compileD1QueryUnoptimizedForTest(output));
    expect(optimizedRows).toEqual(originalRows);
    expect(optimizedRows).toEqual([
      {
        cardType: "summary",
        value: null,
        events: 0,
        sessions: 0,
        scopedEvents: 0,
      },
    ]);
  });

  it("shares the closed count but rejects its correlated-input variant", () => {
    const db = database();
    const makeOutput = (withCorrelation: boolean) => {
      const source = valuesRelation(
        { value: { affinity: "text", nullable: false } },
        [{ value: "a" }, { value: "b" }],
      ) as AnyRelation;
      let countInput = source;
      if (withCorrelation) {
        const lookup = valuesRelation(
          { value: { affinity: "text", nullable: false } },
          [{ value: "a" }],
        ) as AnyRelation;
        const correlatedLookup = filter(
          lookup,
          equals(lookup.columns.value!, source.columns.value!),
        ) as AnyRelation;
        const correlatedValue = scalar(
          project(correlatedLookup, {
            value: correlatedLookup.columns.value!,
          }),
        ) as AnyExpression;
        countInput = filter(
          source,
          equals(correlatedValue, param("a") as AnyExpression),
        ) as AnyRelation;
      }
      const controls = aggregate(countInput, {
        groupBy: {},
        aggregates: { controlCount: count() },
      }) as AnyRelation;
      const markers = valuesRelation(
        { marker: { affinity: "text", nullable: false } },
        [{ marker: "first" }],
      ) as AnyRelation;
      const firstJoin = join(controls, markers, alwaysTrue(), "inner");
      const secondJoin = join(controls, markers, alwaysTrue(), "inner");
      const first = project(firstJoin, {
        marker: firstJoin.columns.right_marker!,
        controlCount: firstJoin.columns.left_controlCount!,
      }) as AnyRelation;
      const second = project(secondJoin, {
        marker: secondJoin.columns.right_marker!,
        controlCount: secondJoin.columns.left_controlCount!,
      }) as AnyRelation;
      return { output: union(first, second, true) as AnyRelation, controls };
    };

    const closed = makeOutput(false);
    const closedPhysical = lowerLogicalPlan(closed.output);
    expect(
      closedPhysical.sharedRelations.find(
        ({ node }) => node === closed.controls.node,
      ),
    ).toMatchObject({ materialization: "materialized" });
    const closedOptimized = execute(db, compileD1Query(closedPhysical));
    const closedOriginal = execute(
      db,
      compileD1QueryUnoptimizedForTest(closed.output),
    );
    expect(rowBag(closedOptimized)).toEqual(rowBag(closedOriginal));
    expect(closedOptimized).toEqual([
      { marker: "first", controlCount: 2 },
      { marker: "first", controlCount: 2 },
    ]);

    const correlated = makeOutput(true);
    const correlatedPhysical = lowerLogicalPlan(correlated.output);
    expect(
      correlatedPhysical.sharedRelations.some(
        ({ node }) => node === correlated.controls.node,
      ),
    ).toBe(false);
    const correlatedOptimized = execute(db, compileD1Query(correlatedPhysical));
    const correlatedOriginal = execute(
      db,
      compileD1QueryUnoptimizedForTest(correlated.output),
    );
    expect(rowBag(correlatedOptimized)).toEqual(rowBag(correlatedOriginal));
    expect(correlatedOptimized).toEqual([
      { marker: "first", controlCount: 1 },
      { marker: "first", controlCount: 1 },
    ]);
  });

  it("rejects incomplete keys, unsafe joins, windows, limits, and union tags", () => {
    const mutations: TopKMutation[] = [
      "missing-group-key",
      "transformed-group-key",
      "wrong-index-group-key",
      "unordered-limit",
      "left-join",
      "left-join-ancestor",
      "non-scalar-join",
      "window-sibling",
      "window-ancestor",
      "union-pseudo-tag",
    ];
    for (const mutation of mutations) {
      const { output, controls } = buildOverview({ mutation });
      assertCountNotMaterialized(output, controls.node);
    }

    const volatile = buildOverview({ volatileCountInput: true });
    assertCountNotMaterialized(volatile.output, volatile.controls.node);
    const correlated = buildOverview({ correlatedCountInput: true });
    assertCountNotMaterialized(correlated.output, correlated.controls.node);
  });

  it("does not treat a nullable primary key as a unique Top-K group key", () => {
    expect(schema.visits.columns.visit_id.nullable).toBe(true);
    const visits = scan(schema.visits) as AnyRelation;
    const seeds = valuesRelation(
      { value: { affinity: "text", nullable: false } },
      [{ value: "seed" }],
    ) as AnyRelation;
    const controls = aggregate(seeds, {
      groupBy: {},
      aggregates: { controlCount: count() },
    }) as AnyRelation;
    const firstJoin = join(visits, controls, alwaysTrue(), "inner");
    const firstColumns = firstJoin.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const first = project(firstJoin, {
      visitId: firstColumns.left_visit_id!,
      status: firstColumns.left_status!,
      controlCount: firstColumns.right_controlCount!,
    }) as AnyRelation;
    const ordered = sort(first, [
      { expression: first.columns.status!, direction: "ASC" },
      { expression: first.columns.visitId!, direction: "ASC" },
    ]) as AnyRelation;
    const top = limit(ordered, 8) as AnyRelation;
    const secondJoin = join(visits, controls, alwaysTrue(), "inner");
    const secondColumns = secondJoin.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const second = project(secondJoin, {
      visitId: secondColumns.left_visit_id!,
      status: secondColumns.left_status!,
      controlCount: secondColumns.right_controlCount!,
    }) as AnyRelation;
    const output = union(top, second, true) as AnyRelation;

    assertCountNotMaterialized(output, controls.node);
  });

  it("rejects forged fresh-validator metadata for an unproved scalar count", () => {
    const { output, controls } = buildOverview({
      mutation: "missing-group-key",
    });
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.some(({ node }) => node === controls.node),
    ).toBe(false);
    const forged = {
      ...physical,
      sharedRelations: [
        ...physical.sharedRelations,
        {
          name: "_d1_shared_forged_scalar_count",
          node: controls.node,
          scope: controls.scope,
          fields: controls.fields,
          dependencies: [],
          materialization: "materialized" as const,
        },
      ],
    };
    expect(() => validatePhysicalQueryPlan(forged)).toThrow();
  });

  it("rejects an unguarded scan even when both consumers are scalar joins", () => {
    const visits = scan(schema.visits) as AnyRelation;
    const controls = aggregate(visits, {
      groupBy: {},
      aggregates: { controlCount: count() },
    }) as AnyRelation;
    const markers = valuesRelation(
      { marker: { affinity: "text", nullable: false } },
      [{ marker: "one-row" }],
    ) as AnyRelation;
    const firstJoin = join(controls, markers, alwaysTrue(), "inner");
    const secondJoin = join(controls, markers, alwaysTrue(), "inner");
    const first = project(firstJoin, {
      marker: firstJoin.columns.right_marker!,
      controlCount: firstJoin.columns.left_controlCount!,
    }) as AnyRelation;
    const second = project(secondJoin, {
      marker: secondJoin.columns.right_marker!,
      controlCount: secondJoin.columns.left_controlCount!,
    }) as AnyRelation;

    assertCountNotMaterialized(
      union(first, second, true) as AnyRelation,
      controls.node,
    );
  });

  it("shares repeated source paths when every path enters the admitted gate", () => {
    const db = database();
    seedVisit(db, "guarded-shared-site", "guarded-shared-visit");
    const visits = scan(schema.visits) as AnyRelation;
    const repeatedSource = join(
      visits,
      visits,
      alwaysTrue(),
      "inner",
    ) as AnyRelation;
    const repeatedColumns = repeatedSource.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const control = boundedAdmissionControl("guarded-shared-site");
    const admitted = semiJoin(
      repeatedSource,
      control,
      equals(repeatedColumns.left_site_id!, control.columns.siteId!),
    ) as AnyRelation;
    const { output, count: controls } = scalarCountWithTwoConsumers(admitted);
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === controls.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();

    const optimizedRows = execute(db, compileD1Query(physical));
    const originalRows = execute(db, compileD1QueryUnoptimizedForTest(output));
    expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
    expect(optimizedRows).toEqual([
      { marker: "one-row", controlCount: 1 },
      { marker: "one-row", controlCount: 1 },
    ]);
  });

  it("rejects a shared scan reached through both admitted and unguarded paths", () => {
    const db = database();
    seedVisit(db, "excluded-shared-site", "excluded-shared-visit");
    const visits = scan(schema.visits) as AnyRelation;
    const control = boundedAdmissionControl("admitted-only-site");
    const admitted = semiJoin(
      visits,
      control,
      equals(visits.columns.site_id!, control.columns.siteId!),
    ) as AnyRelation;
    const mixedPaths = join(
      visits,
      admitted,
      equals(visits.columns.site_id!, admitted.columns.site_id!),
      "left",
    ) as AnyRelation;
    const { output, count: controls } = scalarCountWithTwoConsumers(mixedPaths);
    const physical = assertCountNotMaterialized(output, controls.node);
    const optimizedRows = execute(db, compileD1Query(physical));
    const originalRows = execute(db, compileD1QueryUnoptimizedForTest(output));
    expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
    expect(optimizedRows).toEqual([
      { marker: "one-row", controlCount: 1 },
      { marker: "one-row", controlCount: 1 },
    ]);

    const forged = {
      ...physical,
      sharedRelations: [
        ...physical.sharedRelations,
        {
          name: "_d1_shared_forged_scalar_count_path",
          node: controls.node,
          scope: controls.scope,
          fields: controls.fields,
          dependencies: [],
          materialization: "materialized" as const,
        },
      ],
    };
    expect(() => validatePhysicalQueryPlan(forged)).toThrow();
  });

  it("rejects a gate control assembled from two distinct bounded summaries", () => {
    const firstControl = boundedAdmissionControl("admitted-only-site");
    const secondControl = boundedAdmissionControl("admitted-only-site");
    const controlsJoin = join(
      firstControl,
      secondControl,
      equals(firstControl.columns.siteId!, secondControl.columns.siteId!),
      "inner",
    );
    const controlsColumns = controlsJoin.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const controlsProjection = project(controlsJoin, {
      siteId: controlsColumns.left_siteId!,
      groupCount: controlsColumns.left_groupCount!,
      secondGroupCount: controlsColumns.right_groupCount!,
    }) as AnyRelation;
    const combinedControl = filter(
      controlsProjection,
      gt(
        controlsProjection.columns.groupCount as SqlExpression<number | null>,
        param(0) as never,
      ),
    ) as AnyRelation;
    const visits = scan(schema.visits) as AnyRelation;
    const admitted = semiJoin(
      visits,
      combinedControl,
      equals(visits.columns.site_id!, combinedControl.columns.siteId!),
    ) as AnyRelation;
    const { output, count: controls } = scalarCountWithTwoConsumers(admitted);

    assertCountNotMaterialized(output, controls.node);
  });

  it("does not license a Cartesian product of multirow finite inputs", () => {
    const left = valuesRelation(
      { left_value: { affinity: "text", nullable: false } },
      [{ left_value: "one" }, { left_value: "two" }],
    ) as AnyRelation;
    const right = valuesRelation(
      { right_value: { affinity: "text", nullable: false } },
      [{ right_value: "one" }, { right_value: "two" }],
    ) as AnyRelation;
    const product = join(left, right, alwaysTrue(), "inner");
    const controls = aggregate(product, {
      groupBy: {},
      aggregates: { controlCount: count() },
    }) as AnyRelation;
    const markers = valuesRelation(
      { marker: { affinity: "text", nullable: false } },
      [{ marker: "one-row" }],
    ) as AnyRelation;
    const firstJoin = join(controls, markers, alwaysTrue(), "inner");
    const secondJoin = join(controls, markers, alwaysTrue(), "inner");
    const first = project(firstJoin, {
      marker: firstJoin.columns.right_marker!,
      controlCount: firstJoin.columns.left_controlCount!,
    }) as AnyRelation;
    const second = project(secondJoin, {
      marker: secondJoin.columns.right_marker!,
      controlCount: secondJoin.columns.left_controlCount!,
    }) as AnyRelation;

    assertCountNotMaterialized(
      union(first, second, true) as AnyRelation,
      controls.node,
    );
  });

  it("reuses scalar counts when literal join multiplicity is finite", () => {
    const db = database();
    const empty = valuesRelation(
      { value: { affinity: "text", nullable: false } },
      [],
    ) as AnyRelation;
    const one = valuesRelation(
      { value: { affinity: "text", nullable: false } },
      [{ value: "one" }],
    ) as AnyRelation;
    const two = valuesRelation(
      { value: { affinity: "text", nullable: false } },
      [{ value: "one" }, { value: "two" }],
    ) as AnyRelation;
    const three = valuesRelation(
      { value: { affinity: "text", nullable: false } },
      [{ value: "one" }, { value: "two" }, { value: "three" }],
    ) as AnyRelation;
    const scenarios: readonly {
      readonly input: AnyRelation;
      readonly expectedCount: number;
    }[] = [
      { input: join(one, three, alwaysTrue(), "inner"), expectedCount: 3 },
      { input: join(empty, three, alwaysTrue(), "inner"), expectedCount: 0 },
      { input: join(one, empty, alwaysTrue(), "left"), expectedCount: 1 },
      { input: join(two, empty, alwaysTrue(), "left"), expectedCount: 2 },
      {
        input: join(
          two,
          valuesRelation({ value: { affinity: "text", nullable: false } }, [
            { value: "right" },
          ]) as AnyRelation,
          alwaysTrue(),
          "left",
        ),
        expectedCount: 2,
      },
    ];

    for (const { input, expectedCount } of scenarios) {
      const { output, count: controls } = scalarCountWithTwoConsumers(input);
      const physical = lowerLogicalPlan(output);
      expect(
        physical.sharedRelations.find(({ node }) => node === controls.node),
      ).toMatchObject({ materialization: "materialized" });
      expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();

      const optimizedRows = execute(db, compileD1Query(physical));
      const originalRows = execute(
        db,
        compileD1QueryUnoptimizedForTest(output),
      );
      const expectedRows = [
        { marker: "one-row", controlCount: expectedCount },
        { marker: "one-row", controlCount: expectedCount },
      ];
      expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
      expect(rowBag(optimizedRows)).toEqual(rowBag(expectedRows));
    }

    const rightControls = aggregate(one, {
      groupBy: {},
      aggregates: { controlCount: count() },
    }) as AnyRelation;
    const markers = valuesRelation(
      { marker: { affinity: "text", nullable: false } },
      [{ marker: "first" }, { marker: "second" }],
    ) as AnyRelation;
    const firstRightJoin = join(markers, rightControls, alwaysTrue(), "inner");
    const secondRightJoin = join(markers, rightControls, alwaysTrue(), "inner");
    const firstRight = project(firstRightJoin, {
      marker: firstRightJoin.columns.left_marker!,
      controlCount: firstRightJoin.columns.right_controlCount!,
    }) as AnyRelation;
    const secondRight = project(secondRightJoin, {
      marker: secondRightJoin.columns.left_marker!,
      controlCount: secondRightJoin.columns.right_controlCount!,
    }) as AnyRelation;
    const rightCountOutput = union(
      firstRight,
      secondRight,
      true,
    ) as AnyRelation;
    const rightPhysical = lowerLogicalPlan(rightCountOutput);
    expect(
      rightPhysical.sharedRelations.find(
        ({ node }) => node === rightControls.node,
      ),
    ).toMatchObject({ materialization: "materialized" });
    expect(() => validatePhysicalQueryPlan(rightPhysical)).not.toThrow();
    const rightOptimizedRows = execute(db, compileD1Query(rightPhysical));
    const rightOriginalRows = execute(
      db,
      compileD1QueryUnoptimizedForTest(rightCountOutput),
    );
    const rightExpectedRows = ["first", "second", "first", "second"].map(
      (marker) => ({ marker, controlCount: 1 }),
    );
    expect(rowBag(rightOptimizedRows)).toEqual(rowBag(rightOriginalRows));
    expect(rowBag(rightOptimizedRows)).toEqual(rowBag(rightExpectedRows));
  });

  it("keeps closed total expressions eligible and excludes partial expressions", () => {
    const db = database();
    const input = valuesRelation(
      {
        raw: { affinity: "text", nullable: true },
        label: { affinity: "text", nullable: true },
      },
      [
        { raw: null, label: null },
        { raw: "12", label: "twelve" },
        { raw: "0", label: null },
      ],
    ) as AnyRelation;
    const closed = project(input, {
      display: caseWhen(
        [
          {
            when: isNull(input.columns.raw!),
            then: coalesce(input.columns.label!, constant("missing")),
          },
        ],
        input.columns.raw!,
      ),
    }) as AnyRelation;
    expect(
      inspectTotalMaterializationSubtree(closed.node, new Set()).safe,
    ).toBe(true);
    const physical = lowerLogicalPlan(closed);
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
    const optimizedRows = execute(db, compileD1Query(physical));
    const originalRows = execute(db, compileD1QueryUnoptimizedForTest(closed));
    expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
    expect(optimizedRows).toEqual([
      { display: "missing" },
      { display: "12" },
      { display: "0" },
    ]);

    const partial = project(input, {
      absolute: callFunction(
        "abs",
        input.columns.raw as SqlExpression<number | null>,
      ),
    }) as AnyRelation;
    expect(
      inspectTotalMaterializationSubtree(partial.node, new Set()).safe,
    ).toBe(false);
  });

  it("requires every numeric JSON and coalesce child to stay unit bounded", () => {
    const db = database();
    const scenarios: readonly {
      readonly name: string;
      readonly values: readonly number[];
      readonly expression: (
        value: SqlExpression<number>,
      ) => SqlExpression<number>;
      readonly locallySafe: boolean;
    }[] = [
      {
        name: "numeric-json-array-within-unit-range",
        values: [-1, 0, 1],
        expression: (value) => value,
        locallySafe: true,
      },
      {
        name: "numeric-json-array-with-out-of-range-member",
        values: [-1, 2],
        expression: (value) => value,
        locallySafe: false,
      },
      {
        name: "coalesce-with-only-unit-bounded-children",
        values: [-1, 1],
        expression: (value) => coalesce(value, constant(0)),
        locallySafe: true,
      },
      {
        name: "coalesce-with-one-out-of-range-child",
        values: [-1, 1],
        expression: (value) => coalesce(value, constant(2)),
        locallySafe: false,
      },
    ];

    for (const scenario of scenarios) {
      const {
        output,
        count: controls,
        input,
        aggregateExpression,
      } = scalarCountFromNumericSumInput(scenario.values, scenario.expression);
      const locallySafe = isMaterializationSafeAggregateExpression(
        aggregateExpression,
        input,
      );
      expect(locallySafe, scenario.name).toBe(scenario.locallySafe);
      const completeSubtree = inspectTotalMaterializationSubtree(
        controls.node,
        new Set(),
      );
      expect(completeSubtree.safe, scenario.name).toBe(false);
      expect(
        completeSubtree.safe ? undefined : completeSubtree.reason,
        scenario.name,
      ).toBe(
        scenario.locallySafe ? "limit-barrier" : "unsafe-local-expression",
      );
      const physical = lowerLogicalPlan(output);
      const definition = physical.sharedRelations.find(
        ({ node }) => node === controls.node,
      );
      expect(definition, scenario.name).toBeUndefined();
      expect(
        () => validatePhysicalQueryPlan(physical),
        scenario.name,
      ).not.toThrow();
      const optimizedRows = execute(db, compileD1Query(physical));
      const originalRows = execute(
        db,
        compileD1QueryUnoptimizedForTest(output),
      );
      expect(rowBag(optimizedRows), scenario.name).toEqual(
        rowBag(originalRows),
      );
    }
  });

  it("keeps false resource consumers from evaluating ABS(INT64_MIN) early", () => {
    const db = database();
    const siteId = "scalar-count-abs-site";
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
      ) VALUES (
        'scalar-count-abs-min', '${siteId}', 'visitor-a', 'session-a',
        'complete', 1, 1, -9223372036854775808, '/', 'example.test', ${sitePk}
      )
    `);

    const visits = scan(schema.visits) as AnyRelation;
    const allowedSites = valuesRelation(
      { siteId: { affinity: "text", nullable: false } },
      [],
    ) as AnyRelation;
    const scoped = semiJoin(
      visits,
      allowedSites,
      equals(visits.columns.site_id!, allowedSites.columns.siteId!),
    ) as AnyRelation;
    const emptyResourceInput = limit(scoped, 0) as AnyRelation;
    const complete = filter(
      emptyResourceInput,
      equals(
        emptyResourceInput.columns.status! as AnyExpression,
        param("complete"),
      ),
    ) as AnyRelation;
    const absolute = project(complete, {
      duration: callFunction(
        "abs",
        complete.columns.duration_ms as SqlExpression<number | null>,
      ),
    }) as AnyRelation;
    const filtered = filter(
      absolute,
      gt(
        absolute.columns.duration as SqlExpression<number | null>,
        param(0) as never,
      ),
    ) as AnyRelation;
    const controls = aggregate(filtered, {
      groupBy: {},
      aggregates: { controlCount: count() },
    }) as AnyRelation;
    const emptyGate = valuesRelation(
      { gate: { affinity: "text", nullable: false } },
      [],
    ) as AnyRelation;
    const firstJoin = join(controls, emptyGate, alwaysTrue(), "inner");
    const secondJoin = join(controls, emptyGate, alwaysTrue(), "inner");
    const first = project(firstJoin, {
      controlCount: firstJoin.columns.left_controlCount!,
    }) as AnyRelation;
    const second = project(secondJoin, {
      controlCount: secondJoin.columns.left_controlCount!,
    }) as AnyRelation;
    const output = union(first, second, true) as AnyRelation;
    const physical = assertCountNotMaterialized(output, controls.node);
    const optimizedRows = execute(db, compileD1Query(physical));
    const originalRows = execute(db, compileD1QueryUnoptimizedForTest(output));
    expect(optimizedRows).toEqual(originalRows);
    expect(optimizedRows).toEqual([]);
  });

  it("fails closed on an unknown function", () => {
    const unknownFunction = {
      kind: "function",
      name: "not-a-sql-function",
      arguments: [],
      resultType: { affinity: "text", nullable: false },
    } as unknown as AnyExpression;
    expect(isMaterializationSafeExpression(unknownFunction, new Map())).toBe(
      false,
    );
  });
});
