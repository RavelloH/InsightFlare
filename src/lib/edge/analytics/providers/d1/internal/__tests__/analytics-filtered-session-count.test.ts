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
import { lowerAnalyticsFilteredSessionCountPlan } from "@/lib/edge/analytics/providers/d1/internal/analytics-page-session-lowering";
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

const CANDIDATE_RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const READ_RANGE = { startMs: 0, endExclusiveMs: 100 } as const;
const SITE_A = "site-a";
const SITE_B = "site-b";

function condition(field: string, value: string) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator: "eq",
    value,
  } as const;
}

function inCondition(field: string, values: readonly string[]) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator: "in",
    value: values,
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

function buildSemanticSessionsPlan(
  filters: FilterDocument,
  options: {
    readonly siteId?: string;
    readonly candidateRange?: {
      readonly startMs: number;
      readonly endExclusiveMs: number;
    };
    readonly readRange?: {
      readonly startMs: number;
      readonly endExclusiveMs: number;
    };
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
    throw new Error(
      `Expected a supported Session filter, received ${lowered.kind}.`,
    );
  }

  const dataset = new LazyEligibleDataset({
    subject: context.subject,
    scope: {
      kind: "matching",
      target: "session",
      relation: lowered.selection.relation,
      entitySlotName: "entity",
    },
    resolveRelation(entity) {
      return entity === "session"
        ? lowered.selection.relation
        : builder.source(entity);
    },
    resolveAssociation() {
      throw new Error("An ungrouped sessions count does not use associations.");
    },
  });
  return planSemanticAggregateQuery(
    builder,
    { context, dimensions: [], metrics: ["sessions"], sort: [] },
    dataset,
  );
}

interface SiteSeed {
  readonly id: string;
  readonly key: number;
  readonly signupEventNameId: number;
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
  readonly name: "signup" | "other";
}

function setupSite(db: DatabaseSync, id: string): SiteSeed {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const identity = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  const insertName = db.prepare(
    "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
  );
  insertName.run(id, "signup", 1, identity.site_pk);
  insertName.run(id, "other", 1, identity.site_pk);
  const signup = db
    .prepare(
      "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'signup'",
    )
    .get(identity.site_pk) as { readonly id: number };
  return { id, key: identity.site_pk, signupEventNameId: signup.id };
}

function addPage(
  db: DatabaseSync,
  site: SiteSeed,
  visitId: string,
  sessionId: string,
  startedAt: number,
  pathname: string,
): PageSeed {
  const page = { visitId, site, sessionId, startedAt, pathname };
  db.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, site_pk
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, 'example.test', ?)`,
  ).run(
    visitId,
    site.id,
    `visitor-${visitId}`,
    sessionId,
    startedAt,
    startedAt,
    pathname,
    site.key,
  );
  return page;
}

function addEvent(
  db: DatabaseSync,
  event: Omit<EventSeed, "name"> & { readonly name: EventSeed["name"] },
): void {
  const eventNameId =
    event.name === "signup"
      ? event.site.signupEventNameId
      : (
          db
            .prepare(
              "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'other'",
            )
            .get(event.site.key) as { readonly id: number }
        ).id;
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
    eventNameId,
    event.occurredAt,
    event.occurredAt,
  );
}

function asPageEntity(page: PageSeed): FilterEvaluationEntity {
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

function asEventEntity(event: EventSeed): FilterEvaluationEntity {
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

function candidateRestrictedEvaluatorSet(
  filters: FilterDocument,
  dataset: {
    readonly pages: readonly FilterEvaluationEntity[];
    readonly events: readonly FilterEvaluationEntity[];
  },
): ReadonlySet<string> {
  const candidateIds = new Set(
    [...dataset.pages, ...dataset.events]
      .filter(
        (entity) =>
          entity.time !== undefined &&
          entity.time >= CANDIDATE_RANGE.startMs &&
          entity.time < CANDIDATE_RANGE.endExclusiveMs,
      )
      .map((entity) => entity.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
  const evaluate = (expression: unknown): Set<string> => {
    if (!expression || typeof expression !== "object") {
      throw new Error("Expected a normalized filter expression.");
    }
    const node = expression as Record<string, unknown>;
    if (node.kind === "condition") {
      const matches = evaluateFilterDocument(
        document(node),
        { ...dataset, coverageRange: { startMs: 0, endExclusiveMs: 200 } },
        {
          scope: "session",
          candidateRange: CANDIDATE_RANGE,
          filterRange: READ_RANGE,
          readRange: READ_RANGE,
          reportingTimeZone: "UTC",
          capturedAtMs: 200,
        },
      ).matchingScopeEntityIds;
      return new Set([...matches].filter((id) => candidateIds.has(id)));
    }
    if (node.kind === "not") {
      const child = evaluate(node.child);
      return new Set([...candidateIds].filter((id) => !child.has(id)));
    }
    if (node.kind === "and" || node.kind === "or") {
      if (!Array.isArray(node.children)) {
        throw new Error("Expected Boolean child expressions.");
      }
      const children = node.children.map(evaluate);
      if (node.kind === "and") {
        return new Set(
          [...(children[0] ?? [])].filter((id) =>
            children.slice(1).every((child) => child.has(id)),
          ),
        );
      }
      return new Set(children.flatMap((child) => [...child]));
    }
    throw new Error(`Unsupported test expression '${String(node.kind)}'.`);
  };
  return evaluate(filters.root);
}

function mutablePlan(plan: LogicalPlan): {
  readonly nodes: Array<Record<string, unknown>>;
  readonly outputs: Array<{
    readonly relation: number;
    readonly fields: Array<Record<string, unknown>>;
  }>;
  readonly context: Record<string, unknown>;
} {
  return structuredClone(plan) as unknown as ReturnType<typeof mutablePlan>;
}

function asPlan(plan: ReturnType<typeof mutablePlan>): LogicalPlan {
  return plan as unknown as LogicalPlan;
}

describe("semantic sessions aggregate → filtered Session D1 count", () => {
  it("executes AND and candidate-relative NOT as one query with evaluator parity", async () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const siteA = setupSite(db, SITE_A);
      const siteB = setupSite(db, SITE_B);
      const pages: FilterEvaluationEntity[] = [];
      const events: FilterEvaluationEntity[] = [];
      const page = (
        site: SiteSeed,
        visitId: string,
        sessionId: string,
        time: number,
        pathname: string,
      ) => {
        const row = addPage(db, site, visitId, sessionId, time, pathname);
        if (site.id === SITE_A) pages.push(asPageEntity(row));
        return row;
      };
      const event = (
        site: SiteSeed,
        eventId: string,
        owner: PageSeed,
        time: number,
        name: EventSeed["name"] = "signup",
      ) => {
        const row = { eventId, site, visit: owner, occurredAt: time, name };
        addEvent(db, row);
        if (site.id === SITE_A) events.push(asEventEntity(row));
      };

      const bothHistory = page(
        siteA,
        "and-page-history",
        "s-and",
        10,
        "/match",
      );
      page(siteA, "and-duplicate-history", "s-and", 15, "/else");
      event(siteA, "and-event-history", bothHistory, 20);
      page(siteA, "and-candidate", "s-and", 110, "/candidate");

      const eventCandidateOwner = page(
        siteA,
        "event-only-history",
        "s-event-candidate",
        25,
        "/match",
      );
      event(siteA, "event-only-history-event", eventCandidateOwner, 30);
      const candidateEventOwnerOutsideWindows = page(
        siteA,
        "candidate-event-owner-outside-windows",
        "s-event-candidate",
        300,
        "/ignored",
      );
      event(
        siteA,
        "event-only-candidate",
        candidateEventOwnerOutsideWindows,
        120,
      );

      page(siteA, "page-only-history", "s-page-only", 35, "/match");
      page(siteA, "page-only-candidate", "s-page-only", 130, "/candidate");

      const eventOnly = page(
        siteA,
        "event-only-page",
        "s-no-page",
        40,
        "/else",
      );
      event(siteA, "event-only-read", eventOnly, 45);
      event(siteA, "event-only-candidate-row", eventOnly, 140);

      const noCandidate = page(
        siteA,
        "no-candidate-history",
        "s-no-candidate",
        50,
        "/match",
      );
      event(siteA, "no-candidate-event", noCandidate, 55);

      const boundaryHistory = page(
        siteA,
        "boundary-history",
        "s-event-at-candidate-start",
        60,
        "/match",
      );
      event(siteA, "event-at-candidate-start", boundaryHistory, 100);
      page(siteA, "candidate-before-end", "s-before-end", 199, "/candidate");
      const endHistory = page(
        siteA,
        "end-history",
        "s-end-excluded",
        65,
        "/match",
      );
      event(siteA, "end-history-event", endHistory, 70);
      page(siteA, "candidate-at-end", "s-end-excluded", 200, "/candidate");

      const otherSiteHistory = page(
        siteB,
        "site-b-history",
        "s-and",
        10,
        "/match",
      );
      event(siteB, "site-b-event", otherSiteHistory, 20);
      page(siteB, "site-b-candidate", "s-and", 110, "/candidate");

      const evaluatorDataset = { pages, events };
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace));
      const assertCount = async (
        filters: FilterDocument,
        expectedSessions: ReadonlySet<string>,
      ) => {
        const semanticPlan = buildSemanticSessionsPlan(filters);
        const lowered = lowerAnalyticsFilteredSessionCountPlan(semanticPlan);
        expect(lowered.kind).toBe("supported");
        if (lowered.kind !== "supported") {
          throw new Error(`Unsupported plan: ${lowered.reason}`);
        }
        const queryTraceStart = trace.preparedSql.length;
        const result = await client.all(lowered.query);
        const rows = result.results as Array<{ readonly sessions: number }>;
        expect(rows).toEqual([{ sessions: expectedSessions.size }]);
        expect(trace.preparedSql).toHaveLength(queryTraceStart + 1);
        expect(trace.bindings.at(-1)).toHaveLength(
          lowered.query.bindings?.length ?? 0,
        );
        expect(
          new TextEncoder().encode(lowered.query.sql).length,
        ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(lowered.query.bindings?.length ?? 0).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
        const explain = explainQueryPlan(db, lowered.query).join("\n");
        expect(explain).toContain("idx_visits_site_pk_started_at");
        return lowered.query;
      };

      const andExpected = candidateRestrictedEvaluatorSet(
        AND_FILTER,
        evaluatorDataset,
      );
      expect(andExpected).toEqual(new Set(["s-and", "s-event-candidate"]));
      const andQuery = await assertCount(AND_FILTER, andExpected);
      expect(andQuery.tag).toBe("analytics.filtered-session-count.wave-3");
      expect(andQuery.sql).toMatch(/COUNT\s*\(\s*\*\s*\)/iu);
      // Shared candidate Session relations keep the two-leaf shape compact.
      expect(andQuery.bindings).toHaveLength(24);
      const andExplain = explainQueryPlan(db, andQuery);
      expect(
        andExplain.some((line) =>
          /SEARCH \w+ USING INDEX idx_visits_site_pk_started_at \(site_pk=\? AND started_at>\? AND started_at<\?\)/u.test(
            line,
          ),
        ),
      ).toBe(true);
      expect(
        andExplain.some((line) =>
          /SEARCH \w+ USING INDEX idx_custom_events_site_pk_time \(site_pk=\? AND occurred_at>\? AND occurred_at<\?\)/u.test(
            line,
          ),
        ),
      ).toBe(true);

      const notExpected = candidateRestrictedEvaluatorSet(
        NOT_EVENT_FILTER,
        evaluatorDataset,
      );
      expect(notExpected).toEqual(
        new Set(["s-page-only", "s-event-at-candidate-start", "s-before-end"]),
      );
      await assertCount(NOT_EVENT_FILTER, notExpected);

      const emptyQuery = await assertCount(
        document(condition("page.path", "/not-present")),
        new Set(),
      );
      expect(emptyQuery.sql).toMatch(/COUNT\s*\(\s*\*\s*\)/iu);

      const membershipFilter = document(
        inCondition("page.path", [
          "/match",
          ...Array.from({ length: 31 }, (_, index) => `/unused-${index}`),
        ]),
      );
      const membershipExpected = candidateRestrictedEvaluatorSet(
        membershipFilter,
        evaluatorDataset,
      );
      const membershipQuery = await assertCount(
        membershipFilter,
        membershipExpected,
      );
      expect(membershipQuery.bindings?.length ?? 0).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      const eventMembershipFilter = document(
        inCondition("event.name", ["signup", "other"]),
      );
      await assertCount(
        eventMembershipFilter,
        candidateRestrictedEvaluatorSet(
          eventMembershipFilter,
          evaluatorDataset,
        ),
      );

      const mixedFilter = document({
        kind: "and",
        children: [
          inCondition("page.path", ["/match", "/event-only-history"]),
          {
            kind: "or",
            children: [
              condition("event.name", "signup"),
              condition("page.path", "/read-start"),
              condition("event.name", "other"),
            ],
          },
        ],
      });
      await assertCount(
        mixedFilter,
        candidateRestrictedEvaluatorSet(mixedFilter, evaluatorDataset),
      );

      const packedMembershipFilter = document(
        inCondition("page.path", [
          "/match",
          ...Array.from({ length: 127 }, (_, index) => `/distractor-${index}`),
        ]),
      );
      const packedMembershipExpected = candidateRestrictedEvaluatorSet(
        packedMembershipFilter,
        evaluatorDataset,
      );
      const packedMembershipQuery = await assertCount(
        packedMembershipFilter,
        packedMembershipExpected,
      );
      expect(packedMembershipQuery.sql).toContain("json_each(?)");
      expect(packedMembershipQuery.bindings?.length ?? 0).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      const notInMembershipFilter = document({
        kind: "not",
        child: inCondition("page.path", [
          "/match",
          ...Array.from({ length: 127 }, (_, index) => `/distractor-${index}`),
        ]),
      });
      const notInMembershipQuery = await assertCount(
        notInMembershipFilter,
        candidateRestrictedEvaluatorSet(
          notInMembershipFilter,
          evaluatorDataset,
        ),
      );
      expect(notInMembershipQuery.sql).toContain("json_each(?)");

      const validButUnoptimizableFilter = document({
        kind: "and",
        children: Array.from({ length: 101 }, (_, index) =>
          condition("page.path", `/native-budget-${index}`),
        ),
      });
      const beforeUnoptimizableBudget = trace.preparedSql.length;
      const unoptimizableBudget = lowerAnalyticsFilteredSessionCountPlan(
        buildSemanticSessionsPlan(validButUnoptimizableFilter),
      );
      expect(unoptimizableBudget).toMatchObject({
        kind: "unsupported",
        capability: "d1-query-budget-exceeded",
        node: "compiled-query",
        reason: expect.stringMatching(
          /^(?:SQL UTF-8 bytes|bound parameters): \d+ \(limit \d+\);/u,
        ),
      });
      expect(trace.preparedSql).toHaveLength(beforeUnoptimizableBudget);
    } finally {
      db.close();
    }
  });

  it("rejects aggregate and scope mutations before producing SQL", () => {
    const original = buildSemanticSessionsPlan(AND_FILTER);
    const mutations: Array<(plan: ReturnType<typeof mutablePlan>) => void> = [
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
        const scope = plan.context.scope as Record<string, unknown>;
        scope.requested = "visitor";
        scope.contractScope = "visitor";
        scope.logicalScope = "visitor";
      },
      (plan) => {
        const subject = plan.context.subject as Record<string, unknown>;
        subject.siteIds = [SITE_A, SITE_B];
      },
      (plan) => {
        const time = plan.context.time as Record<string, unknown>;
        time.read = { kind: "retained-history" };
      },
      (plan) => {
        const semantic = plan.outputs[0]!.fields[0]!.semantic as Record<
          string,
          unknown
        >;
        semantic.id = "visitors";
      },
    ];

    for (const mutate of mutations) {
      const plan = mutablePlan(original);
      mutate(plan);
      const lowered = lowerAnalyticsFilteredSessionCountPlan(asPlan(plan));
      expect(lowered.kind).toBe("unsupported");
      if (lowered.kind === "supported") {
        throw new Error("A mutated plan unexpectedly produced a D1 query.");
      }
      expect(lowered.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps one common positive fixture aligned with the legacy D1 sessions count", async () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const site = setupSite(db, SITE_A);
      const filters = document(condition("page.path", "/legacy-match"));
      const first = addPage(
        db,
        site,
        "legacy-one",
        "s-legacy",
        110,
        "/legacy-match",
      );
      addPage(db, site, "legacy-two", "s-legacy", 120, "/legacy-match");
      addEvent(db, {
        eventId: "legacy-event",
        site,
        visit: first,
        occurredAt: 125,
        name: "signup",
      });

      const semantic = lowerAnalyticsFilteredSessionCountPlan(
        buildSemanticSessionsPlan(filters, {
          readRange: CANDIDATE_RANGE,
        }),
      );
      expect(semantic.kind).toBe("supported");
      if (semantic.kind !== "supported")
        throw new Error("Expected Wave 3 support.");
      const client = createD1DatabaseClient(createSqliteD1Database(db));
      const semanticResult = await client.all(semantic.query);
      const row = await queryOverviewFromD1(
        { DB: createSqliteD1Database(db) } as never,
        SITE_A,
        {
          startMs: CANDIDATE_RANGE.startMs,
          endExclusiveMs: CANDIDATE_RANGE.endExclusiveMs,
          nowMs: CANDIDATE_RANGE.endExclusiveMs,
          timeZone: "UTC",
        },
        filters,
      );

      expect(semanticResult.results).toEqual([{ sessions: 1 }]);
      expect(row.sessions).toBe(1);
      // This is one shared positive case. Legacy overview selects matching
      // visits inside its query window and counts session_id values. Wave 3
      // separates read evidence from candidate membership and derives a
      // composite site_pk/session_id set from page and event occurrence times.
    } finally {
      db.close();
    }
  });
});
