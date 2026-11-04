import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  and,
  callFunction,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  gt,
  isNotNull,
  join,
  not,
  param,
  project,
  rowNumber,
  scalar,
  scan,
  union,
  unixepoch,
  window,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import {
  type AnyExpression,
  isNull,
  type RelationScope,
  type SqlExpression,
} from "@/lib/db/query/expression";
import { correlatedConstantExistenceOuterScopes } from "@/lib/db/query/ordinary-filter-fanout";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type {
  LogicalQueryNode,
  QuerySource,
  Relation,
} from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function wideProject(input: Relation, width: number): Relation {
  const columns = Object.values(input.columns) as AnyExpression[];
  const projections = Object.fromEntries(
    Array.from({ length: width }, (_, index) => [
      `field${index}`,
      columns[index % columns.length]!,
    ]),
  );
  return project(input, projections);
}

function ordinaryCandidate(width: number): Relation {
  const visits = scan(schema.visits);
  const selected = filter(
    visits,
    eq(visits.columns.pathname, param("/candidate")),
  );
  return wideProject(selected, width);
}

function localFanout(width: number, references: number) {
  const candidate = ordinaryCandidate(width);
  const branches = Array.from({ length: references }, (_, index) =>
    filter(
      candidate,
      eq(candidate.columns.field0!, param(`row-${index}`) as never),
    ),
  );
  const output = branches
    .slice(1)
    .reduce((previous, branch) => union(previous, branch, true), branches[0]!);
  return { candidate, output };
}

function queryConsumerFanout(
  consumer:
    | "scalar-equality"
    | "nonconstant"
    | "negated"
    | "nested"
    | "volatile"
    | "erroring"
    | "in-query-edge",
) {
  const candidate = ordinaryCandidate(17);
  const branches = Array.from({ length: 8 }, (_, index) => {
    if (consumer === "in-query-edge") {
      const outer = scan(schema.site_identities);
      const candidateQuery = project(candidate, { found: constant(1) });
      return filter(outer, isNotNull(scalar(candidateQuery)));
    }
    const events = scan(schema.visits);
    let matching = filter(
      events,
      and(
        eq(events.columns.session_id, candidate.columns.field1!),
        eq(events.columns.pathname, param(`/condition-${index}`)),
      ),
    );
    if (consumer === "nested") {
      const nestedVisits = scan(schema.visits);
      const nested = filter(
        nestedVisits,
        eq(nestedVisits.columns.visit_id, param("unused")),
      );
      matching = filter(
        matching,
        isNotNull(scalar(project(nested, { found: constant(1) }))),
      );
    }
    if (consumer === "volatile")
      matching = filter(matching, gt(unixepoch(), param(0)));
    if (consumer === "erroring")
      matching = filter(
        matching,
        gt(callFunction("abs", matching.columns.duration_ms), constant(0)),
      );
    const output = project(
      matching,
      consumer === "nonconstant"
        ? { found: matching.columns.visit_id }
        : { found: constant(1) },
    );
    const exists = isNotNull(scalar(output));
    const predicate =
      consumer === "scalar-equality"
        ? eq(scalar(output), constant(1) as never)
        : consumer === "negated"
          ? not(exists)
          : exists;
    return filter(candidate, predicate);
  });
  const output = branches
    .slice(1)
    .reduce((previous, branch) => union(previous, branch, true), branches[0]!);
  return { candidate, output };
}

function correlatedPayloadFanout(includeNullableDurationScenario = false): {
  readonly candidate: Relation;
  readonly output: Relation;
  readonly database: DatabaseSync;
} {
  const database = createMigratedDatabase();
  databases.add(database);
  const siteId = "ordinary-fanout-site";
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { site_pk: number }
    ).site_pk,
  );
  const insertName = database.prepare(
    "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, 1, ?)",
  );
  insertName.run(1, siteId, "name-a", sitePk);
  insertName.run(2, siteId, "name-b", sitePk);
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, duration_ms, pathname, hostname, site_pk
    ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, 'ordinary.fixture', ?)`,
  );
  const addVisit = (
    visitId: string,
    sessionId: string | null,
    pathname: string,
    duration: number | null,
  ) =>
    insertVisit.run(
      visitId,
      siteId,
      `visitor:${visitId}`,
      sessionId,
      100,
      100,
      duration,
      pathname,
      sitePk,
    );
  addVisit("candidate-good", "shared-session", "/entity", null);
  addVisit("candidate-incomplete", "incomplete-session", "/entity", 17);
  addVisit("candidate-unmatched", "unmatched-session", "/entity", 23);
  for (let index = 0; index < 8; index += 1)
    addVisit(
      `event-good-${index}`,
      "shared-session",
      `/condition-${index}`,
      index,
    );
  for (let index = 0; index < 7; index += 1)
    addVisit(
      `event-incomplete-${index}`,
      "incomplete-session",
      `/condition-${index}`,
      index,
    );
  if (includeNullableDurationScenario)
    for (let index = 0; index < 7; index += 1)
      addVisit(
        `event-duration-match-${index}`,
        "duration-match-session",
        `/condition-${index}`,
        17,
      );

  const pages = scan(schema.visits);
  const candidatePages = filter(
    pages,
    eq(pages.columns.pathname, param("/entity")),
  );
  const names = scan(schema.custom_event_names);
  const joined = join(
    candidatePages,
    names,
    eq(candidatePages.columns.site_pk, names.columns.site_pk),
  );
  const projections: Record<string, AnyExpression> = {
    field0: joined.columns.left_visit_id,
    field1: joined.columns.left_session_id,
    field2: joined.columns.left_duration_ms,
    field3: joined.columns.right_name,
  };
  const available = Object.values(projections);
  for (let index = 4; index < 17; index += 1)
    projections[`field${index}`] = available[(index - 4) % available.length]!;
  const candidate = project(joined, projections);

  const branches = Array.from({ length: 8 }, (_, index) => {
    const events = scan(schema.visits);
    const matching = filter(
      events,
      and(
        eq(events.columns.session_id, candidate.columns.field1),
        eq(events.columns.pathname, param(`/condition-${index}`)),
      ),
    );
    const existence = project(matching, { found: constant(1) });
    return filter(candidate, isNotNull(scalar(existence)));
  });
  let accumulated = project(branches[0]!, {
    candidateId: branches[0]!.columns.field0,
    duration: branches[0]!.columns.field2,
  });
  for (const branch of branches.slice(1)) {
    const joinedBranches = join(
      accumulated,
      branch,
      eq(accumulated.columns.candidateId, branch.columns.field0),
    );
    accumulated = project(joinedBranches, {
      candidateId: joinedBranches.columns.left_candidateId,
      duration: joinedBranches.columns.left_duration,
    });
  }
  return { candidate, output: accumulated, database };
}

function rowBag(rows: readonly Record<string, unknown>[]): readonly string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function relationChildren(node: LogicalQueryNode): readonly QuerySource[] {
  if (
    node.kind === "scan" ||
    node.kind === "values-relation" ||
    node.kind === "json-scalar-array"
  )
    return [];
  if (
    node.kind === "filter" ||
    node.kind === "project" ||
    node.kind === "aggregate" ||
    node.kind === "distinct" ||
    node.kind === "window" ||
    node.kind === "sort" ||
    node.kind === "limit"
  )
    return [node.input];
  if (node.kind === "recursive-closure") return [node.seed, node.candidates];
  return [node.left, node.right];
}

function inspectSimpleColumns(
  expression: SqlExpression,
  _allowedScopes: ReadonlySet<RelationScope>,
) {
  const columns: { scope: RelationScope; index: number }[] = [];
  let valid = true;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.kind === "column") {
      columns.push({
        scope: record.scope as RelationScope,
        index: record.index as number,
      });
      return;
    }
    if (
      record.kind === "unixepoch" ||
      record.kind === "scalar-subquery" ||
      record.kind === "in-subquery"
    ) {
      valid = false;
      return;
    }
    for (const [key, child] of Object.entries(record))
      if (key !== "scope" && key !== "query") visit(child);
  };
  visit(expression);
  return { valid, columns };
}

describe("ordinary shared filter fanout", () => {
  it.each([
    [17, 8, true],
    [32, 8, true],
    [16, 8, false],
    [33, 8, false],
    [17, 7, false],
  ] as const)(
    "applies the independent width/reference boundary %i/%i",
    (width, references, shared) => {
      const { candidate, output } = localFanout(width, references);
      const physical = lowerLogicalPlan(output);
      const selected = physical.sharedRelations.find(
        ({ node }) => node === candidate.node,
      );
      expect(selected?.materialization === "auto").toBe(shared);
      if (shared) {
        expect(() =>
          compileD1Query({
            ...physical,
            sharedRelations: physical.sharedRelations.filter(
              ({ node }) => node !== candidate.node,
            ),
          }),
        ).toThrowError(expect.objectContaining({ code: "invalid_plan" }));
      }
    },
  );

  it("shares only the closed ordinary base and preserves correlated AND, duplicate, and NULL bags", () => {
    const { candidate, output, database } = correlatedPayloadFanout();
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === candidate.node),
    ).toMatchObject({ materialization: "auto", fields: expect.any(Array) });
    expect(
      physical.sharedRelations.some(
        ({ node }) => node.kind === "project" && node !== candidate.node,
      ),
    ).toBe(false);

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(output);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];

    expect(optimized.sql.length).toBeLessThan(mechanical.sql.length);
    expect(rowBag(optimizedRows)).toEqual(rowBag(mechanicalRows));
    expect(optimizedRows).toHaveLength(256);
    expect(
      new Set(optimizedRows.map(({ candidateId }) => candidateId)),
    ).toEqual(new Set(["candidate-good"]));
    expect(optimizedRows.every(({ duration }) => duration === null)).toBe(true);
  });

  it.each(["IS NULL", "IS NOT NULL"] as const)(
    "proves correlated SELECT 1 %s only over its complete safe body",
    (polarity) => {
      const candidate = ordinaryCandidate(17);
      const events = scan(schema.visits);
      const selectedEvents = filter(
        events,
        and(
          eq(events.columns.duration_ms, candidate.columns.field2!),
          eq(events.columns.pathname, param("/condition")),
        ),
      );
      const names = scan(schema.custom_event_names);
      const joined = join(
        selectedEvents,
        names,
        eq(selectedEvents.columns.site_pk, names.columns.site_pk),
      );
      const existence = project(joined, { found: constant(1) });
      const parent = filter(
        candidate,
        polarity === "IS NULL"
          ? isNull(scalar(existence))
          : isNotNull(scalar(existence)),
      );

      expect(
        correlatedConstantExistenceOuterScopes(
          parent.node,
          relationChildren,
          inspectSimpleColumns,
        ),
      ).toEqual(new Map([[candidate.scope, candidate.fields.length]]));
    },
  );

  it("preserves correlated IS NULL bags for missing matches and NULL outer keys", () => {
    const { candidate, database } = correlatedPayloadFanout(true);
    const events = scan(schema.visits);
    const branches = Array.from({ length: 8 }, (_, index) => {
      const matching = filter(
        events,
        and(
          eq(events.columns.duration_ms, candidate.columns.field2!),
          eq(events.columns.pathname, param(`/condition-${index}`)),
        ),
      );
      const absent = filter(
        candidate,
        isNull(scalar(project(matching, { found: constant(1) }))),
      );
      return project(absent, {
        candidateId: absent.columns.field0!,
        duration: absent.columns.field2!,
      });
    });
    const output = branches
      .slice(1)
      .reduce(
        (previous, branch) => union(previous, branch, true),
        branches[0]!,
      );
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === candidate.node),
    ).toMatchObject({ materialization: "auto", fields: expect.any(Array) });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(output);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];

    expect(rowBag(optimizedRows)).toEqual(rowBag(mechanicalRows));
    expect(optimizedRows).toHaveLength(34);
    expect(
      new Set(optimizedRows.map(({ candidateId }) => candidateId)),
    ).toEqual(
      new Set([
        "candidate-good",
        "candidate-incomplete",
        "candidate-unmatched",
      ]),
    );
    expect(
      optimizedRows.filter(
        ({ candidateId }) => candidateId === "candidate-good",
      ),
    ).toHaveLength(16);
    expect(
      optimizedRows
        .filter(({ candidateId }) => candidateId === "candidate-good")
        .every(({ duration }) => duration === null),
    ).toBe(true);
  });

  it("accepts a shared scan DAG inside a closed ordinary join candidate", () => {
    const { database } = correlatedPayloadFanout();
    const visits = scan(schema.visits);
    const leftRows = filter(
      visits,
      eq(visits.columns.pathname, param("/entity")),
    );
    const left = project(leftRows, {
      visitId: leftRows.columns.visit_id,
      sessionId: leftRows.columns.session_id,
    });
    const rightRows = filter(
      visits,
      eq(visits.columns.pathname, param("/entity")),
    );
    const right = project(rightRows, {
      visitId: rightRows.columns.visit_id,
      sessionId: rightRows.columns.session_id,
    });
    const joined = join(
      left,
      right,
      eq(left.columns.sessionId, right.columns.sessionId),
    );
    const candidate = wideProject(joined, 17);
    const branches = Array.from({ length: 8 }, () =>
      filter(
        candidate,
        eq(candidate.columns.field0!, param("candidate-good") as never),
      ),
    );
    const output = branches
      .slice(1)
      .reduce(
        (previous, branch) => union(previous, branch, true),
        branches[0]!,
      );
    const physical = lowerLogicalPlan(output);

    expect(
      physical.sharedRelations.find(({ node }) => node === candidate.node),
    ).toMatchObject({ materialization: "auto", fields: expect.any(Array) });

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(output);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];

    expect(rowBag(optimizedRows)).toEqual(rowBag(mechanicalRows));
    expect(optimizedRows).toHaveLength(8);
  });

  it("stops ordinary base analysis when a join contains an aggregate child", () => {
    const { database } = correlatedPayloadFanout();
    const identities = scan(schema.site_identities);
    const grouped = aggregate(identities, {
      groupBy: { siteId: identities.columns.site_id },
      aggregates: { rows: count() },
    });
    const right = scan(schema.site_identities);
    const joined = join(
      grouped,
      right,
      eq(grouped.columns.siteId, right.columns.site_id),
    );
    const candidate = wideProject(joined, 17);
    const branches = Array.from({ length: 8 }, () =>
      filter(
        candidate,
        eq(candidate.columns.field0!, param("ordinary-fanout-site") as never),
      ),
    );
    const output = branches
      .slice(1)
      .reduce(
        (previous, branch) => union(previous, branch, true),
        branches[0]!,
      );
    const physical = lowerLogicalPlan(output);

    expect(
      physical.sharedRelations.some(({ node }) => node === candidate.node),
    ).toBe(false);

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(output);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];

    expect(rowBag(optimizedRows)).toEqual(rowBag(mechanicalRows));
    expect(optimizedRows).toHaveLength(8);
  });

  it("keeps a self-based scalar existence fanout unmaterialized", () => {
    const { candidate, database } = correlatedPayloadFanout();
    const branches = Array.from({ length: 8 }, () =>
      filter(
        candidate,
        isNotNull(scalar(project(candidate, { found: constant(1) }))),
      ),
    );
    const output = branches
      .slice(1)
      .reduce(
        (previous, branch) => union(previous, branch, true),
        branches[0]!,
      );
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.some(({ node }) => node === candidate.node),
    ).toBe(false);

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(output);
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];

    expect(rowBag(optimizedRows)).toEqual(rowBag(mechanicalRows));
    expect(optimizedRows).toHaveLength(48);
  });

  it.each([
    "scalar-equality",
    "nonconstant",
    "negated",
    "nested",
    "volatile",
    "erroring",
    "in-query-edge",
  ] as const)("rejects the unsafe %s consumer shape", (consumer) => {
    const { candidate, output } = queryConsumerFanout(consumer);
    expect(
      lowerLogicalPlan(output).sharedRelations.some(
        ({ node }) => node === candidate.node,
      ),
    ).toBe(false);
  });

  it.each(["window", "aggregate", "query", "volatile"] as const)(
    "rejects a %s node in the candidate base closure",
    (kind) => {
      const visits = scan(schema.visits);
      const selected = filter(
        visits,
        eq(visits.columns.pathname, param("/candidate")),
      );
      let input: Relation = selected;
      if (kind === "window")
        input = window(selected, {
          rank: rowNumber({
            orderBy: [
              { expression: selected.columns.visit_id, direction: "ASC" },
            ],
          }),
        });
      else if (kind === "aggregate")
        input = aggregate(selected, {
          groupBy: { visitId: selected.columns.visit_id },
          aggregates: { rows: count() },
        });
      else if (kind === "query")
        input = filter(
          selected,
          isNotNull(
            scalar(project(scan(schema.visits), { found: constant(1) })),
          ),
        );
      else input = filter(selected, gt(unixepoch(), param(0)));
      const candidate = wideProject(input, 17);
      const branches = Array.from({ length: 8 }, (_, index) =>
        filter(
          candidate,
          eq(candidate.columns.field0!, param(`row-${index}`) as never),
        ),
      );
      const output = branches
        .slice(1)
        .reduce(
          (previous, branch) => union(previous, branch, true),
          branches[0]!,
        );
      expect(
        lowerLogicalPlan(output).sharedRelations.some(
          ({ node }) => node === candidate.node,
        ),
      ).toBe(false);
    },
  );

  it("rejects external scopes in candidate and correlated-query closures", () => {
    const visits = scan(schema.visits);
    const selected = filter(
      visits,
      eq(visits.columns.pathname, param("/candidate")),
    );
    const external = scan(schema.site_identities);
    const candidateWithExternalScope = wideProject(
      filter(selected, eq(selected.columns.site_pk, external.columns.site_pk)),
      17,
    );
    const invalidCandidateBranches = Array.from({ length: 8 }, (_, index) =>
      filter(
        candidateWithExternalScope,
        eq(
          candidateWithExternalScope.columns.field0!,
          param(`row-${index}`) as never,
        ),
      ),
    );
    const invalidCandidateOutput = invalidCandidateBranches
      .slice(1)
      .reduce(
        (previous, branch) => union(previous, branch, true),
        invalidCandidateBranches[0]!,
      );
    expect(() => lowerLogicalPlan(invalidCandidateOutput)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );

    const candidate = ordinaryCandidate(17);
    const externalRows = scan(schema.site_identities);
    const events = scan(schema.visits);
    const queryWithExternalScope = project(
      filter(events, eq(events.columns.site_pk, externalRows.columns.site_pk)),
      { found: constant(1) },
    );
    const invalidQueryBranches = Array.from({ length: 8 }, () =>
      filter(candidate, isNotNull(scalar(queryWithExternalScope))),
    );
    const invalidQueryOutput = invalidQueryBranches
      .slice(1)
      .reduce(
        (previous, branch) => union(previous, branch, true),
        invalidQueryBranches[0]!,
      );
    expect(() => lowerLogicalPlan(invalidQueryOutput)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });
});
