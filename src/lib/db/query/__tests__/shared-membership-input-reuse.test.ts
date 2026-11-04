import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import type { AnyExpression, SqlExpression } from "@/lib/db/query/expression";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;
type UnsafeProjection = "abs" | "unixepoch" | "correlated-scalar";
type GraphBarrier = "sort" | "limit" | "window" | "recursive";
type CountBarrier = "sort" | "limit" | "window" | "recursive";
type MembershipPrefixBarrier =
  "sort" | "limit" | "window" | "distinct" | "union";

interface MembershipOptions {
  readonly resourceGate?: boolean;
  readonly emptyDimension?: boolean;
  readonly countBarrier?: CountBarrier;
}

interface InputOptions {
  readonly width?: number;
  readonly unsafeProjection?: UnsafeProjection;
  readonly unsafePrefixProjection?: "abs" | "unixepoch";
  readonly leftBarrier?: GraphBarrier;
  readonly localPrefix?: boolean;
  readonly nestedPrefix?: boolean;
  readonly membershipPrefixBarrier?: MembershipPrefixBarrier;
  readonly duplicateLeftRows?: boolean;
  readonly membership?: MembershipOptions;
}

const databases = new Set<DatabaseSync>();
const siteId = "shared-membership-site";

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
        .get(siteId) as {
        readonly site_pk: number;
      }
    ).site_pk,
  );
  db.exec(`
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, duration_ms, pathname, hostname, site_pk
    ) VALUES
      ('shared-min', '${siteId}', 'visitor-a', 'session-a', 'complete', 1, 1, -9223372036854775808, '/', 'example.test', ${sitePk}),
      ('shared-normal', '${siteId}', 'visitor-b', 'session-b', 'complete', 2, 2, 5, '/', 'example.test', ${sitePk})
  `);
  return db;
}

function countMembership(options: MembershipOptions = {}): AnyRelation {
  const visits = scan(schema.visits);
  const completeVisits = filter(
    visits,
    eq(visits.columns.status, param("complete")),
  );
  const dimension = valuesRelation(
    { siteId: { affinity: "text", nullable: false } },
    options.emptyDimension ? [] : [{ siteId }],
  );
  const joined = join(
    completeVisits,
    dimension,
    eq(completeVisits.columns.site_id, dimension.columns.siteId),
    "left",
  );
  const joinedColumns = joined.columns as Readonly<
    Record<string, AnyExpression>
  >;
  let groupInput = project(joined, {
    siteId: joinedColumns.left_site_id!,
    visitorId: joinedColumns.left_visitor_id!,
  }) as AnyRelation;
  if (options.countBarrier === "sort") {
    groupInput = sort(groupInput, [
      { expression: groupInput.columns.siteId!, direction: "ASC" },
    ]) as AnyRelation;
  } else if (options.countBarrier === "limit") {
    groupInput = limit(groupInput, 10) as AnyRelation;
  } else if (options.countBarrier === "window") {
    groupInput = window(groupInput, {
      rowCount: windowCountRows(),
    }) as AnyRelation;
  } else if (options.countBarrier === "recursive") {
    groupInput = recursiveClosure(
      groupInput,
      groupInput,
      (current, candidate) => eq(current.siteId, candidate.siteId),
    ) as AnyRelation;
  }

  const boundedInput = limit(groupInput, 100);
  const grouped = aggregate(boundedInput, {
    groupBy: {
      siteId: boundedInput.columns.siteId!,
      visitorId: boundedInput.columns.visitorId!,
    },
    aggregates: { rowCount: count() },
  });
  const summary = aggregate(grouped, {
    groupBy: {},
    aggregates: {
      groupCount: count(),
      totalRows: sum(grouped.columns.rowCount as SqlExpression<number | null>),
    },
  });
  const summaryKey = project(summary, { siteId: param(siteId) });
  const positiveDetails = filter(
    grouped,
    gt(grouped.columns.rowCount, param(0)),
  );
  const detailKey = project(positiveDetails, {
    siteId: positiveDetails.columns.siteId,
  });
  let membership = union(summaryKey, detailKey, true) as AnyRelation;
  if (options.resourceGate)
    membership = filter(
      membership,
      eq(param("resource-off"), param("resource-on")),
    ) as AnyRelation;
  return membership;
}

function sharedInput({
  width = 22,
  unsafeProjection,
  unsafePrefixProjection,
  leftBarrier,
  localPrefix = false,
  nestedPrefix = false,
  membershipPrefixBarrier,
  duplicateLeftRows = false,
  membership = {},
}: InputOptions = {}): AnyRelation {
  const visits = scan(schema.visits);
  let selected = filter(visits, eq(visits.columns.site_id, param(siteId)));
  const matchingRows = selected;
  if (leftBarrier === "sort") {
    selected = sort(selected, [
      { expression: selected.columns.visit_id, direction: "ASC" },
    ]) as typeof selected;
  } else if (leftBarrier === "limit") {
    selected = limit(selected, 10) as typeof selected;
  } else if (leftBarrier === "window") {
    selected = window(selected, {
      rowCount: windowCountRows(),
    }) as typeof selected;
  } else if (leftBarrier === "recursive") {
    selected = recursiveClosure(
      matchingRows,
      matchingRows,
      (current, candidate) => eq(current.visit_id, candidate.visit_id),
    ) as typeof selected;
  }
  if (duplicateLeftRows)
    selected = union(selected, selected, true) as typeof selected;
  const membershipRows = countMembership(membership);
  const matched = semiJoin(
    selected,
    membershipRows,
    eq(selected.columns.site_id, membershipRows.columns.siteId),
  ) as AnyRelation;
  let projectionInput = matched;
  if (localPrefix) {
    projectionInput = filter(
      projectionInput,
      eq(
        projectionInput.columns.status as SqlExpression<string | null>,
        param("complete") as never,
      ),
    ) as AnyRelation;
    if (nestedPrefix) {
      const copiedColumns = Object.fromEntries(
        Object.entries(projectionInput.columns).map(([name, expression]) => [
          name,
          expression,
        ]),
      ) as Record<string, AnyExpression>;
      if (unsafePrefixProjection === "abs")
        copiedColumns.duration_ms = callFunction(
          "abs",
          projectionInput.columns.duration_ms as SqlExpression<number | null>,
        );
      else if (unsafePrefixProjection === "unixepoch")
        copiedColumns.duration_ms = unixepoch() as AnyExpression;
      projectionInput = project(projectionInput, copiedColumns) as AnyRelation;
      projectionInput = filter(
        projectionInput,
        eq(
          projectionInput.columns.status as SqlExpression<string | null>,
          param("complete") as never,
        ),
      ) as AnyRelation;
    }
  }
  switch (membershipPrefixBarrier) {
    case "sort":
      projectionInput = sort(projectionInput, [
        { expression: projectionInput.columns.visit_id, direction: "ASC" },
      ]) as AnyRelation;
      break;
    case "limit":
      projectionInput = limit(projectionInput, 10) as AnyRelation;
      break;
    case "window":
      projectionInput = window(projectionInput, {
        rowCount: windowCountRows(),
      }) as AnyRelation;
      break;
    case "distinct":
      projectionInput = distinct(projectionInput) as AnyRelation;
      break;
    case "union":
      projectionInput = union(
        projectionInput,
        projectionInput,
        true,
      ) as AnyRelation;
      break;
  }
  const columns = projectionInput.columns as Readonly<
    Record<string, AnyExpression>
  >;
  const projections: Record<string, AnyExpression> = {
    duration:
      unsafeProjection === "abs"
        ? callFunction(
            "abs",
            columns.duration_ms! as SqlExpression<number | null>,
          )
        : columns.duration_ms!,
    visitId: columns.visit_id!,
    siteId: columns.site_id!,
    sitePk: columns.site_pk!,
    visitorId: columns.visitor_id!,
    sessionId: columns.session_id!,
    status: columns.status!,
    startedAt: columns.started_at!,
    lastActivityAt: columns.last_activity_at!,
    pathname: columns.pathname!,
    queryString: columns.query_string!,
    hostname: columns.hostname!,
    title: columns.title!,
    utmSource: columns.utm_source!,
    utmMedium: columns.utm_medium!,
    utmCampaign: columns.utm_campaign!,
    browser: columns.browser!,
    language: columns.language!,
  };
  if (unsafeProjection === "unixepoch")
    projections.duration = unixepoch() as AnyExpression;
  else if (unsafeProjection === "correlated-scalar") {
    const identities = scan(schema.site_identities);
    const correlated = filter(
      identities,
      eq(identities.columns.site_id, matched.columns.site_id),
    );
    const scalarValue = project(correlated, {
      siteId: correlated.columns.site_id,
    });
    projections.duration = awaitScalar(scalarValue) as AnyExpression;
  }
  const projectionEntries = Object.entries(projections);
  while (projectionEntries.length > width) {
    const last = projectionEntries.at(-1)?.[0];
    if (last === undefined || last === "visitId" || last === "siteId") break;
    projectionEntries.pop();
  }
  const selectedProjections = Object.fromEntries(projectionEntries) as Record<
    string,
    AnyExpression
  >;
  const stableFields = [
    columns.duration_ms!,
    columns.site_id!,
    columns.visit_id!,
    columns.visitor_id!,
    columns.session_id!,
    columns.status!,
    columns.started_at!,
    columns.last_activity_at!,
    columns.pathname!,
    columns.hostname!,
  ];
  for (
    let index = Object.keys(selectedProjections).length;
    index < width;
    index++
  )
    selectedProjections[`extra${index}`] =
      stableFields[index % stableFields.length]!;
  return project(projectionInput, selectedProjections) as AnyRelation;
}

function awaitScalar(source: AnyRelation): AnyExpression {
  // Keep the query import local to make the expression edge obvious here.
  return scalarSubquery(source);
}

function scalarSubquery(source: AnyRelation): AnyExpression {
  return scalar(source);
}

function consumers(
  input: AnyRelation,
  count: number,
  reject = false,
): AnyRelation {
  const columns = input.columns as Readonly<Record<string, AnyExpression>>;
  const branches = Array.from({ length: count }, (_value, index) => {
    if (reject) {
      const visitId = columns.visitId! as SqlExpression<string>;
      const rejected = filter(
        input,
        eq(visitId, param<string>("no-such-visit") as never),
      );
      return project(rejected, {
        visitId: rejected.columns.visitId,
      }) as AnyRelation;
    }
    return project(input, {
      visitId: columns.visitId!,
      consumer: param(`consumer-${index}`),
    }) as AnyRelation;
  });
  return branches
    .slice(1)
    .reduce(
      (combined, branch) => union(combined, branch, true) as AnyRelation,
      branches[0]!,
    );
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

function observe(
  run: () => Record<string, unknown>[],
):
  | { readonly kind: "rows"; readonly rows: Record<string, unknown>[] }
  | { readonly kind: "error"; readonly message: string } {
  try {
    return { kind: "rows", rows: run() };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeEvidence(value: unknown): void {
  const evidencePath = process.env.WAVE94E_REPAIR_ABS_EVIDENCE_PATH;
  if (!evidencePath) return;
  const absolutePath = resolve(evidencePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("shared membership input reuse review", () => {
  it("rejects ABS(INT64_MIN) and preserves false-consumer SQLite behavior", () => {
    const db = database();
    const input = sharedInput({ width: 17, unsafeProjection: "abs" });
    const output = consumers(input, 8, true);
    const physical = lowerLogicalPlan(output);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === input.node,
    );
    const optimized = compileD1Query(physical);
    const original = compileD1QueryUnoptimizedForTest(output);
    const optimizedOutcome = observe(() => execute(db, optimized));
    const originalOutcome = observe(() => execute(db, original));
    const falseGateInput = sharedInput({
      width: 18,
      unsafeProjection: "abs",
      membership: { resourceGate: true },
    });
    const falseGateOutput = consumers(falseGateInput, 8);
    const falseGatePhysical = lowerLogicalPlan(falseGateOutput);
    const falseGateDefinition = falseGatePhysical.sharedRelations.find(
      ({ node }) => node === falseGateInput.node,
    );
    const falseGateOptimized = compileD1Query(falseGatePhysical);
    const falseGateOriginal = compileD1QueryUnoptimizedForTest(falseGateOutput);
    const falseGateOptimizedOutcome = observe(() =>
      execute(db, falseGateOptimized),
    );
    const falseGateOriginalOutcome = observe(() =>
      execute(db, falseGateOriginal),
    );
    writeEvidence({
      schema: "wave94e-shared-membership-abs-postfix-oracle-v1",
      scenarios: [
        {
          scenario: "false-consumer-abs-int64-min",
          publicApiShape: {
            projectFields: input.fields.length,
            membershipKind:
              input.node.kind === "project" ? input.node.input.node.kind : null,
            consumerCount: 8,
            rightContainsBoundedGroupSummary: true,
          },
          selectedSharedDefinition: definition
            ? {
                name: definition.name,
                materialization: definition.materialization,
                width: definition.fields.length,
              }
            : null,
          optimized: {
            sql: optimized.sql,
            bindings: optimized.bindings ?? [],
            sqlUtf8Bytes: Buffer.byteLength(optimized.sql, "utf8"),
            sha256: sha256(optimized.sql),
            outcome: optimizedOutcome,
          },
          original: {
            sql: original.sql,
            bindings: original.bindings ?? [],
            sqlUtf8Bytes: Buffer.byteLength(original.sql, "utf8"),
            sha256: sha256(original.sql),
            outcome: originalOutcome,
          },
        },
        {
          scenario: "false-resource-gate-abs-int64-min",
          publicApiShape: {
            projectFields: falseGateInput.fields.length,
            membershipKind:
              falseGateInput.node.kind === "project"
                ? falseGateInput.node.input.node.kind
                : null,
            consumerCount: 8,
            rightContainsBoundedGroupSummary: true,
            resourceGate:
              "false equality filter inside right membership relation",
          },
          selectedSharedDefinition: falseGateDefinition
            ? {
                name: falseGateDefinition.name,
                materialization: falseGateDefinition.materialization,
                width: falseGateDefinition.fields.length,
              }
            : null,
          optimized: {
            sql: falseGateOptimized.sql,
            bindings: falseGateOptimized.bindings ?? [],
            sqlUtf8Bytes: Buffer.byteLength(falseGateOptimized.sql, "utf8"),
            sha256: sha256(falseGateOptimized.sql),
            outcome: falseGateOptimizedOutcome,
          },
          original: {
            sql: falseGateOriginal.sql,
            bindings: falseGateOriginal.bindings ?? [],
            sqlUtf8Bytes: Buffer.byteLength(falseGateOriginal.sql, "utf8"),
            sha256: sha256(falseGateOriginal.sql),
            outcome: falseGateOriginalOutcome,
          },
        },
      ],
      oracle: {
        absInt64MinWouldOverflowIfEvaluated: true,
        bothScenariosReturnRows: false,
        optimizedAndOriginalOutcomesMatch: true,
      },
    });
    expect(definition).toBeUndefined();
    expect(optimizedOutcome).toEqual({ kind: "rows", rows: [] });
    expect(originalOutcome).toEqual({ kind: "rows", rows: [] });
    expect(falseGateDefinition).toBeUndefined();
    expect(falseGateOptimizedOutcome).toEqual({ kind: "rows", rows: [] });
    expect(falseGateOriginalOutcome).toEqual({ kind: "rows", rows: [] });
  });

  it("materializes a safe wide fanout input and preserves bag semantics", () => {
    const db = database();
    const input = sharedInput({ width: 22 });
    const output = consumers(input, 8);
    const physical = lowerLogicalPlan(output);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === input.node,
    );
    expect(definition).toMatchObject({
      materialization: "materialized",
      fields: input.fields,
    });

    const optimized = compileD1Query(physical);
    const original = compileD1QueryUnoptimizedForTest(output);
    expect(Buffer.byteLength(optimized.sql, "utf8")).toBeLessThan(100_000);
    expect(Buffer.byteLength(original.sql, "utf8")).toBeLessThan(100_000);
    const optimizedRows = execute(db, optimized);
    const originalRows = execute(db, original);
    expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
    expect(optimizedRows).toHaveLength(16);

    expect(() =>
      validatePhysicalQueryPlan({ ...physical, sharedRelations: [] }),
    ).toThrow(/shared relation metadata is inconsistent/i);
  });

  it("shares a closed local Project/Filter prefix with 22 direct consumers", () => {
    const db = database();
    const input = sharedInput({
      width: 23,
      localPrefix: true,
      nestedPrefix: true,
      duplicateLeftRows: true,
    });
    const output = consumers(input, 22);
    const physical = lowerLogicalPlan(output);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === input.node,
    );
    expect(definition).toMatchObject({
      materialization: "materialized",
      fields: input.fields,
    });
    expect(input.node.kind).toBe("project");
    if (input.node.kind === "project") {
      expect(input.node.input.node.kind).toBe("filter");
      if (input.node.input.node.kind === "filter")
        expect(input.node.input.node.input.node.kind).toBe("project");
    }

    const optimized = compileD1Query(physical);
    const optimizedRows = execute(db, optimized);
    expect(optimizedRows).toHaveLength(88);
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();

    const singleOutput = consumers(input, 1);
    const singleOriginal = compileD1QueryUnoptimizedForTest(singleOutput);
    const singleRows = execute(db, singleOriginal);
    const expectedRows = Array.from({ length: 22 }, (_value, index) =>
      singleRows.map((row) => ({ ...row, consumer: `consumer-${index}` })),
    ).flat();
    expect(rowBag(optimizedRows)).toEqual(rowBag(expectedRows));

    const semanticInput = sharedInput({
      width: 17,
      localPrefix: true,
    });
    const semanticOutput = consumers(semanticInput, 8);
    const semanticPhysical = lowerLogicalPlan(semanticOutput);
    const semanticOptimized = compileD1Query(semanticPhysical);
    const optimizedSemanticRows = execute(db, semanticOptimized);
    const semanticSingleOriginal = compileD1QueryUnoptimizedForTest(
      consumers(semanticInput, 1),
    );
    const semanticSingleRows = execute(db, semanticSingleOriginal);
    const semanticExpectedRows = Array.from({ length: 8 }, (_value, index) =>
      semanticSingleRows.map((row) => ({
        ...row,
        consumer: `consumer-${index}`,
      })),
    ).flat();
    expect(rowBag(optimizedSemanticRows)).toEqual(rowBag(semanticExpectedRows));
    expect(optimizedSemanticRows).toHaveLength(16);

    const barrierInput = sharedInput({
      width: 23,
      localPrefix: true,
      membershipPrefixBarrier: "limit",
    });
    const barrierPhysical = lowerLogicalPlan(consumers(barrierInput, 22));
    expect(
      barrierPhysical.sharedRelations.some(
        ({ node }) => node === barrierInput.node,
      ),
    ).toBe(false);
    const forged = {
      ...barrierPhysical,
      sharedRelations: [
        ...barrierPhysical.sharedRelations,
        {
          name: "_d1_shared_forged",
          node: barrierInput.node,
          fields: barrierInput.fields,
          materialization: "materialized",
          dependencies: [],
        },
      ],
    } as typeof barrierPhysical;
    expect(() => validatePhysicalQueryPlan(forged)).toThrow(
      /shared relation metadata is inconsistent/i,
    );
  });

  it("keeps the resource gate inside membership and preserves LEFT JOIN empty-side rows", () => {
    const db = database();
    for (const membership of [
      { resourceGate: true },
      { emptyDimension: true },
    ]) {
      const input = sharedInput({ width: 22, membership });
      const output = consumers(input, 8);
      const physical = lowerLogicalPlan(output);
      expect(
        physical.sharedRelations.find(({ node }) => node === input.node),
      ).toMatchObject({ materialization: "materialized" });
      const optimizedRows = execute(db, compileD1Query(physical));
      const originalRows = execute(
        db,
        compileD1QueryUnoptimizedForTest(output),
      );
      expect(rowBag(optimizedRows)).toEqual(rowBag(originalRows));
      expect(optimizedRows).toHaveLength(membership.resourceGate ? 0 : 16);
    }
  });

  it("requires eight consumers and rejects non-total projections and graph barriers", () => {
    const rejectedInputs: InputOptions[] = [
      { width: 22, unsafeProjection: "unixepoch" },
      { width: 22, unsafeProjection: "correlated-scalar" },
      { width: 22, leftBarrier: "sort" },
      { width: 22, leftBarrier: "limit" },
      { width: 22, leftBarrier: "window" },
      { width: 22, leftBarrier: "recursive" },
      { width: 22, membership: { countBarrier: "sort" } },
      { width: 22, membership: { countBarrier: "limit" } },
      { width: 22, membership: { countBarrier: "window" } },
      { width: 22, membership: { countBarrier: "recursive" } },
    ];
    for (const options of rejectedInputs) {
      const input = sharedInput(options);
      const physical = lowerLogicalPlan(consumers(input, 8));
      expect(
        physical.sharedRelations.some(({ node }) => node === input.node),
      ).toBe(false);
    }

    for (const options of [
      {
        width: 23,
        localPrefix: true,
        nestedPrefix: true,
        unsafePrefixProjection: "abs" as const,
      },
      {
        width: 23,
        localPrefix: true,
        nestedPrefix: true,
        unsafePrefixProjection: "unixepoch" as const,
      },
      ...(["sort", "limit", "window", "distinct", "union"] as const).map(
        (membershipPrefixBarrier) => ({
          width: 23,
          localPrefix: true,
          membershipPrefixBarrier,
        }),
      ),
      { width: 16, localPrefix: true },
      { width: 33, localPrefix: true },
    ]) {
      const input = sharedInput(options);
      const physical = lowerLogicalPlan(consumers(input, 22));
      expect(
        physical.sharedRelations.some(({ node }) => node === input.node),
      ).toBe(false);
    }

    const sevenConsumers = sharedInput({ width: 22 });
    const physical = lowerLogicalPlan(consumers(sevenConsumers, 7));
    expect(
      physical.sharedRelations.some(({ node }) => node === sevenConsumers.node),
    ).toBe(false);
  });

  it("does not treat nullable visits.visit_id as a unique window order key", () => {
    const input = sharedInput({ width: 22 });
    const ranked = window(input, {
      rank: rowNumber({
        orderBy: [{ expression: input.columns.visitId!, direction: "ASC" }],
      }),
    }) as AnyRelation;
    const output = union(
      consumers(input, 8),
      consumers(ranked, 1),
      true,
    ) as AnyRelation;
    const physical = lowerLogicalPlan(output);

    expect(
      physical.sharedRelations.some(({ node }) => node === input.node),
    ).toBe(false);
  });
});
