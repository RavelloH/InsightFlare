import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  LazyEligibleDataset,
  LogicalPlanBuilder,
  planSemanticAggregateQuery,
} from "@/lib/edge/analytics/engine";
import { lowerFilterDocumentToScope } from "@/lib/edge/analytics/engine/filter-document-lowering";
import type { LogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  lowerAnalyticsFilteredSessionOverviewPairPlan,
  lowerAnalyticsFilteredSessionViewsPlan,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-page-session-lowering";
import { queryOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import {
  evaluateFilterDocument,
  type FilterEvaluationEntity,
} from "@/lib/filter-contract/filter-evaluator";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import {
  type FilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE_A = "site-a";
const SITE_B = "site-b";
const CANDIDATE_RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const READ_RANGE = { startMs: 0, endExclusiveMs: 100 } as const;
const EVENT_NAMES = ["signup", "other"] as const;

type EventName = (typeof EVENT_NAMES)[number];
type TestRange = {
  readonly startMs: number;
  readonly endExclusiveMs: number;
};

function condition(field: string, value: string) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator: "eq",
    value,
  } as const;
}

function document(root: unknown): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

const AND_FILTER = document({
  kind: "and",
  children: [
    condition("page.path", "/match"),
    condition("event.name", "signup"),
  ],
});

const NOT_EVENT_FILTER = document({
  kind: "not",
  child: condition("event.name", "signup"),
});

const TWO_LEAF_BOOLEAN_FILTERS = [
  { label: "two-leaf AND", filters: AND_FILTER },
  {
    label: "two-leaf OR",
    filters: document({
      kind: "or",
      children: [
        condition("page.path", "/match"),
        condition("event.name", "signup"),
      ],
    }),
  },
  {
    label: "NOT(two-leaf AND)",
    filters: document({ kind: "not", child: AND_FILTER.root }),
  },
  {
    label: "NOT(two-leaf OR)",
    filters: document({
      kind: "not",
      child: {
        kind: "or",
        children: [
          condition("page.path", "/match"),
          condition("event.name", "signup"),
        ],
      },
    }),
  },
  {
    label: "AND(NOT page.path, event.name)",
    filters: document({
      kind: "and",
      children: [
        { kind: "not", child: condition("page.path", "/match") },
        condition("event.name", "signup"),
      ],
    }),
  },
] as const;

function buildSemanticViewsPlan(
  filters: FilterDocument,
  options: {
    readonly siteId?: string;
    readonly candidateRange?: TestRange;
    readonly readRange?: TestRange;
  } = {},
): LogicalPlan {
  const siteId = options.siteId ?? SITE_A;
  const candidateRange = options.candidateRange ?? CANDIDATE_RANGE;
  const readRange = options.readRange ?? READ_RANGE;
  const context = {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [siteId as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: candidateRange as never,
      read: { kind: "bounded", range: readRange as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: candidateRange.endExclusiveMs as never,
    }),
    scope: resolveAnalyticsScope("session"),
  };
  const builder = new LogicalPlanBuilder(context);
  const analysis = analyzeFilterDocument(filters, analyticsFilterRegistry);
  const lowered = lowerFilterDocumentToScope(builder, analysis, {
    targetScope: "session",
    resolveTemporalDomain: () => "read",
  });
  if (lowered.kind !== "supported") {
    throw new Error(`Expected a Session filter, received ${lowered.kind}.`);
  }
  const candidatePages = builder.source("page", {
    relationships: ["page.session"],
  });
  const eligiblePages = builder.semiJoin(
    candidatePages,
    lowered.selection.relation,
    [{ left: "relationship:page.session", right: "entity" }],
  );
  const dataset = new LazyEligibleDataset({
    subject: context.subject,
    scope: {
      kind: "matching",
      target: "session",
      relation: lowered.selection.relation,
      entitySlotName: "entity",
    },
    resolveRelation(entity) {
      if (entity === "page") return eligiblePages;
      if (entity === "session") return lowered.selection.relation;
      return builder.source(entity);
    },
    resolveAssociation() {
      throw new Error("An ungrouped views metric does not use associations.");
    },
  });
  return planSemanticAggregateQuery(
    builder,
    { context, dimensions: [], metrics: ["views"], sort: [] },
    dataset,
  );
}

function buildSemanticOverviewPairPlan(
  filters: FilterDocument,
  options: {
    readonly siteId?: string;
    readonly candidateRange?: TestRange;
    readonly readRange?: TestRange;
  } = {},
): LogicalPlan {
  const siteId = options.siteId ?? SITE_A;
  const candidateRange = options.candidateRange ?? CANDIDATE_RANGE;
  const readRange = options.readRange ?? READ_RANGE;
  const context = {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [siteId as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: candidateRange as never,
      read: { kind: "bounded", range: readRange as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: candidateRange.endExclusiveMs as never,
    }),
    scope: resolveAnalyticsScope("session"),
  };
  const builder = new LogicalPlanBuilder(context);
  const analysis = analyzeFilterDocument(filters, analyticsFilterRegistry);
  const lowered = lowerFilterDocumentToScope(builder, analysis, {
    targetScope: "session",
    resolveTemporalDomain: () => "read",
  });
  if (lowered.kind !== "supported") {
    throw new Error(`Expected a Session filter, received ${lowered.kind}.`);
  }
  const candidatePages = builder.source("page", {
    relationships: ["page.session"],
  });
  const eligiblePages = builder.semiJoin(
    candidatePages,
    lowered.selection.relation,
    [{ left: "relationship:page.session", right: "entity" }],
  );
  const dataset = new LazyEligibleDataset({
    subject: context.subject,
    scope: {
      kind: "matching",
      target: "session",
      relation: lowered.selection.relation,
      entitySlotName: "entity",
    },
    resolveRelation(entity) {
      if (entity === "page") return eligiblePages;
      if (entity === "session") return lowered.selection.relation;
      return builder.source(entity);
    },
    resolveAssociation() {
      throw new Error("An ungrouped overview pair does not use associations.");
    },
  });
  return planSemanticAggregateQuery(
    builder,
    { context, dimensions: [], metrics: ["sessions", "views"], sort: [] },
    dataset,
  );
}

interface SiteSeed {
  readonly id: string;
  readonly key: number;
  readonly eventNameIds: Readonly<Record<EventName, number>>;
}

interface PageSeed {
  readonly visitId: string;
  readonly site: SiteSeed;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly pathname: string;
}

interface EventSeed {
  readonly eventId: string;
  readonly site: SiteSeed;
  readonly visit: PageSeed;
  readonly occurredAt: number;
  readonly name: EventName;
}

interface EvaluationFixture {
  readonly pages: readonly FilterEvaluationEntity[];
  readonly events: readonly FilterEvaluationEntity[];
  readonly candidatePages: readonly PageSeed[];
}

function setupSite(db: DatabaseSync, id: string): SiteSeed {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const identity = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  const insertName = db.prepare(
    "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
  );
  for (const name of EVENT_NAMES) insertName.run(id, name, 1, identity.site_pk);
  const eventNameIds = Object.fromEntries(
    EVENT_NAMES.map((name) => {
      const row = db
        .prepare(
          "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
        )
        .get(identity.site_pk, name) as { readonly id: number };
      return [name, row.id];
    }),
  ) as Record<EventName, number>;
  return { id, key: identity.site_pk, eventNameIds };
}

function insertPage(db: DatabaseSync, page: PageSeed): void {
  db.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, site_pk
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, 'example.test', ?)`,
  ).run(
    page.visitId,
    page.site.id,
    `visitor-${page.visitId}`,
    page.sessionId,
    page.startedAt,
    page.startedAt,
    page.pathname,
    page.site.key,
  );
}

function insertEvent(db: DatabaseSync, event: EventSeed): void {
  db.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(
    event.eventId,
    event.site.id,
    event.site.key,
    event.visit.visitId,
    event.site.eventNameIds[event.name],
    event.occurredAt,
    event.occurredAt,
  );
}

function pageEntity(page: PageSeed): FilterEvaluationEntity {
  return {
    kind: "page",
    id: page.visitId,
    visitId: page.visitId,
    sessionId: page.sessionId,
    visitorId: `visitor-${page.visitId}`,
    time: page.startedAt,
    fields: { "page.path": page.pathname },
  };
}

function eventEntity(event: EventSeed): FilterEvaluationEntity {
  return {
    kind: "event",
    id: event.eventId,
    visitId: event.visit.visitId,
    sessionId: event.visit.sessionId,
    visitorId: `visitor-${event.visit.visitId}`,
    time: event.occurredAt,
    fields: { "event.name": event.name },
    payload: {},
  };
}

function evaluateCandidateRestrictedSessionSet(
  filters: FilterDocument,
  fixture: EvaluationFixture,
): ReadonlySet<string> {
  const candidateSessionIds = new Set(
    [...fixture.pages, ...fixture.events]
      .filter(
        (entity) =>
          entity.time !== undefined &&
          entity.time >= CANDIDATE_RANGE.startMs &&
          entity.time < CANDIDATE_RANGE.endExclusiveMs,
      )
      .map((entity) => entity.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const evaluate = (expression: unknown): Set<string> => {
    if (!expression || typeof expression !== "object") {
      throw new Error("Expected a normalized filter expression.");
    }
    const node = expression as Record<string, unknown>;
    if (node.kind === "condition") {
      const evaluated = evaluateFilterDocument(
        document(node),
        {
          pages: fixture.pages,
          events: fixture.events,
          coverageRange: { startMs: 0, endExclusiveMs: 500 },
        },
        {
          scope: "session",
          candidateRange: CANDIDATE_RANGE,
          filterRange: READ_RANGE,
          readRange: READ_RANGE,
          reportingTimeZone: "UTC",
          capturedAtMs: 500,
        },
      ).matchingScopeEntityIds;
      return new Set(
        [...evaluated].filter((sessionId) =>
          candidateSessionIds.has(sessionId),
        ),
      );
    }
    if (node.kind === "not") {
      const child = evaluate(node.child);
      return new Set(
        [...candidateSessionIds].filter((sessionId) => !child.has(sessionId)),
      );
    }
    if (node.kind === "and" || node.kind === "or") {
      if (!Array.isArray(node.children)) {
        throw new Error("Expected Boolean child expressions.");
      }
      const children = node.children.map(evaluate);
      if (node.kind === "and") {
        return new Set(
          [...(children[0] ?? [])].filter((sessionId) =>
            children.slice(1).every((child) => child.has(sessionId)),
          ),
        );
      }
      return new Set(children.flatMap((child) => [...child]));
    }
    throw new Error(`Unsupported test expression '${String(node.kind)}'.`);
  };
  return evaluate(filters.root);
}

function expectedViews(
  filters: FilterDocument,
  fixture: EvaluationFixture,
): number {
  const selectedSessions = evaluateCandidateRestrictedSessionSet(
    filters,
    fixture,
  );
  return fixture.candidatePages.filter(
    (page) =>
      page.startedAt >= CANDIDATE_RANGE.startMs &&
      page.startedAt < CANDIDATE_RANGE.endExclusiveMs &&
      Boolean(page.sessionId) &&
      selectedSessions.has(page.sessionId),
  ).length;
}

interface MutablePlanForTest {
  readonly nodes: Array<Record<string, unknown>>;
  readonly outputs: Array<{
    readonly relation: number;
    readonly fields: Array<Record<string, unknown>>;
  }>;
  readonly context: Record<string, unknown>;
}

function mutablePlan(plan: LogicalPlan): MutablePlanForTest {
  return structuredClone(plan) as unknown as MutablePlanForTest;
}

function asPlan(plan: MutablePlanForTest): LogicalPlan {
  return plan as unknown as LogicalPlan;
}

function createFixture(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys = ON");
  const siteA = setupSite(db, SITE_A);
  const siteB = setupSite(db, SITE_B);
  const pages: FilterEvaluationEntity[] = [];
  const events: FilterEvaluationEntity[] = [];
  const candidatePages: PageSeed[] = [];
  return {
    siteA,
    siteB,
    evaluation: { pages, events, candidatePages } satisfies EvaluationFixture,
    addPage(
      site: SiteSeed,
      visitId: string,
      sessionId: string,
      startedAt: number,
      pathname: string,
    ): PageSeed {
      const page = {
        visitId,
        site,
        sessionId,
        startedAt,
        pathname,
      } satisfies PageSeed;
      insertPage(db, page);
      if (site.id === SITE_A) {
        pages.push(pageEntity(page));
        candidatePages.push(page);
      }
      return page;
    },
    addEvent(
      site: SiteSeed,
      eventId: string,
      visit: PageSeed,
      occurredAt: number,
      name: EventName = "signup",
    ): void {
      const event = {
        eventId,
        site,
        visit,
        occurredAt,
        name,
      } satisfies EventSeed;
      insertEvent(db, event);
      if (site.id === SITE_A) events.push(eventEntity(event));
    },
  };
}

async function executeViewsQuery(
  db: DatabaseSync,
  client: ReturnType<typeof createD1DatabaseClient>,
  trace: SqliteD1Trace,
  filters: FilterDocument,
  expected: number,
  options: {
    readonly siteId?: string;
    readonly candidateRange?: TestRange;
    readonly readRange?: TestRange;
  } = {},
) {
  const semanticPlan = buildSemanticViewsPlan(filters, options);
  const lowered = lowerAnalyticsFilteredSessionViewsPlan(semanticPlan, {
    siteId: options.siteId ?? SITE_A,
    candidateRange: (options.candidateRange ?? CANDIDATE_RANGE) as never,
    readRange: (options.readRange ?? READ_RANGE) as never,
  });
  expect(lowered.kind).toBe("supported");
  if (lowered.kind !== "supported") {
    throw new Error(
      `Unsupported views plan at ${lowered.node}: ${lowered.reason}`,
    );
  }
  const statementStart = trace.preparedSql.length;
  const bindingStart = trace.bindings.length;
  const result = await client.all(lowered.query);
  expect(result.results).toEqual([{ views: expected }]);
  expect(trace.preparedSql).toHaveLength(statementStart + 1);
  expect(trace.bindings).toHaveLength(bindingStart + 1);
  expect(trace.bindings[bindingStart]).toHaveLength(
    lowered.query.bindings?.length ?? 0,
  );
  expect(lowered.query.sql.length).toBeLessThan(60_000);
  expect(lowered.query.bindings?.length ?? 0).toBeLessThanOrEqual(40);
  const explain = explainQueryPlan(db, lowered.query);
  expect(
    explain.some(
      (line) =>
        line.includes("idx_visits_site_pk_started_at") ||
        line.includes("idx_visits_site_pk_session_started_at"),
    ),
  ).toBe(true);
  return { query: lowered.query, explain };
}

function expectedOverviewPair(
  filters: FilterDocument,
  fixture: EvaluationFixture,
): { readonly sessions: number; readonly views: number } {
  return {
    sessions: evaluateCandidateRestrictedSessionSet(filters, fixture).size,
    views: expectedViews(filters, fixture),
  };
}

async function executeOverviewPairQuery(
  db: DatabaseSync,
  client: ReturnType<typeof createD1DatabaseClient>,
  trace: SqliteD1Trace,
  filters: FilterDocument,
  expected: { readonly sessions: number; readonly views: number },
  options: {
    readonly siteId?: string;
    readonly candidateRange?: TestRange;
    readonly readRange?: TestRange;
  } = {},
) {
  const semanticPlan = buildSemanticOverviewPairPlan(filters, options);
  const lowered = lowerAnalyticsFilteredSessionOverviewPairPlan(semanticPlan, {
    siteId: options.siteId ?? SITE_A,
    candidateRange: options.candidateRange ?? CANDIDATE_RANGE,
    readRange: options.readRange ?? READ_RANGE,
  } as never);
  if (lowered.kind !== "supported") {
    throw new Error(
      `Unsupported overview pair at ${lowered.node}: ${lowered.reason}`,
    );
  }
  expect(lowered.kind).toBe("supported");
  const statementStart = trace.preparedSql.length;
  const bindingStart = trace.bindings.length;
  const result = await client.all(lowered.query);
  expect(result.results).toEqual([expected]);
  expect(trace.preparedSql).toHaveLength(statementStart + 1);
  expect(trace.bindings).toHaveLength(bindingStart + 1);
  expect(trace.bindings[bindingStart]).toHaveLength(
    lowered.query.bindings?.length ?? 0,
  );
  const sqlBytes = new TextEncoder().encode(lowered.query.sql).length;
  expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
  expect(lowered.query.bindings?.length ?? 0).toBeLessThanOrEqual(
    D1_MAX_BOUND_PARAMETERS,
  );
  const explain = explainQueryPlan(db, lowered.query);
  expect(
    explain.some(
      (line) =>
        line.includes("idx_visits_site_pk_started_at") ||
        line.includes("idx_visits_site_pk_session_started_at"),
    ),
  ).toBe(true);
  return { query: lowered.query, explain, sqlBytes };
}

describe("semantic Session-filtered views plan", () => {
  it("counts candidate Page rows from matching Sessions in one D1 query", async () => {
    const db = createMigratedDatabase();
    try {
      const fixture = createFixture(db);
      const { siteA, siteB, evaluation, addPage, addEvent } = fixture;

      addPage(siteA, "and-history-page", "s-and", 10, "/match");
      addPage(siteA, "and-duplicate-history-page", "s-and", 11, "/match");
      const andEventOwnerOutsideBothWindows = addPage(
        siteA,
        "and-event-owner-outside-windows",
        "s-and",
        300,
        "/owner-only",
      );
      addEvent(siteA, "and-history-event", andEventOwnerOutsideBothWindows, 30);
      addEvent(
        siteA,
        "and-duplicate-history-event",
        andEventOwnerOutsideBothWindows,
        31,
      );
      addPage(siteA, "and-candidate-start", "s-and", 100, "/not-match");
      addPage(siteA, "and-candidate-before-end", "s-and", 199, "/not-match");

      const eventCandidateHistory = addPage(
        siteA,
        "event-candidate-history",
        "s-event-candidate",
        12,
        "/match",
      );
      const eventCandidateOwnerOutsideBothWindows = addPage(
        siteA,
        "event-candidate-owner-outside-windows",
        "s-event-candidate",
        320,
        "/owner-only",
      );
      addEvent(
        siteA,
        "event-candidate-history-event",
        eventCandidateHistory,
        35,
      );
      addPage(
        siteA,
        "event-candidate-page-a",
        "s-event-candidate",
        120,
        "/else",
      );
      addPage(
        siteA,
        "event-candidate-page-b",
        "s-event-candidate",
        150,
        "/else",
      );
      addEvent(
        siteA,
        "event-candidate-event",
        eventCandidateOwnerOutsideBothWindows,
        160,
        "other",
      );

      const eventOnlyHistory = addPage(
        siteA,
        "event-only-history-page",
        "s-event-only-candidate",
        14,
        "/match",
      );
      addEvent(siteA, "event-only-history-event", eventOnlyHistory, 37);
      const eventOnlyOwnerOutsideWindows = addPage(
        siteA,
        "event-only-candidate-owner",
        "s-event-only-candidate",
        350,
        "/owner-only",
      );
      addEvent(
        siteA,
        "event-only-candidate-event",
        eventOnlyOwnerOutsideWindows,
        130,
        "other",
      );

      const historyOnlyPage = addPage(
        siteA,
        "history-only-page",
        "s-history-only",
        16,
        "/match",
      );
      addEvent(siteA, "history-only-event", historyOnlyPage, 40);

      addPage(siteA, "page-only-history", "s-page-only", 18, "/match");
      addPage(siteA, "page-only-candidate", "s-page-only", 125, "/else");

      const eventAtCandidateStartHistory = addPage(
        siteA,
        "event-at-candidate-start-history",
        "s-event-at-candidate-start",
        20,
        "/match",
      );
      addEvent(
        siteA,
        "event-at-candidate-start",
        eventAtCandidateStartHistory,
        100,
      );
      addPage(
        siteA,
        "event-at-candidate-start-page",
        "s-event-at-candidate-start",
        145,
        "/else",
      );

      const pageStartHistory = addPage(
        siteA,
        "page-start-history",
        "s-page-at-candidate-start",
        22,
        "/match",
      );
      addEvent(siteA, "page-start-history-event", pageStartHistory, 23);
      addPage(
        siteA,
        "page-at-candidate-start",
        "s-page-at-candidate-start",
        100,
        "/else",
      );

      const pageEndHistory = addPage(
        siteA,
        "page-end-history",
        "s-page-at-candidate-end",
        24,
        "/match",
      );
      addEvent(siteA, "page-end-history-event", pageEndHistory, 25);
      const pageEndCandidateEventOwner = addPage(
        siteA,
        "page-end-candidate-event-owner",
        "s-page-at-candidate-end",
        330,
        "/owner-only",
      );
      addEvent(
        siteA,
        "page-end-candidate-event",
        pageEndCandidateEventOwner,
        155,
        "other",
      );
      addPage(
        siteA,
        "page-at-candidate-end",
        "s-page-at-candidate-end",
        200,
        "/else",
      );

      const crossSiteOwner = addPage(
        siteB,
        "site-b-shared-session-history",
        "s-shared",
        10,
        "/match",
      );
      addEvent(siteB, "site-b-shared-session-event", crossSiteOwner, 20);
      addPage(
        siteB,
        "site-b-shared-session-candidate",
        "s-shared",
        120,
        "/else",
      );
      addPage(
        siteA,
        "site-a-shared-session-candidate",
        "s-shared",
        110,
        "/else",
      );

      addPage(siteA, "empty-session-candidate", "", 115, "/else");

      addPage(
        siteA,
        "solo-event-only-history",
        "s-solo-event-only-candidate",
        45,
        "/event-only-history",
      );
      const soloEventOnlyOwner = addPage(
        siteA,
        "solo-event-only-owner-outside-windows",
        "s-solo-event-only-candidate",
        420,
        "/owner-only",
      );
      addEvent(
        siteA,
        "solo-event-only-candidate-event",
        soloEventOnlyOwner,
        140,
        "other",
      );
      // The history Page makes this Session match the filter; only the Event
      // puts it in the candidate universe, and there is no candidate Page.

      const noFilterCandidate = addPage(
        siteA,
        "not-filtered-candidate",
        "s-not-filtered-candidate",
        199,
        "/else",
      );
      addEvent(
        siteA,
        "not-filtered-candidate-event",
        noFilterCandidate,
        199,
        "other",
      );

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace));

      const andExpected = expectedViews(AND_FILTER, evaluation);
      expect(andExpected).toBe(5);
      const andPlan = buildSemanticViewsPlan(AND_FILTER);
      const aggregateNode = andPlan.nodes.find(
        (node) => node.kind === "aggregate",
      );
      const pageSource = andPlan.nodes.find(
        (node) => node.kind === "source" && node.entity === "page",
      );
      const pageMembership = andPlan.nodes.find(
        (node) => node.kind === "semi-join" && node.left === pageSource?.id,
      );
      expect(aggregateNode).toMatchObject({
        kind: "aggregate",
        groups: [],
        measures: [{ kind: "count-rows" }],
      });
      expect(pageSource).toMatchObject({
        kind: "source",
        entity: "page",
        temporalDomain: "candidate",
        grain: { kind: "entity", entity: "page" },
      });
      expect(pageMembership).toMatchObject({
        kind: "semi-join",
        grain: { kind: "entity", entity: "page" },
      });

      const executed = await executeViewsQuery(
        db,
        client,
        trace,
        AND_FILTER,
        andExpected,
      );
      expect(executed.query.tag).toBe(
        "analytics.filtered-session-views.wave-4",
      );
      expect(executed.query.sql).toMatch(/COUNT\s*\(\s*\*\s*\)/iu);
      // Shared candidate Session relations keep the two-leaf shape compact.
      expect(executed.query.bindings).toHaveLength(18);
      const explainText = executed.explain.join("\n");
      expect(explainText).toContain("idx_visits_site_pk_session_started_at");
      expect(explainText).toContain("idx_custom_events_site_pk_visit_time");

      const eventOnlyFilter = document(
        condition("page.path", "/event-only-history"),
      );
      expect(
        evaluateCandidateRestrictedSessionSet(eventOnlyFilter, evaluation),
      ).toEqual(new Set(["s-solo-event-only-candidate"]));
      expect(expectedViews(eventOnlyFilter, evaluation)).toBe(0);
      await executeViewsQuery(db, client, trace, eventOnlyFilter, 0);

      const notExpected = expectedViews(NOT_EVENT_FILTER, evaluation);
      const notQuery = await executeViewsQuery(
        db,
        client,
        trace,
        NOT_EVENT_FILTER,
        notExpected,
      );
      expect(notExpected).toBeGreaterThan(0);
      expect(notQuery.query.sql).toMatch(/COUNT\s*\(\s*\*\s*\)/iu);

      const noMatch = document(condition("page.path", "/never-seen"));
      await executeViewsQuery(db, client, trace, noMatch, 0);
    } finally {
      db.close();
    }
  });

  it("rejects metric, Page membership, output, and scope mutations before SQL", () => {
    const original = buildSemanticViewsPlan(AND_FILTER);
    const mutations: Array<(plan: MutablePlanForTest) => void> = [
      (plan) => {
        const aggregate = plan.nodes.find((node) => node.kind === "aggregate");
        const measures = aggregate?.measures as Array<Record<string, unknown>>;
        measures[0]!.kind = "sum";
      },
      (plan) => {
        const aggregate = plan.nodes.find((node) => node.kind === "aggregate");
        const source = plan.nodes.find((node) => node.kind === "source");
        aggregate!.input = source!.id;
      },
      (plan) => {
        const aggregate = plan.nodes.find((node) => node.kind === "aggregate");
        (aggregate!.groups as unknown[]).push({ invalid: true });
      },
      (plan) => {
        const source = plan.nodes.find(
          (node) => node.kind === "source" && node.entity === "page",
        );
        source!.temporalDomain = "read";
      },
      (plan) => {
        const membership = plan.nodes.find((node) => node.kind === "semi-join");
        membership!.kind = "anti-join";
      },
      (plan) => {
        const semantic = plan.outputs[0]!.fields[0]!.semantic as Record<
          string,
          unknown
        >;
        semantic.id = "sessions";
      },
      (plan) => {
        const subject = plan.context.subject as Record<string, unknown>;
        subject.siteIds = [SITE_A, SITE_B];
      },
      (plan) => {
        const subject = plan.context.subject as Record<string, unknown>;
        subject.siteIds = [SITE_B];
      },
      (plan) => {
        const scope = plan.context.scope as Record<string, unknown>;
        scope.requested = "visitor";
        scope.contractScope = "visitor";
        scope.logicalScope = "visitor";
      },
      (plan) => {
        const time = plan.context.time as Record<string, unknown>;
        time.read = { kind: "retained-history" };
      },
      (plan) => {
        const time = plan.context.time as Record<string, unknown>;
        time.candidate = { startMs: 200, endExclusiveMs: 200 };
      },
      (plan) => {
        const time = plan.context.time as Record<string, unknown>;
        time.candidate = { startMs: 101, endExclusiveMs: 200 };
      },
      (plan) => {
        const time = plan.context.time as Record<string, unknown>;
        time.read = {
          kind: "bounded",
          range: { startMs: 1, endExclusiveMs: 100 },
        };
      },
    ];
    for (const mutate of mutations) {
      const plan = mutablePlan(original);
      mutate(plan);
      const lowered = lowerAnalyticsFilteredSessionViewsPlan(asPlan(plan), {
        siteId: SITE_A,
        candidateRange: CANDIDATE_RANGE as never,
        readRange: READ_RANGE as never,
      });
      expect(lowered.kind).toBe("unsupported");
      if (lowered.kind === "supported") {
        throw new Error("A mutated views plan unexpectedly produced SQL.");
      }
      expect(lowered.node.length).toBeGreaterThan(0);
      expect(lowered.reason.length).toBeGreaterThan(0);
    }
  });

  it("matches one unambiguous legacy Overview views example", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA, addPage } = createFixture(db);
      addPage(siteA, "legacy-match", "s-legacy", 110, "/legacy-match");
      addPage(siteA, "legacy-other-page", "s-legacy", 120, "/else");
      const filter = document(condition("page.path", "/legacy-match"));
      const candidateAndRead = CANDIDATE_RANGE;
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace));
      const newResult = await executeViewsQuery(db, client, trace, filter, 2, {
        candidateRange: candidateAndRead,
        readRange: candidateAndRead,
      });
      const legacy = await queryOverviewFromD1(
        { DB: createSqliteD1Database(db) } as never,
        SITE_A,
        {
          startMs: candidateAndRead.startMs,
          endExclusiveMs: candidateAndRead.endExclusiveMs,
          nowMs: candidateAndRead.endExclusiveMs,
          timeZone: "UTC",
        },
        filter,
      );
      expect(newResult.query.tag).toBe(
        "analytics.filtered-session-views.wave-4",
      );
      expect(legacy.views).toBe(2);
      // The common positive case shares a window. Legacy overview selects
      // matching visits in that window, while Wave 4 selects a Session from
      // read evidence and then counts every candidate Page in that Session.
    } finally {
      db.close();
    }
  });
});

describe("formal sessions + views overview pair plan", () => {
  it("lowers both metrics from the formal shared-Session plan in one D1 query", async () => {
    const db = createMigratedDatabase();
    try {
      const fixture = createFixture(db);
      const { siteA, siteB, evaluation, addPage, addEvent } = fixture;

      const andOwner = addPage(
        siteA,
        "pair-and-owner",
        "pair-and",
        300,
        "/owner",
      );
      addPage(siteA, "pair-and-history", "pair-and", 10, "/match");
      addEvent(siteA, "pair-and-event-a", andOwner, 30, "signup");
      addEvent(siteA, "pair-and-event-b", andOwner, 31, "signup");
      addPage(siteA, "pair-and-candidate-a", "pair-and", 100, "/other");
      addPage(siteA, "pair-and-candidate-b", "pair-and", 199, "/other");
      addPage(siteA, "pair-and-end-excluded", "pair-and", 200, "/other");

      addPage(
        siteA,
        "pair-event-only-history",
        "pair-event-only",
        12,
        "/event-only",
      );
      const eventOnlyOwner = addPage(
        siteA,
        "pair-event-only-owner",
        "pair-event-only",
        320,
        "/owner",
      );
      addEvent(
        siteA,
        "pair-event-only-candidate",
        eventOnlyOwner,
        130,
        "other",
      );

      addPage(siteA, "pair-history-only", "pair-history-only", 15, "/match");
      addEvent(
        siteA,
        "pair-history-only-event",
        addPage(
          siteA,
          "pair-history-only-owner",
          "pair-history-only",
          16,
          "/owner",
        ),
        20,
        "signup",
      );

      const readStart = addPage(
        siteA,
        "pair-read-start",
        "pair-read-start",
        0,
        "/read-start",
      );
      addEvent(siteA, "pair-read-start-event", readStart, 0, "signup");
      addPage(
        siteA,
        "pair-read-start-candidate",
        "pair-read-start",
        150,
        "/other",
      );
      const readEnd = addPage(
        siteA,
        "pair-read-end-owner",
        "pair-read-end",
        300,
        "/owner",
      );
      addEvent(siteA, "pair-read-end-event", readEnd, 100, "signup");
      addPage(siteA, "pair-read-end-candidate", "pair-read-end", 151, "/other");

      const siteBOwner = addPage(
        siteB,
        "pair-site-b-owner",
        "pair-shared-id",
        10,
        "/match",
      );
      addEvent(siteB, "pair-site-b-event", siteBOwner, 20, "signup");
      addPage(siteB, "pair-site-b-candidate", "pair-shared-id", 120, "/other");
      addPage(siteA, "pair-site-a-candidate", "pair-shared-id", 121, "/other");

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace));
      const pairPlan = buildSemanticOverviewPairPlan(AND_FILTER);
      const aggregateNodes = pairPlan.nodes.filter(
        (node) => node.kind === "aggregate",
      );
      const pairJoin = pairPlan.nodes.find((node) => node.kind === "join");
      const pageSource = pairPlan.nodes.find(
        (node) => node.kind === "source" && node.entity === "page",
      );
      const pageMembership = pairPlan.nodes.find(
        (node) => node.kind === "semi-join" && node.left === pageSource?.id,
      );
      expect(aggregateNodes).toHaveLength(2);
      expect(
        aggregateNodes.every(
          (node) =>
            node.kind === "aggregate" &&
            node.groups.length === 0 &&
            node.measures.length === 1 &&
            node.measures[0]!.kind === "count-rows",
        ),
      ).toBe(true);
      expect(pairJoin).toMatchObject({
        kind: "join",
        joinType: "inner",
        keys: [],
      });
      const sessionBranch = aggregateNodes.find(
        (node) =>
          node.kind === "aggregate" &&
          pairPlan.nodes.find((candidate) => candidate.id === node.input)
            ?.kind === "set-operation",
      );
      const viewsBranch = aggregateNodes.find(
        (node) =>
          node.kind === "aggregate" &&
          pairPlan.nodes.find((candidate) => candidate.id === node.input)
            ?.kind === "semi-join",
      );
      expect(sessionBranch).toBeDefined();
      expect(viewsBranch).toBeDefined();
      expect(pageMembership).toMatchObject({
        kind: "semi-join",
        left: pageSource?.id,
        right: sessionBranch?.input,
      });
      expect(viewsBranch?.input).toBe(pageMembership?.id);

      const scenarios = [
        ...TWO_LEAF_BOOLEAN_FILTERS,
        {
          label: "Event-only candidate",
          filters: document(condition("page.path", "/event-only")),
        },
        { label: "NOT event.name", filters: NOT_EVENT_FILTER },
        {
          label: "read start boundary",
          filters: document(condition("page.path", "/read-start")),
        },
        {
          label: "read end boundary",
          filters: document(condition("event.name", "signup")),
        },
        {
          label: "empty match",
          filters: document(condition("page.path", "/never-seen")),
        },
      ];
      const expectedSupportedLabels = [
        "two-leaf AND",
        "two-leaf OR",
        "NOT(two-leaf AND)",
        "NOT(two-leaf OR)",
        "AND(NOT page.path, event.name)",
        "Event-only candidate",
        "NOT event.name",
        "read start boundary",
        "read end boundary",
        "empty match",
      ];
      const expectedBudgetRejectedLabels: string[] = [];
      const measuredCosts: Array<{
        readonly label: string;
        readonly query: {
          readonly sql: string;
          readonly bindings?: readonly unknown[];
        };
        readonly explain: readonly string[];
        readonly sqlBytes: number;
      }> = [];
      const budgetRejections: Array<{
        readonly label: string;
        readonly reason: string;
      }> = [];
      for (const scenario of scenarios) {
        const { filters } = scenario;
        const expected = expectedOverviewPair(filters, evaluation);
        const beforePrepare = trace.preparedSql.length;
        const budgetCheck = lowerAnalyticsFilteredSessionOverviewPairPlan(
          buildSemanticOverviewPairPlan(filters),
          {
            siteId: SITE_A,
            candidateRange: CANDIDATE_RANGE,
            readRange: READ_RANGE,
          } as never,
        );
        if (budgetCheck.kind !== "supported") {
          expect(expectedBudgetRejectedLabels).toContain(scenario.label);
          expect(budgetCheck.capability).toBe("d1-query-budget-exceeded");
          expect(budgetCheck.node).toBe("compiled-query");
          expect(budgetCheck.reason).toMatch(/limit 100000|limit 100/iu);
          expect(trace.preparedSql).toHaveLength(beforePrepare);
          budgetRejections.push({
            label: scenario.label,
            reason: budgetCheck.reason,
          });
          continue;
        }
        expect(expectedSupportedLabels).toContain(scenario.label);
        const executed = await executeOverviewPairQuery(
          db,
          client,
          trace,
          filters,
          expected,
        );
        expect(executed.query.tag).toBe(
          "analytics.filtered-session-overview-pair.wave-5",
        );
        expect(executed.query.sql).toMatch(/COUNT\s*\(\s*\*\s*\)/iu);
        measuredCosts.push({ label: scenario.label, ...executed });
        if (scenario.label === "Event-only candidate") {
          expect(expected).toEqual({ sessions: 1, views: 0 });
        }
      }
      expect(measuredCosts.length + budgetRejections.length).toBe(
        scenarios.length,
      );
      expect(measuredCosts.map((cost) => cost.label).sort()).toEqual(
        expectedSupportedLabels.sort(),
      );
      expect(budgetRejections.map((cost) => cost.label).sort()).toEqual(
        expectedBudgetRejectedLabels.sort(),
      );
      const maxSqlCost = measuredCosts.reduce((maximum, cost) =>
        cost.sqlBytes > maximum.sqlBytes ? cost : maximum,
      );
      const maxBindingCost = measuredCosts.reduce((maximum, cost) =>
        (cost.query.bindings?.length ?? 0) >
        (maximum.query.bindings?.length ?? 0)
          ? cost
          : maximum,
      );
      const countPlanLines = (
        cost: (typeof measuredCosts)[number],
        pattern: RegExp,
      ) => cost.explain.filter((line) => pattern.test(line)).length;
      {
        const visitScans = maxSqlCost.explain.filter(
          (line) => line.startsWith("SCAN ") && line.includes("idx_visits_"),
        );
        const eventScans = maxSqlCost.explain.filter(
          (line) =>
            line.startsWith("SCAN ") && line.includes("idx_custom_events_"),
        );
        const indexedEventLookups = maxSqlCost.explain.filter(
          (line) =>
            line.startsWith("SEARCH ") && line.includes("idx_custom_events_"),
        );
        console.info(
          "Wave 6 optimized D1 cost",
          JSON.stringify({
            baselineWave5: [
              { filter: "two-leaf AND", sqlBytes: 79_011, bindings: 58 },
              { filter: "two-leaf OR", sqlBytes: 78_939, bindings: 58 },
              {
                filter: "NOT(two-leaf AND)",
                sqlBytes: 102_612,
                bindings: 74,
                disposition: "over SQL budget",
              },
              {
                filter: "NOT(two-leaf OR)",
                sqlBytes: 102_540,
                bindings: 74,
                disposition: "over SQL budget",
              },
              {
                filter: "AND(NOT page.path, event.name)",
                sqlBytes: 102_588,
                bindings: 74,
                disposition: "over SQL budget",
              },
            ],
            testedShapes: measuredCosts.map((cost) => ({
              filter: cost.label,
              disposition: "supported",
              sqlBytes: cost.sqlBytes,
              bindings: cost.query.bindings?.length ?? 0,
              statements: 1,
              sharedCteDefinitions: (
                cost.query.sql.match(/"_d1_shared_\d+" AS \(/gu) ?? []
              ).length,
              explainScans: {
                visitsCovering: countPlanLines(
                  cost,
                  /^SCAN .*USING COVERING INDEX idx_visits_/u,
                ),
                customEventsCovering: countPlanLines(
                  cost,
                  /^SCAN .*USING COVERING INDEX idx_custom_events_/u,
                ),
                customEventsIndexedLookups: countPlanLines(
                  cost,
                  /^SEARCH .*USING .*INDEX idx_custom_events_/u,
                ),
              },
            })),
            rejectedOverBudgetShapes: budgetRejections,
            maximumMeasuredSupportedShape: {
              sql: {
                filter: maxSqlCost.label,
                bytes: maxSqlCost.sqlBytes,
                remainingBytes: D1_MAX_SQL_UTF8_BYTES - maxSqlCost.sqlBytes,
              },
              bindings: {
                filter: maxBindingCost.label,
                count: maxBindingCost.query.bindings?.length ?? 0,
                remaining:
                  D1_MAX_BOUND_PARAMETERS -
                  (maxBindingCost.query.bindings?.length ?? 0),
              },
            },
            explain: {
              visitsIndexedScans: visitScans.length,
              customEventsIndexedScans: eventScans.length,
              customEventsIndexedLookups: indexedEventLookups.length,
              repeatedScanEvidence: [...visitScans, ...eventScans],
              temporaryStructures: maxSqlCost.explain.filter(
                (line) =>
                  line.includes("TEMP B-TREE") || line.includes("AUTOMATIC"),
              ),
            },
          }),
        );
      }
      expect(trace.preparedSql).toHaveLength(measuredCosts.length);
    } finally {
      db.close();
    }
  });

  it("rejects altered metric branches, scalar Join, Page membership, output, scope, and authorized context", () => {
    const original = buildSemanticOverviewPairPlan(AND_FILTER);
    const expectedContext = {
      siteId: SITE_A,
      candidateRange: CANDIDATE_RANGE,
      readRange: READ_RANGE,
    };
    const mutations: Array<(plan: MutablePlanForTest) => void> = [
      (plan) => {
        const aggregate = plan.nodes.find((node) => node.kind === "aggregate");
        const measures = aggregate?.measures as Array<Record<string, unknown>>;
        measures[0]!.kind = "sum";
      },
      (plan) => {
        const aggregate = plan.nodes.find(
          (node) =>
            node.kind === "aggregate" &&
            plan.nodes.find((candidate) => candidate.id === node.input)
              ?.kind === "semi-join",
        );
        const source = plan.nodes.find(
          (node) => node.kind === "source" && node.entity === "page",
        );
        aggregate!.input = source!.id;
      },
      (plan) => {
        const join = plan.nodes.find((node) => node.kind === "join")!;
        join.joinType = "left";
      },
      (plan) => {
        const join = plan.nodes.find((node) => node.kind === "join")!;
        const sessions = plan.nodes.find(
          (node) =>
            node.kind === "aggregate" &&
            plan.nodes.find((candidate) => candidate.id === node.input)
              ?.kind === "set-operation",
        )!;
        const views = plan.nodes.find(
          (node) =>
            node.kind === "aggregate" &&
            plan.nodes.find((candidate) => candidate.id === node.input)
              ?.kind === "semi-join",
        )!;
        const sessionOutput = (sessions.output as unknown[])[0];
        const viewOutput = (views.output as unknown[])[0];
        join.keys = [{ left: sessionOutput, right: viewOutput }];
      },
      (plan) => {
        const outputRelation = plan.nodes.find(
          (node) => node.id === plan.outputs[0]!.relation,
        )!;
        const projections = outputRelation.projections as Array<
          Record<string, unknown>
        >;
        const second = projections[1]!.expression as Record<string, unknown>;
        const first = projections[0]!.expression as Record<string, unknown>;
        second.slot = first.slot;
      },
      (plan) => {
        const semantic = plan.outputs[0]!.fields[1]!.semantic as Record<
          string,
          unknown
        >;
        semantic.id = "sessions";
      },
      (plan) => {
        const source = plan.nodes.find(
          (node) => node.kind === "source" && node.entity === "page",
        )!;
        source.temporalDomain = "read";
      },
      (plan) => {
        const membership = plan.nodes.find(
          (node) => node.kind === "semi-join",
        )!;
        membership.kind = "anti-join";
      },
      (plan) => {
        const subject = plan.context.subject as Record<string, unknown>;
        subject.siteIds = [SITE_B];
      },
      (plan) => {
        const time = plan.context.time as Record<string, unknown>;
        time.candidate = { startMs: 101, endExclusiveMs: 200 };
      },
      (plan) => {
        const time = plan.context.time as Record<string, unknown>;
        time.read = {
          kind: "bounded",
          range: { startMs: 1, endExclusiveMs: 100 },
        };
      },
    ];
    for (const mutate of mutations) {
      const plan = mutablePlan(original);
      mutate(plan);
      const lowered = lowerAnalyticsFilteredSessionOverviewPairPlan(
        asPlan(plan),
        expectedContext as never,
      );
      expect(lowered.kind).toBe("unsupported");
      if (lowered.kind === "supported") {
        throw new Error("A mutated pair plan unexpectedly produced SQL.");
      }
      expect(lowered.node.length).toBeGreaterThan(0);
      expect(lowered.reason.length).toBeGreaterThan(0);
    }
    for (const wrongContext of [
      { ...expectedContext, siteId: SITE_B },
      {
        ...expectedContext,
        candidateRange: { startMs: 101, endExclusiveMs: 200 },
      },
      { ...expectedContext, readRange: { startMs: 1, endExclusiveMs: 100 } },
    ]) {
      const lowered = lowerAnalyticsFilteredSessionOverviewPairPlan(
        original,
        wrongContext as never,
      );
      expect(lowered.kind).toBe("unsupported");
    }
  });

  it("matches the legacy Overview pair on one common positive fixture", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA, addPage } = createFixture(db);
      addPage(siteA, "pair-legacy-match", "pair-legacy", 110, "/legacy-match");
      addPage(siteA, "pair-legacy-other", "pair-legacy", 120, "/else");
      const filter = document(condition("page.path", "/legacy-match"));
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace));
      const semanticResult = await executeOverviewPairQuery(
        db,
        client,
        trace,
        filter,
        { sessions: 1, views: 2 },
        { candidateRange: CANDIDATE_RANGE, readRange: CANDIDATE_RANGE },
      );
      const legacy = await queryOverviewFromD1(
        { DB: createSqliteD1Database(db) } as never,
        SITE_A,
        {
          startMs: CANDIDATE_RANGE.startMs,
          endExclusiveMs: CANDIDATE_RANGE.endExclusiveMs,
          nowMs: CANDIDATE_RANGE.endExclusiveMs,
          timeZone: "UTC",
        },
        filter,
      );
      expect(semanticResult.query.tag).toBe(
        "analytics.filtered-session-overview-pair.wave-5",
      );
      expect(legacy.sessions).toBe(1);
      expect(legacy.views).toBe(2);
      expect(trace.preparedSql).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
