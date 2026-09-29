import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createD1DatabaseClient } from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { LogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  type AnalyticsPageSessionLoweringInput,
  lowerAnalyticsPagePathSessionPlan,
  lowerAnalyticsPagePathToSessionQuery,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-page-session-lowering";
import {
  evaluateFilterDocument,
  type FilterEvaluationEntity,
} from "@/lib/filter-contract/filter-evaluator";
import { type FilterDocument } from "@/lib/filter-contract/filters";

const CANDIDATE_RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const READ_RANGE = { startMs: 0, endExclusiveMs: 100 } as const;
const SITE_A = "site-a";
const SITE_B = "site-b";
const DOCUMENT = {
  version: 1,
  root: {
    kind: "condition",
    target: { kind: "field", field: "page.path" },
    operator: "eq",
    value: "/pricing",
  },
} as FilterDocument;

function pathCondition(path: string) {
  return {
    kind: "condition",
    target: { kind: "field", field: "page.path" },
    operator: "eq",
    value: path,
  } as const;
}

function filterDocument(root: unknown): FilterDocument {
  return { version: 1, root } as unknown as FilterDocument;
}

const PATH_A = filterDocument(pathCondition("/a"));
const PATH_B = filterDocument(pathCondition("/b"));

interface SiteSeed {
  readonly id: string;
  readonly key: number;
  readonly eventNameId: number;
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
}

function setupSites(db: DatabaseSync): {
  readonly siteA: SiteSeed;
  readonly siteB: SiteSeed;
} {
  const insertSite = db.prepare(
    "INSERT INTO site_identities (site_id) VALUES (?)",
  );
  const insertEventName = db.prepare(
    "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
  );
  const makeSite = (id: string): SiteSeed => {
    insertSite.run(id);
    const row = db
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(id) as { site_pk: number };
    insertEventName.run(id, "activity", 1, row.site_pk);
    const name = db
      .prepare("SELECT id FROM custom_event_names WHERE site_id = ?")
      .get(id) as { id: number };
    return { id, key: row.site_pk, eventNameId: name.id };
  };
  return { siteA: makeSite(SITE_A), siteB: makeSite(SITE_B) };
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
    event.site.eventNameId,
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
    fields: {},
    payload: {},
  };
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
  insertPage(db, page);
  return page;
}

function lower(
  document: unknown = DOCUMENT,
  siteIds: readonly string[] = [SITE_A],
  candidateRange: AnalyticsPageSessionLoweringInput["candidateRange"] = CANDIDATE_RANGE as never,
  readRange: AnalyticsPageSessionLoweringInput["readRange"] = READ_RANGE as never,
) {
  return lowerAnalyticsPagePathToSessionQuery({
    document,
    siteIds: siteIds as never,
    candidateRange: candidateRange as never,
    readRange: readRange as never,
    reportingTimeZone: "UTC" as never,
    capturedAtMs: 200 as never,
  });
}

interface MutablePlanForTest {
  readonly nodes: Array<Record<string, unknown>>;
  readonly slots: Array<Record<string, unknown>>;
  readonly outputs: Array<{
    readonly relation: number;
    readonly fields: Array<Record<string, unknown>>;
  }>;
}

function mutablePlan(plan: LogicalPlan): MutablePlanForTest {
  return structuredClone(plan) as unknown as MutablePlanForTest;
}

function asLogicalPlan(plan: MutablePlanForTest): LogicalPlan {
  return plan as unknown as LogicalPlan;
}

function evaluateCandidateRestrictedSets(
  expression: unknown,
  dataset: {
    readonly pages: readonly FilterEvaluationEntity[];
    readonly events: readonly FilterEvaluationEntity[];
    readonly coverageRange: {
      readonly startMs: number;
      readonly endExclusiveMs: number;
    };
  },
  candidateIds: ReadonlySet<string>,
): ReadonlySet<string> {
  // With an explicit filterRange, Filter Evaluator enumerates Sessions from
  // the filter evidence. Wave 1 defines NOT over the bounded candidate set,
  // so evaluate each leaf first and apply Boolean set algebra to that universe.
  const evaluate = (input: unknown): Set<string> => {
    if (!input || typeof input !== "object") {
      throw new Error("Expected a normalized page.path expression.");
    }
    const node = input as Record<string, unknown>;
    if (node.kind === "condition") {
      const leafMatches = evaluateFilterDocument(
        filterDocument(node),
        dataset,
        {
          scope: "session",
          candidateRange: CANDIDATE_RANGE,
          filterRange: READ_RANGE,
          readRange: READ_RANGE,
          reportingTimeZone: "UTC",
          capturedAtMs: 200,
        },
      ).matchingScopeEntityIds;
      return new Set([...leafMatches].filter((id) => candidateIds.has(id)));
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
  return evaluate(expression);
}

describe("Analytics page.path → Session D1 lowering", () => {
  it("executes the verified slice as one composite-key D1 query", async () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const { siteA, siteB } = setupSites(db);
      const evaluatorPages: FilterEvaluationEntity[] = [];
      const evaluatorEvents: FilterEvaluationEntity[] = [];
      const page = (
        site: SiteSeed,
        visitId: string,
        sessionId: string,
        startedAt: number,
        pathname: string,
      ) => {
        const row = addPage(db, site, visitId, sessionId, startedAt, pathname);
        if (site.id === SITE_A && sessionId !== "") {
          evaluatorPages.push(pageEntity(row));
        }
        return row;
      };
      const event = (
        eventId: string,
        site: SiteSeed,
        owner: PageSeed,
        occurredAt: number,
      ) => {
        const row = { eventId, site, visit: owner, occurredAt };
        insertEvent(db, row);
        // The evaluator has no site-key dimension; keep its parity fixture to
        // observations whose persisted owner relation is site-consistent.
        if (site.id === SITE_A && owner.site.key === site.key) {
          evaluatorEvents.push(eventEntity(row));
        }
      };

      const good = page(siteA, "good-history", "s-good", 0, "/pricing");
      event("good-candidate-event", siteA, good, 100);
      page(siteA, "history-only", "s-history-only", 10, "/pricing");
      page(siteA, "both-history-1", "s-page-event", 11, "/pricing");
      page(siteA, "both-history-2", "s-page-event", 12, "/pricing");
      const bothCandidate = page(
        siteA,
        "both-candidate-page",
        "s-page-event",
        100,
        "/other",
      );
      event("both-candidate-event", siteA, bothCandidate, 199);

      page(siteA, "start-history", "s-start-page", 0, "/pricing");
      page(siteA, "start-candidate", "s-start-page", 100, "/else");

      const eventEndHistory = page(
        siteA,
        "event-end-history",
        "s-event-end",
        30,
        "/pricing",
      );
      event("candidate-event-at-end", siteA, eventEndHistory, 200);

      page(siteA, "page-end-history", "s-page-end", 31, "/pricing");
      page(siteA, "candidate-page-at-end", "s-page-end", 200, "/other");

      page(siteA, "read-end-history", "s-read-end", 100, "/pricing");
      page(siteA, "read-end-candidate", "s-read-end", 110, "/other");

      const whitespaceCodes = [
        0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000,
        0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
        0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
      ];
      whitespaceCodes.forEach((codePoint, index) => {
        const character = String.fromCodePoint(codePoint);
        const sessionId = `s-whitespace-${index}`;
        const history = page(
          siteA,
          `whitespace-history-${index}`,
          sessionId,
          40 + index,
          `${character}/pricing${character}`,
        );
        event(`whitespace-event-${index}`, siteA, history, 100 + index);
      });

      const wrongCase = page(siteA, "case-history", "s-case", 70, "/Pricing");
      event("case-candidate-event", siteA, wrongCase, 170);

      page(siteB, "site-b-shared-history", "s-shared", 71, "/pricing");
      const siteASharedOwner = page(
        siteA,
        "site-a-shared-owner",
        "s-shared",
        72,
        "/other",
      );
      event("site-a-shared-candidate", siteA, siteASharedOwner, 171);

      page(siteA, "site-a-corrupt-history", "s-bad-owner", 73, "/pricing");
      const siteBCorruptOwner = page(
        siteB,
        "site-b-corrupt-owner",
        "s-bad-owner",
        74,
        "/other",
      );
      event("site-a-event-to-site-b-owner", siteA, siteBCorruptOwner, 172);

      const emptyHistory = page(siteA, "empty-history", "", 75, "/pricing");
      page(siteA, "empty-candidate", "", 150, "/other");
      event("empty-session-event", siteA, emptyHistory, 151);

      const lowered = lower();
      expect(lowered.kind).toBe("supported");
      if (lowered.kind !== "supported") {
        throw new Error("Expected the page.path slice to be supported.");
      }
      const planLowered = lowerAnalyticsPagePathSessionPlan(
        lowered.logicalPlan,
      );
      expect(planLowered.kind).toBe("supported");
      if (planLowered.kind !== "supported") {
        throw new Error("Expected the validated plan to lower directly.");
      }
      expect(planLowered.query.sql).toBe(lowered.query.sql);
      expect(planLowered.query.bindings).toEqual(lowered.query.bindings);
      expect(lowered.logicalPlan.context.scope.logicalScope).toBe("session");
      expect(lowered.logicalPlan.context.subject.siteIds).toEqual([SITE_A]);

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace));
      const result = await client.all(lowered.query);
      const actualRows = result.results as Array<{
        site_pk: number;
        session_id: string;
      }>;
      const actualSessions = new Set(actualRows.map((row) => row.session_id));
      const evaluated = evaluateFilterDocument(
        DOCUMENT,
        {
          pages: evaluatorPages,
          events: evaluatorEvents,
          coverageRange: { startMs: 0, endExclusiveMs: 250 },
        },
        {
          scope: "session",
          candidateRange: CANDIDATE_RANGE,
          filterRange: READ_RANGE,
          readRange: READ_RANGE,
          reportingTimeZone: "UTC",
          capturedAtMs: 200,
        },
      );
      const candidateSessionIds = new Set(
        [
          ...evaluatorPages
            .filter(
              (entity) =>
                entity.time !== undefined &&
                entity.time >= CANDIDATE_RANGE.startMs &&
                entity.time < CANDIDATE_RANGE.endExclusiveMs,
            )
            .map((entity) => entity.sessionId),
          ...evaluatorEvents
            .filter(
              (entity) =>
                entity.time !== undefined &&
                entity.time >= CANDIDATE_RANGE.startMs &&
                entity.time < CANDIDATE_RANGE.endExclusiveMs,
            )
            .map((entity) => entity.sessionId),
        ].filter((sessionId): sessionId is string => Boolean(sessionId)),
      );
      const evaluatorCandidateSessions = new Set(
        [...evaluated.matchingScopeEntityIds].filter((sessionId) =>
          candidateSessionIds.has(sessionId),
        ),
      );

      expect(actualSessions).toEqual(evaluatorCandidateSessions);
      expect(actualRows.every((row) => row.site_pk === siteA.key)).toBe(true);
      expect(actualRows).toHaveLength(
        new Set(actualRows.map((row) => row.session_id)).size,
      );
      expect(actualSessions.has("s-good")).toBe(true);
      expect(actualSessions.has("s-history-only")).toBe(false);
      expect(actualSessions.has("s-event-end")).toBe(false);
      expect(actualSessions.has("s-page-end")).toBe(false);
      expect(actualSessions.has("s-read-end")).toBe(false);
      expect(actualSessions.has("s-case")).toBe(false);
      expect(actualSessions.has("s-shared")).toBe(false);
      expect(actualSessions.has("s-bad-owner")).toBe(false);
      expect(actualSessions.has("")).toBe(false);
      for (let index = 0; index < whitespaceCodes.length; index++) {
        expect(actualSessions.has(`s-whitespace-${index}`)).toBe(true);
      }

      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.bindings).toHaveLength(1);
      expect(trace.bindings[0]).toHaveLength(
        lowered.query.bindings?.length ?? 0,
      );
      expect(lowered.query.bindings).toHaveLength(13);
      expect(lowered.query.sql).toContain("UNION");
      expect(lowered.query.sql).toContain("TRIM(");
      expect(lowered.query.sql).toContain("EXISTS (");
      expect(lowered.query.sql).not.toMatch(/\bIN\s*\(/u);

      const plan = explainQueryPlan(db, lowered.query);
      expect(plan.length).toBeGreaterThan(0);
      const explain = plan.join("\n");
      expect(explain).toMatch(
        /SCAN \w+ USING COVERING INDEX idx_visits_site_pk_session_started_at/u,
      );
      expect(explain).toMatch(
        /SCAN \w+ USING COVERING INDEX idx_custom_events_site_pk_visit_time/u,
      );
      expect(explain).toMatch(
        /SEARCH \w+ USING INDEX idx_visits_site_pk_session_started_at \(site_pk=\? AND session_id=\? AND started_at>\? AND started_at<\?\)/u,
      );
      expect(explain).toMatch(
        /SEARCH \w+ USING INDEX sqlite_autoindex_visits_1 \(visit_id=\?\)/u,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a direct-plan union that escapes the candidate Session universe", async () => {
    const documentLowering = lower(DOCUMENT);
    expect(documentLowering.kind).toBe("supported");
    if (documentLowering.kind !== "supported") {
      throw new Error("Expected the page.path document to lower.");
    }

    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const { siteA } = setupSites(db);
      addPage(db, siteA, "history-only", "s-history-only", 10, "/pricing");

      const candidatePages = db
        .prepare(
          "SELECT COUNT(*) AS count FROM visits WHERE site_pk = ? AND started_at >= ? AND started_at < ?",
        )
        .get(
          siteA.key,
          CANDIDATE_RANGE.startMs,
          CANDIDATE_RANGE.endExclusiveMs,
        ) as {
        readonly count: number;
      };
      expect(candidatePages.count).toBe(0);
      const historyMatch = db
        .prepare(
          "SELECT COUNT(*) AS count FROM visits WHERE site_pk = ? AND started_at >= ? AND started_at < ? AND pathname = ?",
        )
        .get(
          siteA.key,
          READ_RANGE.startMs,
          READ_RANGE.endExclusiveMs,
          "/pricing",
        ) as {
        readonly count: number;
      };
      expect(historyMatch.count).toBe(1);

      const client = createD1DatabaseClient(createSqliteD1Database(db));
      const documentResult = await client.all(documentLowering.query);
      expect(documentResult.results).toEqual([]);

      const mutatedPlan = mutablePlan(documentLowering.logicalPlan);
      const rootRelation = mutatedPlan.outputs[0]!.relation;
      const root = mutatedPlan.nodes.find((node) => node.id === rootRelation);
      if (root?.kind !== "set-operation") {
        throw new Error("Expected the candidate-scoped set-operation root.");
      }
      expect(root.operation).toBe("intersect");
      root.operation = "union";

      const directPlanResult = lowerAnalyticsPagePathSessionPlan(
        asLogicalPlan(mutatedPlan),
      );
      expect(directPlanResult).toMatchObject({
        kind: "unsupported",
        capability: "session-boolean-plan-shape",
        node: `nodes[${rootRelation}]`,
        reason: expect.stringContaining("candidate Session universe"),
      });
      expect("query" in directPlanResult).toBe(false);
    } finally {
      db.close();
    }
  });

  it("lowers the supplied plan expression and rejects unsupported node or output changes", async () => {
    const base = lower();
    expect(base.kind).toBe("supported");
    if (base.kind !== "supported") {
      throw new Error("Expected the source document to build a plan.");
    }

    const changedLiteral = mutablePlan(base.logicalPlan);
    const filterNode = changedLiteral.nodes.find(
      (node) => node.kind === "filter",
    );
    const predicate = filterNode?.predicate as
      Record<string, unknown> | undefined;
    const right = predicate?.right as Record<string, unknown> | undefined;
    if (!right) throw new Error("Expected a comparison literal in the plan.");
    right.value = " \u00a0/about\t";

    const changed = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(changedLiteral),
    );
    expect(changed.kind).toBe("supported");
    if (changed.kind !== "supported") {
      throw new Error("Expected a supported page path literal change.");
    }
    expect(changed.query.bindings).toContain("/about");
    expect(changed.query.bindings).not.toContain(" \u00a0/about\t");

    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const { siteA } = setupSites(db);
      addPage(db, siteA, "about-history", "s-about", 10, "/about");
      addPage(db, siteA, "about-candidate", "s-about", 100, "/other");
      const client = createD1DatabaseClient(createSqliteD1Database(db));
      const result = await client.all(changed.query);
      expect(
        (result.results as Array<{ readonly session_id: string }>).map(
          (row) => row.session_id,
        ),
      ).toEqual(["s-about"]);
    } finally {
      db.close();
    }

    const changedDomain = mutablePlan(base.logicalPlan);
    const candidateSource = changedDomain.nodes.find(
      (node) => node.kind === "source" && node.temporalDomain === "candidate",
    );
    if (!candidateSource) {
      throw new Error("Expected the candidate Source node in the plan.");
    }
    candidateSource.temporalDomain = "read";
    const unsupportedDomain = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(changedDomain),
    );
    expect(unsupportedDomain).toMatchObject({
      kind: "unsupported",
      capability: "session-boolean-plan-shape",
      node: expect.stringContaining("temporalDomain"),
    });
    expect("query" in unsupportedDomain).toBe(false);

    const changedOutput = mutablePlan(base.logicalPlan);
    changedOutput.outputs[0]!.fields[0]!.name = "other";
    const unsupportedOutput = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(changedOutput),
    );
    expect(unsupportedOutput).toMatchObject({
      kind: "unsupported",
      capability: "session-boolean-plan-shape",
      node: "outputs",
    });
    expect("query" in unsupportedOutput).toBe(false);

    const changedExpression = mutablePlan(base.logicalPlan);
    const changedFilter = changedExpression.nodes.find(
      (node) => node.kind === "filter",
    );
    if (!changedFilter?.predicate) {
      throw new Error("Expected a Filter predicate in the plan.");
    }
    changedFilter.predicate = {
      kind: "boolean",
      operator: "and",
      terms: [changedFilter.predicate],
    };
    const unsupportedExpression = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(changedExpression),
    );
    expect(unsupportedExpression).toMatchObject({
      kind: "unsupported",
      capability: "session-boolean-plan-shape",
      node: expect.stringContaining("predicate"),
    });
    expect("query" in unsupportedExpression).toBe(false);

    const wrongSlot = mutablePlan(base.logicalPlan);
    const wrongSlotFilter = wrongSlot.nodes.find(
      (node) => node.kind === "filter",
    );
    const wrongSlotPredicate = wrongSlotFilter?.predicate as
      Record<string, unknown> | undefined;
    const wrongSlotLeft = wrongSlotPredicate?.left as
      Record<string, unknown> | undefined;
    if (typeof wrongSlotLeft?.slot !== "number") {
      throw new Error("Expected a slot reference in the Filter predicate.");
    }
    wrongSlotLeft.slot = -1;
    const unsupportedSlot = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(wrongSlot),
    );
    expect(unsupportedSlot).toMatchObject({
      kind: "unsupported",
      capability: "valid-analytics-plan-required",
      node: "plan",
    });
    expect("query" in unsupportedSlot).toBe(false);

    const unreachablePlan = mutablePlan(base.logicalPlan);
    const sourceTemplate = unreachablePlan.nodes.find(
      (node) => node.kind === "source",
    );
    const sourceValues = sourceTemplate?.values as
      Array<Record<string, unknown>> | undefined;
    const selfBinding = sourceValues?.find(
      (binding) => binding.kind === "self",
    );
    if (
      !sourceTemplate ||
      typeof selfBinding?.slot !== "number" ||
      typeof sourceTemplate.entity !== "string"
    ) {
      throw new Error("Expected a self-bound Source node to clone.");
    }
    const sourceSlot = unreachablePlan.slots.find(
      (slot) => slot.id === selfBinding.slot,
    );
    if (!sourceSlot) throw new Error("Expected the Source slot definition.");
    const orphanSlotId =
      Math.max(...unreachablePlan.slots.map((slot) => Number(slot.id))) + 1;
    const orphanRelationId =
      Math.max(...unreachablePlan.nodes.map((node) => Number(node.id))) + 1;
    unreachablePlan.slots.push({ ...sourceSlot, id: orphanSlotId });
    unreachablePlan.nodes.push({
      kind: "source",
      id: orphanRelationId,
      entity: sourceTemplate.entity,
      temporalDomain: sourceTemplate.temporalDomain,
      values: [{ kind: "self", slot: orphanSlotId }],
      output: [orphanSlotId],
      grain: {
        kind: "entity",
        entity: sourceTemplate.entity,
        key: orphanSlotId,
      },
    });
    const unsupportedUnreachable = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(unreachablePlan),
    );
    expect(unsupportedUnreachable).toMatchObject({
      kind: "unsupported",
      capability: "session-boolean-plan-shape",
      node: expect.stringContaining("nodes["),
    });
    expect("query" in unsupportedUnreachable).toBe(false);

    const invalidPlan = lowerAnalyticsPagePathSessionPlan({} as LogicalPlan);
    expect(invalidPlan).toMatchObject({
      kind: "unsupported",
      capability: "valid-analytics-plan-required",
      node: "plan",
    });
    expect("query" in invalidPlan).toBe(false);
  });

  it("executes composable Session AND/OR/NOT sets and locks D1 cost baselines", async () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const { siteA, siteB } = setupSites(db);
      const evaluatorPages: FilterEvaluationEntity[] = [];
      const evaluatorEvents: FilterEvaluationEntity[] = [];
      const page = (
        site: SiteSeed,
        visitId: string,
        sessionId: string,
        startedAt: number,
        pathname: string,
      ) => {
        const row = addPage(db, site, visitId, sessionId, startedAt, pathname);
        if (site.id === SITE_A) evaluatorPages.push(pageEntity(row));
        return row;
      };
      const event = (
        eventId: string,
        site: SiteSeed,
        owner: PageSeed,
        occurredAt: number,
      ) => {
        const row = { eventId, site, visit: owner, occurredAt };
        insertEvent(db, row);
        if (site.id === SITE_A && owner.site.key === site.key) {
          evaluatorEvents.push(eventEntity(row));
        }
      };

      // A and B are separate historical Pages in one Session. Candidate
      // membership for this Session comes from Events only.
      page(siteA, "ab-history-a", "s-ab", 10, "/a");
      page(siteA, "ab-history-b", "s-ab", 11, "/b");
      const abOwner = page(siteA, "ab-event-owner", "s-ab", 20, "/other");
      event("ab-candidate-event-1", siteA, abOwner, 100);
      event("ab-candidate-event-2", siteA, abOwner, 101);

      page(siteA, "a-history-1", "s-a", 21, "/a");
      page(siteA, "a-history-duplicate", "s-a", 22, "/a");
      const aCandidate = page(siteA, "a-candidate", "s-a", 110, "/other");
      page(siteA, "a-candidate-duplicate", "s-a", 111, "/other");
      event("a-candidate-event", siteA, aCandidate, 112);

      page(siteA, "b-history", "s-b", 23, "/b");
      page(siteA, "b-candidate", "s-b", 120, "/other");
      page(siteA, "neither-history", "s-neither", 24, "/other");
      page(siteA, "neither-candidate", "s-neither", 130, "/other");
      page(siteA, "history-only", "s-history-only", 25, "/a");
      page(siteA, "candidate-only", "s-candidate-only", 140, "/other");

      page(siteA, "trim-history", "s-trim", 26, " \u00a0/a\t");
      const trimOwner = page(siteA, "trim-event-owner", "s-trim", 27, "/other");
      event("trim-candidate-event", siteA, trimOwner, 150);
      page(siteA, "case-history", "s-case", 28, "/A");
      page(siteA, "case-candidate", "s-case", 160, "/other");

      const readEnd = page(siteA, "read-end", "s-read-end", 100, "/a");
      event("read-end-candidate-event", siteA, readEnd, 170);
      page(siteA, "candidate-end-history", "s-candidate-end", 29, "/a");
      const candidateEndOwner = page(
        siteA,
        "candidate-end-owner",
        "s-candidate-end",
        30,
        "/other",
      );
      event("candidate-event-at-end", siteA, candidateEndOwner, 200);
      page(siteA, "candidate-start-history", "s-start", 31, "/b");
      const startOwner = page(
        siteA,
        "candidate-start-owner",
        "s-start",
        32,
        "/other",
      );
      event("candidate-event-at-start", siteA, startOwner, 100);

      // The same Session string exists on another site; B there cannot satisfy
      // the site A predicate or change its NOT result.
      page(siteA, "shared-history-a", "s-shared", 33, "/a");
      page(siteA, "shared-candidate-a", "s-shared", 150, "/other");
      page(siteB, "shared-history-b", "s-shared", 34, "/b");
      page(siteB, "shared-candidate-b", "s-shared", 151, "/other");

      const documentA = PATH_A;
      const documentB = PATH_B;
      const cases = [
        {
          name: "and",
          document: filterDocument({
            kind: "and",
            children: [documentA.root, documentB.root],
          }),
          expected: ["s-ab"],
        },
        {
          name: "or",
          document: filterDocument({
            kind: "or",
            children: [documentA.root, documentB.root],
          }),
          expected: ["s-ab", "s-a", "s-b", "s-trim", "s-start", "s-shared"],
        },
        {
          name: "not",
          document: filterDocument({ kind: "not", child: documentA.root }),
          expected: [
            "s-b",
            "s-neither",
            "s-candidate-only",
            "s-case",
            "s-read-end",
            "s-start",
          ],
        },
        {
          name: "nested-and-not",
          document: filterDocument({
            kind: "and",
            children: [documentA.root, { kind: "not", child: documentB.root }],
          }),
          expected: ["s-a", "s-trim", "s-shared"],
        },
        {
          name: "or-set-operation",
          document: filterDocument({
            kind: "or",
            children: [{ kind: "not", child: documentA.root }, documentB.root],
          }),
          expected: [
            "s-ab",
            "s-b",
            "s-neither",
            "s-candidate-only",
            "s-case",
            "s-read-end",
            "s-start",
          ],
        },
      ] as const;

      const costs: Record<
        string,
        {
          readonly statements: number;
          readonly bindings: number;
          readonly sqlLength: number;
          readonly explain: {
            readonly operations: number;
            readonly candidatePageCoveringScans: number;
            readonly candidateEventCoveringScans: number;
            readonly historicalKeyRangeSearches: number;
            readonly visitPrimaryKeyLookups: number;
            readonly unionTempTrees: number;
          };
        }
      > = {};
      for (const item of cases) {
        const lowered = lower(item.document);
        expect(lowered.kind, item.name).toBe("supported");
        if (lowered.kind !== "supported") {
          throw new Error(`Expected ${item.name} to lower.`);
        }
        const directlyLowered = lowerAnalyticsPagePathSessionPlan(
          lowered.logicalPlan,
        );
        expect(directlyLowered.kind, `${item.name} direct plan`).toBe(
          "supported",
        );
        if (directlyLowered.kind !== "supported") {
          throw new Error(`Expected ${item.name} plan to lower directly.`);
        }
        expect(directlyLowered.query.sql).toBe(lowered.query.sql);
        expect(directlyLowered.query.bindings).toEqual(lowered.query.bindings);

        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const client = createD1DatabaseClient(
          createSqliteD1Database(db, trace),
        );
        const result = await client.all(lowered.query);
        const actualRows = result.results as Array<{
          readonly site_pk: number;
          readonly session_id: string;
        }>;
        const actual = new Set(actualRows.map((row) => row.session_id));
        const evaluatorDataset = {
          pages: evaluatorPages,
          events: evaluatorEvents,
          coverageRange: { startMs: 0, endExclusiveMs: 250 },
        };
        const candidateSessionIds = new Set(
          [
            ...evaluatorPages
              .filter(
                (entity) =>
                  entity.time !== undefined &&
                  entity.time >= CANDIDATE_RANGE.startMs &&
                  entity.time < CANDIDATE_RANGE.endExclusiveMs,
              )
              .map((entity) => entity.sessionId),
            ...evaluatorEvents
              .filter(
                (entity) =>
                  entity.time !== undefined &&
                  entity.time >= CANDIDATE_RANGE.startMs &&
                  entity.time < CANDIDATE_RANGE.endExclusiveMs,
              )
              .map((entity) => entity.sessionId),
          ].filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        const evaluatorSessions = evaluateCandidateRestrictedSets(
          item.document.root,
          evaluatorDataset,
          candidateSessionIds,
        );
        expect(actual).toEqual(evaluatorSessions);
        expect([...actual].sort()).toEqual([...item.expected].sort());
        expect(actualRows.every((row) => row.site_pk === siteA.key)).toBe(true);
        expect(actualRows).toHaveLength(actual.size);
        expect(trace.preparedSql).toHaveLength(1);
        expect(trace.bindings).toHaveLength(1);

        const explain = explainQueryPlan(db, lowered.query);
        const explainText = explain.join("\n");
        expect(explainText).toMatch(
          /SCAN \w+ USING COVERING INDEX idx_visits_site_pk_session_started_at/u,
        );
        expect(explainText).toMatch(
          /SCAN \w+ USING COVERING INDEX idx_custom_events_site_pk_visit_time/u,
        );
        const countExplain = (pattern: RegExp) =>
          explain.filter((line) => pattern.test(line)).length;
        costs[item.name] = {
          statements: trace.preparedSql.length,
          bindings: lowered.query.bindings?.length ?? 0,
          sqlLength: lowered.query.sql.length,
          explain: {
            operations: explain.length,
            candidatePageCoveringScans: countExplain(
              /SCAN \w+ USING COVERING INDEX idx_visits_site_pk_session_started_at/u,
            ),
            candidateEventCoveringScans: countExplain(
              /SCAN \w+ USING COVERING INDEX idx_custom_events_site_pk_visit_time/u,
            ),
            historicalKeyRangeSearches: countExplain(
              /SEARCH \w+ USING INDEX idx_visits_site_pk_session_started_at \(site_pk=\? AND session_id=\? AND started_at>\? AND started_at<\?\)/u,
            ),
            visitPrimaryKeyLookups: countExplain(
              /SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid=\?\)/u,
            ),
            unionTempTrees: countExplain(/UNION USING TEMP B-TREE/u),
          },
        };
      }
      expect(costs).toEqual({
        and: {
          statements: 1,
          bindings: 26,
          sqlLength: 32834,
          explain: {
            operations: 34,
            candidatePageCoveringScans: 2,
            candidateEventCoveringScans: 2,
            historicalKeyRangeSearches: 2,
            visitPrimaryKeyLookups: 6,
            unionTempTrees: 2,
          },
        },
        or: {
          statements: 1,
          bindings: 14,
          sqlLength: 16161,
          explain: {
            operations: 16,
            candidatePageCoveringScans: 1,
            candidateEventCoveringScans: 1,
            historicalKeyRangeSearches: 1,
            visitPrimaryKeyLookups: 3,
            unionTempTrees: 1,
          },
        },
        not: {
          statements: 1,
          bindings: 21,
          sqlLength: 27698,
          explain: {
            operations: 30,
            candidatePageCoveringScans: 2,
            candidateEventCoveringScans: 2,
            historicalKeyRangeSearches: 1,
            visitPrimaryKeyLookups: 5,
            unionTempTrees: 2,
          },
        },
        "nested-and-not": {
          statements: 1,
          bindings: 34,
          sqlLength: 44610,
          explain: {
            operations: 48,
            candidatePageCoveringScans: 3,
            candidateEventCoveringScans: 3,
            historicalKeyRangeSearches: 2,
            visitPrimaryKeyLookups: 8,
            unionTempTrees: 3,
          },
        },
        "or-set-operation": {
          statements: 1,
          bindings: 34,
          sqlLength: 44574,
          explain: {
            operations: 51,
            candidatePageCoveringScans: 3,
            candidateEventCoveringScans: 3,
            historicalKeyRangeSearches: 2,
            visitPrimaryKeyLookups: 8,
            unionTempTrees: 4,
          },
        },
      });
    } finally {
      db.close();
    }
  });

  it("rejects unsupported fields and multiple site identities before building DB SQL", () => {
    const unsupportedField = lower(
      filterDocument({
        kind: "condition",
        target: { kind: "field", field: "page.title" },
        operator: "eq",
        value: "Welcome",
      }),
    );
    expect(unsupportedField).toMatchObject({
      kind: "unsupported",
      capability: "page-path-equality-only",
    });
    expect("query" in unsupportedField).toBe(false);

    const unsupportedSites = lower(DOCUMENT, [SITE_A, SITE_B]);
    expect(unsupportedSites).toMatchObject({
      kind: "unsupported",
      capability: "single-site-only",
    });
    expect("query" in unsupportedSites).toBe(false);

    const oneChildBoolean = lower(
      filterDocument({ kind: "and", children: [PATH_A.root] }),
    );
    expect(oneChildBoolean).toMatchObject({
      kind: "unsupported",
      capability: "page-path-boolean-shape",
    });
    expect("query" in oneChildBoolean).toBe(false);
  });

  it("returns located unsupported results for empty, invalid, and unbounded inputs", () => {
    const empty = lower({ version: 1, root: null });
    expect(empty).toMatchObject({
      kind: "unsupported",
      capability: "page-path-equality-only",
      node: "empty-document",
    });
    expect("query" in empty).toBe(false);

    const invalidDocument = lower({ version: 2, root: null });
    expect(invalidDocument).toMatchObject({
      kind: "unsupported",
      capability: "valid-filter-document-required",
      node: "root",
    });
    expect("query" in invalidDocument).toBe(false);

    const invalidRange = lower(
      DOCUMENT,
      [SITE_A],
      { startMs: 200, endExclusiveMs: 100 } as never,
      READ_RANGE as never,
    );
    expect(invalidRange).toMatchObject({
      kind: "unsupported",
      capability: "bounded-single-site-context-required",
      node: "context",
    });
    expect("query" in invalidRange).toBe(false);
  });
});
