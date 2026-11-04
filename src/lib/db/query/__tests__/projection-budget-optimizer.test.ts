import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  add,
  and,
  antiJoin,
  callFunction,
  caseWhen,
  castInteger,
  castText,
  coalesce,
  compileD1Query,
  constant,
  count,
  distinct,
  eq,
  filter,
  inList,
  inSubquery,
  isDistinctFrom,
  isNotNull,
  isNull,
  join,
  jsonScalarArray,
  limit,
  neq,
  not,
  or,
  param,
  project,
  recursiveClosure,
  scalar,
  scan,
  semiJoin,
  textLike,
  textPosition,
  textSubstring,
  union,
  unixepoch,
  valuesRelation,
} from "@/lib/db";
import {
  compileD1QueryTupleMembershipFallbackForTest,
  compileD1QueryUnoptimizedForTest,
} from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import { hasKnownBinaryTableColumn } from "@/lib/db/query/physical/self-membership";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import { optimizePhysicalMembershipBudget } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type { SchemaObjectReference } from "@/lib/db/schema/types";

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function projectionExistsPlan(includePassthrough: boolean) {
  const outer = scan(schema.site_identities);
  const projections: Record<string, AnyExpression> = {
    siteId: outer.columns.site_id,
  };

  for (let index = 0; index < 48; index += 1) {
    const left = scan(schema.site_identities);
    const right = scan(schema.site_identities);
    const joined = join(
      left,
      right,
      eq(left.columns.site_pk, right.columns.site_pk),
    );
    const selected = filter(
      joined,
      and(
        eq(joined.columns.left_site_pk, outer.columns.site_pk),
        eq(
          joined.columns.right_site_id,
          param(index === 0 ? "projection-budget-match" : `missing-${index}`),
        ),
      ),
    );

    let input: Relation<
      object,
      Readonly<Record<string, AnyExpression>>
    > = selected;
    if (includePassthrough) {
      const forwarded: Record<string, AnyExpression> = {};
      for (let field = 0; field < 12; field += 1)
        forwarded[`copy_${field}`] =
          field % 2 === 0
            ? selected.columns.left_site_pk
            : selected.columns.right_site_id;
      input = project(selected, forwarded) as typeof input;
    }

    projections[`exists_${index}`] = isNotNull(
      scalar(project(input, { found: constant(1) })),
    );
  }

  return project(outer, projections);
}

function hashSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function runRows(
  db: DatabaseSync,
  query: {
    readonly sql: string;
    readonly bindings?: readonly unknown[];
  },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]))
    .sort((left, right) =>
      String(left.siteId).localeCompare(String(right.siteId)),
    );
}

function runBag(
  db: DatabaseSync,
  query: {
    readonly sql: string;
    readonly bindings?: readonly unknown[];
  },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function compositeMembershipPlan(
  fillerCount: number,
  suffix = "A",
  guardFiniteRowsWithTextLike = false,
) {
  const rows = [
    { siteId: "tuple-site-a", sessionId: "tuple-session-a", kind: "eligible" },
    { siteId: "tuple-site-a", sessionId: "tuple-session-a", kind: "eligible" },
    { siteId: "tuple-site-b", sessionId: "tuple-session-b", kind: "eligible" },
    { siteId: "tuple-site-a", sessionId: null, kind: "eligible" },
    { siteId: "tuple-site-a", sessionId: "tuple-session-01", kind: "eligible" },
    { siteId: "tuple-site-a", sessionId: "tuple-session-1", kind: "eligible" },
  ];
  for (let index = 0; index < fillerCount; index += 1)
    rows.push({
      siteId: index % 2 === 0 ? "tuple-site-a" : "tuple-site-b",
      sessionId: `tuple-filler-${suffix}-${String(index).padStart(3, "0")}`,
      kind: "eligible",
    });
  rows.push({
    siteId: "tuple-site-a",
    sessionId: "tuple-ineligible",
    kind: "ignored",
  });

  const finiteRows = valuesRelation(
    {
      siteId: { affinity: "text", nullable: false },
      sessionId: { affinity: "text", nullable: true },
      kind: { affinity: "text", nullable: false },
    } as const,
    rows,
  );
  const eligibleRows = filter(
    finiteRows,
    guardFiniteRowsWithTextLike
      ? and(
          eq(finiteRows.columns.kind, param("eligible")),
          textLike(finiteRows.columns.sessionId, param("%tuple-session%")),
        )
      : eq(finiteRows.columns.kind, param("eligible")),
  );
  const authorizedSites = scan(schema.site_identities);
  const authorizedPairs = join(
    eligibleRows,
    authorizedSites,
    eq(eligibleRows.columns.siteId, authorizedSites.columns.site_id),
  );
  // Deliberately reverse the right key order from the ON equality order.
  const identityProjection = project(authorizedPairs, {
    sessionKey: authorizedPairs.columns.left_sessionId,
    ownerKey: authorizedPairs.columns.right_site_pk,
  });
  const identityKeys = distinct(identityProjection);
  const visits = scan(schema.visits);
  const matches = join(
    visits,
    identityKeys,
    and(
      eq(visits.columns.site_pk, identityKeys.columns.ownerKey),
      eq(visits.columns.session_id, identityKeys.columns.sessionKey),
    ),
  );
  const result = project(matches, {
    siteId: matches.columns.left_site_id,
    sessionId: matches.columns.left_session_id,
  });
  return {
    result,
    finiteRows,
    authorizedPairs,
    identityProjection,
    identityKeys,
    visits,
    matches,
  };
}

function sharedTupleMembershipPlan<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>> & {
    readonly siteId: AnyExpression;
    readonly sitePk: AnyExpression;
  },
>(authorizedSites: Relation<Row, Columns>, fillerCount: number) {
  const rows = [
    { siteId: "tuple-site-a", sessionId: "tuple-session-a", kind: "eligible" },
    { siteId: "tuple-site-a", sessionId: "tuple-session-a", kind: "eligible" },
    { siteId: "tuple-site-b", sessionId: "tuple-session-b", kind: "eligible" },
    { siteId: "tuple-site-a", sessionId: null, kind: "eligible" },
    { siteId: "tuple-site-a", sessionId: "tuple-session-01", kind: "eligible" },
    { siteId: "tuple-site-a", sessionId: "tuple-session-1", kind: "eligible" },
  ];
  for (let index = 0; index < fillerCount; index += 1)
    rows.push({
      siteId: index % 2 === 0 ? "tuple-site-a" : "tuple-site-b",
      sessionId: `tuple-session-filler-${String(index).padStart(5, "0")}`,
      kind: "eligible",
    });
  rows.push({
    siteId: "tuple-site-a",
    sessionId: "tuple-session-ignored",
    kind: "ignored",
  });

  const finiteRows = valuesRelation(
    {
      siteId: { affinity: "text", nullable: false },
      sessionId: { affinity: "text", nullable: true },
      kind: { affinity: "text", nullable: false },
    } as const,
    rows,
  );
  const eligibleRows = filter(
    finiteRows,
    inList(finiteRows.columns.kind, ["eligible", "retry"]),
  );
  const authorizedPairs = join(
    eligibleRows,
    authorizedSites,
    eq(eligibleRows.columns.siteId, authorizedSites.columns.siteId),
  );
  const identityKeys = distinct(
    project(authorizedPairs, {
      sessionKey: authorizedPairs.columns.left_sessionId,
      ownerKey: authorizedPairs.columns.right_sitePk,
    }),
  );
  const visits = scan(schema.visits);
  const matches = join(
    visits,
    identityKeys,
    and(
      eq(
        visits.columns.site_pk,
        identityKeys.columns
          .ownerKey as unknown as typeof visits.columns.site_pk,
      ),
      eq(visits.columns.session_id, identityKeys.columns.sessionKey),
    ),
  );
  const tupleResult = project(matches, {
    siteId: matches.columns.left_site_id,
    sessionId: matches.columns.left_session_id,
  });
  const sharedBranch = project(authorizedSites, {
    siteId: authorizedSites.columns.siteId,
    sessionId: param("shared-branch"),
  });
  const result = union(tupleResult, sharedBranch, true);
  return { result, finiteRows, identityKeys, visits, matches, tupleResult };
}

function firstSharedCteDefinition(sql: string): string {
  const prefix = "WITH _d1_shared_0 AS (";
  const start = sql.indexOf(prefix);
  if (start < 0) throw new Error("Expected the first shared CTE");
  const opening = start + prefix.length - 1;
  let depth = 0;
  let quote: "identifier" | "string" | undefined;
  for (let index = opening; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (quote === "identifier") {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (quote === "string") {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") quote = undefined;
      continue;
    }
    if (character === '"') quote = "identifier";
    else if (character === "'") quote = "string";
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(start, index + 1);
    }
  }
  throw new Error("Unterminated shared CTE definition");
}

function seedTupleFixture(database: DatabaseSync) {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
    .run("tuple-site-a", "tuple-site-b");
  const siteKeys = new Map(
    database
      .prepare("SELECT site_id, site_pk FROM site_identities")
      .all()
      .map((row) => [String(row.site_id), Number(row.site_pk)] as const),
  );
  const insertVisit = database.prepare(
    "INSERT INTO visits (visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, site_pk) VALUES (?, ?, ?, ?, ?, 1, 1, '/', 'tuple.test', ?)",
  );
  const insert = (
    id: string,
    siteId: "tuple-site-a" | "tuple-site-b",
    sessionId: string | Uint8Array,
    bindSitePkAsText = false,
  ) =>
    insertVisit.run(
      id,
      siteId,
      "tuple-visitor",
      sessionId,
      "active",
      bindSitePkAsText ? String(siteKeys.get(siteId)) : siteKeys.get(siteId)!,
    );

  insert("tuple-a-first", "tuple-site-a", "tuple-session-a", true);
  insert("tuple-a-second", "tuple-site-a", "tuple-session-a");
  insert("tuple-b-first", "tuple-site-b", "tuple-session-b");
  insert("tuple-cross-ab", "tuple-site-a", "tuple-session-b");
  insert("tuple-cross-ba", "tuple-site-b", "tuple-session-a");
  insert("tuple-leading-zero", "tuple-site-a", "tuple-session-01");
  insert("tuple-no-leading-zero", "tuple-site-a", "tuple-session-1");
  insert("tuple-partial-null", "tuple-site-a", "tuple-session-absent");
  insert(
    "tuple-blob-session",
    "tuple-site-a",
    new TextEncoder().encode("tuple-session-a"),
  );

  expect(
    database
      .prepare(
        "SELECT typeof(site_pk) AS site_type FROM visits WHERE visit_id = ?",
      )
      .get("tuple-a-first")?.site_type,
  ).toBe("integer");
  expect(
    database
      .prepare(
        "SELECT typeof(session_id) AS session_type FROM visits WHERE visit_id = ?",
      )
      .get("tuple-blob-session")?.session_type,
  ).toBe("blob");
}

describe("generated Event primary-key nullability", () => {
  it("keeps a rowid alias non-null and null-extends it on the right of a LEFT JOIN", () => {
    const events = scan(schema.custom_events);
    const owners = scan(schema.custom_events);
    const leftJoined = join(
      events,
      owners,
      eq(events.columns.event_pk, owners.columns.event_pk),
      "left",
    );

    expect(events.columns.event_pk.resultType.nullable).toBe(false);
    expect(leftJoined.columns.right_event_pk.resultType.nullable).toBe(true);
  });
});

describe("safe passthrough projection fusion", () => {
  it("removes an unused pure projection from 48 correlated scalar-exists leaves", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
      .run("projection-budget-match", "projection-budget-other");

    const relation = projectionExistsPlan(true);
    const physical = lowerLogicalPlan(relation);
    expect(physical.passthroughProjectFusions).toHaveLength(48);
    expect(physical.constantFilterJoinProjections).toHaveLength(48);
    expect(
      physical.passthroughProjectFusions.every(
        ({ input }) => input.node.kind === "filter",
      ),
    ).toBe(true);

    const rootNode = relation.node;
    const before = compileD1QueryUnoptimizedForTest(relation);
    const optimized = compileD1Query(physical);
    const optimizedAgain = compileD1Query(relation);
    const beforeBytes = new TextEncoder().encode(before.sql).byteLength;
    const optimizedBytes = new TextEncoder().encode(optimized.sql).byteLength;
    expect(optimizedBytes).toBeLessThan(beforeBytes - 10_000);
    expect(optimizedBytes).toBeLessThan(100_000);
    expect(physical.sharedRelations).toEqual([]);
    expect(physical.directScanProjections).toEqual([]);
    expect(optimized.bindings).toEqual(before.bindings);
    expect(optimized.bindings).toHaveLength(48);
    expect(optimizedAgain.sql).toBe(optimized.sql);
    expect(optimizedAgain.bindings).toEqual(optimized.bindings);
    expect(hashSql(optimizedAgain.sql)).toBe(hashSql(optimized.sql));
    expect(hashSql(before.sql)).not.toBe(hashSql(optimized.sql));
    expect(optimizedAgain.physicalPlanShape).toEqual(
      optimized.physicalPlanShape,
    );
    expect(optimized.physicalPlanShape).toEqual({
      version: 1,
      cteCount: 0,
      directScanProjectionCount: 0,
      nativeMembershipCount: 0,
      jsonMembershipCount: 0,
    });
    expect(relation.node).toBe(rootNode);

    const frozenOutput = runRows(database, before);
    const optimizedOutput = runRows(database, optimized);
    expect(optimizedOutput).toEqual(frozenOutput);
    expect(
      optimizedOutput.map((row) => [
        row.siteId,
        Object.entries(row).filter(
          ([name, value]) => name.startsWith("exists_") && value === 1,
        ).length,
      ]),
    ).toEqual([
      ["projection-budget-match", 1],
      ["projection-budget-other", 0],
    ]);

    const forged = {
      ...physical,
      passthroughProjectFusions: [],
    };
    expect(() => compileD1Query(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });

  it("compiles a neutral 1K finite identity carrier through the r7/r8 node shape", () => {
    const identifiers = Array.from(
      { length: 1_023 },
      (_item, index) =>
        `neutral-id-${String(index).padStart(5, "0")}-${"x".repeat(36)}`,
    );
    const identifierSchema = {
      siteKey: { affinity: "text", nullable: false },
      kind: { affinity: "text", nullable: false },
      entityId: { affinity: "text", nullable: false },
    } as const;
    const finiteIdentifiers = valuesRelation(identifierSchema, [
      ...identifiers.map((entityId) => ({
        siteKey: "neutral-scope-a",
        kind: "session",
        entityId,
      })),
      {
        siteKey: "neutral-scope-b",
        kind: "session",
        entityId: identifiers[0]!,
      },
    ]);

    // r7: typed finite rows → kind filter → scanned owner relation → pair
    // projection + DISTINCT. The leaves and column names are deliberately generic.
    const kindScoped = filter(
      finiteIdentifiers,
      eq(finiteIdentifiers.columns.kind, param("session")),
    );
    const ownerScan = scan(schema.site_identities);
    const joinedOwners = join(
      kindScoped,
      ownerScan,
      eq(kindScoped.columns.siteKey, ownerScan.columns.site_id),
    );
    const identityPairs = distinct(
      project(joinedOwners, {
        ownerKey: joinedOwners.columns.right_site_pk,
        entityKey: joinedOwners.columns.left_entityId,
      }),
    );

    // r8: a scanned/filter candidate side joins the pair relation, is narrowed
    // to a distinct identity carrier, then joins back to the wider candidate.
    const candidateScan = scan(schema.visits);
    const eligibleCandidates = filter(
      candidateScan,
      neq(candidateScan.columns.session_id, param("")),
    );
    const matchingCandidates = join(
      eligibleCandidates,
      identityPairs,
      and(
        eq(eligibleCandidates.columns.site_pk, identityPairs.columns.ownerKey),
        eq(
          eligibleCandidates.columns.session_id,
          identityPairs.columns.entityKey,
        ),
      ),
    );
    const matchedPairs = distinct(
      project(matchingCandidates, {
        ownerKey: matchingCandidates.columns.left_site_pk,
        candidateKey: matchingCandidates.columns.left_visit_id,
      }),
    );
    const pageCandidates = join(
      eligibleCandidates,
      matchedPairs,
      and(
        eq(eligibleCandidates.columns.site_pk, matchedPairs.columns.ownerKey),
        eq(
          eligibleCandidates.columns.visit_id,
          matchedPairs.columns.candidateKey,
        ),
      ),
    );
    const page = project(pageCandidates, {
      siteId: pageCandidates.columns.left_site_id,
      visitId: pageCandidates.columns.left_visit_id,
      sessionId: pageCandidates.columns.left_session_id,
    });

    const compiled = compileD1Query(page);
    const compiledAgain = compileD1Query(page);
    const compiledBindings = compiled.bindings ?? [];
    const jsonRows = compiledBindings.filter(
      (value): value is string =>
        typeof value === "string" &&
        value.startsWith("[") &&
        value.includes("neutral-scope-a"),
    );
    expect(compiled.kind).toBe("query");
    expect(compiledBindings.length).toBeLessThan(100);
    expect(jsonRows).toHaveLength(1);
    expect(
      jsonRows.every(
        (segment) => new TextEncoder().encode(segment).byteLength <= 1_000_000,
      ),
    ).toBe(true);
    expect(compiled.physicalPlanShape).toMatchObject({
      version: 2,
      jsonRowRelationCount: 1,
    });
    expect(compiled.sql).toContain('json_each("_segments".column1)');
    expect(compiled.sql).toBe(compiledAgain.sql);
    expect(hashSql(compiled.sql)).toBe(hashSql(compiledAgain.sql));
    expect(compiled.bindings).toEqual(compiledAgain.bindings);
  });

  it("keeps computed projections and child-scope reads behind the rewrite barrier", () => {
    const source = scan(schema.site_identities);
    const selected = filter(source, eq(source.columns.site_pk, param(1)));
    const computed = project(selected, {
      copied: selected.columns.site_id,
      clock: unixepoch(),
    });
    const unusedComputed = project(computed, { found: constant(1) });
    expect(lowerLogicalPlan(unusedComputed).passthroughProjectFusions).toEqual(
      [],
    );

    const passthrough = project(selected, { copied: selected.columns.site_id });
    const readsChildScope = project(passthrough, {
      copiedAgain: passthrough.columns.copied,
    });
    expect(lowerLogicalPlan(readsChildScope).passthroughProjectFusions).toEqual(
      [],
    );
  });

  it("retains left-join NULL extension when bypassing only its pure projection", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    const left = valuesRelation(
      {
        key: { affinity: "text", nullable: false },
        allowed: { affinity: "text", nullable: false },
      } as const,
      [
        { key: "duplicate-match", allowed: "no" },
        { key: "skip-match", allowed: "no" },
        { key: "null-match", allowed: "no" },
        { key: "unmatched-allowed", allowed: "yes" },
        { key: "unmatched-denied", allowed: "no" },
      ] as const,
    );
    const right = valuesRelation(
      {
        key: { affinity: "text", nullable: false },
        mode: { affinity: "text", nullable: true },
      } as const,
      [
        { key: "duplicate-match", mode: "keep" },
        { key: "duplicate-match", mode: "keep" },
        { key: "skip-match", mode: "skip" },
        { key: "null-match", mode: null },
      ] as const,
    );
    const leftJoined = join(
      left,
      right,
      eq(left.columns.key, right.columns.key),
      "left",
    );
    const filtered = filter(
      leftJoined,
      or(
        eq(leftJoined.columns.right_mode, param("keep")),
        eq(leftJoined.columns.left_allowed, param("yes")),
      ),
    );
    const found = project(filtered, { found: constant(1) });
    const physical = lowerLogicalPlan(found);
    expect(physical.constantFilterJoinProjections).toHaveLength(1);
    expect(
      physical.constantFilterJoinProjections[0]?.referencedOutputColumns,
    ).toEqual([1, 3]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(found);
    expect(optimized.sql).toContain("LEFT JOIN");
    expect(optimized.sql).toContain("NULL AS _c0");
    expect(optimized.sql).toContain("NULL AS _c2");
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const baselineRows = database
      .prepare(baseline.sql)
      .all(...(baseline.bindings as SQLInputValue[]));
    expect(optimizedRows).toEqual(baselineRows);
    // Two duplicate right-side matches and one NULL-extended left row survive.
    // A NULL comparison OR false remains UNKNOWN and is filtered out by SQL.
    expect(optimizedRows).toEqual([{ found: 1 }, { found: 1 }, { found: 1 }]);
    expect(optimized.bindings).toEqual(baseline.bindings);

    const forged = {
      ...physical,
      constantFilterJoinProjections: [],
    };
    expect(() => compileD1Query(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });

  it("collects every nested predicate column before pruning a constant LEFT JOIN projection", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    const left = valuesRelation(
      {
        key: { affinity: "text", nullable: false },
        text: { affinity: "text", nullable: true },
        start: { affinity: "text", nullable: true },
        pattern: { affinity: "text", nullable: true },
      } as const,
      [
        { key: "duplicate", text: "a\0b", start: "1", pattern: "ordinary" },
        { key: "duplicate", text: "a\0b", start: "1", pattern: "ordinary" },
        { key: "empty", text: "", start: "1", pattern: "" },
        { key: "unicode", text: "😀abc", start: "1", pattern: "blocked-value" },
        { key: "null", text: null, start: null, pattern: null },
        { key: "unmatched", text: "lonely", start: "1", pattern: null },
      ] as const,
    );
    const right = valuesRelation(
      {
        key: { affinity: "text", nullable: false },
        marker: { affinity: "text", nullable: true },
        needle: { affinity: "text", nullable: true },
        length: { affinity: "text", nullable: true },
        fallback: { affinity: "text", nullable: true },
      } as const,
      [
        {
          key: "duplicate",
          marker: "present",
          needle: "\0",
          length: "2",
          fallback: null,
        },
        {
          key: "duplicate",
          marker: "present",
          needle: "a",
          length: "3",
          fallback: null,
        },
        {
          key: "empty",
          marker: null,
          needle: null,
          length: null,
          fallback: null,
        },
        {
          key: "unicode",
          marker: "present",
          needle: "😀",
          length: "2",
          fallback: null,
        },
        {
          key: "null",
          marker: null,
          needle: null,
          length: null,
          fallback: null,
        },
      ] as const,
    );
    const joined = join(
      left,
      right,
      eq(left.columns.key, right.columns.key),
      "left",
    );
    const searchedPosition = coalesce(
      castText(
        textPosition(
          joined.columns.left_text,
          coalesce(joined.columns.right_needle, param("")),
        ),
      ),
      param("absent"),
    );
    const substring = castText(
      textSubstring(
        joined.columns.left_text,
        castInteger(param(1)),
        castInteger(param(2)),
      ),
    );
    const nestedCase = caseWhen(
      [
        {
          when: isNotNull(joined.columns.right_marker),
          then: searchedPosition,
        },
      ],
      substring,
    );
    const nestedPredicate = or(
      and(
        eq(joined.columns.left_key, joined.columns.right_key),
        or(
          eq(nestedCase, param("1")),
          eq(callFunction("length", joined.columns.left_text), param(1)),
          eq(joined.columns.left_start, param("1")),
          eq(joined.columns.right_length, param("2")),
          not(
            textLike(
              coalesce(joined.columns.left_pattern, param("blocked")),
              param("blocked%"),
            ),
          ),
          isNull(joined.columns.right_marker),
          isDistinctFrom(
            coalesce(joined.columns.left_text, param("fallback")),
            joined.columns.right_fallback,
          ),
        ),
      ),
      isNull(joined.columns.right_marker),
    );
    const filtered = filter(joined, nestedPredicate);
    const found = project(filtered, { found: constant(1) });
    const physical = lowerLogicalPlan(found);
    expect(physical.constantFilterJoinProjections).toHaveLength(1);
    expect(
      physical.constantFilterJoinProjections[0]?.referencedOutputColumns,
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(found);
    const optimizedRows = runBag(database, optimized);
    const baselineRows = runBag(database, baseline);
    expect(optimizedRows).toEqual(baselineRows);
    expect(optimizedRows).toEqual(
      Array.from({ length: 8 }, () => ({ found: 1 })),
    );
    expect(optimized.bindings).toEqual(baseline.bindings);
  });

  it("fuses a passthrough input beneath independent nested expressions", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    const source = valuesRelation(
      { value: { affinity: "text", nullable: false } } as const,
      [{ value: "first" }, { value: "second" }] as const,
    );
    const passthrough = project(source, { copied: source.columns.value });
    const nestedRows = valuesRelation(
      { value: { affinity: "text", nullable: false } } as const,
      [{ value: "nested" }] as const,
    );
    const nestedProjection = project(nestedRows, {
      value: nestedRows.columns.value,
    });
    const result = project(passthrough, {
      arithmetic: add(param(2), param(3)),
      distinct: isDistinctFrom(param("left"), param("right")),
      boolean: and(eq(param(1), param(1)), isNull(param(null))),
      negated: not(eq(param("no"), param("yes"))),
      nullCheck: isNull(param(null)),
      integerCast: castInteger(param(7)),
      textCast: castText(param(7)),
      listMembership: inList(param("key"), ["key"]),
      position: textPosition(param("abc"), param("b")),
      substring: textSubstring(param("abc"), param(1), param(2)),
      like: textLike(param("abc"), param("a%")),
      subqueryMembership: inSubquery(param("nested"), nestedProjection),
      function: callFunction("lower", param("UPPER")),
      aggregate: count(param(1)),
      fallback: coalesce(param(null), param("fallback")),
      branch: caseWhen(
        [{ when: eq(param(1), param(1)), then: param("match") }],
        param("no"),
      ),
      scalar: scalar(nestedProjection),
      clock: unixepoch(),
    });
    const physical = lowerLogicalPlan(result);
    expect(physical.passthroughProjectFusions).toHaveLength(1);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(result);
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
    expect(optimized.bindings).toEqual(baseline.bindings);
  });

  it("keeps a nested text expression that reads the passthrough scope behind the fusion barrier", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    const source = valuesRelation(
      { value: { affinity: "text", nullable: false } } as const,
      [{ value: "first" }, { value: "second" }] as const,
    );
    const passthrough = project(source, { copied: source.columns.value });
    const result = project(passthrough, {
      slice: textSubstring(passthrough.columns.copied, param(1), param(3)),
    });
    const physical = lowerLogicalPlan(result);
    expect(physical.passthroughProjectFusions).toEqual([]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(result);
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
    expect(runBag(database, optimized)).toEqual([
      { slice: "fir" },
      { slice: "sec" },
    ]);
  });

  it("does not share a repeated selective relation across a Limit boundary", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    const source = valuesRelation(
      { value: { affinity: "text", nullable: false } } as const,
      [{ value: "keep" }, { value: "skip" }] as const,
    );
    const limited = limit(
      filter(source, eq(source.columns.value, param("keep"))),
      1,
    );
    const shared = project(limited, { value: limited.columns.value });
    const first = scalar(project(shared, { value: shared.columns.value }));
    const second = scalar(project(shared, { value: shared.columns.value }));
    const root = valuesRelation(
      { seed: { affinity: "text", nullable: false } } as const,
      [{ seed: "root" }] as const,
    );
    const result = project(root, { first, second });
    const physical = lowerLogicalPlan(result);
    expect(physical.sharedRelations).toEqual([]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(result);
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
    expect(runBag(database, optimized)).toEqual([
      { first: "keep", second: "keep" },
    ]);
  });

  it("keeps a repeated shared relation unmaterialized when its subtree contains a Limit", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);

    const identities = scan(schema.site_identities);
    const selected = filter(
      identities,
      eq(identities.columns.site_id, param("tuple-site-a")),
    );
    const limited = limit(selected, 1);
    const shared = project(limited, {
      sitePk: limited.columns.site_pk,
      siteId: limited.columns.site_id,
    });
    const left = project(shared, { sitePk: shared.columns.sitePk });
    const right = project(shared, { sitePk: shared.columns.sitePk });
    const joined = join(
      left,
      right,
      eq(left.columns.sitePk, right.columns.sitePk),
    );
    const result = project(joined, { sitePk: joined.columns.left_sitePk });
    const physical = lowerLogicalPlan(result);
    expect(physical.sharedRelations).toEqual([]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(result);
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
    expect(runBag(database, optimized)).toEqual([{ sitePk: 1 }]);
  });

  it("blocks constant projection pruning across computed, correlated, and shared inputs", () => {
    const rows = valuesRelation(
      {
        key: { affinity: "text", nullable: false },
      } as const,
      [{ key: "generic-key" }] as const,
    );
    const otherRows = valuesRelation(
      {
        key: { affinity: "text", nullable: false },
      } as const,
      [{ key: "generic-key" }] as const,
    );
    const joined = join(
      rows,
      otherRows,
      eq(rows.columns.key, otherRows.columns.key),
    );

    const computed = project(joined, {
      copied: joined.columns.left_key,
      timestamp: unixepoch(),
    });
    const computedFilter = filter(
      computed,
      eq(computed.columns.copied, param("generic-key")),
    );
    const computedFound = project(computedFilter, { found: constant(1) });
    expect(
      lowerLogicalPlan(computedFound).constantFilterJoinProjections,
    ).toEqual([]);

    const scalarRows = valuesRelation(
      {
        ignored: { affinity: "text", nullable: false },
      } as const,
      [{ ignored: "scalar" }] as const,
    );
    const correlatedValue = scalar(
      project(scalarRows, { value: joined.columns.left_key }),
    );
    const correlatedFilter = filter(
      joined,
      eq(joined.columns.left_key, correlatedValue),
    );
    const correlatedFound = project(correlatedFilter, {
      found: constant(1),
    });
    expect(
      lowerLogicalPlan(correlatedFound).constantFilterJoinProjections,
    ).toEqual([]);

    const sharedFilter = filter(
      joined,
      eq(joined.columns.left_key, param("generic-key")),
    );
    const sharedFound = project(sharedFilter, { found: constant(1) });
    const secondUse = scalar(
      project(sharedFilter, { copied: sharedFilter.columns.left_key }),
    );
    const sharedRoot = project(sharedFound, {
      found: sharedFound.columns.found,
      secondUse,
    });
    expect(lowerLogicalPlan(sharedRoot).constantFilterJoinProjections).toEqual(
      [],
    );
  });
});

describe("finite packed positive tuple membership", () => {
  it("keeps composite association and left bag semantics for packed DISTINCT keys", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);

    const { result, finiteRows, identityKeys, visits } =
      compositeMembershipPlan(40);
    const physical = lowerLogicalPlan(result);
    expect(physical.positiveTupleMembershipCandidates).toHaveLength(1);
    const candidate = physical.positiveTupleMembershipCandidates[0]!;
    expect(candidate.valuesRelation).toBe(finiteRows.node);
    expect(candidate.rightKeyIndexes).toEqual([0, 1]);
    expect(candidate.leftKeyIndexes).toEqual([
      visits.columns.session_id.index,
      visits.columns.site_pk.index,
    ]);

    // A redundant TRUE filter blocks the tuple rule while leaving the exact
    // same relation and row values for the reference compilation.
    const referenceKeys = filter(identityKeys, eq(constant(1), constant(1)));
    const referenceJoin = join(
      visits,
      referenceKeys,
      and(
        eq(visits.columns.site_pk, referenceKeys.columns.ownerKey),
        eq(visits.columns.session_id, referenceKeys.columns.sessionKey),
      ),
    );
    const referenceResult = project(referenceJoin, {
      siteId: referenceJoin.columns.left_site_id,
      sessionId: referenceJoin.columns.left_session_id,
    });
    const referencePhysical = lowerLogicalPlan(referenceResult);
    expect(referencePhysical.positiveTupleMembershipCandidates).toEqual([]);
    const baseline = compileD1Query(referencePhysical);
    const optimized = compileD1Query(physical);
    expect(new TextEncoder().encode(baseline.sql).byteLength).toBe(2_189);
    expect(baseline.bindings).toHaveLength(2);
    expect(hashSql(baseline.sql)).toBe(
      "5629a1beaad3a76e1fa210061591ccd70ad04c54d4504b1c2351cac7683486dc",
    );
    expect(baseline.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 1,
    });
    expect(new TextEncoder().encode(optimized.sql).byteLength).toBe(2_092);
    const optimizedBindings = optimized.bindings ?? [];
    expect(optimizedBindings).toHaveLength(2);
    expect(hashSql(optimized.sql)).toBe(
      "e37510e2bf96dcd425d6110e0cd5bbbef799362746e6af2ad036820aec105543",
    );
    const optimizedAgain = compileD1Query(result);
    expect(baseline.sql).not.toContain(" IN (SELECT ");
    expect(optimized.sql).toContain(" IN (SELECT ");
    expect(optimized.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 1,
    });
    expect(optimized.bindings).toHaveLength(2);
    expect(optimizedAgain.sql).toBe(optimized.sql);
    expect(optimizedAgain.bindings).toEqual(optimized.bindings);
    expect(hashSql(optimizedAgain.sql)).toBe(hashSql(optimized.sql));
    expect(new TextEncoder().encode(optimized.sql).byteLength).toBeLessThan(
      100_000,
    );
    const packed = optimizedBindings.find(
      (value): value is string =>
        typeof value === "string" && value.startsWith("[["),
    );
    expect(packed).toBeDefined();
    expect(new TextEncoder().encode(packed!).byteLength).toBeLessThanOrEqual(
      1_000_000,
    );

    const baselineRows = runBag(database, baseline);
    const optimizedRows = runBag(database, optimized);
    expect(optimizedRows).toEqual(baselineRows);
    expect(optimizedRows).toEqual([
      { siteId: "tuple-site-a", sessionId: "tuple-session-01" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-1" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-b", sessionId: "tuple-session-b" },
    ]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM visits WHERE visit_id LIKE 'tuple-cross-%'",
        )
        .get()?.count,
    ).toBe(2);

    const alternate = compileD1Query(compositeMembershipPlan(40, "B").result);
    const firstAgain = compileD1Query(compositeMembershipPlan(40, "A").result);
    expect(alternate.sql).toBe(optimized.sql);
    expect(hashSql(alternate.sql)).toBe(hashSql(optimized.sql));
    expect(alternate.bindings).not.toEqual(optimized.bindings);
    expect(firstAgain.sql).toBe(optimized.sql);
    expect(firstAgain.bindings).toEqual(optimized.bindings);
  });

  it("rewrites both consumers of a shared finite DISTINCT keyset without copying its CTE", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);
    database
      .prepare(
        "INSERT INTO visits (visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, site_pk) VALUES (?, ?, ?, ?, ?, 1, 1, '/', 'tuple.test', (SELECT site_pk FROM site_identities WHERE site_id = ?))",
      )
      .run(
        "tuple-b-shared-session",
        "tuple-site-b",
        "tuple-visitor",
        "tuple-session-a",
        "active",
        "tuple-site-b",
      );
    database
      .prepare(
        "INSERT INTO visits (visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, site_pk) VALUES (?, ?, ?, ?, ?, 1, 1, '/', 'tuple.test', (SELECT site_pk FROM site_identities WHERE site_id = ?))",
      )
      .run(
        "tuple-kind-only",
        "tuple-site-a",
        "tuple-visitor",
        "tuple-kind-only-session",
        "active",
        "tuple-site-a",
      );

    const rows = [
      {
        siteId: "tuple-site-a",
        sessionId: "tuple-session-a",
        kind: "session",
      },
      {
        siteId: "tuple-site-a",
        sessionId: "tuple-session-a",
        kind: "session",
      },
      {
        siteId: "tuple-site-a",
        sessionId: "tuple-session-a",
        kind: "session",
      },
      {
        siteId: "tuple-site-a",
        sessionId: null,
        kind: "session",
      },
      {
        siteId: "tuple-site-a",
        sessionId: "tuple-kind-only-session",
        kind: "page",
      },
    ];
    for (let index = 0; index < 36; index += 1)
      rows.push({
        siteId: index % 2 === 0 ? "tuple-site-a" : "tuple-site-b",
        sessionId: `shared-filler-${String(index).padStart(3, "0")}`,
        kind: "session",
      });
    const finiteRows = valuesRelation(
      {
        siteId: { affinity: "text", nullable: false },
        sessionId: { affinity: "text", nullable: true },
        kind: { affinity: "text", nullable: false },
      } as const,
      rows,
    );
    const sessions = filter(
      finiteRows,
      eq(finiteRows.columns.kind, param("session")),
    );
    const identities = scan(schema.site_identities);
    const authorizedPairs = join(
      sessions,
      identities,
      eq(sessions.columns.siteId, identities.columns.site_id),
    );
    const keys = distinct(
      project(authorizedPairs, {
        sessionId: authorizedPairs.columns.left_sessionId,
        sitePk: authorizedPairs.columns.right_site_pk,
      }),
    );

    const firstVisits = scan(schema.visits);
    const firstJoin = join(
      firstVisits,
      keys,
      and(
        eq(firstVisits.columns.site_pk, keys.columns.sitePk),
        eq(firstVisits.columns.session_id, keys.columns.sessionId),
      ),
    );
    const first = project(firstJoin, {
      siteId: firstJoin.columns.left_site_id,
      sessionId: firstJoin.columns.left_session_id,
    });
    const secondVisits = scan(schema.visits);
    const secondJoin = join(
      secondVisits,
      keys,
      and(
        eq(secondVisits.columns.site_pk, keys.columns.sitePk),
        eq(secondVisits.columns.session_id, keys.columns.sessionId),
      ),
    );
    const second = project(secondJoin, {
      siteId: secondJoin.columns.left_site_id,
      sessionId: secondJoin.columns.left_session_id,
    });
    const result = union(first, second, true);
    const physical = lowerLogicalPlan(result);

    expect(physical.sharedRelations).toContainEqual(
      expect.objectContaining({ node: keys.node }),
    );
    expect(physical.positiveTupleMembershipCandidates).toHaveLength(2);
    expect(
      physical.positiveTupleMembershipCandidates.map(
        (candidate) => candidate.membershipSource,
      ),
    ).toEqual(["finite-values", "finite-values"]);
    expect(
      physical.positiveTupleMembershipCandidates.every(
        (candidate) => candidate.valuesRelation === finiteRows.node,
      ),
    ).toBe(true);

    const optimized = compileD1Query(physical);
    const fallback = compileD1QueryTupleMembershipFallbackForTest(physical);
    expect(optimized.sql.match(/_d1_shared_0 AS \(/gu)).toHaveLength(1);
    expect(optimized.sql.match(/FROM _d1_shared_0/gu)).toHaveLength(2);
    expect(optimized.sql.match(/ IN \(SELECT /gu)).toHaveLength(2);
    expect(fallback.sql).not.toContain(" IN (SELECT ");
    expect(runBag(database, optimized)).toEqual(runBag(database, fallback));
    expect(runBag(database, optimized)).toEqual([
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
    ]);
  });

  it("rewrites a dynamic composite keyset while retaining its LEFT owner lookup", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);

    const siteKeys = new Map(
      database
        .prepare("SELECT site_id, site_pk FROM site_identities")
        .all()
        .map((row) => [String(row.site_id), Number(row.site_pk)] as const),
    );
    for (const siteId of ["tuple-site-a", "tuple-site-b"] as const) {
      database
        .prepare(
          "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, 'dynamic-membership', 1, ?)",
        )
        .run(siteId, siteKeys.get(siteId)!);
    }
    const insertEvent = database.prepare(
      "INSERT INTO custom_events (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk) SELECT ?, identities.site_id, ?, names.id, 1, 1, 0, 0, identities.site_pk FROM site_identities AS identities JOIN custom_event_names AS names ON names.site_pk = identities.site_pk AND names.name = 'dynamic-membership' WHERE identities.site_id = ?",
    );
    insertEvent.run("dynamic-key-hit", "tuple-a-first", "tuple-site-a");
    insertEvent.run("dynamic-key-left-only", "tuple-a-second", "tuple-site-a");
    insertEvent.run("dynamic-key-b-only", "tuple-b-first", "tuple-site-b");

    const sourceEvents = scan(schema.custom_events);
    const owners = scan(schema.visits);
    const eventOwners = join(
      sourceEvents,
      owners,
      and(
        eq(sourceEvents.columns.site_pk, owners.columns.site_pk),
        eq(sourceEvents.columns.visit_id, owners.columns.visit_id),
      ),
      "left",
    );
    const dynamicKeys = distinct(
      project(eventOwners, {
        siteId: eventOwners.columns.left_site_id,
        eventId: eventOwners.columns.left_event_id,
      }),
    );
    const candidateRows = valuesRelation(
      {
        siteId: { affinity: "text", nullable: false },
        eventId: { affinity: "text", nullable: true },
      } as const,
      [
        { siteId: "tuple-site-a", eventId: "dynamic-key-hit" },
        { siteId: "tuple-site-a", eventId: "dynamic-key-hit" },
        { siteId: "tuple-site-b", eventId: "dynamic-key-hit" },
        { siteId: "tuple-site-a", eventId: null },
        {
          siteId: "tuple-site-a",
          eventId: "dynamic-key-left-only",
        },
      ] as const,
    );
    const firstMatches = join(
      candidateRows,
      dynamicKeys,
      and(
        eq(candidateRows.columns.siteId, dynamicKeys.columns.siteId),
        eq(candidateRows.columns.eventId, dynamicKeys.columns.eventId),
      ),
    );
    const firstResult = project(firstMatches, {
      siteId: firstMatches.columns.left_siteId,
      eventId: firstMatches.columns.left_eventId,
    });
    const secondMatches = join(
      candidateRows,
      dynamicKeys,
      and(
        eq(candidateRows.columns.siteId, dynamicKeys.columns.siteId),
        eq(candidateRows.columns.eventId, dynamicKeys.columns.eventId),
      ),
    );
    const secondResult = project(secondMatches, {
      siteId: secondMatches.columns.left_siteId,
      eventId: secondMatches.columns.left_eventId,
    });
    const result = union(firstResult, secondResult, true);
    const physical = lowerLogicalPlan(result);

    expect(
      physical.positiveTupleMembershipCandidates.map(
        (candidate) => candidate.membershipSource,
      ),
    ).toEqual(["dynamic-distinct", "dynamic-distinct"]);
    expect(
      physical.positiveTupleMembershipCandidates.every(
        (candidate) => candidate.valuesRelation === undefined,
      ),
    ).toBe(true);
    const optimized = compileD1Query(physical);
    const fallback = compileD1QueryTupleMembershipFallbackForTest(physical);
    expect(optimized.sql.match(/ IN \(SELECT /gu)).toHaveLength(2);
    expect(optimized.sql).toContain("LEFT JOIN");
    expect(fallback.sql).not.toContain(" IN (SELECT ");
    expect(fallback.sql).toContain("LEFT JOIN");
    expect(runBag(database, optimized)).toEqual(runBag(database, fallback));
    expect(runBag(database, optimized)).toEqual([
      {
        siteId: "tuple-site-a",
        eventId: "dynamic-key-hit",
      },
      {
        siteId: "tuple-site-a",
        eventId: "dynamic-key-hit",
      },
      {
        siteId: "tuple-site-a",
        eventId: "dynamic-key-hit",
      },
      {
        siteId: "tuple-site-a",
        eventId: "dynamic-key-hit",
      },
      {
        siteId: "tuple-site-a",
        eventId: "dynamic-key-left-only",
      },
      {
        siteId: "tuple-site-a",
        eventId: "dynamic-key-left-only",
      },
    ]);

    const explain = database
      .prepare(`EXPLAIN QUERY PLAN ${optimized.sql}`)
      .all(...((optimized.bindings ?? []) as SQLInputValue[]));
    expect(
      explain.some((row) => String(row.detail).includes("LIST SUBQUERY")),
    ).toBe(true);
  });

  it("rejects dynamic keysets with a row boundary or recursive source", () => {
    const sourceEvents = scan(schema.custom_events);
    const owners = scan(schema.visits);
    const eventOwners = join(
      sourceEvents,
      owners,
      and(
        eq(sourceEvents.columns.site_pk, owners.columns.site_pk),
        eq(sourceEvents.columns.visit_id, owners.columns.visit_id),
      ),
      "left",
    );
    const outerRows = valuesRelation(
      {
        siteId: { affinity: "text", nullable: false },
        eventId: { affinity: "text", nullable: false },
      } as const,
      [{ siteId: "candidate-site", eventId: "candidate" }] as const,
    );
    const candidateFor = (keys: typeof eventOwners) => {
      const dynamicKeys = distinct(
        project(keys, {
          siteId: keys.columns.left_site_id,
          eventId: keys.columns.left_event_id,
        }),
      );
      const matches = join(
        outerRows,
        dynamicKeys,
        and(
          eq(outerRows.columns.siteId, dynamicKeys.columns.siteId),
          eq(outerRows.columns.eventId, dynamicKeys.columns.eventId),
        ),
      );
      return project(matches, {
        eventId: matches.columns.left_eventId,
      });
    };

    const limitedKeys = limit(eventOwners, 1);
    expect(
      lowerLogicalPlan(candidateFor(limitedKeys))
        .positiveTupleMembershipCandidates,
    ).toEqual([]);

    const unsafeLeftLookup = join(
      sourceEvents,
      owners,
      and(
        eq(sourceEvents.columns.site_pk, owners.columns.site_pk),
        eq(sourceEvents.columns.visit_id, owners.columns.visit_id),
        neq(sourceEvents.columns.event_id, owners.columns.visit_id),
      ),
      "left",
    );
    expect(
      lowerLogicalPlan(candidateFor(unsafeLeftLookup))
        .positiveTupleMembershipCandidates,
    ).toEqual([]);

    const recursiveKeys = recursiveClosure(
      project(eventOwners, {
        siteId: eventOwners.columns.left_site_id,
        eventId: eventOwners.columns.left_event_id,
      }),
      project(eventOwners, {
        siteId: eventOwners.columns.left_site_id,
        eventId: eventOwners.columns.left_event_id,
      }),
      (current, candidate) =>
        and(
          eq(current.siteId, candidate.siteId),
          eq(current.eventId, candidate.eventId),
        ),
    );
    const recursiveDynamicKeys = distinct(
      project(recursiveKeys, {
        siteId: recursiveKeys.columns.siteId,
        eventId: recursiveKeys.columns.eventId,
      }),
    );
    const recursiveMatches = join(
      outerRows,
      recursiveDynamicKeys,
      and(
        eq(outerRows.columns.siteId, recursiveDynamicKeys.columns.siteId),
        eq(outerRows.columns.eventId, recursiveDynamicKeys.columns.eventId),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(recursiveMatches, {
          eventId: recursiveMatches.columns.left_eventId,
        }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const correlatedOwner = scan(schema.site_identities);
    const correlatedRows = filter(
      eventOwners,
      eq(eventOwners.columns.left_site_pk, correlatedOwner.columns.site_pk),
    );
    const correlatedKeys = distinct(
      project(correlatedRows, {
        siteId: correlatedRows.columns.left_site_id,
        eventId: correlatedRows.columns.left_event_id,
      }),
    );
    const correlatedMatches = join(
      outerRows,
      correlatedKeys,
      and(
        eq(outerRows.columns.siteId, correlatedKeys.columns.siteId),
        eq(outerRows.columns.eventId, correlatedKeys.columns.eventId),
      ),
    );
    const correlatedRoot = project(correlatedOwner, {
      siteId: correlatedOwner.columns.site_id,
      eventId: scalar(
        project(correlatedMatches, {
          eventId: correlatedMatches.columns.left_eventId,
        }),
      ),
    });
    expect(
      lowerLogicalPlan(correlatedRoot).positiveTupleMembershipCandidates,
    ).toEqual([]);
  });

  it("keeps a finite lookup as an ordinary Join when its filter is outside the proven safe algebra", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);
    const { result } = compositeMembershipPlan(8, "A", true);
    const physical = lowerLogicalPlan(result);
    expect(physical.positiveTupleMembershipCandidates).toEqual([]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(result);
    expect(optimized.sql).toContain("INNER JOIN");
    expect(optimized.sql).not.toContain(" IN (SELECT ");
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
    expect(runBag(database, optimized)).toEqual([
      { siteId: "tuple-site-a", sessionId: "tuple-session-01" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-1" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-b", sessionId: "tuple-session-b" },
    ]);
  });

  it("keeps a computed boolean finite-row filter out of tuple membership rewriting", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);

    const finiteRows = valuesRelation(
      {
        siteId: { affinity: "text", nullable: false },
        sessionId: { affinity: "text", nullable: false },
        kind: { affinity: "text", nullable: false },
      } as const,
      [
        {
          siteId: "tuple-site-a",
          sessionId: "tuple-session-a",
          kind: "eligible",
        },
      ] as const,
    );
    const withEligibility = project(finiteRows, {
      siteId: finiteRows.columns.siteId,
      sessionId: finiteRows.columns.sessionId,
      eligible: eq(finiteRows.columns.kind, param("eligible")),
    });
    const eligibleRows = filter(
      withEligibility,
      withEligibility.columns.eligible,
    );
    const identities = scan(schema.site_identities);
    const authorizedPairs = join(
      eligibleRows,
      identities,
      eq(eligibleRows.columns.siteId, identities.columns.site_id),
    );
    const identityKeys = distinct(
      project(authorizedPairs, {
        sessionKey: authorizedPairs.columns.left_sessionId,
        ownerKey: authorizedPairs.columns.right_site_pk,
      }),
    );
    const visits = scan(schema.visits);
    const matches = join(
      visits,
      identityKeys,
      and(
        eq(visits.columns.site_pk, identityKeys.columns.ownerKey),
        eq(visits.columns.session_id, identityKeys.columns.sessionKey),
      ),
    );
    const result = project(matches, {
      visitId: matches.columns.left_visit_id,
    });
    const physical = lowerLogicalPlan(result);
    expect(physical.positiveTupleMembershipCandidates).toEqual([]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(result);
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
    expect(runBag(database, optimized)).toEqual([
      { visitId: "tuple-a-first" },
      { visitId: "tuple-a-second" },
    ]);
  });

  it("keeps a non-equality Join out of tuple membership rewriting", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);
    const { identityKeys, visits } = compositeMembershipPlan(8);
    const nonEqualityJoin = join(
      visits,
      identityKeys,
      and(
        neq(visits.columns.site_pk, identityKeys.columns.ownerKey),
        eq(visits.columns.session_id, identityKeys.columns.sessionKey),
      ),
    );
    const result = project(nonEqualityJoin, {
      siteId: nonEqualityJoin.columns.left_site_id,
      sessionId: nonEqualityJoin.columns.left_session_id,
    });
    const physical = lowerLogicalPlan(result);
    expect(physical.positiveTupleMembershipCandidates).toEqual([]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(result);
    expect(optimized.sql).toContain("INNER JOIN");
    expect(optimized.sql).not.toContain(" IN (SELECT ");
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
  });

  it("leaves a small native key relation as an ordinary join and handles empty RHS", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);

    const small = compositeMembershipPlan(8);
    const smallPhysical = lowerLogicalPlan(small.result);
    const smallCompiled = compileD1Query(smallPhysical);
    const smallBaseline = compileD1QueryUnoptimizedForTest(small.result);
    const smallBindings = smallCompiled.bindings ?? [];
    const smallBaselineBindings = smallBaseline.bindings ?? [];
    expect(smallPhysical.positiveTupleMembershipCandidates).toHaveLength(1);
    expect(smallCompiled.sql).not.toContain(" IN (SELECT ");
    expect(smallCompiled.sql).toContain("INNER JOIN");
    expect(smallBindings).toEqual(smallBaselineBindings);
    expect(smallCompiled.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 1,
      jsonRowRelationCount: 0,
    });
    expect(runBag(database, smallCompiled)).toEqual(
      runBag(database, smallBaseline),
    );

    const emptyRows = valuesRelation(
      {
        siteId: { affinity: "text", nullable: false },
        sessionId: { affinity: "text", nullable: true },
        kind: { affinity: "text", nullable: false },
      } as const,
      [],
    );
    const eligibleEmpty = filter(
      emptyRows,
      eq(emptyRows.columns.kind, param("eligible")),
    );
    const siteLookup = scan(schema.site_identities);
    const emptyLookup = join(
      eligibleEmpty,
      siteLookup,
      eq(eligibleEmpty.columns.siteId, siteLookup.columns.site_id),
    );
    const emptyKeys = distinct(
      project(emptyLookup, {
        sessionKey: emptyLookup.columns.left_sessionId,
        ownerKey: emptyLookup.columns.right_site_pk,
      }),
    );
    const candidateRows = scan(schema.visits);
    const emptyMatches = join(
      candidateRows,
      emptyKeys,
      and(
        eq(candidateRows.columns.site_pk, emptyKeys.columns.ownerKey),
        eq(candidateRows.columns.session_id, emptyKeys.columns.sessionKey),
      ),
    );
    const emptyResult = project(emptyMatches, {
      visitId: emptyMatches.columns.left_visit_id,
    });
    const emptyPhysical = lowerLogicalPlan(emptyResult);
    expect(emptyPhysical.positiveTupleMembershipCandidates).toHaveLength(1);
    const emptyCompiled = compileD1Query(emptyPhysical);
    expect(emptyCompiled.sql).not.toContain(" IN (SELECT ");
    expect(runBag(database, emptyCompiled)).toEqual([]);
  });

  it("preserves a limited lookup as an ordinary Join when packing would cross its row boundary", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    const left = valuesRelation(
      {
        siteId: { affinity: "text", nullable: false },
        entityId: { affinity: "text", nullable: false },
      } as const,
      [
        { siteId: "scope-a", entityId: "first" },
        { siteId: "scope-a", entityId: "second" },
        { siteId: "scope-b", entityId: "first" },
      ] as const,
    );
    const finiteRows = valuesRelation(
      {
        siteId: { affinity: "text", nullable: false },
        entityId: { affinity: "text", nullable: false },
      } as const,
      [
        { siteId: "scope-a", entityId: "first" },
        { siteId: "scope-a", entityId: "second" },
      ] as const,
    );
    const selectedRows = limit(finiteRows, 1);
    const distinctKeys = distinct(
      project(selectedRows, {
        siteId: selectedRows.columns.siteId,
        entityId: selectedRows.columns.entityId,
      }),
    );
    const joined = join(
      left,
      distinctKeys,
      and(
        eq(left.columns.siteId, distinctKeys.columns.siteId),
        eq(left.columns.entityId, distinctKeys.columns.entityId),
      ),
    );
    const result = project(joined, {
      siteId: joined.columns.left_siteId,
      entityId: joined.columns.left_entityId,
    });
    const physical = lowerLogicalPlan(result);
    expect(physical.positiveTupleMembershipCandidates).toEqual([]);

    const optimized = compileD1Query(physical);
    const baseline = compileD1QueryUnoptimizedForTest(result);
    expect(optimized.sql).toContain("INNER JOIN");
    expect(optimized.sql).not.toContain(" IN (SELECT ");
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
    expect(runBag(database, optimized)).toEqual([
      { entityId: "first", siteId: "scope-a" },
    ]);
  });

  it("renders the original Join if final packed-choice costs reject tuple-IN", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);

    const { result, identityKeys, visits } = compositeMembershipPlan(40);
    const physical = lowerLogicalPlan(result);
    expect(physical.positiveTupleMembershipCandidates).toHaveLength(1);
    const baselineKeys = filter(identityKeys, eq(constant(1), constant(1)));
    const baselineJoin = join(
      visits,
      baselineKeys,
      and(
        eq(visits.columns.site_pk, baselineKeys.columns.ownerKey),
        eq(visits.columns.session_id, baselineKeys.columns.sessionKey),
      ),
    );
    const baseline = compileD1Query(
      lowerLogicalPlan(
        project(baselineJoin, {
          siteId: baselineJoin.columns.left_site_id,
          sessionId: baselineJoin.columns.left_session_id,
        }),
      ),
    );
    const fallback = compileD1QueryTupleMembershipFallbackForTest(physical);
    const baselineBindings = baseline.bindings ?? [];
    const fallbackBindings = fallback.bindings ?? [];

    expect(baselineBindings).toHaveLength(2);
    expect(fallbackBindings).toEqual(baselineBindings);
    expect(fallback.sql).toContain("INNER JOIN");
    expect(fallback.sql).not.toContain(" IN (SELECT ");
    expect(fallback.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 1,
    });
    expect(runBag(database, fallback)).toEqual(runBag(database, baseline));
  });

  it("keeps a pure shared static-IN lookup intact beside 20K finite rows", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);

    const lookupLeft = scan(schema.site_identities);
    const lookupRight = scan(schema.site_identities);
    const lookupJoin = join(
      lookupLeft,
      lookupRight,
      eq(lookupLeft.columns.site_id, lookupRight.columns.site_id),
    );
    const lookupProjection = project(lookupJoin, {
      siteId: lookupJoin.columns.left_site_id,
      sitePk: lookupJoin.columns.right_site_pk,
    });
    const authorizedSites = filter(
      lookupProjection,
      inList(lookupProjection.columns.siteId, ["tuple-site-a", "tuple-site-b"]),
    );
    const { result, finiteRows } = sharedTupleMembershipPlan(
      authorizedSites,
      19_993,
    );
    expect(finiteRows.node.kind).toBe("values-relation");
    if (finiteRows.node.kind !== "values-relation") throw new Error();
    expect(finiteRows.node.rows).toHaveLength(20_000);

    const physical = lowerLogicalPlan(result);
    expect(physical.sharedRelations).toHaveLength(1);
    expect(physical.sharedRelations[0]!.name).toBe("_d1_shared_0");
    expect(physical.sharedRelations[0]!.node).toBe(authorizedSites.node);
    expect(physical.positiveTupleMembershipCandidates).toHaveLength(1);
    expect(physical.positiveTupleMembershipCandidates[0]!.valuesRelation).toBe(
      finiteRows.node,
    );

    const compiled = compileD1Query(physical);
    const fallback = compileD1QueryTupleMembershipFallbackForTest(physical);
    const cte = firstSharedCteDefinition(compiled.sql);
    expect(firstSharedCteDefinition(fallback.sql)).toBe(cte);
    expect(cte).toContain('"site_identities"');
    expect(cte).toContain("INNER JOIN");
    expect(cte).toContain(" IN (?, ?)");
    expect(cte).not.toContain(" IN (SELECT ");
    expect(compiled.sql).toContain("FROM _d1_shared_0");
    expect(compiled.sql).toContain(" IN (SELECT ");
    expect(compiled.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 1,
    });
    const bindings = compiled.bindings ?? [];
    expect(fallback.bindings).toEqual(bindings);
    const packedSegments = bindings.filter(
      (value): value is string =>
        typeof value === "string" && value.startsWith("[["),
    );
    expect(packedSegments).toHaveLength(2);
    expect(bindings.length).toBeLessThanOrEqual(100);
    expect(bindings).toHaveLength(7);
    expect(new TextEncoder().encode(compiled.sql).byteLength).toBeLessThan(
      100_000,
    );
    expect(new TextEncoder().encode(compiled.sql).byteLength).toBe(2_572);
    expect(hashSql(compiled.sql)).toBe(
      "dbe65a65e8e0070ec11ddeb9fa427bb1b81a71d5dbe9bdacc579357a42145946",
    );
    expect(new TextEncoder().encode(fallback.sql).byteLength).toBe(2_627);
    expect(hashSql(fallback.sql)).toBe(
      "8a0c5d95d4a36d2b6f306bf8af93903a4d426aa7d61b6522e9c10ef13f3b2ad5",
    );
    expect(
      packedSegments.every(
        (segment) => new TextEncoder().encode(segment).byteLength <= 1_000_000,
      ),
    ).toBe(true);

    const expectedRows = [
      { siteId: "tuple-site-a", sessionId: "tuple-session-01" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-1" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-b", sessionId: "tuple-session-b" },
      { siteId: "tuple-site-a", sessionId: "shared-branch" },
      { siteId: "tuple-site-b", sessionId: "shared-branch" },
    ].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
    expect(runBag(database, compiled)).toEqual(expectedRows);
    expect(runBag(database, fallback)).toEqual(expectedRows);
  });

  it("renders sparse constant Join outputs with the packed tuple row strategy", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);
    const { result: membershipResult } = compositeMembershipPlan(40);
    const lookupLeft = scan(schema.site_identities);
    const lookupRight = scan(schema.site_identities);
    const lookupJoin = join(
      lookupLeft,
      lookupRight,
      eq(lookupLeft.columns.site_id, lookupRight.columns.site_id),
    );
    const lookupFilter = filter(
      lookupJoin,
      eq(lookupJoin.columns.right_site_id, param("tuple-site-a")),
    );
    const hasSite = isNotNull(
      scalar(project(lookupFilter, { found: constant(1) })),
    );
    const result = project(membershipResult, {
      siteId: membershipResult.columns.siteId,
      sessionId: membershipResult.columns.sessionId,
      hasSite,
    });
    const physical = lowerLogicalPlan(result);
    expect(physical.positiveTupleMembershipCandidates).toHaveLength(1);
    expect(physical.constantFilterJoinProjections).toHaveLength(1);

    const optimized = compileD1Query(physical);
    const fallback = compileD1QueryTupleMembershipFallbackForTest(physical);
    expect(optimized.sql).toContain(" IN (SELECT ");
    expect(fallback.sql).toContain("INNER JOIN");
    expect(fallback.sql).not.toContain(" IN (SELECT ");
    expect(optimized.physicalPlanShape).toMatchObject({
      version: 2,
      jsonRowRelationCount: 1,
    });
    expect(runBag(database, optimized)).toEqual(runBag(database, fallback));
  });

  it("allows a pure twice-used lookup below a Limit without CTE hoisting", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);

    const identities = scan(schema.site_identities);
    const selected = filter(
      identities,
      inList(identities.columns.site_id, ["tuple-site-a", "tuple-site-b"]),
    );
    const staticSiteLookup = project(selected, {
      siteId: selected.columns.site_id,
      sitePk: selected.columns.site_pk,
    });
    const { result, finiteRows } = sharedTupleMembershipPlan(
      staticSiteLookup,
      40,
    );
    const limited = limit(result, 100);

    expect(finiteRows.node.kind).toBe("values-relation");
    if (finiteRows.node.kind !== "values-relation") throw new Error();
    expect(finiteRows.node.rows).toHaveLength(47);

    const physical = lowerLogicalPlan(limited);
    expect(physical.sharedRelations).toEqual([]);
    expect(physical.positiveTupleMembershipCandidates).toHaveLength(1);
    expect(physical.positiveTupleMembershipCandidates[0]!.valuesRelation).toBe(
      finiteRows.node,
    );

    const optimized = compileD1Query(physical);
    const fallback = compileD1QueryTupleMembershipFallbackForTest(physical);
    expect(optimized.sql).toContain(" IN (SELECT ");
    expect(fallback.sql).toContain("INNER JOIN");
    expect(fallback.sql).not.toContain(" IN (SELECT ");
    expect(optimized.physicalPlanShape).toMatchObject({
      version: 8,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 1,
    });
    expect(fallback.bindings).toEqual(optimized.bindings);
    const expectedRows = [
      { siteId: "tuple-site-a", sessionId: "tuple-session-01" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-1" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-a", sessionId: "tuple-session-a" },
      { siteId: "tuple-site-b", sessionId: "tuple-session-b" },
      { siteId: "tuple-site-a", sessionId: "shared-branch" },
      { siteId: "tuple-site-b", sessionId: "shared-branch" },
    ].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
    expect(runBag(database, optimized)).toEqual(expectedRows);
    expect(runBag(database, fallback)).toEqual(expectedRows);
  });

  it("rejects shared lookup bodies with computed, correlated, or unknown lineage", () => {
    const computedLeft = scan(schema.site_identities);
    const computedRight = scan(schema.site_identities);
    const computedJoin = join(
      computedLeft,
      computedRight,
      eq(computedLeft.columns.site_id, computedRight.columns.site_id),
    );
    const computedProject = project(computedJoin, {
      siteId: castText(computedJoin.columns.left_site_id),
      sitePk: computedJoin.columns.right_site_pk,
    });
    const computedLookup = filter(
      computedProject,
      inList(computedProject.columns.siteId, ["tuple-site-a", "tuple-site-b"]),
    );
    expect(
      lowerLogicalPlan(sharedTupleMembershipPlan(computedLookup, 8).result)
        .positiveTupleMembershipCandidates,
    ).toEqual([]);

    const unknownSource = jsonScalarArray("text", [
      "tuple-site-a",
      "tuple-site-b",
    ]);
    const unknownGenerated = scan(schema.site_identities);
    const unknownJoin = join(
      unknownSource,
      unknownGenerated,
      eq(unknownSource.columns.value, unknownGenerated.columns.site_id),
    );
    const unknownProject = project(unknownJoin, {
      siteId: unknownJoin.columns.left_value,
      sitePk: unknownJoin.columns.right_site_pk,
    });
    const unknownLookup = filter(
      unknownProject,
      inList(unknownProject.columns.siteId, ["tuple-site-a", "tuple-site-b"]),
    );
    expect(
      lowerLogicalPlan(sharedTupleMembershipPlan(unknownLookup, 8).result)
        .positiveTupleMembershipCandidates,
    ).toEqual([]);

    const outer = scan(schema.visits);
    const correlatedLeft = scan(schema.site_identities);
    const correlatedRight = scan(schema.site_identities);
    const correlatedJoin = join(
      correlatedLeft,
      correlatedRight,
      eq(correlatedLeft.columns.site_id, correlatedRight.columns.site_id),
    );
    const correlatedProject = project(correlatedJoin, {
      siteId: correlatedJoin.columns.left_site_id,
      sitePk: correlatedJoin.columns.right_site_pk,
    });
    const correlatedLookup = filter(
      correlatedProject,
      and(
        eq(correlatedProject.columns.siteId, outer.columns.site_id),
        inList(correlatedProject.columns.siteId, [
          "tuple-site-a",
          "tuple-site-b",
        ]),
      ),
    );
    const correlatedCandidate = sharedTupleMembershipPlan(correlatedLookup, 8);
    const correlatedRoot = project(outer, {
      visitId: outer.columns.visit_id,
      match: scalar(
        project(correlatedCandidate.result, { found: constant(1) }),
      ),
    });
    expect(
      lowerLogicalPlan(correlatedRoot).positiveTupleMembershipCandidates,
    ).toEqual([]);
  });

  it("rejects incomplete, computed, shared, correlated, and unknown-source keys", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);
    const base = compositeMembershipPlan(40);
    const physical = lowerLogicalPlan(base.result);
    expect(physical.positiveTupleMembershipCandidates).toHaveLength(1);

    const leftJoin = join(
      base.visits,
      base.identityKeys,
      and(
        eq(base.visits.columns.site_pk, base.identityKeys.columns.ownerKey),
        eq(
          base.visits.columns.session_id,
          base.identityKeys.columns.sessionKey,
        ),
      ),
      "left",
    );
    expect(
      lowerLogicalPlan(
        project(leftJoin, { visitId: leftJoin.columns.left_visit_id }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const partial = join(
      base.visits,
      base.identityKeys,
      eq(base.visits.columns.site_pk, base.identityKeys.columns.ownerKey),
    );
    expect(
      lowerLogicalPlan(
        project(partial, { visitId: partial.columns.left_visit_id }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const extraPredicate = join(
      base.visits,
      base.identityKeys,
      and(
        eq(base.visits.columns.site_pk, base.identityKeys.columns.ownerKey),
        eq(
          base.visits.columns.session_id,
          base.identityKeys.columns.sessionKey,
        ),
        eq(base.visits.columns.status, param("active")),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(extraPredicate, {
          visitId: extraPredicate.columns.left_visit_id,
        }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const nondistinctJoin = join(
      base.visits,
      base.identityProjection,
      and(
        eq(
          base.visits.columns.site_pk,
          base.identityProjection.columns.ownerKey,
        ),
        eq(
          base.visits.columns.session_id,
          base.identityProjection.columns.sessionKey,
        ),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(nondistinctJoin, {
          visitId: nondistinctJoin.columns.left_visit_id,
        }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const computedIdentity = distinct(
      project(base.authorizedPairs, {
        sessionKey: castText(base.authorizedPairs.columns.left_sessionId),
        ownerKey: base.authorizedPairs.columns.right_site_pk,
      }),
    );
    const computedJoin = join(
      base.visits,
      computedIdentity,
      and(
        eq(base.visits.columns.site_pk, computedIdentity.columns.ownerKey),
        eq(base.visits.columns.session_id, computedIdentity.columns.sessionKey),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(computedJoin, { visitId: computedJoin.columns.left_visit_id }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const volatileRows = filter(
      base.finiteRows,
      and(
        eq(base.finiteRows.columns.kind, param("eligible")),
        eq(unixepoch(), param(0)),
      ),
    );
    const volatileSites = scan(schema.site_identities);
    const volatileLookup = join(
      volatileRows,
      volatileSites,
      eq(volatileRows.columns.siteId, volatileSites.columns.site_id),
    );
    const volatileKeys = distinct(
      project(volatileLookup, {
        sessionKey: volatileLookup.columns.left_sessionId,
        ownerKey: volatileLookup.columns.right_site_pk,
      }),
    );
    const volatileLeft = scan(schema.visits);
    const volatileJoin = join(
      volatileLeft,
      volatileKeys,
      and(
        eq(volatileLeft.columns.site_pk, volatileKeys.columns.ownerKey),
        eq(volatileLeft.columns.session_id, volatileKeys.columns.sessionKey),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(volatileJoin, { visitId: volatileJoin.columns.left_visit_id }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const outer = scan(schema.visits);
    const correlatedRows = filter(
      base.finiteRows,
      eq(base.finiteRows.columns.siteId, outer.columns.site_id),
    );
    const correlatedSites = scan(schema.site_identities);
    const correlatedLookup = join(
      correlatedRows,
      correlatedSites,
      eq(correlatedRows.columns.siteId, correlatedSites.columns.site_id),
    );
    const correlatedKeys = distinct(
      project(correlatedLookup, {
        sessionKey: correlatedLookup.columns.left_sessionId,
        ownerKey: correlatedLookup.columns.right_site_pk,
      }),
    );
    const correlatedLeft = scan(schema.visits);
    const correlatedJoin = join(
      correlatedLeft,
      correlatedKeys,
      and(
        eq(correlatedLeft.columns.site_pk, correlatedKeys.columns.ownerKey),
        eq(
          correlatedLeft.columns.session_id,
          correlatedKeys.columns.sessionKey,
        ),
      ),
    );
    const correlatedRoot = project(outer, {
      visitId: outer.columns.visit_id,
      match: scalar(
        project(correlatedJoin, {
          visitId: correlatedJoin.columns.left_visit_id,
        }),
      ),
    });
    expect(
      lowerLogicalPlan(correlatedRoot).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const dynamicRows = jsonScalarArray("text", ["tuple-site-a"]);
    const dynamicSites = scan(schema.site_identities);
    const dynamicLookup = join(
      dynamicRows,
      dynamicSites,
      eq(dynamicRows.columns.value, dynamicSites.columns.site_id),
    );
    const dynamicKeys = distinct(
      project(dynamicLookup, {
        siteId: dynamicLookup.columns.left_value,
        sitePk: dynamicLookup.columns.right_site_pk,
      }),
    );
    const dynamicLeft = scan(schema.visits);
    const dynamicJoin = join(
      dynamicLeft,
      dynamicKeys,
      and(
        eq(dynamicLeft.columns.site_id, dynamicKeys.columns.siteId),
        eq(dynamicLeft.columns.site_pk, dynamicKeys.columns.sitePk),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(dynamicJoin, { visitId: dynamicJoin.columns.left_visit_id }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const membershipOnly = semiJoin(
      base.visits,
      base.identityKeys,
      and(
        eq(base.visits.columns.site_pk, base.identityKeys.columns.ownerKey),
        eq(
          base.visits.columns.session_id,
          base.identityKeys.columns.sessionKey,
        ),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(membershipOnly, { visitId: membershipOnly.columns.visit_id }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);
    const antiMembershipOnly = antiJoin(
      base.visits,
      base.identityKeys,
      and(
        eq(base.visits.columns.site_pk, base.identityKeys.columns.ownerKey),
        eq(
          base.visits.columns.session_id,
          base.identityKeys.columns.sessionKey,
        ),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(antiMembershipOnly, {
          visitId: antiMembershipOnly.columns.visit_id,
        }),
      ).positiveTupleMembershipCandidates,
    ).toEqual([]);

    const sharedRoot = project(base.result, {
      siteId: base.result.columns.siteId,
      sessionId: base.result.columns.sessionId,
      rhsCount: scalar(project(base.identityKeys, { value: constant(1) })),
    });
    const sharedPhysical = lowerLogicalPlan(sharedRoot);
    expect(sharedPhysical.positiveTupleMembershipCandidates).toHaveLength(1);
    expect(
      sharedPhysical.positiveTupleMembershipCandidates[0]?.membershipSource,
    ).toBe("finite-values");
    const sharedOptimized = compileD1Query(sharedPhysical);
    const sharedBaseline =
      compileD1QueryTupleMembershipFallbackForTest(sharedPhysical);
    expect(sharedOptimized.sql).toContain(" IN (SELECT ");
    expect(runBag(database, sharedOptimized)).toEqual(
      runBag(database, sharedBaseline),
    );

    const forged = {
      ...physical,
      positiveTupleMembershipCandidates: [
        {
          ...physical.positiveTupleMembershipCandidates[0]!,
          rightKeyIndexes: [1, 0],
        },
      ],
    };
    expect(() => compileD1Query(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );

    const forgedAffinity = {
      ...physical,
      positiveTupleMembershipCandidates: [
        {
          ...physical.positiveTupleMembershipCandidates[0]!,
          leftKeyIndexes: [
            base.visits.columns.site_pk.index,
            base.visits.columns.session_id.index,
          ],
        },
      ],
    };
    expect(() => compileD1Query(forgedAffinity)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });
});

describe("generic self-membership elimination", () => {
  function selfMembershipResult() {
    const visits = scan(schema.visits);
    const keys = distinct(
      project(visits, {
        duration: visits.columns.duration_ms,
        reason: visits.columns.exit_reason,
      }),
    );
    const matches = join(
      visits,
      keys,
      and(
        eq(visits.columns.duration_ms, keys.columns.duration),
        eq(visits.columns.exit_reason, keys.columns.reason),
      ),
    );
    return {
      visits,
      result: project(matches, {
        visitId: matches.columns.left_visit_id,
        duration: matches.columns.left_duration_ms,
        reason: matches.columns.left_exit_reason,
      }),
    };
  }

  it("preserves the left bag while removing an exact BINARY self-membership Join", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    seedTupleFixture(database);
    const update = database.prepare(
      "UPDATE visits SET duration_ms = ?, exit_reason = ? WHERE visit_id = ?",
    );
    update.run(21, "same", "tuple-a-first");
    update.run(21, "same", "tuple-a-second");
    update.run(22, "other", "tuple-b-first");
    update.run(null, "null-first", "tuple-cross-ab");
    update.run(23, null, "tuple-cross-ba");
    update.run(null, null, "tuple-leading-zero");
    update.run(24, "different", "tuple-no-leading-zero");
    update.run(25, "", "tuple-partial-null");
    update.run(26, "blob-source", "tuple-blob-session");

    expect(
      database
        .prepare(
          "SELECT typeof(duration_ms) AS duration_type, typeof(exit_reason) AS reason_type FROM visits WHERE visit_id = ?",
        )
        .get("tuple-a-first"),
    ).toEqual({ duration_type: "integer", reason_type: "text" });

    const { visits, result } = selfMembershipResult();
    const physical = lowerLogicalPlan(result);
    expect(physical.selfMembershipChoices).toHaveLength(1);
    expect(physical.selfMembershipChoices[0]?.leftKeyIndexes).toEqual([
      visits.columns.duration_ms.index,
      visits.columns.exit_reason.index,
    ]);
    expect(physical.selfMembershipChoices[0]?.nullableKeyIndexes).toEqual([
      visits.columns.duration_ms.index,
      visits.columns.exit_reason.index,
    ]);
    expect(physical.positiveTupleMembershipCandidates).toEqual([]);

    const baseline = compileD1QueryUnoptimizedForTest(result);
    const optimized = compileD1Query(physical);
    expect(optimized.physicalPlanShape).toMatchObject({
      version: 7,
      selfMembershipCount: 1,
    });
    expect(optimized.sql).not.toContain("INNER JOIN");
    expect(optimized.sql.match(/\bIS NOT NULL\b/gu)).toHaveLength(2);
    expect(optimized.bindings ?? []).toEqual(baseline.bindings ?? []);
    expect(runBag(database, optimized)).toEqual(runBag(database, baseline));
    expect(runBag(database, optimized)).toEqual([
      {
        visitId: "tuple-a-first",
        duration: 21,
        reason: "same",
      },
      {
        visitId: "tuple-a-second",
        duration: 21,
        reason: "same",
      },
      { visitId: "tuple-b-first", duration: 22, reason: "other" },
      {
        visitId: "tuple-blob-session",
        duration: 26,
        reason: "blob-source",
      },
      {
        visitId: "tuple-no-leading-zero",
        duration: 24,
        reason: "different",
      },
      { visitId: "tuple-partial-null", duration: 25, reason: "" },
    ]);

    database.exec("UPDATE visits SET duration_ms = NULL, exit_reason = NULL");
    expect(runBag(database, optimized)).toEqual([]);
    expect(runBag(database, baseline)).toEqual([]);

    const emptyInput = filter(
      visits,
      eq(visits.columns.site_pk, param(-999_999)),
    );
    const emptyKeys = distinct(
      project(emptyInput, {
        duration: emptyInput.columns.duration_ms,
        reason: emptyInput.columns.exit_reason,
      }),
    );
    const emptyJoin = join(
      emptyInput,
      emptyKeys,
      and(
        eq(emptyInput.columns.duration_ms, emptyKeys.columns.duration),
        eq(emptyInput.columns.exit_reason, emptyKeys.columns.reason),
      ),
    );
    const emptyResult = project(emptyJoin, {
      visitId: emptyJoin.columns.left_visit_id,
    });
    const emptyPhysical = lowerLogicalPlan(emptyResult);
    expect(emptyPhysical.selfMembershipChoices).toHaveLength(1);
    const emptyBaseline = compileD1QueryUnoptimizedForTest(emptyResult);
    const emptyOptimized = compileD1Query(emptyPhysical);
    expect(runBag(database, emptyOptimized)).toEqual(
      runBag(database, emptyBaseline),
    );
    expect(runBag(database, emptyOptimized)).toEqual([]);
  });

  it("rejects source, key, output, collation, and computed-expression mismatches", () => {
    const visits = scan(schema.visits);
    const separateVisits = scan(schema.visits);
    const separateKeys = distinct(
      project(separateVisits, {
        duration: separateVisits.columns.duration_ms,
        reason: separateVisits.columns.exit_reason,
      }),
    );
    const separateJoin = join(
      visits,
      separateKeys,
      and(
        eq(visits.columns.duration_ms, separateKeys.columns.duration),
        eq(visits.columns.exit_reason, separateKeys.columns.reason),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(separateJoin, {
          visitId: separateJoin.columns.left_visit_id,
        }),
      ).selfMembershipChoices,
    ).toEqual([]);

    const filteredRight = filter(visits, eq(visits.columns.site_pk, param(-1)));
    const filteredKeys = distinct(
      project(filteredRight, {
        duration: filteredRight.columns.duration_ms,
        reason: filteredRight.columns.exit_reason,
      }),
    );
    const filteredRightJoin = join(
      visits,
      filteredKeys,
      and(
        eq(visits.columns.duration_ms, filteredKeys.columns.duration),
        eq(visits.columns.exit_reason, filteredKeys.columns.reason),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(filteredRightJoin, {
          visitId: filteredRightJoin.columns.left_visit_id,
        }),
      ).selfMembershipChoices,
    ).toEqual([]);

    const wrongKeys = distinct(
      project(visits, {
        duration: visits.columns.started_at,
        reason: visits.columns.exit_reason,
      }),
    );
    const wrongJoin = join(
      visits,
      wrongKeys,
      and(
        eq(visits.columns.duration_ms, wrongKeys.columns.duration),
        eq(visits.columns.exit_reason, wrongKeys.columns.reason),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(wrongJoin, { visitId: wrongJoin.columns.left_visit_id }),
      ).selfMembershipChoices,
    ).toEqual([]);

    const partialKeys = distinct(
      project(visits, {
        duration: visits.columns.duration_ms,
        reason: visits.columns.exit_reason,
      }),
    );
    const partialJoin = join(
      visits,
      partialKeys,
      eq(visits.columns.duration_ms, partialKeys.columns.duration),
    );
    expect(
      lowerLogicalPlan(
        project(partialJoin, { visitId: partialJoin.columns.left_visit_id }),
      ).selfMembershipChoices,
    ).toEqual([]);

    const residualJoin = join(
      visits,
      partialKeys,
      and(
        eq(visits.columns.duration_ms, partialKeys.columns.duration),
        eq(visits.columns.exit_reason, partialKeys.columns.reason),
        eq(visits.columns.status, param("active")),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(residualJoin, { visitId: residualJoin.columns.left_visit_id }),
      ).selfMembershipChoices,
    ).toEqual([]);

    const rightOutputJoin = join(
      visits,
      partialKeys,
      and(
        eq(visits.columns.duration_ms, partialKeys.columns.duration),
        eq(visits.columns.exit_reason, partialKeys.columns.reason),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(rightOutputJoin, {
          visitId: rightOutputJoin.columns.left_visit_id,
          rightDuration: rightOutputJoin.columns.right_duration,
        }),
      ).selfMembershipChoices,
    ).toEqual([]);

    const computedKeys = distinct(
      project(visits, {
        duration: unixepoch(),
        reason: visits.columns.exit_reason,
      }),
    );
    const computedJoin = join(
      visits,
      computedKeys,
      and(
        eq(visits.columns.duration_ms, computedKeys.columns.duration),
        eq(visits.columns.exit_reason, computedKeys.columns.reason),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(computedJoin, { visitId: computedJoin.columns.left_visit_id }),
      ).selfMembershipChoices,
    ).toEqual([]);

    const unknownCollationVisits: SchemaObjectReference = {
      ...schema.visits,
      defaultCollation: "unknown",
    };
    const durationIndex = visits.columns.duration_ms.index;
    expect(
      hasKnownBinaryTableColumn(
        schema.visits,
        durationIndex,
        visits.fields[durationIndex],
      ),
    ).toBe(true);
    expect(
      hasKnownBinaryTableColumn(
        unknownCollationVisits,
        durationIndex,
        visits.fields[durationIndex],
      ),
    ).toBe(false);
  });

  it("rejects forged self-membership metadata during physical validation", () => {
    const { result } = selfMembershipResult();
    const physical = lowerLogicalPlan(result);
    expect(physical.selfMembershipChoices).toHaveLength(1);
    const forged = {
      ...physical,
      selfMembershipChoices: [
        {
          ...physical.selfMembershipChoices[0]!,
          nullableKeyIndexes: [],
        },
      ],
    };
    expect(() => compileD1Query(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });
});
