import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  add,
  aggregate,
  callFunction,
  caseWhen,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  gt,
  isNull,
  join,
  limit,
  lte,
  max,
  project,
  recursiveClosure,
  rowNumber,
  scan,
  sort,
  union,
  unixepoch,
  window,
} from "@/lib/db";
import { boundedAdmissionReuseCandidates } from "@/lib/db/query/bounded-admission-reuse";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function database(): DatabaseSync {
  const result = createMigratedDatabase();
  databases.add(result);
  const insertSite = result.prepare(
    "INSERT INTO site_identities (site_id) VALUES (?)",
  );
  const domainKeys = new Map<string, number>();
  for (const domainId of ["admission-a", "admission-b"]) {
    insertSite.run(domainId);
    const row = result
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(domainId) as { readonly site_pk: number };
    domainKeys.set(domainId, row.site_pk);
  }
  const insertSampleRow = result.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, duration_source, pathname, hostname, site_pk
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, '/', 'example.test', ?)`,
  );
  const domains = [
    ["admission-a", [null, "timer", "timer", "all-null"]],
    ["admission-b", [null, "timer", "timer"]],
  ] as const;
  for (const [domainId, values] of domains)
    values.forEach((rowValue, index) =>
      insertSampleRow.run(
        `${domainId}-${index}`,
        domainId,
        `${domainId}-visitor-${index}`,
        `${domainId}-session-${index}`,
        index + 1,
        index + 1,
        rowValue,
        domainKeys.get(domainId)!,
      ),
    );
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

function normalizedBag(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

interface AdmissionFixtureOptions {
  readonly domainId: string;
  readonly domain: number;
  readonly maximumRows: number;
  readonly threshold?: number;
  readonly offset?: number;
  readonly boundedRowsGate?: "inner" | "left";
  readonly thirdConsumer?: boolean;
  readonly additionalAdmissionGates?: number;
  readonly differentCounter?: boolean;
  readonly volatileInput?: boolean;
  readonly unsafeAbsInput?:
    "direct" | "case" | "filter" | "recursive-seed" | "recursive-candidate";
}

function admissionFixture(options: AdmissionFixtureOptions): {
  readonly root: AnyRelation;
  readonly bounded: AnyRelation;
  readonly counter: AnyRelation;
} {
  const rowsSource = scan(schema.visits);
  const scopedRows = filter(
    rowsSource,
    eq(rowsSource.columns.site_id, constant(options.domainId)),
  );
  const selectedInput =
    options.unsafeAbsInput === "filter"
      ? filter(
          scopedRows,
          gt(callFunction("abs", scopedRows.columns.started_at), constant(0)),
        )
      : scopedRows;
  const selectedRows =
    options.unsafeAbsInput === "recursive-seed" ||
    options.unsafeAbsInput === "recursive-candidate"
      ? recursiveClosure(
          project(scopedRows, {
            selectedValue:
              options.unsafeAbsInput === "recursive-seed"
                ? callFunction("abs", scopedRows.columns.started_at)
                : scopedRows.columns.started_at,
          }),
          project(scopedRows, {
            selectedValue:
              options.unsafeAbsInput === "recursive-candidate"
                ? callFunction("abs", scopedRows.columns.started_at)
                : scopedRows.columns.started_at,
          }),
          (current, candidate) =>
            eq(current.selectedValue, candidate.selectedValue),
        )
      : project(selectedInput, {
          selectedValue: options.volatileInput
            ? unixepoch()
            : options.unsafeAbsInput === "direct"
              ? callFunction("abs", selectedInput.columns.started_at)
              : options.unsafeAbsInput === "case"
                ? caseWhen(
                    [
                      {
                        when: eq(selectedInput.columns.started_at, constant(1)),
                        then: callFunction(
                          "abs",
                          selectedInput.columns.started_at,
                        ),
                      },
                    ],
                    constant(0),
                  )
                : selectedInput.columns.duration_source,
        });
  const bounded = limit(selectedRows, options.maximumRows + 1, options.offset);
  const counter = aggregate(bounded, {
    groupBy: {},
    aggregates: { rowCount: count() },
  });
  const gateCounter = options.differentCounter
    ? aggregate(bounded, {
        groupBy: {},
        aggregates: { rowCount: count() },
      })
    : counter;
  const admittedCounter = filter(
    gateCounter,
    lte(
      gateCounter.columns.rowCount,
      constant(options.threshold ?? options.maximumRows),
    ),
  );
  const truePredicate = eq(constant(1), constant(1));
  const admittedRows = join(
    bounded,
    admittedCounter,
    truePredicate,
    options.boundedRowsGate ?? "inner",
  );
  const otherRows = join(scopedRows, admittedCounter, truePredicate);
  const boundedRows = project(admittedRows, {
    rowKind: constant(1),
    domain: constant(options.domain),
    value: isNull(admittedRows.columns.left_selectedValue),
  });
  const otherRowsWithKind = project(otherRows, {
    rowKind: constant(2),
    domain: constant(options.domain),
    value: constant(0),
  });
  const control = project(counter, {
    rowKind: constant(0),
    domain: constant(options.domain),
    value: counter.columns.rowCount,
  });
  const root = union(
    union(control, boundedRows, true),
    otherRowsWithKind,
    true,
  );
  const rootWithAdditionalGates = Array.from(
    { length: options.additionalAdmissionGates ?? 0 },
    (_, index) => {
      const gatedRows = join(scopedRows, admittedCounter, truePredicate);
      return project(gatedRows, {
        rowKind: constant(4 + index),
        domain: constant(options.domain),
        value: constant(0),
      });
    },
  ).reduce(
    (current, rows) => union(current, rows, true) as AnyRelation,
    root as AnyRelation,
  );
  return {
    root: options.thirdConsumer
      ? union(
          rootWithAdditionalGates,
          project(bounded, {
            rowKind: constant(3),
            domain: constant(options.domain),
            value: isNull(bounded.columns.selectedValue),
          }),
          true,
        )
      : rootWithAdditionalGates,
    bounded,
    counter,
  };
}

type EarlyEvaluationLocation =
  "aggregate-group" | "aggregate-expression" | "window-order" | "sort-key";

function admissionEarlyEvaluationFixture(
  location: EarlyEvaluationLocation,
  unsafe: boolean,
): {
  readonly root: AnyRelation;
  readonly bounded: AnyRelation;
  readonly counter: AnyRelation;
} {
  const rowsSource = scan(schema.visits);
  const scopedRows = filter(
    rowsSource,
    eq(rowsSource.columns.site_id, constant("admission-a")),
  );
  const earlyValue = unsafe
    ? callFunction("abs", scopedRows.columns.started_at)
    : scopedRows.columns.started_at;
  let selectedRows: AnyRelation;

  switch (location) {
    case "aggregate-group":
      selectedRows = aggregate(scopedRows, {
        groupBy: { selectedValue: earlyValue },
        aggregates: { rowCount: count() },
      }) as AnyRelation;
      break;
    case "aggregate-expression":
      selectedRows = aggregate(scopedRows, {
        groupBy: { startedAt: scopedRows.columns.started_at },
        aggregates: {
          selectedValue: unsafe
            ? max(callFunction("abs", scopedRows.columns.started_at))
            : max(scopedRows.columns.started_at),
        },
      }) as AnyRelation;
      break;
    case "window-order": {
      const ranked = window(scopedRows, {
        rank: rowNumber({
          orderBy: [{ expression: earlyValue, direction: "ASC" }],
        }),
      });
      selectedRows = project(ranked, {
        selectedValue: ranked.columns.started_at,
      }) as AnyRelation;
      break;
    }
    case "sort-key": {
      const ordered = sort(scopedRows, [
        { expression: earlyValue, direction: "ASC" },
      ]);
      selectedRows = project(ordered, {
        selectedValue: ordered.columns.started_at,
      }) as AnyRelation;
      break;
    }
  }

  const maximumRows = 3;
  const bounded = limit(selectedRows, maximumRows + 1);
  const counter = aggregate(bounded, {
    groupBy: {},
    aggregates: { rowCount: count() },
  });
  const admittedCounter = filter(
    counter,
    lte(counter.columns.rowCount, constant(maximumRows)),
  );
  const truePredicate = eq(constant(1), constant(1));
  const admittedRows = join(bounded, admittedCounter, truePredicate);
  const otherRows = join(scopedRows, admittedCounter, truePredicate);
  const root = union(
    union(
      project(counter, {
        rowKind: constant(0),
        domain: constant(1),
        value: counter.columns.rowCount,
      }),
      project(admittedRows, {
        rowKind: constant(1),
        domain: constant(1),
        value: isNull(admittedRows.columns.left_selectedValue),
      }),
      true,
    ),
    project(otherRows, {
      rowKind: constant(2),
      domain: constant(1),
      value: constant(0),
    }),
    true,
  );

  return { root: root as AnyRelation, bounded, counter };
}

function combinedRoot(packets: readonly AnyRelation[]): AnyRelation {
  return packets
    .slice(1)
    .reduce(
      (root, next) => union(root, next, true) as AnyRelation,
      packets[0]!,
    );
}

describe("bounded admission relation reuse", () => {
  // Aggregate safe controls prove the same graph can be licensed; ABS variants
  // exercise its early-evaluation guard. The current closed-subtree proof
  // excludes every Window and Sort node, so those safe variants document that
  // public optimizer boundary instead of claiming a sharing-positive control.
  it.each([
    ["aggregate group key", "aggregate-group", false, true],
    ["aggregate group key with ABS", "aggregate-group", true, false],
    ["aggregate input", "aggregate-expression", false, true],
    ["aggregate input with ABS", "aggregate-expression", true, false],
    ["window order", "window-order", false, false],
    ["window order with ABS", "window-order", true, false],
    ["sort key", "sort-key", false, false],
    ["sort key with ABS", "sort-key", true, false],
  ] as const)(
    "keeps %s admission behavior aligned with SQLite",
    (_label, location, unsafe, shouldShare) => {
      const built = admissionEarlyEvaluationFixture(location, unsafe);
      const physical = lowerLogicalPlan(built.root);
      const boundedDefinition = physical.sharedRelations.find(
        ({ node }) => node === built.bounded.node,
      );
      const counterDefinition = physical.sharedRelations.find(
        ({ node }) => node === built.counter.node,
      );

      if (shouldShare) {
        expect(boundedDefinition).toMatchObject({
          materialization: "materialized",
        });
        expect(counterDefinition).toMatchObject({
          materialization: "materialized",
          dependencies: [boundedDefinition?.name],
        });
      } else {
        expect(boundedDefinition).toBeUndefined();
        expect(counterDefinition).toBeUndefined();
      }

      const optimized = compileD1Query(physical);
      const unoptimized = compileD1QueryUnoptimizedForTest(built.root);
      const db = database();
      const optimizedRows = runAll(db, optimized);
      expect(normalizedBag(optimizedRows)).toEqual(
        normalizedBag(runAll(db, unoptimized)),
      );
      expect(optimizedRows).toEqual([{ rowKind: 0, domain: 1, value: 4 }]);
    },
  );

  it("shares one M+1 admission across multiple typed global gates", () => {
    const fixture = admissionFixture({
      domainId: "admission-a",
      domain: 1,
      maximumRows: 3,
      additionalAdmissionGates: 1,
    });
    const physical = lowerLogicalPlan(fixture.root);
    expect(
      physical.sharedRelations.find(
        ({ node }) => node === fixture.bounded.node,
      ),
    ).toMatchObject({ materialization: "materialized" });
    const optimized = compileD1Query(physical);
    const unoptimized = compileD1QueryUnoptimizedForTest(fixture.root);
    const db = database();
    expect(normalizedBag(runAll(db, optimized))).toEqual(
      normalizedBag(runAll(db, unoptimized)),
    );
  });

  it("shares only each bounded root and preserves both admitted bags and raw counts", () => {
    const empty = admissionFixture({
      domainId: "admission-empty",
      domain: 3,
      maximumRows: 3,
    });
    const exactlyAtLimit = admissionFixture({
      domainId: "admission-b",
      domain: 2,
      maximumRows: 3,
    });
    const overflow = admissionFixture({
      domainId: "admission-a",
      domain: 1,
      maximumRows: 3,
    });
    const root = combinedRoot([empty.root, exactlyAtLimit.root, overflow.root]);
    const physical = lowerLogicalPlan(root);
    for (const bounded of [
      empty.bounded,
      exactlyAtLimit.bounded,
      overflow.bounded,
    ])
      expect(
        physical.sharedRelations.find(({ node }) => node === bounded.node),
      ).toMatchObject({ materialization: "materialized" });
    for (const fixture of [empty, exactlyAtLimit, overflow]) {
      const boundedDefinition = physical.sharedRelations.find(
        ({ node }) => node === fixture.bounded.node,
      );
      const counterDefinition = physical.sharedRelations.find(
        ({ node }) => node === fixture.counter.node,
      );
      expect(counterDefinition).toMatchObject({
        materialization: "materialized",
        dependencies: [boundedDefinition?.name],
      });
    }
    expect(
      physical.sharedRelations.filter(({ node }) =>
        [empty.bounded, exactlyAtLimit.bounded, overflow.bounded].some(
          ({ node: boundedNode }) => node === boundedNode,
        ),
      ),
    ).toHaveLength(3);

    const optimized = compileD1Query(physical);
    const unoptimized = compileD1QueryUnoptimizedForTest(root);
    const db = database();
    const optimizedRows = runAll(db, optimized);
    expect(normalizedBag(optimizedRows)).toEqual(
      normalizedBag(runAll(db, unoptimized)),
    );
    const controls = optimizedRows
      .filter(({ rowKind }) => rowKind === 0)
      .map(({ domain, value }) => ({ domain, value }))
      .sort((left, right) => Number(left.domain) - Number(right.domain));
    expect(controls).toEqual([
      { domain: 1, value: 4 },
      { domain: 2, value: 3 },
      { domain: 3, value: 0 },
    ]);
    expect(
      optimizedRows.filter(
        ({ rowKind, domain }) => rowKind === 1 && domain === 1,
      ),
    ).toHaveLength(0);
    expect(
      optimizedRows.filter(
        ({ rowKind, domain }) => rowKind === 2 && domain === 1,
      ),
    ).toHaveLength(0);
    expect(
      optimizedRows.filter(
        ({ rowKind, domain }) => rowKind === 1 && domain === 2,
      ),
    ).toHaveLength(3);
    expect(
      optimizedRows.filter(
        ({ rowKind, domain }) => rowKind === 2 && domain === 2,
      ),
    ).toHaveLength(3);
    expect(
      optimizedRows.filter(
        ({ rowKind, domain, value }) =>
          rowKind === 1 && domain === 2 && value === 1,
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["mismatched count threshold", { threshold: 4 }],
    ["LEFT bounded-row gate", { boundedRowsGate: "left" as const }],
    ["OFFSET limit", { offset: 1 }],
    ["third ungated bounded consumer", { thirdConsumer: true }],
    ["different counter aggregate", { differentCounter: true }],
    ["volatile bounded input", { volatileInput: true }],
    ["ABS in a projection", { unsafeAbsInput: "direct" as const }],
    ["ABS nested under CASE", { unsafeAbsInput: "case" as const }],
    ["ABS in a filter", { unsafeAbsInput: "filter" as const }],
    ["ABS in recursive seeds", { unsafeAbsInput: "recursive-seed" as const }],
    [
      "ABS in recursive candidates",
      { unsafeAbsInput: "recursive-candidate" as const },
    ],
  ])("rejects %s", (_label, options) => {
    const built = admissionFixture({
      domainId: "admission-a",
      domain: 1,
      maximumRows: 3,
      ...options,
    });
    const physical = lowerLogicalPlan(built.root);
    expect(
      physical.sharedRelations.some(({ node }) => node === built.bounded.node),
    ).toBe(false);
    expect(
      physical.sharedRelations.some(({ node }) => node === built.counter.node),
    ).toBe(false);
  });

  it("keeps a legal ABS filter below the admission boundary and preserves its actual SQLite bag", () => {
    const built = admissionFixture({
      domainId: "admission-a",
      domain: 1,
      maximumRows: 3,
      unsafeAbsInput: "filter",
    });
    const physical = lowerLogicalPlan(built.root);
    expect(
      physical.sharedRelations.some(({ node }) => node === built.bounded.node),
    ).toBe(false);
    expect(
      physical.sharedRelations.some(({ node }) => node === built.counter.node),
    ).toBe(false);

    const optimized = compileD1Query(physical);
    const unoptimized = compileD1QueryUnoptimizedForTest(built.root);
    const db = database();
    const rows = runAll(db, optimized);
    expect(normalizedBag(rows)).toEqual(normalizedBag(runAll(db, unoptimized)));
    expect(
      rows
        .filter(({ rowKind }) => rowKind === 0)
        .map(({ domain, value }) => ({ domain, value })),
    ).toEqual([{ domain: 1, value: 4 }]);
    expect(
      rows.some(({ rowKind, domain }) => rowKind !== 0 && domain === 1),
    ).toBe(false);
  });

  it("keeps SQLite ABS overflow out of the shared pre-admission evaluation", () => {
    const db = createMigratedDatabase();
    databases.add(db);
    db.exec(
      "INSERT INTO site_identities (site_pk, site_id) VALUES (-9223372036854775808, 'danger'), (1, 'normal')",
    );

    const sites = scan(schema.site_identities);
    const selected = project(sites, {
      value: callFunction("abs", sites.columns.site_pk),
    });
    const bounded = limit(selected, 2);
    const counter = aggregate(bounded, {
      groupBy: {},
      aggregates: { rowCount: count() },
    });
    const admittedCounter = filter(
      counter,
      lte(counter.columns.rowCount, constant(1)),
    );
    const globalGate = eq(constant(1), constant(1));
    const admittedRows = join(bounded, admittedCounter, globalGate);
    const otherRows = join(sites, admittedCounter, globalGate);
    const root = union(
      union(
        project(counter, {
          kind: constant(0),
          value: counter.columns.rowCount,
        }),
        project(admittedRows, {
          kind: constant(1),
          value: admittedRows.columns.left_value,
        }),
        true,
      ),
      project(otherRows, {
        kind: constant(2),
        value: otherRows.columns.left_site_pk,
      }),
      true,
    );

    const physical = lowerLogicalPlan(root);
    expect(
      physical.sharedRelations.some(({ node }) => node === bounded.node),
    ).toBe(false);

    const optimized = compileD1Query(physical);
    const unoptimized = compileD1QueryUnoptimizedForTest(root);
    const optimizedRows = runAll(db, optimized);
    const unoptimizedRows = runAll(db, unoptimized);
    expect(normalizedBag(optimizedRows)).toEqual(
      normalizedBag(unoptimizedRows),
    );
    expect(optimizedRows).toEqual([{ kind: 0, value: 2 }]);
  });

  it("recomputes the license instead of trusting a forged physical candidate", () => {
    const licensed = admissionFixture({
      domainId: "admission-a",
      domain: 1,
      maximumRows: 3,
    });
    const unlicensed = admissionFixture({
      domainId: "admission-a",
      domain: 1,
      maximumRows: 3,
      threshold: 4,
    });
    const licensedPlan = lowerLogicalPlan(licensed.root);
    const unlicensedPlan = lowerLogicalPlan(unlicensed.root);
    const definition = licensedPlan.sharedRelations.find(
      ({ node }) => node === licensed.bounded.node,
    );
    if (!definition) throw new Error("bounded_admission_license_missing");
    const forged = {
      ...unlicensedPlan,
      sharedRelations: [
        ...unlicensedPlan.sharedRelations,
        { ...definition, node: unlicensed.bounded.node },
      ],
    };
    expect(() => compileD1Query(forged)).toThrow();
  });

  it("rejects a computed limit count even if the surrounding graph is otherwise exact", () => {
    const built = admissionFixture({
      domainId: "admission-a",
      domain: 1,
      maximumRows: 3,
    });
    Object.assign(built.bounded.node, {
      count: add(constant(3), constant(1)),
    });
    const candidates = boundedAdmissionReuseCandidates({
      nodes: [built.bounded.node as LogicalQueryNode],
      incomingCounts: new Map(),
      incoming: new Map(),
      maximumFields: 16,
      inspectLocalStableExpression: () => ({ valid: true, columns: [] }),
    });
    expect(candidates.has(built.bounded.node as LogicalQueryNode)).toBe(false);
  });
});
