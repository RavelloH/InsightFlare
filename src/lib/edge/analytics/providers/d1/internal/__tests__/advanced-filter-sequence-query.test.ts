import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import { createTimeRange } from "@/lib/edge/analytics/contract";
import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
  TeamId,
} from "@/lib/edge/analytics/contract/types";
import { buildAdvancedFilterActivityPlan } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import {
  classifyTwoStepSequence,
  type SupportedSequence,
} from "@/lib/edge/analytics/engine/advanced-filter-sequence-support";
import type { SequenceLimits } from "@/lib/edge/analytics/engine/advanced-sequence-envelope";
import { acceptSequenceAggregate } from "@/lib/edge/analytics/engine/advanced-sequence-envelope";
import type { SequencePlanInput } from "@/lib/edge/analytics/engine/advanced-sequence-filter-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { compileSequenceAggregate } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-sequence-query";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
import {
  evaluateFilterDocument,
  type FilterEvaluationDataset,
  type FilterEvaluationEntity,
} from "@/lib/filter-contract/filter-evaluator";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const range = createTimeRange(0, 1000);
const zone = "UTC" as ReportingTimeZone;
const documents = {
  events:
    'sequence([event { event.name eq "a" }, event { event.name eq "b" }]) exists',
  pageEvent:
    'sequence([page { page.path eq "/first" }, event { event.name eq "b" }]) exists',
  eventPage:
    'sequence([event { event.name eq "b" }, page { page.path eq "/first" }]) exists',
};
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture(siteIds = ["site-a", "site-b"]) {
  const db = createMigratedDatabase();
  databases.push(db);
  const pks = new Map<string, number>();
  const names = new Map<string, number>();
  let nameId = 1;
  for (const siteId of siteIds) {
    db.prepare("INSERT INTO site_identities(site_id) VALUES(?)").run(siteId);
    const pk = Number(
      (
        db
          .prepare("SELECT site_pk FROM site_identities WHERE site_id=?")
          .get(siteId) as { site_pk: number }
      ).site_pk,
    );
    pks.set(siteId, pk);
    for (const name of ["a", "b", "other"]) {
      names.set(`${siteId}:${name}`, nameId);
      db.prepare(
        "INSERT INTO custom_event_names(id,site_id,site_pk,name,last_seen_at) VALUES(?,?,?,?,1)",
      ).run(nameId++, siteId, pk, name);
    }
  }
  function page(
    id: string,
    time: number,
    session = "s",
    visitor = "v",
    path = "/first",
    siteId = "site-a",
  ) {
    db.prepare(
      "INSERT INTO visits(visit_id,site_id,site_pk,session_id,visitor_id,status,started_at,last_activity_at,pathname,hostname) VALUES(?,?,?,?,?,'closed',?,?,?,'spike.test')",
    ).run(id, siteId, pks.get(siteId)!, session, visitor, time, time, path);
  }
  function event(
    id: string,
    time: number,
    name: "a" | "b" | "other",
    owner: string,
    siteId = "site-a",
    sequence = 1,
  ) {
    db.prepare(
      "INSERT INTO custom_events(event_id,site_id,site_pk,visit_id,event_name_id,occurred_at,received_at,sequence,node_count,value_count) VALUES(?,?,?,?,?,?,999,?,1,1)",
    ).run(
      id,
      siteId,
      pks.get(siteId)!,
      owner,
      names.get(`${siteId}:${name}`)!,
      time,
      sequence,
    );
  }
  return { db, page, event };
}
function input(
  dsl: string,
  scope: "session" | "visitor" = "session",
  siteIds = ["site-a"],
  requestedRange = range,
): SequencePlanInput {
  const document = parseFilterDsl(dsl, analyticsFilterRegistry);
  const support = classifyTwoStepSequence(document, scope, {
    range: requestedRange,
  });
  if (support.kind !== "supported")
    throw new Error(`spike_unsupported:${support.code}`);
  return {
    subject: createSemanticSubjectDomain({
      origin: siteIds.length === 1 ? "site" : "team",
      ...(siteIds.length === 1 ? {} : { teamId: "spike-team" as TeamId }),
      siteIds: siteIds as SiteId[],
    }),
    support,
    range: requestedRange,
    reportingTimeZone: zone,
    capturedAtMs: 1000 as EpochMs,
  };
}
function dataset(
  db: DatabaseSync,
  planInput: SequencePlanInput,
  siteId: string,
): FilterEvaluationDataset {
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [siteId as SiteId],
  });
  const plan = buildAdvancedFilterActivityPlan({
    subject,
    range: planInput.range,
  });
  const output = plan.outputs[0]!;
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds: [siteId],
    time: plan.context.time,
  });
  const relation = lowerer.projectOutput(
    lowerer.lower(output),
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const compiled = compileD1Query(lowerLogicalPlan(relation), {
    tag: "analytics.sequence-spike-core-source",
  });
  const rows = db
    .prepare(compiled.sql)
    .all(...(compiled.bindings as never[])) as Record<string, unknown>[];
  const entities = rows.map((row): FilterEvaluationEntity => ({
    kind: row.kind as "page" | "event",
    id: row.id as string,
    time: row.time as number,
    visitId: row.visit_id as string,
    sessionId: row.session_id as string,
    visitorId: row.visitor_id as string,
    fields: { "page.path": row.pathname, "event.name": row.event_name },
  }));
  return {
    pages: entities.filter((row) => row.kind === "page"),
    events: entities.filter((row) => row.kind === "event"),
    coverageRange: planInput.range,
  };
}
function core(
  db: DatabaseSync,
  planInput: SequencePlanInput,
  limits?: { maxActivities: number; maxMatches: number; maxWork: number },
) {
  const matches: { siteId: string; entityId: string }[] = [];
  for (const siteId of planInput.subject.siteIds) {
    const result = evaluateFilterDocument(
      planInput.support.document,
      dataset(db, planInput, siteId),
      {
        scope: planInput.support.scope,
        candidateRange: planInput.range,
        readRange: planInput.range,
        reportingTimeZone: zone,
        capturedAtMs: 1000,
        ...(limits
          ? {
              maxActivities: limits.maxActivities,
              maxSequenceMatches: limits.maxMatches,
              maxSequenceWork: limits.maxWork,
            }
          : {}),
      },
    );
    for (const entityId of result.matchingScopeEntityIds)
      matches.push({ siteId, entityId });
  }
  return matches.sort(
    (a, b) =>
      a.siteId.localeCompare(b.siteId) || a.entityId.localeCompare(b.entityId),
  );
}
function executeSequencePrototype(
  db: DatabaseSync,
  planInput: SequencePlanInput,
  limits?: SequenceLimits,
) {
  const query = compileSequenceAggregate(planInput),
    rows = db.prepare(query.sql).all(...(query.bindings as never[])) as Record<
      string,
      unknown
    >[];
  return {
    ...acceptSequenceAggregate(planInput, rows, limits),
    evidence: [
      {
        output: "sequence-aggregate-envelope",
        sql: query.sql,
        bindings: query.bindings,
        rows,
      },
    ],
  };
}
function parity(db: DatabaseSync, planInput: SequencePlanInput) {
  const result = executeSequencePrototype(db, planInput);
  expect(result.kind).toBe("evaluated");
  if (result.kind !== "evaluated") throw new Error(result.reason);
  expect(
    [...result.matches].sort(
      (a, b) =>
        a.siteId.localeCompare(b.siteId) ||
        a.entityId.localeCompare(b.entityId),
    ),
  ).toEqual(core(db, planInput));
  expect(result.evidence).toHaveLength(1);
  return result;
}

describe("single-statement two-step Seq qualification", () => {
  it("proves the complete tree and explicit unsupported boundaries", () => {
    const supported = classifyTwoStepSequence(
      parseFilterDsl(documents.events, analyticsFilterRegistry),
      "session",
      { range },
    );
    expect(supported.kind).toBe("supported");
    for (const dsl of [
      "sequence([event,event,event]) exists",
      `${documents.events} AND count(event) gt 0`,
      `NOT (${documents.events})`,
      "adjacent(sequence([event,event])) exists",
      "without(sequence([event,event]),page) exists",
      "sequence([event,event]) { $span gt 1ms } exists",
      'sequence([event { event.payload("/x") eq 1 },event]) exists',
    ])
      expect(
        classifyTwoStepSequence(
          parseFilterDsl(dsl, analyticsFilterRegistry),
          "session",
          { range },
        ).kind,
      ).toBe("unsupported");
    expect(
      classifyTwoStepSequence(
        parseFilterDsl(documents.events, analyticsFilterRegistry),
        "event",
        { range },
      ),
    ).toMatchObject({
      kind: "unsupported",
      code: "relation_requires_session_or_visitor_scope",
    });
    for (const time of [
      { range, fullHistory: true },
      { range, filterRange: range },
      { range, readRange: { startMs: -1, endExclusiveMs: 1000 } },
    ])
      expect(
        classifyTwoStepSequence(
          parseFilterDsl(documents.events, analyticsFilterRegistry),
          "session",
          time,
        ),
      ).toMatchObject({
        kind: "unsupported",
        code: "sequence_sql_independent_time_domains",
      });
  });
  it("compiles actual authorized observation sources and agrees with Core in both scopes", () => {
    const f = fixture();
    f.page("owner", 1);
    f.event("a", 10, "a", "owner");
    f.event("b", 20, "b", "owner");
    for (const scope of ["session", "visitor"] as const)
      parity(f.db, input(documents.events, scope));
    f.event("off-window", 1001, "b", "owner");
    parity(f.db, input(documents.events));
  });
  it("preserves Page-before-Event same-millisecond order and ignores event sequence", () => {
    const f = fixture();
    f.page("z-page", 10);
    f.event("a-event", 10, "b", "z-page", "site-a", -100);
    expect(parity(f.db, input(documents.pageEvent)).matches).toEqual([
      { siteId: "site-a", entityId: "s" },
    ]);
    expect(parity(f.db, input(documents.eventPage)).matches).toEqual([]);
  });
  it("does not cross entity partitions or authorized sites with matching local IDs", () => {
    const f = fixture();
    f.page("owner-a", 1, "same", "same", "/a", "site-a");
    f.event("event-a", 10, "a", "owner-a", "site-a");
    f.page("owner-b", 1, "same", "same", "/b", "site-b");
    f.event("event-b", 20, "b", "owner-b", "site-b");
    expect(
      parity(f.db, input(documents.events, "session", ["site-a", "site-b"]))
        .matches,
    ).toEqual([]);
    const result = parity(f.db, input(documents.events, "session", ["site-a"]));
    expect(
      result.evidence
        .flatMap((item) => item.rows)
        .some((row) => row.siteId === "site-b"),
    ).toBe(false);
    f.page("other-session", 1, "other", "same");
    f.event("other-b", 20, "b", "other-session");
    expect(parity(f.db, input(documents.events, "session")).matches).toEqual(
      [],
    );
    expect(parity(f.db, input(documents.events, "visitor")).matches).toEqual([
      { siteId: "site-a", entityId: "same" },
    ]);
  });
  it("handles empty step collections and truthy whitespace identities without trimming", () => {
    const f = fixture();
    f.page("owner", 1, " ", " ");
    f.event("a", 10, "a", "owner");
    expect(parity(f.db, input(documents.events)).matches).toEqual([]);
    f.event("b", 20, "b", "owner");
    expect(parity(f.db, input(documents.events)).matches).toEqual([
      { siteId: "site-a", entityId: " " },
    ]);
    f.page("empty-owner", 1, "", "");
    f.event("empty-a", 10, "a", "empty-owner");
    f.event("empty-b", 20, "b", "empty-owner");
    parity(f.db, input(documents.events));
  });
  it("falls back for same-kind ties instead of inventing BINARY or ordinal order", () => {
    for (const ids of [
      ["a", "A"],
      ["é", "e\u0301"],
    ]) {
      const f = fixture();
      f.page("owner", 1);
      f.event(ids[0]!, 10, "a", "owner");
      f.event(ids[1]!, 10, "b", "owner");
      const result = executeSequencePrototype(f.db, input(documents.events));
      expect(result).toMatchObject({
        kind: "fallback",
        reason: "sequence_locale_tie",
      });
      expect(core(f.db, input(documents.events)).length).toBe(
        ids[0] === "a" ? 1 : 0,
      );
    }
  });
  it("keeps overlap in the tie witness and returns bounded Core for repeated steps", () => {
    const f = fixture();
    f.page("owner", 1);
    f.event("a", 10, "a", "owner");
    expect(
      executeSequencePrototype(f.db, input("sequence([event,event]) exists")),
    ).toMatchObject({ kind: "fallback", reason: "sequence_locale_tie" });
    expect(core(f.db, input("sequence([event,event]) exists"))).toEqual([]);
  });
  it("allows equal budget boundaries and falls back before choosing resource errors", () => {
    const f = fixture();
    f.page("owner", 1);
    f.event("a", 10, "a", "owner");
    f.event("b", 20, "b", "owner");
    f.event("c", 30, "b", "owner");
    const planInput = input(documents.events);
    expect(
      executeSequencePrototype(f.db, planInput, {
        maxActivities: 4,
        maxMatches: 2,
        maxWork: 3,
      }).kind,
    ).toBe("evaluated");
    for (const limits of [
      { maxActivities: 4, maxMatches: 1, maxWork: 100 },
      { maxActivities: 4, maxMatches: 1, maxWork: 2 },
    ]) {
      const result = executeSequencePrototype(f.db, planInput, limits);
      expect(result).toMatchObject({
        kind: "fallback",
        reason: "sequence_budget_unproven",
      });
      expect(() => core(f.db, planInput, limits)).toThrow(
        limits.maxWork === 2
          ? "filter_sequence_work_limit_exceeded"
          : "filter_sequence_match_limit_exceeded",
      );
    }
  });
  it("keeps activity admission global while Seq work/match controls stay per site", () => {
    const f = fixture();
    for (const siteId of ["site-a", "site-b"]) {
      f.page(`owner-${siteId}`, 1, "same", "same", "/", siteId);
      f.event(`a-${siteId}`, 10, "a", `owner-${siteId}`, siteId);
      f.event(`b-${siteId}`, 20, "b", `owner-${siteId}`, siteId);
    }
    const planInput = input(documents.events, "session", ["site-a", "site-b"]);
    expect(
      executeSequencePrototype(f.db, planInput, {
        maxActivities: 6,
        maxMatches: 1,
        maxWork: 2,
      }).kind,
    ).toBe("evaluated");
    const result = executeSequencePrototype(f.db, planInput, {
      maxActivities: 5,
      maxMatches: 1,
      maxWork: 2,
    });
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "sequence_activity_cap",
    });
    expect(result.evidence.map((item) => item.output)).toEqual([
      "sequence-aggregate-envelope",
    ]);
  });
  it("preserves the real default match and work errors by falling back for the whole tree", () => {
    const cases = [
      {
        first: 225,
        second: 225,
        reverse: false,
        error: "filter_sequence_match_limit_exceeded",
      },
      {
        first: 1001,
        second: 1000,
        reverse: true,
        error: "filter_sequence_work_limit_exceeded",
      },
    ];
    for (const item of cases) {
      const f = fixture();
      f.page("owner", 1);
      for (let index = 0; index < item.first; index++)
        f.event(`a-${index}`, (item.reverse ? 3000 : 10) + index, "a", "owner");
      for (let index = 0; index < item.second; index++)
        f.event(`b-${index}`, (item.reverse ? 10 : 3000) + index, "b", "owner");
      const planInput = input(
        documents.events,
        "session",
        ["site-a"],
        createTimeRange(0, 10000),
      );
      const actual = executeSequencePrototype(f.db, planInput);
      expect(actual).toMatchObject({
        kind: "fallback",
        reason: "sequence_budget_unproven",
      });
      expect(() => core(f.db, planInput)).toThrow(item.error);
    }
  });
  it("checks actual historical storage before any budget or membership execution", () => {
    const f = fixture();
    f.page("owner", 1);
    f.event("a", 10, "a", "owner");
    f.event("b", 20, "b", "owner");
    f.db
      .prepare(
        "UPDATE visits SET session_id=CAST('s' AS BLOB) WHERE visit_id='owner'",
      )
      .run();
    const result = executeSequencePrototype(f.db, input(documents.events));
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "sequence_storage_compatibility",
    });
    expect(result.evidence.map((item) => item.output)).toEqual([
      "sequence-aggregate-envelope",
    ]);
  });
  it("uses the registered selector predicates for boolean strings and absence", () => {
    const f = fixture();
    f.page("owner", 1);
    f.event("a", 10, "a", "owner");
    f.event("b", 20, "b", "owner");
    for (const dsl of [
      'sequence([event { event.name eq "a" OR event.name eq "other" }, event { NOT (event.name eq "a") }]) exists',
      'sequence([page { page.path contains "first" AND page.path neq "/missing" }, event { event.name eq "b" }]) exists',
      "sequence([event { event.name notExists }, event]) exists",
    ])
      parity(f.db, input(dsl));
  });
  it.each([
    [0, 10],
    [-10, 0],
    [0, 2],
  ])("preserves explicit half-open step windows for [%i,%i)", (start, end) => {
    const f = fixture(),
      duration = end - start;
    const dsl = `sequence([window(page { page.path eq "/first" },@range.start,[0ms,${duration - 1}ms]),window(event { event.name eq "b" },@range.start,[0ms,${duration - 1}ms])]) exists`;
    f.page("included-owner", start, "included", "included");
    f.event("included-b", end - 2, "b", "included-owner");
    f.page("last-ms-owner", start + 1, "last-ms", "last-ms");
    f.event("last-ms-b", end - 1, "b", "last-ms-owner");
    f.page("outside-owner", start, "outside", "outside");
    f.event("outside-b", end, "b", "outside-owner");
    expect(
      parity(
        f.db,
        input(dsl, "session", ["site-a"], createTimeRange(start, end)),
      ).matches,
    ).toEqual([{ siteId: "site-a", entityId: "included" }]);
  });
  it("declines invalid or unsafe window endpoints and captured clocks without SQL", () => {
    const document = parseFilterDsl(
      documents.pageEvent,
      analyticsFilterRegistry,
    );
    const root = document.root!;
    if (root.kind !== "condition" || root.target.kind !== "sequence")
      throw new Error("fixture_shape");
    const windowed = {
      ...document,
      root: {
        ...root,
        target: {
          ...root.target,
          steps: root.target.steps.map((collection) => ({
            kind: "window" as const,
            collection,
            anchor: {
              kind: "time-anchor" as const,
              anchor: "range.start" as const,
            },
            startOffset: {
              kind: "duration" as const,
              amount: 0,
              unit: "ms" as const,
            },
            endOffset: {
              kind: "duration" as const,
              amount: 0,
              unit: "ms" as const,
            },
          })),
        },
      },
    };
    expect(
      classifyTwoStepSequence(windowed, "session", {
        range: { startMs: 0, endExclusiveMs: 1 },
      }).kind,
    ).toBe("unsupported");
    for (const candidate of [
      { startMs: 0, endExclusiveMs: 0 },
      { startMs: 1, endExclusiveMs: 0 },
      {
        startMs: -Number.MAX_SAFE_INTEGER,
        endExclusiveMs: Number.MAX_SAFE_INTEGER,
      },
      { startMs: 0, endExclusiveMs: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(
        classifyTwoStepSequence(document, "session", { range: candidate }).kind,
      ).toBe("unsupported");
    expect(
      classifyTwoStepSequence(document, "session", {
        range,
        capturedAtMs: 998,
      }),
    ).toMatchObject({
      kind: "unsupported",
      code: "sequence_sql_invalid_time_domain",
    });
    expect(
      classifyTwoStepSequence(document, "session", { range, capturedAtMs: 999 })
        .kind,
    ).toBe("supported");
    expect(
      classifyTwoStepSequence(document, "session", {
        range,
        capturedAtMs: Number.MAX_SAFE_INTEGER,
      }).kind,
    ).toBe("unsupported");
  });
  it("refuses forged or mutated classifier proof before reading data", () => {
    const f = fixture();
    const planInput = input(documents.events);
    expect(() =>
      compileSequenceAggregate({
        ...planInput,
        support: { ...planInput.support },
      }),
    ).toThrow("sequence_sql_support_proof_invalid");
    (
      planInput.support as unknown as { steps: SupportedSequence["steps"] }
    ).steps = [
      { kind: "page", predicate: null },
      { kind: "page", predicate: null },
    ];
    expect(() => executeSequencePrototype(f.db, planInput)).toThrow(
      "sequence_sql_support_proof_invalid",
    );
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "executes deterministic fixture seed %i against an independently evaluated Core",
    (seed) => {
      const f = fixture();
      let index = 0;
      for (const siteId of ["site-a", "site-b"])
        for (const session of ["s1", "s2"]) {
          const owner = `owner-${seed}-${index++}`;
          f.page(owner, 1, session, `v${index % 2}`, "/first", siteId);
          for (let i = 0; i < 6; i++)
            f.event(
              `ev-${seed}-${index}-${i}`,
              10 + i * 7,
              (seed + i + index) % 3 === 0
                ? "a"
                : (seed + i) % 2 === 0
                  ? "b"
                  : "other",
              owner,
              siteId,
              100 - i,
            );
        }
      for (const scope of ["session", "visitor"] as const)
        parity(f.db, input(documents.events, scope, ["site-a", "site-b"]));
    },
  );
});

describe("W141 real window proof context", () => {
  it("rejects a different legal range before SQL and leaves the genuine proof reusable", () => {
    const f = fixture(["site-a"]);
    f.page("included-owner", 0, "included", "included");
    f.event("included-b", 8, "b", "included-owner");
    const dsl =
      'sequence([window(page { page.path eq "/first" },@range.start,[0ms,9ms]),window(event { event.name eq "b" },@range.start,[0ms,9ms])]) exists';
    const original = input(dsl, "session", ["site-a"], createTimeRange(0, 10));
    const proof = original.support;
    const before = parity(f.db, original);
    expect(before.matches).toEqual([
      { siteId: "site-a", entityId: "included" },
    ]);
    const prepare = vi.spyOn(f.db, "prepare");
    try {
      const changed = { ...original, range: createTimeRange(1, 11) };
      expect(changed.support).toBe(proof);
      expect(() => executeSequencePrototype(f.db, changed)).toThrowError(
        /^sequence_sql_window_context_changed$/,
      );
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
    expect(original.support).toBe(proof);
    expect(parity(f.db, original)).toEqual(before);
  });
});
