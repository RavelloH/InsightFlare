import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  caseWhen,
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  eq,
  inList,
  param,
  project,
  scan,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { schema } from "@/lib/db/schema";
import {
  LazyEligibleDataset,
  LogicalPlanBuilder,
  lowerFilterDocumentToScope,
  planSemanticAggregateQuery,
} from "@/lib/edge/analytics/engine";
import type { LogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  type AnalyticsPageSessionLoweringInput,
  lowerAnalyticsFilteredSessionCountPlan,
  lowerAnalyticsFilteredSessionOverviewPairPlan,
  lowerAnalyticsFilteredSessionViewsPlan,
  lowerAnalyticsPagePathSessionPlan,
  lowerAnalyticsPagePathToSessionQuery,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-page-session-lowering";
import {
  lowerNativePrimitivePredicate,
  type NativePrimitiveFieldId,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-primitive-predicate-lowering";
import {
  evaluateFilterDocument,
  type FilterEvaluationEntity,
} from "@/lib/filter-contract/filter-evaluator";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import {
  type FilterDocument,
  type FilterOperator,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

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

function eventNameCondition(name: string) {
  return {
    kind: "condition",
    target: { kind: "field", field: "event.name" },
    operator: "eq",
    value: name,
  } as const;
}

function fieldCondition(
  field: NativePrimitiveFieldId,
  operator: FilterOperator,
  value?: string | readonly string[],
) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator,
    ...(value === undefined ? {} : { value }),
  } as const;
}

function inCondition(field: NativePrimitiveFieldId, values: string[]) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator: "in",
    value: values,
  } as const;
}

function filterDocument(root: unknown): FilterDocument {
  return { version: 1, root } as unknown as FilterDocument;
}

function buildDirectSessionPlan(
  input: unknown,
  output: "matches" | "sessions" = "matches",
): LogicalPlan {
  const document = normalizeFilterDocument(input, analyticsFilterRegistry);
  const context = {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_A as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: CANDIDATE_RANGE as never,
      read: { kind: "bounded", range: READ_RANGE as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 200 as never,
    }),
    scope: resolveAnalyticsScope("session"),
  };
  const builder = new LogicalPlanBuilder(context);
  const lowered = lowerFilterDocumentToScope(
    builder,
    analyzeFilterDocument(document, analyticsFilterRegistry),
    {
      targetScope: "session",
      resolveTemporalDomain: () => "read",
    },
  );
  if (lowered.kind !== "supported") {
    throw new Error(
      `Expected a supported Session filter, received ${lowered.kind}.`,
    );
  }
  if (output === "sessions") {
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
        throw new Error(
          "An ungrouped sessions count does not use associations.",
        );
      },
    });
    return planSemanticAggregateQuery(
      builder,
      { context, dimensions: [], metrics: ["sessions"], sort: [] },
      dataset,
    );
  }
  builder.output("matches", lowered.selection.relation, [
    { name: "entity", slot: "entity" },
  ]);
  return builder.finish();
}

function buildDirectMetricPlan(
  input: unknown,
  metrics: readonly ("sessions" | "views")[],
): LogicalPlan {
  const document = normalizeFilterDocument(input, analyticsFilterRegistry);
  const context = {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_A as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: CANDIDATE_RANGE as never,
      read: { kind: "bounded", range: READ_RANGE as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 200 as never,
    }),
    scope: resolveAnalyticsScope("session"),
  };
  const builder = new LogicalPlanBuilder(context);
  const lowered = lowerFilterDocumentToScope(
    builder,
    analyzeFilterDocument(document, analyticsFilterRegistry),
    { targetScope: "session", resolveTemporalDomain: () => "read" },
  );
  if (lowered.kind !== "supported") {
    throw new Error(
      `Expected a supported Session filter, received ${lowered.kind}.`,
    );
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
      throw new Error("An ungrouped aggregate does not use associations.");
    },
  });
  return planSemanticAggregateQuery(
    builder,
    { context, dimensions: [], metrics: [...metrics], sort: [] },
    dataset,
  );
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
  readonly title?: string;
  readonly query?: string;
  readonly hash?: string;
}

interface EventSeed {
  readonly eventId: string;
  readonly site: SiteSeed;
  readonly visit: PageSeed;
  readonly occurredAt: number;
  readonly eventName?: string;
  readonly eventNameId?: number;
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
    event.eventNameId ?? event.site.eventNameId,
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
    fields: {
      "page.path": page.pathname,
      "page.title": page.title ?? "",
      "page.query": page.query ?? "",
      "page.hash": page.hash ?? "",
    },
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
    fields: { "event.name": event.eventName ?? "activity" },
    payload: {},
  };
}

function ensureEventNameId(
  db: DatabaseSync,
  site: SiteSeed,
  name: string,
): number {
  db.prepare(
    "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?) ON CONFLICT(site_pk, name) DO NOTHING",
  ).run(site.id, name, 1, site.key);
  const row = db
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.key, name) as { readonly id: number };
  return row.id;
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

function withPageAttributes(
  db: DatabaseSync,
  page: PageSeed,
  attributes: {
    readonly title?: string;
    readonly query?: string;
    readonly hash?: string;
  },
): PageSeed {
  const title = attributes.title ?? "";
  const query = attributes.query ?? "";
  const hash = attributes.hash ?? "";
  db.prepare(
    "UPDATE visits SET title = ?, query_string = ?, hash_fragment = ? WHERE visit_id = ?",
  ).run(title, query, hash, page.visitId);
  return { ...page, title, query, hash };
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

function reverseEvidenceLeftIntersections(input: LogicalPlan): {
  readonly plan: LogicalPlan;
  readonly reversed: number;
} {
  const plan = mutablePlan(input);
  const nodeAt = (id: unknown) => plan.nodes.find((node) => node.id === id);
  const setInputKind = (id: unknown): "candidate" | "evidence" | undefined => {
    const distinct = nodeAt(id);
    if (distinct?.kind !== "distinct") return undefined;
    const inputNode = nodeAt(distinct.input);
    if (
      inputNode?.kind === "source" &&
      inputNode.temporalDomain === "candidate"
    ) {
      return "candidate";
    }
    if (inputNode?.kind === "project") return "evidence";
    return undefined;
  };

  let reversed = 0;
  for (const node of plan.nodes) {
    if (
      node.kind !== "set-operation" ||
      node.operation !== "intersect" ||
      !Array.isArray(node.inputs) ||
      node.inputs.length !== 2
    ) {
      continue;
    }
    const [leftId, rightId] = node.inputs;
    if (
      setInputKind(leftId) !== "candidate" ||
      setInputKind(rightId) !== "evidence"
    ) {
      continue;
    }
    node.inputs = [rightId, leftId];
    const left = nodeAt(rightId);
    const right = nodeAt(leftId);
    const output = Array.isArray(node.output) ? node.output[0] : undefined;
    const outputSlot = plan.slots.find((slot) => slot.id === output);
    const lineage = outputSlot?.lineage as Record<string, unknown> | undefined;
    if (
      left &&
      right &&
      Array.isArray(left.output) &&
      Array.isArray(right.output) &&
      lineage?.kind === "derived" &&
      lineage.operation === "set:intersect"
    ) {
      lineage.inputs = [left.output[0], right.output[0]];
      reversed += 1;
    }
  }
  return { plan: asLogicalPlan(plan), reversed };
}

function countConditionLeaves(expression: unknown): number {
  if (!expression || typeof expression !== "object") return 0;
  const node = expression as Record<string, unknown>;
  if (node.kind === "condition") return 1;
  if (node.kind === "not") return countConditionLeaves(node.child);
  if (node.kind === "and" || node.kind === "or") {
    return Array.isArray(node.children)
      ? node.children.reduce<number>(
          (sum, child) => sum + countConditionLeaves(child),
          0,
        )
      : 0;
  }
  return 0;
}

function cteDefinitionCount(sql: string): number {
  return [
    ...sql.matchAll(/(?:\bWITH|,)\s*(?:"[^"]+"|[A-Za-z_]\w*)\s+AS\s*\(/giu),
  ].length;
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
  // the filter evidence. Session filtering defines NOT over the bounded
  // candidate set, so evaluate each leaf first and apply set algebra there.
  const evaluate = (input: unknown): Set<string> => {
    if (!input || typeof input !== "object") {
      throw new Error("Expected a normalized page.path/event.name expression.");
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

describe("Analytics native Page/Event primitive → Session D1 lowering", () => {
  it("keeps nullable SQL expression truth distinct inside native primitive lowering", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA } = setupSites(db);
      const visitNullability = db
        .prepare("PRAGMA table_info(visits)")
        .all() as Array<{ readonly name: string; readonly notnull: number }>;
      const eventNameNullability = db
        .prepare("PRAGMA table_info(custom_event_names)")
        .all() as Array<{ readonly name: string; readonly notnull: number }>;
      for (const [column, schemaColumn] of [
        ["pathname", schema.visits.columns.pathname],
        ["title", schema.visits.columns.title],
        ["query_string", schema.visits.columns.query_string],
        ["hash_fragment", schema.visits.columns.hash_fragment],
      ] as const) {
        expect(schemaColumn.nullable, `${column} typed nullability`).toBe(
          false,
        );
        expect(
          visitNullability.find((item) => item.name === column)?.notnull,
          `${column} migrated nullability`,
        ).toBe(1);
      }
      expect(schema.custom_event_names.columns.name.nullable).toBe(false);
      expect(
        eventNameNullability.find((item) => item.name === "name")?.notnull,
      ).toBe(1);
      addPage(db, siteA, "nullable-probe", "s-nullable", 10, "/probe");
      addPage(db, siteA, "value-probe", "s-value", 11, "/probe");

      const visits = scan(schema.visits);
      const maybeNull = caseWhen(
        [
          {
            when: eq(visits.columns.visit_id, param("nullable-probe")),
            then: param(null),
          },
        ],
        param(" Match "),
      );
      const projected = project(visits, {
        visitId: visits.columns.visit_id,
        eqValue: lowerNativePrimitivePredicate(maybeNull, {
          operator: "eq",
          value: "Match",
        }),
        neqValue: lowerNativePrimitivePredicate(maybeNull, {
          operator: "neq",
          value: "Match",
        }),
        inValue: lowerNativePrimitivePredicate(maybeNull, {
          operator: "in",
          values: ["Other", "Match"],
        }),
        notInValue: lowerNativePrimitivePredicate(maybeNull, {
          operator: "notIn",
          values: ["Other"],
        }),
        isNullValue: lowerNativePrimitivePredicate(maybeNull, {
          operator: "isNull",
        }),
        notNullValue: lowerNativePrimitivePredicate(maybeNull, {
          operator: "notNull",
        }),
      });
      const client = createD1DatabaseClient(createSqliteD1Database(db));
      const query = compileD1Query(projected);
      const result = await client.all(query);
      const rows = result.results as Array<{
        readonly visitId: string;
        readonly eqValue: number | null;
        readonly neqValue: number | null;
        readonly inValue: number | null;
        readonly notInValue: number | null;
        readonly isNullValue: number | null;
        readonly notNullValue: number | null;
      }>;
      const byId = new Map(rows.map((row) => [row.visitId, row]));
      expect(byId.get("nullable-probe")).toMatchObject({
        eqValue: null,
        neqValue: 0,
        inValue: null,
        notInValue: 0,
        isNullValue: 1,
        notNullValue: 0,
      });
      expect(byId.get("value-probe")).toMatchObject({
        eqValue: 1,
        neqValue: 0,
        inValue: 1,
        notInValue: 1,
        isNullValue: 0,
        notNullValue: 1,
      });
    } finally {
      db.close();
    }
  });

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
      expect(lowered.query.bindings).toHaveLength(11);
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

  it("deduplicates historical evidence on the left of intersections before later set operations", async () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const { siteA } = setupSites(db);
      const firstHistory = addPage(
        db,
        siteA,
        "repeat-history-1",
        "s-repeat",
        10,
        "/repeat",
      );
      addPage(db, siteA, "repeat-history-2", "s-repeat", 11, "/repeat");
      const eventOwner = addPage(
        db,
        siteA,
        "repeat-event-owner",
        "s-repeat",
        20,
        "/ignored",
      );
      insertEvent(db, {
        eventId: "repeat-event-1",
        site: siteA,
        visit: eventOwner,
        occurredAt: 30,
      });
      insertEvent(db, {
        eventId: "repeat-event-2",
        site: siteA,
        visit: eventOwner,
        occurredAt: 31,
      });
      const candidate = addPage(
        db,
        siteA,
        "repeat-candidate",
        "s-repeat",
        110,
        "/candidate",
      );
      insertEvent(db, {
        eventId: "repeat-candidate-event",
        site: siteA,
        visit: candidate,
        occurredAt: 120,
      });

      const direct = createD1DatabaseClient(createSqliteD1Database(db));
      const simpleFilter = filterDocument(pathCondition("/repeat"));
      const simple = lower(simpleFilter);
      expect(simple.kind).toBe("supported");
      if (simple.kind !== "supported") {
        throw new Error("Expected the duplicate-evidence filter to lower.");
      }
      const reversedSimple = reverseEvidenceLeftIntersections(
        simple.logicalPlan,
      );
      expect(reversedSimple.reversed).toBe(1);
      const reversedSimpleLowering = lowerAnalyticsPagePathSessionPlan(
        reversedSimple.plan,
      );
      expect(reversedSimpleLowering.kind).toBe("supported");
      if (reversedSimpleLowering.kind !== "supported") {
        throw new Error("Expected the reversed intersection to remain legal.");
      }
      const canonicalRows = (await direct.all(simple.query)).results;
      const reversedRows = (await direct.all(reversedSimpleLowering.query))
        .results as Array<{
        readonly site_pk: number;
        readonly session_id: string;
      }>;
      expect(canonicalRows).toHaveLength(1);
      expect(reversedRows).toEqual([
        { site_pk: siteA.key, session_id: "s-repeat" },
      ]);

      const canonicalSimpleCount = lowerAnalyticsFilteredSessionCountPlan(
        buildDirectSessionPlan(simpleFilter, "sessions"),
      );
      const reversedSimpleCountPlan = reverseEvidenceLeftIntersections(
        buildDirectSessionPlan(simpleFilter, "sessions"),
      );
      expect(reversedSimpleCountPlan.reversed).toBe(1);
      const reversedSimpleCount = lowerAnalyticsFilteredSessionCountPlan(
        reversedSimpleCountPlan.plan,
      );
      expect(canonicalSimpleCount.kind).toBe("supported");
      expect(reversedSimpleCount.kind).toBe("supported");
      if (
        canonicalSimpleCount.kind !== "supported" ||
        reversedSimpleCount.kind !== "supported"
      ) {
        throw new Error("Expected both simple filtered counts to lower.");
      }
      expect((await direct.all(canonicalSimpleCount.query)).results).toEqual([
        { sessions: 1 },
      ]);
      expect((await direct.all(reversedSimpleCount.query)).results).toEqual([
        { sessions: 1 },
      ]);

      const compositeFilter = filterDocument({
        kind: "and",
        children: [
          filterDocument({
            kind: "or",
            children: [
              pathCondition("/repeat"),
              eventNameCondition("activity"),
              filterDocument({
                kind: "and",
                children: [
                  pathCondition("/repeat"),
                  eventNameCondition("activity"),
                ],
              }).root,
            ],
          }).root,
          pathCondition("/repeat"),
          { kind: "not", child: eventNameCondition("missing") },
        ],
      });
      const composite = lower(compositeFilter);
      expect(composite.kind).toBe("supported");
      if (composite.kind !== "supported") {
        throw new Error("Expected the composite evidence filter to lower.");
      }
      const reversedComposite = reverseEvidenceLeftIntersections(
        composite.logicalPlan,
      );
      expect(reversedComposite.reversed).toBeGreaterThan(1);
      const compositeOperations = composite.logicalPlan.nodes
        .filter((node) => node.kind === "set-operation")
        .map((node) => node.operation);
      expect(compositeOperations).toContain("union");
      expect(compositeOperations).toContain("intersect");
      expect(compositeOperations).toContain("difference");
      const reversedCompositeLowering = lowerAnalyticsPagePathSessionPlan(
        reversedComposite.plan,
      );
      expect(reversedCompositeLowering.kind).toBe("supported");
      if (reversedCompositeLowering.kind !== "supported") {
        throw new Error("Expected the composite reordered plan to be legal.");
      }
      const compositeRows = (await direct.all(reversedCompositeLowering.query))
        .results as Array<{
        readonly site_pk: number;
        readonly session_id: string;
      }>;
      expect(compositeRows).toEqual([
        { site_pk: siteA.key, session_id: "s-repeat" },
      ]);
      expect(compositeRows).toHaveLength(
        new Set(compositeRows.map((row) => `${row.site_pk}:${row.session_id}`))
          .size,
      );

      const canonicalCompositeCount = lowerAnalyticsFilteredSessionCountPlan(
        buildDirectSessionPlan(compositeFilter, "sessions"),
      );
      const reversedCompositeCountPlan = reverseEvidenceLeftIntersections(
        buildDirectSessionPlan(compositeFilter, "sessions"),
      );
      expect(reversedCompositeCountPlan.reversed).toBeGreaterThan(1);
      const reversedCompositeCount = lowerAnalyticsFilteredSessionCountPlan(
        reversedCompositeCountPlan.plan,
      );
      expect(canonicalCompositeCount.kind).toBe("supported");
      expect(reversedCompositeCount.kind).toBe("supported");
      if (
        canonicalCompositeCount.kind !== "supported" ||
        reversedCompositeCount.kind !== "supported"
      ) {
        throw new Error("Expected both composite filtered counts to lower.");
      }
      expect((await direct.all(canonicalCompositeCount.query)).results).toEqual(
        [{ sessions: 1 }],
      );
      expect((await direct.all(reversedCompositeCount.query)).results).toEqual([
        { sessions: 1 },
      ]);
      expect(firstHistory.sessionId).toBe("s-repeat");
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

    const titlePlan = lower(
      filterDocument(fieldCondition("page.title", "eq", "Checkout")),
    );
    expect(titlePlan.kind).toBe("supported");
    if (titlePlan.kind !== "supported") {
      throw new Error("Expected a native page.title plan.");
    }
    const wrongTitleLineage = mutablePlan(titlePlan.logicalPlan);
    const titleSource = wrongTitleLineage.nodes.find(
      (node) =>
        node.kind === "source" &&
        Array.isArray(node.values) &&
        (node.values as Array<Record<string, unknown>>).some(
          (binding) =>
            binding.kind === "attribute" && binding.attribute === "page.title",
        ),
    );
    const titleBindings = titleSource?.values as
      Array<Record<string, unknown>> | undefined;
    const titleBinding = titleBindings?.find(
      (binding) => binding.kind === "attribute",
    );
    const titleSlotId = titleBinding?.slot;
    const titleSlot = wrongTitleLineage.slots.find(
      (slot) => slot.id === titleSlotId,
    );
    if (!titleSlot || typeof titleSlot.lineage !== "object") {
      throw new Error("Expected the page.title slot lineage.");
    }
    (titleSlot.lineage as Record<string, unknown>).attribute = "page.path";
    const unsupportedWrongTitleLineage = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(wrongTitleLineage),
    );
    expect(unsupportedWrongTitleLineage).toMatchObject({
      kind: "unsupported",
      capability: "session-boolean-plan-shape",
      node: expect.stringContaining("page.title"),
    });
    expect("query" in unsupportedWrongTitleLineage).toBe(false);

    const wrongTitleNormalization = mutablePlan(titlePlan.logicalPlan);
    const wrongNormalizationFilter = wrongTitleNormalization.nodes.find(
      (node) => node.kind === "filter",
    );
    const wrongNormalizationPredicate = wrongNormalizationFilter?.predicate as
      Record<string, unknown> | undefined;
    if (!wrongNormalizationPredicate) {
      throw new Error("Expected the page.title primitive predicate.");
    }
    wrongNormalizationPredicate.stringNormalization = "trim-case-fold";
    const unsupportedWrongNormalization = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(wrongTitleNormalization),
    );
    expect(unsupportedWrongNormalization.kind).toBe("unsupported");
    expect("query" in unsupportedWrongNormalization).toBe(false);

    const wrongTitleLiteralType = mutablePlan(titlePlan.logicalPlan);
    const wrongLiteralFilter = wrongTitleLiteralType.nodes.find(
      (node) => node.kind === "filter",
    );
    const wrongLiteralPredicate = wrongLiteralFilter?.predicate as
      Record<string, unknown> | undefined;
    const wrongLiteral = wrongLiteralPredicate?.right as
      Record<string, unknown> | undefined;
    const wrongLiteralValueType = wrongLiteral?.valueType as
      Record<string, unknown> | undefined;
    if (!wrongLiteralValueType) {
      throw new Error("Expected the page.title string literal type.");
    }
    wrongLiteralValueType.scalar = "number";
    const unsupportedWrongLiteralType = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(wrongTitleLiteralType),
    );
    expect(unsupportedWrongLiteralType.kind).toBe("unsupported");
    expect("query" in unsupportedWrongLiteralType).toBe(false);

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
      event("ab-history-event-1", siteA, abOwner, 30);
      event("ab-history-event-2", siteA, abOwner, 31);
      event("ab-candidate-event-1", siteA, abOwner, 100);
      event("ab-candidate-event-2", siteA, abOwner, 101);

      page(siteA, "a-history-1", "s-a", 21, "/a");
      page(siteA, "a-history-duplicate", "s-a", 22, "/a");
      const aCandidate = page(siteA, "a-candidate", "s-a", 110, "/other");
      page(siteA, "a-candidate-duplicate", "s-a", 111, "/other");
      event("a-history-event-1", siteA, aCandidate, 35);
      event("a-history-event-2", siteA, aCandidate, 36);
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
        {
          name: "nary-union",
          document: filterDocument({
            kind: "or",
            children: [
              documentA.root,
              eventNameCondition("activity"),
              filterDocument({
                kind: "and",
                children: [documentB.root, eventNameCondition("activity")],
              }).root,
            ],
          }),
        },
        {
          name: "nary-intersect",
          document: filterDocument({
            kind: "and",
            children: [
              documentA.root,
              eventNameCondition("activity"),
              filterDocument({
                kind: "or",
                children: [documentB.root, eventNameCondition("missing")],
              }).root,
            ],
          }),
        },
        {
          name: "six-leaf-mixed",
          document: filterDocument({
            kind: "and",
            children: [
              documentA.root,
              documentB.root,
              eventNameCondition("activity"),
              { kind: "not", child: eventNameCondition("missing") },
              filterDocument({
                kind: "or",
                children: [documentA.root, eventNameCondition("signup")],
              }).root,
            ],
          }),
        },
        {
          name: "three-path-or",
          document: filterDocument({
            kind: "or",
            children: [
              documentA.root,
              documentB.root,
              pathCondition("/not-seen"),
            ],
          }),
          expected: ["s-ab", "s-a", "s-b", "s-trim", "s-start", "s-shared"],
        },
        {
          name: "three-leaf-page-event-and-not",
          document: filterDocument({
            kind: "and",
            children: [
              documentA.root,
              eventNameCondition("activity"),
              { kind: "not", child: eventNameCondition("missing") },
            ],
          }),
        },
        {
          name: "positive-in-trim-and-deduplicate",
          document: filterDocument(
            inCondition("page.path", [" /a ", "\t/b\t", "/b"]),
          ),
          expected: ["s-ab", "s-a", "s-b", "s-trim", "s-start", "s-shared"],
        },
        {
          name: "positive-singleton-in",
          document: filterDocument(inCondition("page.path", ["/a"])),
        },
        {
          name: "32-value-supported-in",
          document: filterDocument(
            inCondition("page.path", [
              "/a",
              ...Array.from({ length: 31 }, (_, index) => `/unused-${index}`),
            ]),
          ),
          expected: ["s-ab", "s-a", "s-trim", "s-shared"],
        },
        {
          name: "no-candidate-match",
          document: filterDocument(
            inCondition("page.path", ["/unseen-a", "/unseen-b"]),
          ),
          expected: [],
        },
      ] as const;

      const normalizedThreePathOr = normalizeFilterDocument(
        cases.find((item) => item.name === "three-path-or")!.document,
        analyticsFilterRegistry,
      );
      expect(normalizedThreePathOr.root).toMatchObject({
        kind: "condition",
        operator: "in",
        value: ["/a", "/b", "/not-seen"],
      });
      const normalizedPositiveIn = normalizeFilterDocument(
        cases.find((item) => item.name === "positive-in-trim-and-deduplicate")!
          .document,
        analyticsFilterRegistry,
      );
      expect(normalizedPositiveIn.root).toMatchObject({
        kind: "condition",
        operator: "in",
        value: ["/a", "/b"],
      });

      const costs: Record<
        string,
        {
          readonly statements: number;
          readonly bindings: number;
          readonly sqlBytes: number;
          readonly cteCount: number;
          readonly conditionLeaves: number;
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
        if ("expected" in item) {
          expect([...actual].sort()).toEqual([...item.expected].sort());
        }
        expect(actualRows.every((row) => row.site_pk === siteA.key)).toBe(true);
        expect(actualRows).toHaveLength(actual.size);
        expect(trace.preparedSql).toHaveLength(1);
        expect(trace.bindings).toHaveLength(1);
        const sqlBytes = new TextEncoder().encode(lowered.query.sql).length;
        expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(lowered.query.bindings?.length ?? 0).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
        if (item.name === "nary-union" || item.name === "nary-intersect") {
          const expectedOperation =
            item.name === "nary-union" ? "union" : "intersect";
          expect(
            lowered.logicalPlan.nodes.some(
              (node) =>
                node.kind === "set-operation" &&
                node.operation === expectedOperation &&
                node.inputs.length === 3,
            ),
          ).toBe(true);
        }

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
          sqlBytes,
          cteCount: cteDefinitionCount(lowered.query.sql),
          conditionLeaves: countConditionLeaves(item.document.root),
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
      // SQLite versions can represent the same UNION plan with different
      // EXPLAIN rows. Keep the stable access-path counts exact and bound the
      // version-dependent operation and temporary-tree counts separately.
      expect(costs).toMatchObject({
        and: {
          statements: 1,
          bindings: 15,
          sqlBytes: 21611,
          explain: {
            candidatePageCoveringScans: 1,
            candidateEventCoveringScans: 1,
            historicalKeyRangeSearches: 2,
            visitPrimaryKeyLookups: 4,
          },
        },
        or: {
          statements: 1,
          bindings: 12,
          sqlBytes: 16146,
          explain: {
            candidatePageCoveringScans: 1,
            candidateEventCoveringScans: 1,
            historicalKeyRangeSearches: 1,
            visitPrimaryKeyLookups: 3,
          },
        },
        not: {
          statements: 1,
          bindings: 11,
          sqlBytes: 16625,
          explain: {
            candidatePageCoveringScans: 1,
            candidateEventCoveringScans: 1,
            historicalKeyRangeSearches: 1,
            visitPrimaryKeyLookups: 3,
          },
        },
        "nested-and-not": {
          statements: 1,
          bindings: 15,
          sqlBytes: 21935,
          explain: {
            candidatePageCoveringScans: 1,
            candidateEventCoveringScans: 1,
            historicalKeyRangeSearches: 2,
            visitPrimaryKeyLookups: 4,
          },
        },
        "or-set-operation": {
          statements: 1,
          bindings: 15,
          sqlBytes: 21826,
          explain: {
            candidatePageCoveringScans: 1,
            candidateEventCoveringScans: 1,
            historicalKeyRangeSearches: 2,
            visitPrimaryKeyLookups: 4,
          },
        },
      });
      console.info(
        "Wave 7 Analytics Session filter costs",
        JSON.stringify(
          Object.fromEntries(
            [2, 3, 6].map((leafCount) => [
              `${leafCount}-condition`,
              Object.entries(costs)
                .filter(([, cost]) => cost.conditionLeaves === leafCount)
                .map(([name, cost]) => ({ name, ...cost })),
            ]),
          ),
        ),
      );
      for (const [name, maxOperations, maxUnionTempTrees] of [
        ["and", 36, 2],
        ["or", 20, 1],
        ["not", 40, 2],
        ["nested-and-not", 51, 3],
        ["or-set-operation", 56, 4],
      ] as const) {
        expect(costs[name].explain.operations, name).toBeLessThanOrEqual(
          maxOperations,
        );
        expect(costs[name].explain.unionTempTrees, name).toBeLessThanOrEqual(
          maxUnionTempTrees,
        );
      }
      const budgetRejected = lower(
        filterDocument(
          inCondition(
            "page.path",
            Array.from({ length: 128 }, (_, index) => `/budget-${index}`),
          ),
        ),
      );
      expect(budgetRejected).toMatchObject({
        kind: "unsupported",
        capability: "d1-query-budget-exceeded",
        node: "compiled-query",
        reason: expect.stringMatching(/^bound parameters: \d+ \(limit 100\);/u),
      });
      if (budgetRejected.kind === "unsupported") {
        console.info("Wave 7 Session budget refusal", budgetRejected.reason);
      }
      expect("query" in budgetRejected).toBe(false);
      const directPlanBudgetRejected = lowerAnalyticsPagePathSessionPlan(
        buildDirectSessionPlan(
          filterDocument(
            inCondition(
              "page.path",
              Array.from({ length: 128 }, (_, index) => `/budget-${index}`),
            ),
          ),
        ),
      );
      expect(directPlanBudgetRejected).toMatchObject({
        kind: "unsupported",
        capability: "d1-query-budget-exceeded",
        node: "compiled-query",
        reason: expect.stringMatching(/^bound parameters: \d+ \(limit 100\);/u),
      });
      if (directPlanBudgetRejected.kind === "unsupported") {
        console.info(
          "Wave 7 direct Session plan budget refusal",
          directPlanBudgetRejected.reason,
        );
      }
    } finally {
      db.close();
    }
  });

  it("lowers event.name evidence across distinct activity records and preserves D1 boundaries", async () => {
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
        eventName = "activity",
        eventNameId = ensureEventNameId(db, site, eventName),
      ) => {
        const row = {
          eventId,
          site,
          visit: owner,
          occurredAt,
          eventName,
          eventNameId,
        };
        insertEvent(db, row);
        if (
          site.id === SITE_A &&
          owner.site.key === site.key &&
          eventNameId === ensureEventNameId(db, site, eventName)
        ) {
          evaluatorEvents.push(eventEntity(row));
        }
        return row;
      };

      // Each Event's owner visit is outside both activity windows. Its own
      // occurred_at decides whether the Event is read evidence or candidate
      // membership, while its persisted site/session supplies the identity.
      page(siteA, "event-owner-both-1", "s-page-event", 350, "/owner");
      event(
        "read-purchase-both-1",
        siteA,
        {
          visitId: "event-owner-both-1",
          site: siteA,
          sessionId: "s-page-event",
          startedAt: 350,
          pathname: "/owner",
        },
        20,
        "purchase",
      );
      page(siteA, "read-page-both-1", "s-page-event", 10, "/pricing");
      page(siteA, "candidate-page-both-1", "s-page-event", 110, "/other");

      const eventOnlyOwner = page(
        siteA,
        "event-owner-only",
        "s-event-only",
        360,
        "/owner",
      );
      event("read-purchase-event-only", siteA, eventOnlyOwner, 30, "purchase");
      page(siteA, "candidate-page-event-only", "s-event-only", 120, "/other");

      page(siteA, "read-page-only", "s-page-only", 12, "/pricing");
      page(siteA, "candidate-page-only", "s-page-only", 130, "/other");
      page(siteA, "candidate-neither", "s-neither", 140, "/other");
      page(siteA, "candidate-only", "s-candidate-only", 150, "/other");

      const secondEventOwner = page(
        siteA,
        "event-owner-both-2",
        "s-event-page",
        370,
        "/owner",
      );
      event(
        "read-purchase-event-page",
        siteA,
        secondEventOwner,
        40,
        "purchase",
      );
      const candidateEventOwner = page(
        siteA,
        "candidate-event-owner",
        "s-event-page",
        380,
        "/owner",
      );
      event(
        "candidate-event-membership",
        siteA,
        candidateEventOwner,
        130,
        "other-event",
      );

      const readStartOwner = page(
        siteA,
        "read-start-owner",
        "s-read-start",
        390,
        "/owner",
      );
      event("purchase-at-read-start", siteA, readStartOwner, 0, "purchase");
      page(siteA, "read-start-candidate", "s-read-start", 160, "/other");

      const readEndOwner = page(
        siteA,
        "read-end-owner",
        "s-read-end",
        391,
        "/owner",
      );
      event("purchase-at-read-end", siteA, readEndOwner, 100, "purchase");

      page(siteA, "duplicate-event-owner", "s-duplicate-event", 392, "/owner");
      const duplicateOwner = {
        visitId: "duplicate-event-owner",
        site: siteA,
        sessionId: "s-duplicate-event",
        startedAt: 392,
        pathname: "/owner",
      };
      event("purchase-duplicate-1", siteA, duplicateOwner, 50, "purchase");
      event("purchase-duplicate-2", siteA, duplicateOwner, 51, "purchase");
      page(siteA, "duplicate-candidate", "s-duplicate-event", 170, "/other");

      const whitespaceOwner = page(
        siteA,
        "whitespace-event-owner",
        "s-whitespace-event",
        393,
        "/owner",
      );
      event(
        "purchase-with-unicode-whitespace",
        siteA,
        whitespaceOwner,
        60,
        " \u00a0purchase\t",
      );
      page(siteA, "whitespace-candidate", "s-whitespace-event", 171, "/other");

      const caseOwner = page(
        siteA,
        "case-event-owner",
        "s-case-event",
        394,
        "/owner",
      );
      event("case-sensitive-event", siteA, caseOwner, 61, "Purchase");
      page(siteA, "case-candidate", "s-case-event", 172, "/other");

      const sharedCandidate = page(
        siteA,
        "shared-candidate-a",
        "s-shared",
        173,
        "/other",
      );
      const siteBPurchaseId = ensureEventNameId(db, siteB, "purchase");
      const sharedSiteBOwner = page(
        siteB,
        "shared-event-owner-b",
        "s-shared",
        395,
        "/owner",
      );
      event(
        "site-b-purchase-shared",
        siteB,
        sharedSiteBOwner,
        62,
        "purchase",
        siteBPurchaseId,
      );
      void sharedCandidate;

      const crossNameCandidate = page(
        siteA,
        "cross-name-candidate",
        "s-cross-name",
        174,
        "/other",
      );
      const crossNameOwner = page(
        siteA,
        "cross-name-owner",
        "s-cross-name",
        396,
        "/owner",
      );
      event(
        "site-a-event-with-site-b-name-id",
        siteA,
        crossNameOwner,
        63,
        "purchase",
        siteBPurchaseId,
      );
      void crossNameCandidate;

      page(siteA, "cross-owner-candidate", "s-cross-owner", 175, "/other");
      const crossSiteOwner = page(
        siteB,
        "cross-owner-b",
        "s-cross-owner",
        397,
        "/owner",
      );
      event(
        "site-a-event-with-site-b-owner",
        siteA,
        crossSiteOwner,
        64,
        "purchase",
      );

      const emptyOwner = page(siteA, "empty-session-owner", "", 398, "/owner");
      event("empty-session-purchase", siteA, emptyOwner, 65, "purchase");
      page(siteA, "empty-session-candidate", "", 176, "/other");

      const candidateEndOwner = page(
        siteA,
        "candidate-end-owner",
        "s-candidate-end",
        399,
        "/owner",
      );
      event(
        "event-at-candidate-end",
        siteA,
        candidateEndOwner,
        200,
        "purchase",
      );

      const pageA = filterDocument(pathCondition("/pricing"));
      const eventPurchase = filterDocument(
        eventNameCondition(" \u00a0purchase\t"),
      );
      const eventPurchaseNormalized = filterDocument(
        eventNameCondition("purchase"),
      );
      const cases = [
        {
          name: "event-only",
          document: eventPurchase,
          expected: [
            "s-page-event",
            "s-event-only",
            "s-event-page",
            "s-read-start",
            "s-duplicate-event",
            "s-whitespace-event",
          ],
        },
        {
          name: "page-and-event",
          document: filterDocument({
            kind: "and",
            children: [pageA.root, eventPurchase.root],
          }),
          expected: ["s-page-event"],
        },
        {
          name: "page-or-event",
          document: filterDocument({
            kind: "or",
            children: [pageA.root, eventPurchase.root],
          }),
          expected: [
            "s-page-event",
            "s-event-only",
            "s-event-page",
            "s-page-only",
            "s-read-start",
            "s-duplicate-event",
            "s-whitespace-event",
          ],
        },
        {
          name: "not-event",
          document: filterDocument({
            kind: "not",
            child: eventPurchaseNormalized.root,
          }),
          expected: [
            "s-page-only",
            "s-neither",
            "s-candidate-only",
            "s-read-end",
            "s-case-event",
            "s-shared",
            "s-cross-name",
            "s-cross-owner",
          ],
        },
        {
          name: "page-and-not-event",
          document: filterDocument({
            kind: "and",
            children: [
              pageA.root,
              { kind: "not", child: eventPurchaseNormalized.root },
            ],
          }),
          expected: ["s-page-only"],
        },
      ] as const;

      const evaluatorDataset = {
        pages: evaluatorPages,
        events: evaluatorEvents,
        coverageRange: { startMs: 0, endExclusiveMs: 400 },
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
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace));
      const observedCosts: Record<
        string,
        {
          statements: number;
          bindings: number;
          sqlLength: number;
          explain: {
            operations: number;
            candidatePageCoveringScans: number;
            candidateEventCoveringScans: number;
            readEventTimeRangeSearches: number;
            integerPrimaryKeyLookups: number;
            ownerVisitIndexLookups: number;
            unionTempTrees: number;
          };
        }
      > = {};

      for (const item of cases) {
        const lowered = lower(item.document);
        expect(lowered.kind, item.name).toBe("supported");
        if (lowered.kind !== "supported")
          throw new Error(`Expected ${item.name} to lower.`);
        const direct = lowerAnalyticsPagePathSessionPlan(lowered.logicalPlan);
        expect(direct.kind, `${item.name} direct plan`).toBe("supported");
        if (direct.kind !== "supported")
          throw new Error(`Expected ${item.name} plan to lower directly.`);
        expect(direct.query.sql).toBe(lowered.query.sql);
        expect(direct.query.bindings).toEqual(lowered.query.bindings);

        const result = await client.all(lowered.query);
        const rows = result.results as Array<{
          readonly site_pk: number;
          readonly session_id: string;
        }>;
        const actual = new Set(rows.map((row) => row.session_id));
        const evaluated = evaluateCandidateRestrictedSets(
          item.document.root,
          evaluatorDataset,
          candidateSessionIds,
        );
        expect(actual, item.name).toEqual(evaluated);
        expect([...actual].sort(), item.name).toEqual(
          [...item.expected].sort(),
        );
        expect(rows.every((row) => row.site_pk === siteA.key)).toBe(true);
        expect(rows).toHaveLength(actual.size);
        expect(trace.preparedSql).toHaveLength(cases.indexOf(item) + 1);

        if (item.name === "event-only") {
          const explainLines = explainQueryPlan(db, lowered.query);
          const explain = explainLines.join("\n");
          const countExplain = (pattern: RegExp) =>
            explainLines.filter((line) => pattern.test(line)).length;
          observedCosts[item.name] = {
            statements: 1,
            bindings: lowered.query.bindings?.length ?? 0,
            sqlLength: lowered.query.sql.length,
            explain: {
              operations: explainLines.length,
              candidatePageCoveringScans: countExplain(
                /SCAN \w+ USING COVERING INDEX idx_visits_site_pk_session_started_at/u,
              ),
              candidateEventCoveringScans: countExplain(
                /SCAN \w+ USING COVERING INDEX idx_custom_events_site_pk_visit_time/u,
              ),
              readEventTimeRangeSearches: countExplain(
                /SEARCH \w+ USING INDEX idx_custom_events_site_pk_time \(site_pk=\? AND occurred_at>\? AND occurred_at<\?\)/u,
              ),
              integerPrimaryKeyLookups: countExplain(
                /USING INTEGER PRIMARY KEY \(rowid=\?\)/u,
              ),
              ownerVisitIndexLookups: countExplain(
                /sqlite_autoindex_visits_1 \(visit_id=\?\)/u,
              ),
              unionTempTrees: countExplain(/UNION USING TEMP B-TREE/u),
            },
          };
          expect(lowered.query.bindings).toContain("purchase");
          expect(lowered.query.sql).toContain(
            "char(9, 10, 11, 12, 13, 32, 160",
          );
          expect(explain).toMatch(
            /SEARCH \w+ USING INDEX idx_custom_events_site_pk_time \(site_pk=\? AND occurred_at>\? AND occurred_at<\?\)/u,
          );
          expect(
            countExplain(/USING INTEGER PRIMARY KEY \(rowid=\?\)/u),
          ).toBeGreaterThanOrEqual(2);
          expect(explain).toMatch(/sqlite_autoindex_visits_1/u);
          expect(
            countExplain(/sqlite_autoindex_visits_1 \(visit_id=\?\)/u),
          ).toBe(2);
        }
      }

      expect(observedCosts["event-only"]).toMatchObject({
        statements: 1,
        bindings: 11,
        sqlLength: 19156,
        explain: {
          candidatePageCoveringScans: 1,
          candidateEventCoveringScans: 1,
          readEventTimeRangeSearches: 1,
          integerPrimaryKeyLookups: 4,
          ownerVisitIndexLookups: 2,
        },
      });
      expect(
        observedCosts["event-only"].explain.operations,
      ).toBeLessThanOrEqual(21);
      expect(
        observedCosts["event-only"].explain.unionTempTrees,
      ).toBeLessThanOrEqual(1);
      expect(trace.preparedSql).toHaveLength(cases.length);

      const eventLowering = lower(eventPurchaseNormalized);
      expect(eventLowering.kind).toBe("supported");
      if (eventLowering.kind !== "supported")
        throw new Error("Expected event.name plan.");
      const eventPlan = mutablePlan(eventLowering.logicalPlan);
      const eventSource = eventPlan.nodes.find(
        (node) => node.kind === "source" && node.entity === "event",
      );
      const eventBindings = eventSource?.values as
        Array<Record<string, unknown>> | undefined;
      const observationBinding = eventBindings?.find(
        (binding) => binding.kind === "related-entity",
      );
      if (!observationBinding)
        throw new Error("Expected event.observation source binding.");
      observationBinding.relationship = "observation.session";
      const unsupportedEventRelationship = lowerAnalyticsPagePathSessionPlan(
        asLogicalPlan(eventPlan),
      );
      expect(unsupportedEventRelationship).toMatchObject({
        kind: "unsupported",
      });
      expect("query" in unsupportedEventRelationship).toBe(false);

      const eventUnion = mutablePlan(eventLowering.logicalPlan);
      const root = eventUnion.nodes.find(
        (node) => node.id === eventUnion.outputs[0]!.relation,
      );
      if (root?.kind !== "set-operation")
        throw new Error("Expected candidate-scoped set operation.");
      root.operation = "union";
      const unsupportedUnion = lowerAnalyticsPagePathSessionPlan(
        asLogicalPlan(eventUnion),
      );
      expect(unsupportedUnion).toMatchObject({
        kind: "unsupported",
        capability: "session-boolean-plan-shape",
        node: `nodes[${String(root.id)}]`,
        reason: expect.stringContaining("candidate Session universe"),
      });
      expect("query" in unsupportedUnion).toBe(false);

      const eventDomain = mutablePlan(eventLowering.logicalPlan);
      const eventDomainSource = eventDomain.nodes.find(
        (node) => node.kind === "source" && node.entity === "event",
      );
      if (!eventDomainSource)
        throw new Error("Expected the read Event Source node.");
      eventDomainSource.temporalDomain = "candidate";
      const unsupportedEventDomain = lowerAnalyticsPagePathSessionPlan(
        asLogicalPlan(eventDomain),
      );
      expect(unsupportedEventDomain).toMatchObject({
        kind: "unsupported",
        capability: "session-boolean-plan-shape",
        node: expect.stringContaining("temporalDomain"),
      });
      expect("query" in unsupportedEventDomain).toBe(false);
    } finally {
      db.close();
    }
  });

  it("lowers native Page primitives, keeps Event evidence separate, and shares them across adapters", async () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const { siteA } = setupSites(db);
      const evaluatorPages: FilterEvaluationEntity[] = [];
      const evaluatorEvents: FilterEvaluationEntity[] = [];
      const page = (
        visitId: string,
        sessionId: string,
        startedAt: number,
        attributes: {
          readonly title?: string;
          readonly query?: string;
          readonly hash?: string;
        } = {},
      ) => {
        const inserted = addPage(
          db,
          siteA,
          visitId,
          sessionId,
          startedAt,
          "/same-path",
        );
        const row = withPageAttributes(db, inserted, attributes);
        evaluatorPages.push(pageEntity(row));
        return row;
      };
      const event = (
        eventId: string,
        owner: PageSeed,
        occurredAt: number,
        eventName: string,
      ) => {
        const row = {
          eventId,
          site: siteA,
          visit: owner,
          occurredAt,
          eventName,
          eventNameId: ensureEventNameId(db, siteA, eventName),
        };
        insertEvent(db, row);
        evaluatorEvents.push(eventEntity(row));
      };

      page("title-match-read", "s-title-match", 10, {
        title: " \u00a0Checkout\t",
        query: "title-query",
        hash: "title-hash",
      });
      page("title-match-candidate", "s-title-match", 100);
      page("title-conflict-read-1", "s-title-conflict", 11, {
        title: "Checkout",
      });
      page("title-conflict-read-2", "s-title-conflict", 12, {
        title: "Pricing",
      });
      page("title-conflict-candidate", "s-title-conflict", 101);
      page("title-negative-read", "s-title-negative", 13, {
        title: "Other",
      });
      page("title-negative-candidate", "s-title-negative", 102);
      page("title-empty-read", "s-title-empty", 14, { title: "" });
      page("title-empty-candidate", "s-title-empty", 103);
      page("title-whitespace-read", "s-title-whitespace", 15, {
        title: "\u00a0 \t",
      });
      page("title-whitespace-candidate", "s-title-whitespace", 104);
      page("query-map-read", "s-query-map", 16, {
        title: "Else",
        query: "campaign=gold",
        hash: "query-only-hash",
      });
      page("query-map-candidate", "s-query-map", 105);
      page("hash-map-read", "s-hash-map", 17, {
        title: "Else",
        query: "hash-only-query",
        hash: "section-setup",
      });
      page("hash-map-candidate", "s-hash-map", 106);
      page("no-read-candidate", "s-no-read", 107);

      page("mixed-title-read", "s-mixed", 18, { title: "Checkout" });
      page("mixed-candidate-1", "s-mixed", 108);
      page("mixed-candidate-2", "s-mixed", 109);
      const mixedEventOwner = page("mixed-event-owner", "s-mixed", 350, {
        title: "Checkout",
      });
      event("mixed-purchase-read", mixedEventOwner, 50, "purchase");
      event("mixed-other-read", mixedEventOwner, 51, "other");

      page("page-only-title-read", "s-page-only", 19, { title: "Checkout" });
      page("page-only-candidate", "s-page-only", 110);
      const pageOnlyEventOwner = page(
        "page-only-event-owner",
        "s-page-only",
        351,
      );
      event("page-only-other-read", pageOnlyEventOwner, 52, "other");

      page("event-only-candidate", "s-event-only", 111, { title: "Other" });
      const eventOnlyOwner = page("event-only-owner", "s-event-only", 352, {
        title: "Checkout",
      });
      event("event-only-purchase-read", eventOnlyOwner, 53, "purchase");

      const evaluatorDataset = {
        pages: evaluatorPages,
        events: evaluatorEvents,
        coverageRange: { startMs: 0, endExclusiveMs: 400 },
      };
      const candidateSessionIds = new Set(
        evaluatorPages
          .filter(
            (entity) =>
              entity.time !== undefined &&
              entity.time >= CANDIDATE_RANGE.startMs &&
              entity.time < CANDIDATE_RANGE.endExclusiveMs,
          )
          .map((entity) => entity.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId)),
      );
      const pageEq = fieldCondition("page.title", "eq", "Checkout");
      const eventEq = eventNameCondition("purchase");
      const cases = [
        {
          name: "title-eq-trim",
          document: filterDocument(pageEq),
          expected: [
            "s-title-match",
            "s-title-conflict",
            "s-mixed",
            "s-page-only",
          ],
        },
        {
          name: "title-neq-primitive",
          document: filterDocument(
            fieldCondition("page.title", "neq", "Checkout"),
          ),
          expected: [
            "s-title-conflict",
            "s-title-negative",
            "s-title-empty",
            "s-title-whitespace",
            "s-query-map",
            "s-hash-map",
          ],
        },
        {
          name: "title-in",
          document: filterDocument(
            inCondition("page.title", ["Checkout", "Pricing"]),
          ),
          expected: [
            "s-title-match",
            "s-title-conflict",
            "s-mixed",
            "s-page-only",
          ],
        },
        {
          name: "title-not-in-primitive",
          document: filterDocument(
            fieldCondition("page.title", "notIn", ["Checkout"]),
          ),
          expected: [
            "s-title-conflict",
            "s-title-negative",
            "s-title-empty",
            "s-title-whitespace",
            "s-query-map",
            "s-hash-map",
          ],
        },
        {
          name: "title-is-null-on-non-null-storage",
          document: filterDocument(fieldCondition("page.title", "isNull")),
          expected: [],
        },
        {
          name: "title-not-null-includes-empty-values",
          document: filterDocument(fieldCondition("page.title", "notNull")),
          expected: [
            "s-title-match",
            "s-title-conflict",
            "s-title-negative",
            "s-title-empty",
            "s-title-whitespace",
            "s-query-map",
            "s-hash-map",
            "s-mixed",
            "s-page-only",
          ],
        },
        {
          name: "root-not-title-eq-includes-no-read-candidates",
          document: filterDocument({ kind: "not", child: pageEq }),
          expected: [
            "s-title-negative",
            "s-title-empty",
            "s-title-whitespace",
            "s-query-map",
            "s-hash-map",
            "s-no-read",
            "s-event-only",
          ],
        },
        {
          name: "query-maps-query-string-column",
          document: filterDocument(
            fieldCondition("page.query", "eq", "campaign=gold"),
          ),
          expected: ["s-query-map"],
        },
        {
          name: "query-in",
          document: filterDocument(
            inCondition("page.query", ["unused", "campaign=gold"]),
          ),
          expected: ["s-query-map"],
        },
        {
          name: "hash-maps-hash-fragment-column",
          document: filterDocument(
            fieldCondition("page.hash", "eq", "section-setup"),
          ),
          expected: ["s-hash-map"],
        },
        {
          name: "hash-in",
          document: filterDocument(
            inCondition("page.hash", ["unused", "section-setup"]),
          ),
          expected: ["s-hash-map"],
        },
        {
          name: "nary-page-field-or",
          document: filterDocument({
            kind: "or",
            children: [
              pageEq,
              fieldCondition("page.query", "eq", "campaign=gold"),
              fieldCondition("page.hash", "eq", "section-setup"),
            ],
          }),
          expected: [
            "s-title-match",
            "s-title-conflict",
            "s-query-map",
            "s-hash-map",
            "s-mixed",
            "s-page-only",
          ],
        },
        {
          name: "event-neq-uses-matching-event-evidence",
          document: filterDocument(
            fieldCondition("event.name", "neq", "purchase"),
          ),
          expected: ["s-mixed", "s-page-only"],
        },
        {
          name: "event-not-in-uses-matching-event-evidence",
          document: filterDocument(
            fieldCondition("event.name", "notIn", ["purchase"]),
          ),
          expected: ["s-mixed", "s-page-only"],
        },
        {
          name: "event-is-null-does-not-invent-event-evidence",
          document: filterDocument(fieldCondition("event.name", "isNull")),
          expected: [],
        },
        {
          name: "event-not-null-requires-a-read-event",
          document: filterDocument(fieldCondition("event.name", "notNull")),
          expected: ["s-mixed", "s-page-only", "s-event-only"],
        },
        {
          name: "root-not-event-eq-includes-sessions-without-read-event",
          document: filterDocument({ kind: "not", child: eventEq }),
          expected: [
            "s-title-match",
            "s-title-conflict",
            "s-title-negative",
            "s-title-empty",
            "s-title-whitespace",
            "s-query-map",
            "s-hash-map",
            "s-no-read",
            "s-page-only",
          ],
        },
        {
          name: "page-title-and-event-name-use-separate-native-domains",
          document: filterDocument({
            kind: "and",
            children: [pageEq, eventEq],
          }),
          expected: ["s-mixed"],
        },
      ] as const;

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace));
      for (const item of cases) {
        const lowered = lower(item.document);
        expect(lowered.kind, item.name).toBe("supported");
        if (lowered.kind !== "supported") {
          throw new Error(`Expected ${item.name} to lower.`);
        }
        const direct = lowerAnalyticsPagePathSessionPlan(lowered.logicalPlan);
        expect(direct.kind, `${item.name} direct plan`).toBe("supported");
        if (direct.kind !== "supported") {
          throw new Error(`Expected ${item.name} direct plan to lower.`);
        }
        expect(direct.query.sql).toBe(lowered.query.sql);
        const result = await client.all(lowered.query);
        const rows = result.results as Array<{
          readonly site_pk: number;
          readonly session_id: string;
        }>;
        const actual = new Set(rows.map((row) => row.session_id));
        // The generic evaluator treats a missing cross-domain field as NULL.
        // A bare Page/Event condition is anchored to its native activity, so
        // null tests use only that activity's evidence for the leaf oracle.
        const leafDataset =
          item.name === "title-is-null-on-non-null-storage"
            ? { ...evaluatorDataset, events: [] }
            : item.name === "event-is-null-does-not-invent-event-evidence"
              ? { ...evaluatorDataset, pages: [] }
              : evaluatorDataset;
        const evaluated = evaluateCandidateRestrictedSets(
          item.document.root,
          leafDataset,
          candidateSessionIds,
        );
        expect(actual, item.name).toEqual(evaluated);
        expect([...actual].sort(), item.name).toEqual(
          [...item.expected].sort(),
        );
        expect(rows.every((row) => row.site_pk === siteA.key)).toBe(true);
        expect(rows).toHaveLength(actual.size);
      }

      const mixedDocument = cases.find(
        (item) =>
          item.name === "page-title-and-event-name-use-separate-native-domains",
      )!.document;
      const mixedIdentity = lower(mixedDocument);
      if (mixedIdentity.kind !== "supported") {
        throw new Error("Expected mixed Page/Event identity query.");
      }
      const identityStart = trace.preparedSql.length;
      const identityResult = await client.all(mixedIdentity.query);
      expect(identityResult.results).toEqual([
        { site_pk: siteA.key, session_id: "s-mixed" },
      ]);
      expect(trace.preparedSql).toHaveLength(identityStart + 1);

      const countLowering = lowerAnalyticsFilteredSessionCountPlan(
        buildDirectSessionPlan(mixedDocument, "sessions"),
      );
      expect(countLowering.kind).toBe("supported");
      if (countLowering.kind !== "supported") {
        throw new Error("Expected mixed Page/Event sessions count query.");
      }
      const countStart = trace.preparedSql.length;
      expect((await client.all(countLowering.query)).results).toEqual([
        { sessions: 1 },
      ]);
      expect(trace.preparedSql).toHaveLength(countStart + 1);

      const expectedContext = {
        siteId: SITE_A,
        candidateRange: CANDIDATE_RANGE as never,
        readRange: READ_RANGE as never,
      };
      const viewsLowering = lowerAnalyticsFilteredSessionViewsPlan(
        buildDirectMetricPlan(mixedDocument, ["views"]),
        expectedContext,
      );
      expect(viewsLowering.kind).toBe("supported");
      if (viewsLowering.kind !== "supported") {
        throw new Error("Expected mixed Page/Event views query.");
      }
      const viewsStart = trace.preparedSql.length;
      expect((await client.all(viewsLowering.query)).results).toEqual([
        { views: 2 },
      ]);
      expect(trace.preparedSql).toHaveLength(viewsStart + 1);

      const overviewLowering = lowerAnalyticsFilteredSessionOverviewPairPlan(
        buildDirectMetricPlan(mixedDocument, ["sessions", "views"]),
        expectedContext,
      );
      expect(overviewLowering.kind).toBe("supported");
      if (overviewLowering.kind !== "supported") {
        throw new Error("Expected mixed Page/Event overview pair query.");
      }
      const overviewStart = trace.preparedSql.length;
      expect((await client.all(overviewLowering.query)).results).toEqual([
        { sessions: 1, views: 2 },
      ]);
      expect(trace.preparedSql).toHaveLength(overviewStart + 1);

      const costs = Object.fromEntries(
        Object.entries({
          identity: mixedIdentity.query,
          count: countLowering.query,
          views: viewsLowering.query,
          overviewPair: overviewLowering.query,
        }).map(([name, query]) => {
          const sqlBytes = new TextEncoder().encode(query.sql).length;
          expect(sqlBytes, `${name} SQL bytes`).toBeLessThanOrEqual(
            D1_MAX_SQL_UTF8_BYTES,
          );
          expect(
            query.bindings?.length ?? 0,
            `${name} binding count`,
          ).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
          return [
            name,
            {
              statements: 1,
              sqlBytes,
              bindings: query.bindings?.length ?? 0,
              sharedCtes: cteDefinitionCount(query.sql),
            },
          ];
        }),
      );
      expect(trace.preparedSql).toHaveLength(cases.length + 4);
      console.info("Wave 8 native predicate costs", JSON.stringify(costs));
    } finally {
      db.close();
    }
  });

  it("rejects unsupported fields and multiple site identities before building DB SQL", () => {
    const unsupportedField = lower(
      filterDocument({
        kind: "condition",
        target: { kind: "field", field: "page.hostname" },
        operator: "eq",
        value: "example.test",
      }),
    );
    expect(unsupportedField).toMatchObject({
      kind: "unsupported",
      capability: "session-equality-leaf-only",
    });
    expect("query" in unsupportedField).toBe(false);

    const unsupportedEventPayload = lower(
      filterDocument({
        kind: "condition",
        target: { kind: "field", field: "event.payload" },
        operator: "eq",
        value: "purchase",
      }),
    );
    expect(unsupportedEventPayload).toMatchObject({
      kind: "unsupported",
      capability: "valid-filter-document-required",
    });
    expect("query" in unsupportedEventPayload).toBe(false);

    const contractLimitExceeded = lower(
      filterDocument({
        kind: "or",
        children: Array.from({ length: 129 }, (_, index) =>
          pathCondition(`/condition-${index}`),
        ),
      }),
    );
    expect(contractLimitExceeded).toMatchObject({
      kind: "unsupported",
      capability: "valid-filter-document-required",
      node: "root",
      reason: "Filter condition limit exceeded.",
    });
    expect("query" in contractLimitExceeded).toBe(false);

    const emptyMembership = lower(filterDocument(inCondition("page.path", [])));
    expect(emptyMembership).toMatchObject({
      kind: "unsupported",
      capability: "valid-filter-document-required",
      node: "root",
    });
    expect("query" in emptyMembership).toBe(false);

    const unsupportedStringMatch = lower(
      filterDocument(fieldCondition("page.path", "contains", "/a")),
    );
    expect(unsupportedStringMatch).toMatchObject({
      kind: "unsupported",
      capability: "session-equality-leaf-only",
    });
    expect("query" in unsupportedStringMatch).toBe(false);

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
      capability: "session-boolean-shape",
    });
    expect("query" in oneChildBoolean).toBe(false);
  });

  it("returns located unsupported results for empty, invalid, and unbounded inputs", () => {
    const empty = lower({ version: 1, root: null });
    expect(empty).toMatchObject({
      kind: "unsupported",
      capability: "session-equality-leaf-only",
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
