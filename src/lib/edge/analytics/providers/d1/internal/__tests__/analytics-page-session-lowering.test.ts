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
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
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
  it("compares complete entity identities in filters and rejects nullable identity equality", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA, siteB } = setupSites(db);
      addPage(db, siteA, "identity-a", "shared-session", 10, "/a");
      addPage(db, siteA, "identity-b", "", 11, "/b");
      addPage(db, siteB, "identity-other-site", "shared-session", 12, "/other");
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
      for (const operator of ["eq", "neq"] as const) {
        const builder = new LogicalPlanBuilder(context);
        const pages = builder.source("page", { temporalDomain: "read" });
        const filtered = builder.filter(
          pages,
          builder.compare(
            operator,
            builder.slot(pages, "entity"),
            builder.slot(pages, "entity"),
          ),
        );
        builder.output("identity", filtered, [
          { name: "page", slot: "entity" },
        ]);
        const plan = builder.finish();
        const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
          siteId: SITE_A,
          time: plan.context.time,
        });
        const lowered = lowerer.lower(plan.outputs[0]!);
        const query = compileD1Query(
          lowerer.projectOutput(lowered, [
            {
              name: "siteId",
              slot: plan.outputs[0]!.fields[0]!.slot,
              component: 0,
            },
            {
              name: "visitId",
              slot: plan.outputs[0]!.fields[0]!.slot,
              component: 1,
            },
          ]),
        );
        const rows = (
          await createD1DatabaseClient(createSqliteD1Database(db)).all(query)
        ).results;
        expect(rows).toEqual(
          operator === "eq"
            ? [
                { siteId: siteA.key, visitId: "identity-a" },
                { siteId: siteA.key, visitId: "identity-b" },
              ]
            : [],
        );
      }
      const builder = new LogicalPlanBuilder(context);
      const pages = builder.source("page", {
        temporalDomain: "read",
        relationships: ["page.session"],
      });
      const session = builder.slot(pages, "relationship:page.session");
      const filtered = builder.filter(
        pages,
        builder.compare("eq", session, session),
      );
      builder.output("nullableIdentity", filtered, [
        { name: "page", slot: "entity" },
      ]);
      const plan = builder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(plan, {
          siteId: SITE_A,
          time: plan.context.time,
        }).lower(plan.outputs[0]!),
      ).toThrow(/Only matching non-null composite entity keys are comparable/u);
    } finally {
      db.close();
    }
  });

  it("rejects sorted and limited logical outputs before emitting SQL", () => {
    for (const kind of ["sort", "limit"] as const) {
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
      const pages = builder.source("page", {
        temporalDomain: "read",
        attributes: ["page.path"],
      });
      const output =
        kind === "sort"
          ? builder.sort(pages, [
              { slot: "attribute:page.path", direction: "asc", nulls: "last" },
            ])
          : builder.limit(pages, 1);
      builder.output("unsupported", output, [{ name: "page", slot: "entity" }]);
      const plan = builder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(plan, {
          siteId: SITE_A,
          time: plan.context.time,
        }).lower(plan.outputs[0]!),
      ).toThrow(`Logical ${kind} is outside the current D1 capability set.`);
    }
  });

  it("rejects inconsistent slot metadata and malformed predicates at the DB lowering boundary", () => {
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
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.path"],
    });
    const path = builder.slot(pages, "attribute:page.path");
    const filtered = builder.filter(
      pages,
      builder.compare(
        "eq",
        path,
        builder.literal("/a", { kind: "scalar", scalar: "string" }),
      ),
    );
    const projected = builder.project(filtered, {
      path: builder.slot(filtered, "attribute:page.path"),
      page: builder.slot(filtered, "entity"),
    });
    builder.output("boundary", projected, [
      { name: "path", slot: "path" },
      { name: "page", slot: "page" },
    ]);
    const base = builder.finish();
    const sourcePath = pages.slots["attribute:page.path"]!;
    const sourceEntity = pages.slots.entity!;
    const outputPath = projected.slots.path!;
    const outputEntity = projected.slots.page!;
    const text = {
      kind: "literal",
      value: "constant",
      valueType: { kind: "scalar", scalar: "string" },
    };
    const slot = (id: unknown) => ({ kind: "slot", slot: id });
    const cases: Array<{
      change: (plan: MutablePlanForTest) => void;
      reason: RegExp;
    }> = [
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate = {
            kind: "set-membership",
            input: {
              kind: "literal",
              value: 1,
              valueType: { kind: "scalar", scalar: "number" },
            },
            values: [],
            negated: false,
            stringNormalization: "trim",
          };
        },
        reason: /Trim normalization is supported only for string values/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate =
            slot(999_999);
        },
        reason: /is not visible in this relation/u,
      },
      {
        change: (plan) => {
          const source = plan.nodes.find((node) => node.kind === "source")!;
          source.values = (source.values as Array<{ slot: unknown }>).map(
            (item) =>
              item.slot === sourcePath
                ? { kind: "occurrence-time", slot: sourcePath }
                : item,
          );
        },
        reason:
          /Occurrence-time bindings are outside the current D1 capability set/u,
      },
      {
        change: (plan) => {
          const source = plan.nodes.find((node) => node.kind === "source")!;
          source.values = (source.values as Array<{ slot: unknown }>).map(
            (item) =>
              item.slot === sourcePath
                ? {
                    kind: "attribute",
                    slot: sourcePath,
                    attribute: "event.name",
                  }
                : item,
          );
        },
        reason: /A Page source cannot bind Event fields/u,
      },
      {
        change: (plan) => {
          plan.slots.find((item) => item.id === sourcePath)!.type = {
            kind: "entity",
            entity: "page",
          };
        },
        reason: /A source attribute cannot bind an entity slot/u,
      },
      {
        change: (plan) => {
          plan.slots.find((item) => item.id === sourceEntity)!.nullable = true;
        },
        reason: /differs from its registered Logical metadata/u,
      },
      {
        change: (plan) => {
          const source = plan.nodes.find((node) => node.kind === "source")!;
          source.values = (source.values as Array<{ slot: unknown }>).filter(
            (item) => item.slot !== sourcePath,
          );
        },
        reason: /The source does not bind slot/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate = text;
        },
        reason: /A relational predicate must lower to an integer expression/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate =
            slot(sourceEntity);
        },
        reason: /requires a scalar Logical value/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate = {
            kind: "comparison",
            operator: "eq",
            left: slot(sourceEntity),
            right: text,
          };
        },
        reason: /Entity comparison requires two entity identities/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate = {
            kind: "comparison",
            operator: "eq",
            left: slot(sourceEntity),
            right: slot(sourceEntity),
            stringNormalization: "trim",
          };
        },
        reason: /Entity comparisons do not use string normalization/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate = {
            kind: "comparison",
            operator: "gt",
            left: slot(sourceEntity),
            right: slot(sourceEntity),
          };
        },
        reason: /Entity identities support equality only/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate = {
            kind: "set-membership",
            input: slot(sourcePath),
            values: [text],
            negated: false,
            stringNormalization: "trim-case-fold",
          };
        },
        reason: /does not support case-fold normalization/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate = {
            kind: "set-membership",
            input: slot(sourcePath),
            values: [slot(sourcePath)],
            negated: false,
          };
        },
        reason: /Membership values must be literals/u,
      },
      {
        change: (plan) => {
          plan.nodes.find((node) => node.kind === "filter")!.predicate = {
            kind: "comparison",
            operator: "eq",
            left: { kind: "coalesce", values: [] },
            right: text,
          };
        },
        reason: /COALESCE requires at least one value/u,
      },
      {
        change: (plan) => {
          const projections = plan.nodes.find(
            (node) => node.kind === "project",
          )!.projections as Array<{ slot: unknown; expression: unknown }>;
          projections.find((item) => item.slot === outputPath)!.expression =
            text;
          plan.slots.find((item) => item.id === outputPath)!.type = {
            kind: "entity",
            entity: "page",
          };
        },
        reason: /An entity slot cannot be mapped from a scalar expression/u,
      },
      {
        change: (plan) => {
          const projections = plan.nodes.find(
            (node) => node.kind === "project",
          )!.projections as Array<{ slot: unknown; expression: unknown }>;
          projections.find((item) => item.slot === outputPath)!.expression = {
            ...text,
            value: null,
          };
          plan.slots.find((item) => item.id === outputPath)!.nullable = false;
        },
        reason: /lowered scalar can be NULL but the Logical slot cannot/u,
      },
      {
        change: (plan) => {
          plan.slots.find((item) => item.id === outputEntity)!.type = {
            kind: "entity",
            entity: "event",
          };
        },
        reason: /lowered entity key does not match its Logical slot/u,
      },
    ];
    for (const { change, reason } of cases) {
      const changed = mutablePlan(base);
      change(changed);
      const plan = asLogicalPlan(changed);
      expect(() =>
        // Deliberately bypass the validation brand to exercise defensive
        // adapter checks against corrupted plans; production callers validate.
        new AnalyticsLogicalToDbLowerer(plan as typeof base, {
          siteId: SITE_A,
          time: plan.context.time,
        }).lower(plan.outputs[0]!),
      ).toThrow(reason);
    }
  });

  it("preserves NULL, membership, coalesce, and entity-presence semantics in Project", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA } = setupSites(db);
      const first = withPageAttributes(
        db,
        addPage(db, siteA, "expression-a", "s-a", 10, "/a"),
        { title: "A", query: "q-a", hash: "#a" },
      );
      const emptySession = withPageAttributes(
        db,
        addPage(db, siteA, "expression-empty-session", "", 11, "/b"),
        { title: "B", query: "q-b", hash: "#b" },
      );
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
      const pages = builder.source("page", {
        temporalDomain: "read",
        relationships: ["page.session"],
        attributes: ["page.path", "page.title", "page.query", "page.hash"],
      });
      const path = builder.slot(pages, "attribute:page.path");
      const session = builder.slot(pages, "relationship:page.session");
      const title = builder.slot(pages, "attribute:page.title");
      const text = (value: string | null) =>
        builder.literal(value, { kind: "scalar", scalar: "string" });
      const nullComparison = builder.compare("eq", path, text(null));
      const pathMembership = builder.in(path, [text(" /a ")], true, "trim");
      const nullableMembership = builder.in(path, [text(null), text("/a")]);
      const comparisons = {
        eq: builder.compare("eq", path, text("/a")),
        neq: builder.compare("neq", path, text("/a")),
        gt: builder.compare("gt", path, text("/a")),
        gte: builder.compare("gte", path, text("/a")),
        lt: builder.compare("lt", path, text("/a")),
        lte: builder.compare("lte", path, text("/a")),
      };
      const projected = builder.project(pages, {
        path,
        title,
        query: builder.slot(pages, "attribute:page.query"),
        hash: builder.slot(pages, "attribute:page.hash"),
        trimmedColumnComparison: builder.compare("eq", path, title, "trim"),
        nullComparison,
        negatedNullComparison: builder.not(nullComparison),
        pathMembership,
        nullableMembership,
        emptyMembership: builder.in(path, []),
        emptyNotMembership: builder.in(path, [], true),
        nullPath: builder.isNull(path),
        nullLiteral: builder.isNull(text(null)),
        ...comparisons,
        fallback: builder.coalesce(text(null), text(null), text("fallback")),
        emptySession: builder.isNull(session),
        nonEmptySession: builder.isNull(session, true),
      });
      builder.output("expressions", projected, [
        { name: "path", slot: "path" },
        { name: "title", slot: "title" },
        { name: "query", slot: "query" },
        { name: "hash", slot: "hash" },
        { name: "trimmedColumnComparison", slot: "trimmedColumnComparison" },
        { name: "nullComparison", slot: "nullComparison" },
        { name: "negatedNullComparison", slot: "negatedNullComparison" },
        { name: "pathMembership", slot: "pathMembership" },
        { name: "nullableMembership", slot: "nullableMembership" },
        { name: "emptyMembership", slot: "emptyMembership" },
        { name: "emptyNotMembership", slot: "emptyNotMembership" },
        { name: "nullPath", slot: "nullPath" },
        { name: "nullLiteral", slot: "nullLiteral" },
        ...Object.keys(comparisons).map((name) => ({ name, slot: name })),
        { name: "fallback", slot: "fallback" },
        { name: "emptySession", slot: "emptySession" },
        { name: "nonEmptySession", slot: "nonEmptySession" },
      ]);
      const plan = builder.finish();
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_A,
        time: plan.context.time,
      });
      const lowered = lowerer.lower(plan.outputs[0]!);
      const query = compileD1Query(
        lowerer.projectOutput(
          lowered,
          plan.outputs[0]!.fields.map(({ name, slot }) => ({ name, slot })),
        ),
      );
      const rows = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(query)
      ).results as Array<{
        readonly path: string;
        readonly title: string;
        readonly query: string;
        readonly hash: string;
        readonly trimmedColumnComparison: number;
        readonly nullComparison: number | null;
        readonly negatedNullComparison: number | null;
        readonly pathMembership: number | null;
        readonly nullableMembership: number | null;
        readonly emptyMembership: number;
        readonly emptyNotMembership: number;
        readonly nullPath: number;
        readonly nullLiteral: number;
        readonly eq: number;
        readonly neq: number;
        readonly gt: number;
        readonly gte: number;
        readonly lt: number;
        readonly lte: number;
        readonly fallback: string | null;
        readonly emptySession: number;
        readonly nonEmptySession: number;
      }>;
      rows.sort((left, right) => left.path.localeCompare(right.path));
      expect(rows).toEqual([
        {
          path: "/a",
          title: first.title,
          query: first.query,
          hash: first.hash,
          trimmedColumnComparison: 0,
          nullComparison: null,
          negatedNullComparison: null,
          pathMembership: 0,
          nullableMembership: 1,
          emptyMembership: 0,
          emptyNotMembership: 1,
          nullPath: 0,
          nullLiteral: 1,
          eq: 1,
          neq: 0,
          gt: 0,
          gte: 1,
          lt: 0,
          lte: 1,
          fallback: "fallback",
          emptySession: 0,
          nonEmptySession: 1,
        },
        {
          path: "/b",
          title: emptySession.title,
          query: emptySession.query,
          hash: emptySession.hash,
          trimmedColumnComparison: 0,
          nullComparison: null,
          negatedNullComparison: null,
          pathMembership: 1,
          nullableMembership: null,
          emptyMembership: 0,
          emptyNotMembership: 1,
          nullPath: 0,
          nullLiteral: 1,
          eq: 0,
          neq: 1,
          gt: 1,
          gte: 1,
          lt: 0,
          lte: 0,
          fallback: "fallback",
          emptySession: 1,
          nonEmptySession: 0,
        },
      ]);
      const pathSlot = plan.outputs[0]!.fields[0]!.slot;
      expect(() =>
        lowerer.projectOutput(lowered, [
          { name: "duplicate", slot: pathSlot },
          { name: "duplicate", slot: pathSlot },
        ]),
      ).toThrow(/Output column "duplicate" is duplicated/u);
      expect(() =>
        lowerer.projectOutput(lowered, [
          { name: "scalarComponent", slot: pathSlot, component: 0 },
        ]),
      ).toThrow(/has no key component/u);

      const caseBuilder = new LogicalPlanBuilder(context);
      const casePages = caseBuilder.source("page", {
        temporalDomain: "read",
        attributes: ["page.path"],
      });
      const caseProjection = caseBuilder.project(casePages, {
        label: caseBuilder.caseWhen(
          [
            {
              when: caseBuilder.compare(
                "eq",
                caseBuilder.slot(casePages, "attribute:page.path"),
                caseBuilder.literal("/a", {
                  kind: "scalar",
                  scalar: "string",
                }),
              ),
              then: caseBuilder.literal("A", {
                kind: "scalar",
                scalar: "string",
              }),
            },
          ],
          caseBuilder.literal("other", {
            kind: "scalar",
            scalar: "string",
          }),
        ),
      });
      caseBuilder.output("case", caseProjection, [
        { name: "label", slot: "label" },
      ]);
      const casePlan = caseBuilder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(casePlan, {
          siteId: SITE_A,
          time: casePlan.context.time,
        }).lower(casePlan.outputs[0]!),
      ).toThrow(
        /Expression kind case is outside the current D1 capability set/u,
      );
    } finally {
      db.close();
    }
  });

  it("keeps candidate Observation identity bags and never bounds an AntiJoin by its right side", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA } = setupSites(db);
      const pageA = addPage(
        db,
        siteA,
        "candidate-page-a",
        "s-shared",
        110,
        "/a",
      );
      addPage(db, siteA, "candidate-page-b", "s-shared", 120, "/b");
      insertEvent(db, {
        eventId: "candidate-event",
        site: siteA,
        visit: pageA,
        occurredAt: 130,
      });
      addPage(db, siteA, "candidate-empty-session", "", 140, "/empty");
      addPage(db, siteA, "historical-page", "s-historical", 10, "/old");
      addPage(db, siteA, "current-page", "s-current", 110, "/current");

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

      const observationBuilder = new LogicalPlanBuilder(context);
      const observations = observationBuilder.source("observation", {
        temporalDomain: "candidate",
        relationships: ["observation.session"],
      });
      const projectedObservations = observationBuilder.project(observations, {
        observation: observationBuilder.slot(observations, "entity"),
        session: observationBuilder.slot(
          observations,
          "relationship:observation.session",
        ),
      });
      observationBuilder.output("observations", projectedObservations, [
        { name: "observation", slot: "observation" },
        { name: "session", slot: "session" },
      ]);
      const observationPlan = observationBuilder.finish();
      const observationLowerer = new AnalyticsLogicalToDbLowerer(
        observationPlan,
        { siteId: SITE_A, time: observationPlan.context.time },
      );
      const observationOutput = observationPlan.outputs[0]!;
      const loweredObservations = observationLowerer.lower(observationOutput);
      expect(() =>
        observationLowerer.projectOutput(loweredObservations, [
          {
            name: "invalidObservationKey",
            slot: observationOutput.fields[0]!.slot,
            component: 3,
          },
        ]),
      ).toThrow(/requires a valid key component/u);
      const observationQuery = compileD1Query(
        observationLowerer.projectOutput(loweredObservations, [
          {
            name: "kind",
            slot: observationOutput.fields[0]!.slot,
            component: 1,
          },
          {
            name: "activityId",
            slot: observationOutput.fields[0]!.slot,
            component: 2,
          },
          {
            name: "sessionId",
            slot: observationOutput.fields[1]!.slot,
            component: 1,
          },
        ]),
      );
      const activityRows = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(
          observationQuery,
        )
      ).results as Array<{
        readonly kind: string;
        readonly activityId: string;
        readonly sessionId: string;
      }>;
      activityRows.sort((left, right) =>
        left.activityId.localeCompare(right.activityId),
      );
      expect(activityRows).toEqual([
        { kind: "page", activityId: "candidate-empty-session", sessionId: "" },
        { kind: "event", activityId: "candidate-event", sessionId: "s-shared" },
        { kind: "page", activityId: "candidate-page-a", sessionId: "s-shared" },
        { kind: "page", activityId: "candidate-page-b", sessionId: "s-shared" },
        { kind: "page", activityId: "current-page", sessionId: "s-current" },
      ]);
      expect(observationLowerer.candidateActivity(observations.id)).toBe(
        "observation",
      );

      const antiBuilder = new LogicalPlanBuilder(context);
      const historicalPages = antiBuilder.source("page", {
        temporalDomain: "read",
        relationships: ["page.session"],
      });
      const candidatePages = antiBuilder.source("page", {
        temporalDomain: "candidate",
        relationships: ["page.session"],
      });
      const candidateSessions = antiBuilder.distinctEntity(
        candidatePages,
        "relationship:page.session",
        "session",
      );
      const historicalOnly = antiBuilder.antiJoin(
        historicalPages,
        candidateSessions,
        [{ left: "relationship:page.session", right: "session" }],
      );
      antiBuilder.output("historicalOnly", historicalOnly, [
        { name: "session", slot: "relationship:page.session" },
      ]);
      const antiPlan = antiBuilder.finish();
      const antiLowerer = new AnalyticsLogicalToDbLowerer(antiPlan, {
        siteId: SITE_A,
        time: antiPlan.context.time,
      });
      const antiOutput = antiPlan.outputs[0]!;
      const loweredAnti = antiLowerer.lower(antiOutput);
      expect(
        antiLowerer.isCandidateBoundedSlot(
          historicalOnly.id,
          historicalOnly.slots["relationship:page.session"]!,
        ),
      ).toBe(false);
      expect(
        antiLowerer.candidateActivitySessionRelation(historicalOnly.id),
      ).toBeUndefined();
      expect(
        antiLowerer.isCandidateActivitySessionRestricted(historicalOnly.id),
      ).toBe(false);
      const antiQuery = compileD1Query(
        antiLowerer.projectOutput(loweredAnti, [
          { name: "sessionId", slot: antiOutput.fields[0]!.slot, component: 1 },
        ]),
      );
      expect(
        (
          await createD1DatabaseClient(createSqliteD1Database(db)).all(
            antiQuery,
          )
        ).results,
      ).toEqual([{ sessionId: "s-historical" }]);

      const membershipBuilder = new LogicalPlanBuilder(context);
      const membershipLeft = membershipBuilder.source("page", {
        temporalDomain: "candidate",
        relationships: ["page.session"],
        attributes: ["page.path"],
      });
      const membershipRight = membershipBuilder.source("page", {
        temporalDomain: "candidate",
        relationships: ["page.session"],
      });
      const matchedPages = membershipBuilder.semiJoin(
        membershipLeft,
        membershipRight,
        [
          {
            left: "relationship:page.session",
            right: "relationship:page.session",
          },
        ],
      );
      membershipBuilder.output("matchedPages", matchedPages, [
        { name: "path", slot: "attribute:page.path" },
        { name: "session", slot: "relationship:page.session" },
      ]);
      const membershipPlan = membershipBuilder.finish();
      const membershipLowerer = new AnalyticsLogicalToDbLowerer(
        membershipPlan,
        { siteId: SITE_A, time: membershipPlan.context.time },
      );
      const membershipOutput = membershipPlan.outputs[0]!;
      const membershipQuery = compileD1Query(
        membershipLowerer.projectOutput(
          membershipLowerer.lower(membershipOutput),
          [
            { name: "path", slot: membershipOutput.fields[0]!.slot },
            {
              name: "sessionId",
              slot: membershipOutput.fields[1]!.slot,
              component: 1,
            },
          ],
        ),
      );
      const matchingRows = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(
          membershipQuery,
        )
      ).results as Array<{ readonly path: string; readonly sessionId: string }>;
      expect(
        membershipLowerer.isCandidateBoundedSlot(
          matchedPages.id,
          membershipOutput.fields[1]!.slot,
        ),
      ).toBe(true);
      expect(
        membershipLowerer.candidateActivitySessionRelation(matchedPages.id),
      ).toBe(membershipRight.id);
      expect(
        membershipLowerer.isCandidateActivitySessionRestricted(matchedPages.id),
      ).toBe(true);
      matchingRows.sort((left, right) =>
        String(left.path).localeCompare(String(right.path)),
      );
      expect(matchingRows).toEqual([
        { path: "/a", sessionId: "s-shared" },
        { path: "/b", sessionId: "s-shared" },
        { path: "/current", sessionId: "s-current" },
      ]);

      const scalarMembershipBuilder = new LogicalPlanBuilder(context);
      const scalarLeft = scalarMembershipBuilder.source("page", {
        temporalDomain: "candidate",
        attributes: ["page.path"],
      });
      const scalarRight = scalarMembershipBuilder.source("page", {
        temporalDomain: "candidate",
        attributes: ["page.path"],
      });
      const matchingPaths = scalarMembershipBuilder.semiJoin(
        scalarLeft,
        scalarRight,
        [{ left: "attribute:page.path", right: "attribute:page.path" }],
      );
      scalarMembershipBuilder.output("matchingPaths", matchingPaths, [
        { name: "path", slot: "attribute:page.path" },
      ]);
      const scalarMembershipPlan = scalarMembershipBuilder.finish();
      const scalarMembershipLowerer = new AnalyticsLogicalToDbLowerer(
        scalarMembershipPlan,
        { siteId: SITE_A, time: scalarMembershipPlan.context.time },
      );
      const scalarMembershipOutput = scalarMembershipPlan.outputs[0]!;
      const scalarMembershipQuery = compileD1Query(
        scalarMembershipLowerer.projectOutput(
          scalarMembershipLowerer.lower(scalarMembershipOutput),
          [{ name: "path", slot: scalarMembershipOutput.fields[0]!.slot }],
        ),
      );
      const matchedPaths = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(
          scalarMembershipQuery,
        )
      ).results as Array<{ readonly path: string }>;
      matchedPaths.sort((left, right) => left.path.localeCompare(right.path));
      expect(matchedPaths).toEqual([
        { path: "/a" },
        { path: "/b" },
        { path: "/current" },
        { path: "/empty" },
      ]);
    } finally {
      db.close();
    }
  });

  it("lowers registered Page and Event Observation carriers and proves identity through AntiJoin", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA } = setupSites(db);
      const pageOwner = addPage(
        db,
        siteA,
        "observation-carrier-page",
        "s-page",
        10,
        "/carrier-page",
      );
      const oldOwner = addPage(
        db,
        siteA,
        "observation-carrier-old-owner",
        "s-old",
        20,
        "/old-owner",
      );
      const newOwner = addPage(
        db,
        siteA,
        "observation-carrier-new-owner",
        "s-new",
        110,
        "/new-owner",
      );
      insertEvent(db, {
        eventId: "observation-carrier-event",
        site: siteA,
        visit: pageOwner,
        occurredAt: 30,
      });
      insertEvent(db, {
        eventId: "observation-carrier-old-event",
        site: siteA,
        visit: oldOwner,
        occurredAt: 40,
      });
      insertEvent(db, {
        eventId: "observation-carrier-new-event",
        site: siteA,
        visit: newOwner,
        occurredAt: 120,
      });
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

      const pageBuilder = new LogicalPlanBuilder(context);
      const pageObservation = pageBuilder.source("observation", {
        temporalDomain: "read",
        relationships: ["observation.session"],
        attributes: ["page.path"],
      });
      pageBuilder.output("pageObservation", pageObservation, [
        { name: "observation", slot: "entity" },
        { name: "path", slot: "attribute:page.path" },
        { name: "session", slot: "relationship:observation.session" },
      ]);
      const pagePlan = pageBuilder.finish();
      const pageLowerer = new AnalyticsLogicalToDbLowerer(pagePlan, {
        siteId: SITE_A,
        time: pagePlan.context.time,
      });
      const pageOutput = pagePlan.outputs[0]!;
      const pageQuery = compileD1Query(
        pageLowerer.projectOutput(pageLowerer.lower(pageOutput), [
          {
            name: "activityId",
            slot: pageOutput.fields[0]!.slot,
            component: 2,
          },
          { name: "path", slot: pageOutput.fields[1]!.slot },
          {
            name: "sessionId",
            slot: pageOutput.fields[2]!.slot,
            component: 1,
          },
        ]),
      );
      expect(
        (
          await createD1DatabaseClient(createSqliteD1Database(db)).all(
            pageQuery,
          )
        ).results,
      ).toEqual([
        {
          activityId: "observation-carrier-page",
          path: "/carrier-page",
          sessionId: "s-page",
        },
        {
          activityId: "observation-carrier-old-owner",
          path: "/old-owner",
          sessionId: "s-old",
        },
      ]);

      const eventBuilder = new LogicalPlanBuilder(context);
      const eventObservation = eventBuilder.source("observation", {
        temporalDomain: "read",
        relationships: ["observation.session"],
        attributes: ["event.name"],
      });
      eventBuilder.output("eventObservation", eventObservation, [
        { name: "observation", slot: "entity" },
        { name: "name", slot: "attribute:event.name" },
        { name: "session", slot: "relationship:observation.session" },
      ]);
      const eventPlan = eventBuilder.finish();
      const eventLowerer = new AnalyticsLogicalToDbLowerer(eventPlan, {
        siteId: SITE_A,
        time: eventPlan.context.time,
      });
      const eventOutput = eventPlan.outputs[0]!;
      const eventQuery = compileD1Query(
        eventLowerer.projectOutput(eventLowerer.lower(eventOutput), [
          {
            name: "activityId",
            slot: eventOutput.fields[0]!.slot,
            component: 2,
          },
          { name: "name", slot: eventOutput.fields[1]!.slot },
          {
            name: "sessionId",
            slot: eventOutput.fields[2]!.slot,
            component: 1,
          },
        ]),
      );
      expect(
        (
          await createD1DatabaseClient(createSqliteD1Database(db)).all(
            eventQuery,
          )
        ).results,
      ).toEqual([
        {
          activityId: "observation-carrier-event",
          name: "activity",
          sessionId: "s-page",
        },
        {
          activityId: "observation-carrier-old-event",
          name: "activity",
          sessionId: "s-old",
        },
      ]);

      const forwardingBuilder = new LogicalPlanBuilder(context);
      const forwardingEvents = forwardingBuilder.source("event", {
        temporalDomain: "read",
        relationships: ["event.observation"],
      });
      const forwardingObservations = forwardingBuilder.distinctEntity(
        forwardingEvents,
        "relationship:event.observation",
        "observation",
      );
      const forwardedLookup = forwardingBuilder.relationshipLookup(
        forwardingObservations,
        "observation.session",
      );
      forwardingBuilder.output("forwarded", forwardedLookup, [
        { name: "observation", slot: "observation" },
      ]);
      const forwardingPlan = forwardingBuilder.finish();
      const forwardingLowerer = new AnalyticsLogicalToDbLowerer(
        forwardingPlan,
        { siteId: SITE_A, time: forwardingPlan.context.time },
      );
      const forwardingOutput = forwardingPlan.outputs[0]!;
      const forwardingQuery = compileD1Query(
        forwardingLowerer.projectOutput(
          forwardingLowerer.lower(forwardingOutput),
          [
            {
              name: "eventId",
              slot: forwardingOutput.fields[0]!.slot,
              component: 2,
            },
          ],
        ),
      );
      const forwardedRows = (
        await createD1DatabaseClient(createSqliteD1Database(db)).all(
          forwardingQuery,
        )
      ).results as Array<{ readonly eventId: string }>;
      expect(forwardedRows.map((row) => row.eventId).sort()).toEqual([
        "observation-carrier-event",
        "observation-carrier-old-event",
      ]);

      const identityBuilder = new LogicalPlanBuilder(context);
      const historicalEvents = identityBuilder.source("event", {
        temporalDomain: "read",
        relationships: ["event.observation"],
      });
      const historicalObservations = identityBuilder.distinctEntity(
        historicalEvents,
        "relationship:event.observation",
        "observation",
      );
      const candidateEvents = identityBuilder.source("event", {
        temporalDomain: "candidate",
        relationships: ["event.observation"],
      });
      const candidateObservations = identityBuilder.distinctEntity(
        candidateEvents,
        "relationship:event.observation",
        "observation",
      );
      const remainingObservations = identityBuilder.antiJoin(
        historicalObservations,
        candidateObservations,
        [{ left: "observation", right: "observation" }],
      );
      const lookedUp = identityBuilder.relationshipLookup(
        remainingObservations,
        "observation.session",
      );
      identityBuilder.output("remaining", lookedUp, [
        { name: "observation", slot: "observation" },
        { name: "session", slot: "relationship:observation.session" },
      ]);
      const identityPlan = identityBuilder.finish();
      const identityLowerer = new AnalyticsLogicalToDbLowerer(identityPlan, {
        siteId: SITE_A,
        time: identityPlan.context.time,
      });
      const identityOutput = identityPlan.outputs[0]!;
      const identityQuery = compileD1Query(
        identityLowerer.projectOutput(identityLowerer.lower(identityOutput), [
          {
            name: "eventId",
            slot: identityOutput.fields[0]!.slot,
            component: 2,
          },
          {
            name: "sessionId",
            slot: identityOutput.fields[1]!.slot,
            component: 1,
          },
        ]),
      );
      expect(
        (
          await createD1DatabaseClient(createSqliteD1Database(db)).all(
            identityQuery,
          )
        ).results,
      ).toEqual([
        { eventId: "observation-carrier-event", sessionId: "s-page" },
        { eventId: "observation-carrier-old-event", sessionId: "s-old" },
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects nullable or scalar set inputs and refuses unbounded D1 source ranges", () => {
    const db = createMigratedDatabase();
    try {
      const { siteA } = setupSites(db);
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

      const nullableBuilder = new LogicalPlanBuilder(context);
      const nullablePages = nullableBuilder.source("page", {
        temporalDomain: "candidate",
        relationships: ["page.session"],
      });
      const nullableLeft = nullableBuilder.distinct(nullablePages, [
        { input: "relationship:page.session" },
      ]);
      const nullableRight = nullableBuilder.distinct(nullablePages, [
        { input: "relationship:page.session" },
      ]);
      const nullableUnion = nullableBuilder.setOperation("union", [
        nullableLeft,
        nullableRight,
      ]);
      nullableBuilder.output("nullableUnion", nullableUnion, [
        { name: "session", slot: "relationship:page.session" },
      ]);
      const nullablePlan = nullableBuilder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(nullablePlan, {
          siteId: SITE_A,
          time: nullablePlan.context.time,
        }).lower(nullablePlan.outputs[0]!),
      ).toThrow(/Set operations require a non-null composite Session key/u);

      const scalarBuilder = new LogicalPlanBuilder(context);
      const scalarPages = scalarBuilder.source("page", {
        temporalDomain: "candidate",
      });
      const counts = [0, 1].map(() =>
        scalarBuilder.aggregate(scalarPages, {}, [
          { name: "rows", kind: "count-rows" },
        ]),
      );
      const scalarUnion = scalarBuilder.setOperation("union", counts);
      scalarBuilder.output("scalarUnion", scalarUnion, [
        { name: "rows", slot: "rows" },
      ]);
      const scalarPlan = scalarBuilder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(scalarPlan, {
          siteId: SITE_A,
          time: scalarPlan.context.time,
        }).lower(scalarPlan.outputs[0]!),
      ).toThrow(/Set operations require a non-null composite Session key/u);

      const unboundedContext = {
        ...context,
        time: createSemanticTemporalDomains({
          candidate: CANDIDATE_RANGE as never,
          read: { kind: "retained-history" },
          reportingTimeZone: "UTC" as never,
          capturedAtMs: 200 as never,
        }),
      };
      const unboundedBuilder = new LogicalPlanBuilder(unboundedContext);
      const unboundedPages = unboundedBuilder.source("page", {
        temporalDomain: "read",
      });
      unboundedBuilder.output("unbounded", unboundedPages, [
        { name: "page", slot: "entity" },
      ]);
      const unboundedPlan = unboundedBuilder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(unboundedPlan, {
          siteId: SITE_A,
          time: unboundedPlan.context.time,
        }).lower(unboundedPlan.outputs[0]!),
      ).toThrow(/not a safe bounded D1 range/u);

      const observationBuilder = new LogicalPlanBuilder(context);
      const historicalObservations = observationBuilder.source("observation", {
        temporalDomain: "read",
        relationships: ["observation.session"],
      });
      observationBuilder.output(
        "historicalObservations",
        historicalObservations,
        [{ name: "session", slot: "relationship:observation.session" }],
      );
      const observationPlan = observationBuilder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(observationPlan, {
          siteId: SITE_A,
          time: observationPlan.context.time,
        }).lower(observationPlan.outputs[0]!),
      ).toThrow(
        /unqualified Observation source is supported only for the candidate Page\/Event union/u,
      );

      expect(siteA.id).toBe(SITE_A);
    } finally {
      db.close();
    }
  });

  it("lowers keyless scalar COUNT_ROWS joins and rejects keyed entity joins", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA } = setupSites(db);
      addPage(db, siteA, "scalar-join-a", "s-a", 110, "/a");
      addPage(db, siteA, "scalar-join-b", "s-b", 120, "/b");
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
      const pages = builder.source("page", { temporalDomain: "candidate" });
      const counts = ["leftRows", "rightRows"].map((name) =>
        builder.aggregate(pages, {}, [{ name, kind: "count-rows" }]),
      );
      const joinedCounts = builder.join(counts[0]!, counts[1]!, []);
      builder.output("counts", joinedCounts, [
        { name: "leftRows", slot: "leftRows" },
        { name: "rightRows", slot: "right.rightRows" },
      ]);
      const plan = builder.finish();
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_A,
        time: plan.context.time,
      });
      const output = plan.outputs[0]!;
      const query = compileD1Query(
        lowerer.projectOutput(lowerer.lower(output), [
          { name: "leftRows", slot: output.fields[0]!.slot },
          { name: "rightRows", slot: output.fields[1]!.slot },
        ]),
      );
      expect(
        (await createD1DatabaseClient(createSqliteD1Database(db)).all(query))
          .results,
      ).toEqual([{ leftRows: 2, rightRows: 2 }]);

      const keyedBuilder = new LogicalPlanBuilder(context);
      const leftPages = keyedBuilder.source("page", {
        temporalDomain: "candidate",
      });
      const rightPages = keyedBuilder.source("page", {
        temporalDomain: "candidate",
      });
      const keyedJoin = keyedBuilder.join(leftPages, rightPages, [
        { left: "entity", right: "entity" },
      ]);
      keyedBuilder.output("keyedJoin", keyedJoin, [
        { name: "page", slot: "entity" },
      ]);
      const keyedPlan = keyedBuilder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(keyedPlan, {
          siteId: SITE_A,
          time: keyedPlan.context.time,
        }).lower(keyedPlan.outputs[0]!),
      ).toThrow(/Only a keyless inner join of scalar relations is supported/u);
    } finally {
      db.close();
    }
  });

  it("rejects unsupported entity, payload, and mixed-activity Source contracts", () => {
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

    const sessionBuilder = new LogicalPlanBuilder(context);
    const sessions = sessionBuilder.source("session");
    sessionBuilder.output("session", sessions, [
      { name: "session", slot: "entity" },
    ]);
    const sessionPlan = sessionBuilder.finish();
    expect(() =>
      new AnalyticsLogicalToDbLowerer(sessionPlan, {
        siteId: SITE_A,
        time: sessionPlan.context.time,
      }).lower(sessionPlan.outputs[0]!),
    ).toThrow(/supports Page, Event, and Observation carriers only/u);

    const payloadBuilder = new LogicalPlanBuilder(context);
    const payloadEvents = payloadBuilder.source("event", {
      temporalDomain: "read",
      attributes: ["event.payload"],
    });
    payloadBuilder.output("payload", payloadEvents, [
      { name: "payload", slot: "attribute:event.payload" },
    ]);
    const payloadPlan = payloadBuilder.finish();
    expect(() =>
      new AnalyticsLogicalToDbLowerer(payloadPlan, {
        siteId: SITE_A,
        time: payloadPlan.context.time,
      }).lower(payloadPlan.outputs[0]!),
    ).toThrow(
      /No registered D1 primitive storage mapping exists for event\.payload/u,
    );

    const mixedBuilder = new LogicalPlanBuilder(context);
    const mixedObservations = mixedBuilder.source("observation", {
      temporalDomain: "candidate",
      relationships: ["observation.session"],
      attributes: ["page.path", "event.name"],
    });
    mixedBuilder.output("mixed", mixedObservations, [
      { name: "pagePath", slot: "attribute:page.path" },
      { name: "eventName", slot: "attribute:event.name" },
    ]);
    const mixedPlan = mixedBuilder.finish();
    expect(() =>
      new AnalyticsLogicalToDbLowerer(mixedPlan, {
        siteId: SITE_A,
        time: mixedPlan.context.time,
      }).lower(mixedPlan.outputs[0]!),
    ).toThrow(
      /Mixed Page\/Event bindings do not define one native Observation carrier/u,
    );
  });

  it("preserves observation bag rows and declared Event carrier row domains through Project", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA, siteB } = setupSites(db);
      const ownerA = addPage(
        db,
        siteA,
        "project-owner-a",
        "s-shared",
        110,
        "/a",
      );
      addPage(db, siteA, "project-owner-b", "s-shared", 120, "/b");
      insertEvent(db, {
        eventId: "project-shared-event",
        site: siteA,
        visit: ownerA,
        occurredAt: 130,
      });

      // The event table has a valid foreign key to the other site's name, but
      // the D1 native Event carrier is site scoped and requires a same-site
      // dictionary match. Projecting away event.name must keep that source
      // row domain instead of dropping the join with the dead value slot.
      const dictionaryOwner = addPage(
        db,
        siteA,
        "project-dictionary-owner",
        "s-dictionary",
        30,
        "/dictionary",
      );
      insertEvent(db, {
        eventId: "project-cross-site-name",
        site: siteA,
        visit: dictionaryOwner,
        occurredAt: 30,
        eventNameId: siteB.eventNameId,
      });

      // The event is site A data whose FK points at a site B visit. Projecting
      // away observation.session must not remove the declared owner carrier
      // join and silently widen this source's row domain.
      const ownerB = addPage(
        db,
        siteB,
        "project-cross-site-owner",
        "s-owner-b",
        31,
        "/owner",
      );
      insertEvent(db, {
        eventId: "project-cross-site-owner-event",
        site: siteA,
        visit: ownerB,
        occurredAt: 31,
      });

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
      const lowerProjection = async (
        attributes: readonly string[],
        projectedSlot:
          "relationship:observation.session" | "attribute:event.name",
        outputComponent?: number,
      ) => {
        const builder = new LogicalPlanBuilder(context);
        const observations = builder.source("observation", {
          temporalDomain: attributes.length === 0 ? "candidate" : "read",
          relationships: ["observation.session"],
          attributes,
        });
        const projected = builder.project(observations, {
          value: builder.slot(observations, projectedSlot),
        });
        builder.output("projected", projected, [
          { name: "value", slot: "value" },
        ]);
        const plan = builder.finish();
        const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
          siteId: SITE_A,
          time: plan.context.time,
        });
        const lowered = lowerer.lower(plan.outputs[0]!);
        const slot = plan.outputs[0]!.fields[0]!.slot;
        const relation = lowerer.projectOutput(lowered, [
          {
            name: "value",
            slot,
            ...(outputComponent === undefined
              ? {}
              : { component: outputComponent }),
          },
        ]);
        const result = await createD1DatabaseClient(
          createSqliteD1Database(db),
        ).all(compileD1Query(relation));
        return result.results;
      };

      const projectedSessions = (await lowerProjection(
        [],
        "relationship:observation.session",
        1,
      )) as Array<{ readonly value: string | null }>;
      expect(projectedSessions.map(({ value }) => value)).toEqual([
        "s-shared",
        "s-shared",
        "s-shared",
      ]);

      const projectedSessionAfterDeadName = await lowerProjection(
        ["event.name"],
        "relationship:observation.session",
        1,
      );
      expect(projectedSessionAfterDeadName).toEqual([]);

      const projectedNameAfterDeadOwner = await lowerProjection(
        ["event.name"],
        "attribute:event.name",
      );
      expect(projectedNameAfterDeadOwner).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps Event identity rows when the same-site Session owner is absent", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteA, siteB } = setupSites(db);
      // This Page and Event deliberately share a local ID, while the Event
      // belongs to a different Page. Event identity lookup must use the
      // Observation kind instead of treating the shared ID as a Page key.
      addPage(db, siteA, "shared-page-event-id", "s-page-owner", 10, "/page");
      const eventOwner = addPage(
        db,
        siteA,
        "event-owner",
        "s-event-owner",
        11,
        "/event-owner",
      );
      const emptyOwner = addPage(
        db,
        siteA,
        "empty-owner",
        "",
        12,
        "/empty-owner",
      );
      // visits.session_id is NOT NULL in the persisted schema, so exercise
      // the absent/null key through the cross-site owner below and use an
      // empty same-site Session ID for the stored-but-not-present case.
      const crossSiteOwner = addPage(
        db,
        siteB,
        "cross-site-owner",
        "s-cross-site",
        14,
        "/cross-site-owner",
      );
      for (const row of [
        {
          eventId: "shared-page-event-id",
          visit: eventOwner,
          occurredAt: 20,
        },
        { eventId: "second-event", visit: eventOwner, occurredAt: 21 },
        { eventId: "empty-event", visit: emptyOwner, occurredAt: 22 },
        {
          eventId: "cross-site-event",
          visit: crossSiteOwner,
          occurredAt: 23,
        },
      ]) {
        insertEvent(db, { ...row, site: siteA });
      }

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
      const buildPlan = (output: "lookup" | "count") => {
        const builder = new LogicalPlanBuilder(context);
        const events = builder.source("event", {
          temporalDomain: "read",
          relationships: ["event.observation"],
        });
        const observations = builder.distinctEntity(
          events,
          "relationship:event.observation",
          "observation",
        );
        const lookedUp = builder.relationshipLookup(
          observations,
          "observation.session",
        );
        if (output === "lookup") {
          const projected = builder.project(lookedUp, {
            observation: builder.slot(lookedUp, "observation"),
            session: builder.slot(lookedUp, "relationship:observation.session"),
          });
          builder.output("lookup", projected, [
            { name: "observation", slot: "observation" },
            { name: "session", slot: "session" },
          ]);
        } else {
          // Two Events share one Session. Projecting only that Session key
          // must retain both Observation rows for COUNT_ROWS.
          const sessionRows = builder.project(lookedUp, {
            session: builder.slot(lookedUp, "relationship:observation.session"),
          });
          const counted = builder.aggregate(sessionRows, {}, [
            { name: "rows", kind: "count-rows" },
          ]);
          builder.output("count", counted, [{ name: "rows", slot: "rows" }]);
        }
        return builder.finish();
      };
      const lookupPlan = buildPlan("lookup");
      const lookupLowerer = new AnalyticsLogicalToDbLowerer(lookupPlan, {
        siteId: SITE_A,
        time: lookupPlan.context.time,
      });
      const lookupOutput = lookupPlan.outputs[0]!;
      const loweredLookup = lookupLowerer.lower(lookupOutput);
      const observation = lookupLowerer.lowerSourceValue(
        loweredLookup,
        lookupOutput.fields.find((field) => field.name === "observation")!.slot,
        "test.observation",
      );
      const session = lookupLowerer.lowerSourceValue(
        loweredLookup,
        lookupOutput.fields.find((field) => field.name === "session")!.slot,
        "test.session",
      );
      if (observation.kind !== "entity" || session.kind !== "entity") {
        throw new Error("Expected Observation and Session entity outputs.");
      }
      const rows = await createD1DatabaseClient(createSqliteD1Database(db)).all(
        compileD1Query(
          project(loweredLookup.relation, {
            eventId: observation.keys[2]!,
            sessionSitePk: session.keys[0]!,
            sessionId: session.keys[1]!,
            present: session.present,
          }),
        ),
      );
      const actualRows = rows.results.map((row) => ({
        ...row,
        present: Number(row.present),
      })) as unknown as Array<{
        readonly eventId: string;
        readonly sessionSitePk: number | null;
        readonly sessionId: string | null;
        readonly present: number;
      }>;
      actualRows.sort((a, b) => a.eventId.localeCompare(b.eventId));
      const expectedByEvent: Record<
        string,
        {
          readonly sessionSitePk: number | null;
          readonly sessionId: string | null;
          readonly present: number;
        }
      > = {
        "shared-page-event-id": {
          sessionSitePk: siteA.key,
          sessionId: "s-event-owner",
          present: 1,
        },
        "second-event": {
          sessionSitePk: siteA.key,
          sessionId: "s-event-owner",
          present: 1,
        },
        "empty-event": {
          sessionSitePk: siteA.key,
          sessionId: "",
          present: 0,
        },
        "cross-site-event": {
          sessionSitePk: null,
          sessionId: null,
          present: 0,
        },
      };
      expect(actualRows).toHaveLength(4);
      for (const [eventId, expected] of Object.entries(expectedByEvent)) {
        expect(actualRows.filter((row) => row.eventId === eventId)).toEqual([
          { eventId, ...expected },
        ]);
      }

      const countPlan = buildPlan("count");
      const countLowerer = new AnalyticsLogicalToDbLowerer(countPlan, {
        siteId: SITE_A,
        time: countPlan.context.time,
      });
      const countOutput = countPlan.outputs[0]!;
      const loweredCount = countLowerer.lower(countOutput);
      const countQuery = compileD1Query(
        countLowerer.projectOutput(loweredCount, [
          { name: "rows", slot: countOutput.fields[0]!.slot },
        ]),
      );
      expect(
        (
          await createD1DatabaseClient(createSqliteD1Database(db)).all(
            countQuery,
          )
        ).results,
      ).toEqual([{ rows: 4 }]);
    } finally {
      db.close();
    }
  });

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
      expect(lowered.query.bindings).toHaveLength(16);
      expect(lowered.query.sql).toContain("UNION");
      expect(lowered.query.sql).toContain("TRIM(");
      expect(lowered.query.sql).toContain("EXISTS (");
      expect(lowered.query.bindings).toContain(SITE_A);

      const plan = explainQueryPlan(db, lowered.query);
      expect(plan.length).toBeGreaterThan(0);
      const explain = plan.join("\n");
      expect(explain).toMatch(
        /SEARCH \w+ USING INDEX idx_visits_site_pk_started_at \(site_pk=\? AND started_at>\? AND started_at<\?\)/u,
      );
      expect(explain).toMatch(
        /SEARCH \w+ USING INDEX idx_custom_events_site_pk_time \(site_pk=\? AND occurred_at>\? AND occurred_at<\?\)/u,
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
    const redundantBoolean = lowerAnalyticsPagePathSessionPlan(
      asLogicalPlan(changedExpression),
    );
    expect(redundantBoolean.kind).toBe("supported");
    if (redundantBoolean.kind !== "supported")
      throw new Error("Expected the one-term Boolean AND to be supported.");
    expect(redundantBoolean.query.sql).toBe(base.query.sql);
    expect(redundantBoolean.query.bindings).toEqual(base.query.bindings);

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
      reason: expect.stringContaining("page.title"),
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
            readonly pageRangeIndexSearches: number;
            readonly eventRangeIndexSearches: number;
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
        expect(explain.some((line) => /^SCAN t\d+\b/u.test(line))).toBe(false);
        expect(explainText).toMatch(
          /SEARCH \w+ USING INDEX idx_visits_site_pk_started_at \(site_pk=\? AND started_at>\? AND started_at<\?\)/u,
        );
        expect(explainText).toMatch(
          /SEARCH \w+ USING INDEX idx_custom_events_site_pk_time \(site_pk=\? AND occurred_at>\? AND occurred_at<\?\)/u,
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
            pageRangeIndexSearches: countExplain(
              /SEARCH \w+ USING INDEX idx_visits_site_pk_started_at \(site_pk=\? AND started_at>\? AND started_at<\?\)/u,
            ),
            eventRangeIndexSearches: countExplain(
              /SEARCH \w+ USING INDEX idx_custom_events_site_pk_time \(site_pk=\? AND occurred_at>\? AND occurred_at<\?\)/u,
            ),
            visitPrimaryKeyLookups: countExplain(
              /SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid=\?\)/u,
            ),
            unionTempTrees: countExplain(/UNION USING TEMP B-TREE/u),
          },
        };
      }
      const boundaryCosts = [];
      const boundaryClient = createD1DatabaseClient(createSqliteD1Database(db));
      for (const leafCount of [8, 12] as const) {
        const document = filterDocument({
          kind: "and",
          children: Array.from({ length: leafCount }, (_, index) =>
            index % 2 === 0
              ? pathCondition(`/boundary-page-${leafCount}-${index}`)
              : eventNameCondition(`boundary-event-${leafCount}-${index}`),
          ),
        });
        const normalized = normalizeFilterDocument(
          document,
          analyticsFilterRegistry,
        );
        expect(countConditionLeaves(normalized.root)).toBe(leafCount);
        const lowered = lower(document);
        if (lowered.kind === "unsupported") {
          expect(lowered).toMatchObject({
            capability: "d1-query-budget-exceeded",
            node: "compiled-query",
          });
          boundaryCosts.push({
            leafCount,
            kind: lowered.kind,
            reason: lowered.reason,
          });
          continue;
        }
        const sqlBytes = new TextEncoder().encode(lowered.query.sql).length;
        const bindings = lowered.query.bindings?.length ?? 0;
        expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
        const explain = explainQueryPlan(db, lowered.query);
        const count = (pattern: RegExp) =>
          explain.filter((line) => pattern.test(line)).length;
        expect(count(/^SCAN t\d+\b/u)).toBe(0);
        const boundaryRows = (await boundaryClient.all(lowered.query))
          .results as Array<{
          readonly site_pk: number;
          readonly session_id: string;
        }>;
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
        const expectedBoundarySessions = evaluateCandidateRestrictedSets(
          document.root,
          {
            pages: evaluatorPages,
            events: evaluatorEvents,
            coverageRange: { startMs: 0, endExclusiveMs: 250 },
          },
          candidateSessionIds,
        );
        expect(new Set(boundaryRows.map((row) => row.session_id))).toEqual(
          expectedBoundarySessions,
        );
        expect(boundaryRows.every((row) => row.site_pk === siteA.key)).toBe(
          true,
        );
        boundaryCosts.push({
          leafCount,
          kind: lowered.kind,
          sqlBytes,
          bindings,
          cteCount: cteDefinitionCount(lowered.query.sql),
          explain: {
            operations: explain.length,
            pageRangeIndexSearches: count(
              /idx_visits_site_pk_started_at \(site_pk=\? AND started_at>\? AND started_at<\?\)/u,
            ),
            eventRangeIndexSearches: count(
              /idx_custom_events_site_pk_time \(site_pk=\? AND occurred_at>\? AND occurred_at<\?\)/u,
            ),
            visitIdUniqueIndexSearches: count(
              /sqlite_autoindex_visits_1 \(visit_id=\?\)/u,
            ),
            eventIdUniqueIndexSearches: count(
              /sqlite_autoindex_custom_events_1 \(event_id=\?\)/u,
            ),
          },
        });
      }
      // SQLite versions can represent the same UNION plan with different
      // EXPLAIN rows. Require bounded Page/Event source searches, then keep
      // statement, binding, SQL size, and owner lookup costs visible below.
      for (const cost of Object.values(costs)) {
        expect(cost.explain.pageRangeIndexSearches).toBeGreaterThan(0);
        expect(cost.explain.eventRangeIndexSearches).toBeGreaterThan(0);
      }
      expect(
        boundaryCosts.map(({ leafCount, kind }) => ({ leafCount, kind })),
      ).toEqual([
        { leafCount: 8, kind: "supported" },
        { leafCount: 12, kind: "supported" },
      ]);
      expect(boundaryCosts[0]).toMatchObject({
        sqlBytes: 49_629,
        bindings: 54,
        cteCount: 12,
        explain: {
          pageRangeIndexSearches: 5,
          eventRangeIndexSearches: 5,
          visitIdUniqueIndexSearches: 17,
          eventIdUniqueIndexSearches: 8,
        },
      });
      expect(boundaryCosts[1]).toMatchObject({
        sqlBytes: 67_403,
        bindings: 74,
        cteCount: 16,
        explain: {
          pageRangeIndexSearches: 7,
          eventRangeIndexSearches: 7,
          visitIdUniqueIndexSearches: 25,
          eventIdUniqueIndexSearches: 12,
        },
      });
      expect(boundaryCosts[0]!.explain!.operations).toBeLessThanOrEqual(260);
      expect(boundaryCosts[1]!.explain!.operations).toBeLessThanOrEqual(380);
      expect(costs).toMatchObject({
        and: {
          statements: 1,
          bindings: 21,
          sqlBytes: 20_574,
          explain: {
            visitPrimaryKeyLookups: 1,
          },
        },
        or: {
          statements: 1,
          bindings: 17,
          sqlBytes: 16_145,
          explain: {
            visitPrimaryKeyLookups: 1,
          },
        },
        not: {
          statements: 1,
          bindings: 16,
          sqlBytes: 16_765,
          explain: {
            visitPrimaryKeyLookups: 1,
          },
        },
        "nested-and-not": {
          statements: 1,
          bindings: 21,
          sqlBytes: 21_104,
          explain: {
            visitPrimaryKeyLookups: 1,
          },
        },
        "or-set-operation": {
          statements: 1,
          bindings: 21,
          sqlBytes: 20_927,
          explain: {
            visitPrimaryKeyLookups: 1,
          },
        },
      });
      expect(costs["six-leaf-mixed"]).toMatchObject({
        statements: 1,
        bindings: 44,
        sqlBytes: 41_187,
        cteCount: 10,
        explain: {
          operations: 196,
          pageRangeIndexSearches: 4,
          eventRangeIndexSearches: 4,
          visitPrimaryKeyLookups: 7,
        },
      });
      for (const [name, maxOperations, maxUnionTempTrees] of [
        ["and", 70, 2],
        ["or", 40, 1],
        ["not", 50, 2],
        ["nested-and-not", 80, 3],
        ["or-set-operation", 80, 4],
      ] as const) {
        expect(costs[name].explain.operations, name).toBeLessThanOrEqual(
          maxOperations,
        );
        expect(costs[name].explain.unionTempTrees, name).toBeLessThanOrEqual(
          maxUnionTempTrees,
        );
      }
      const packedMembershipFilter = filterDocument(
        inCondition("page.path", [
          "/a",
          ...Array.from({ length: 127 }, (_, index) => `/budget-${index}`),
        ]),
      );
      const packedMembership = lower(packedMembershipFilter);
      expect(packedMembership.kind).toBe("supported");
      if (packedMembership.kind !== "supported")
        throw new Error(
          `Unexpected membership refusal: ${packedMembership.reason}`,
        );
      expect(packedMembership.query.sql).toContain("json_each(?)");
      expect(packedMembership.query.bindings?.length ?? 0).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      const directPlanMembership = lowerAnalyticsPagePathSessionPlan(
        buildDirectSessionPlan(packedMembershipFilter),
      );
      expect(directPlanMembership.kind).toBe("supported");
      if (directPlanMembership.kind !== "supported")
        throw new Error(
          `Unexpected direct membership refusal: ${directPlanMembership.reason}`,
        );
      expect(directPlanMembership.query.sql).toBe(packedMembership.query.sql);
      expect(directPlanMembership.query.bindings).toEqual(
        packedMembership.query.bindings,
      );

      const membershipTrace: SqliteD1Trace = {
        preparedSql: [],
        bindings: [],
      };
      const membershipClient = createD1DatabaseClient(
        createSqliteD1Database(db, membershipTrace),
      );
      const membershipResult = await membershipClient.all(
        packedMembership.query,
      );
      const actualMembershipRows = membershipResult.results as Array<{
        readonly site_pk: number;
        readonly session_id: string;
      }>;
      const membershipCandidateIds = new Set(
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
      const expectedMembership = evaluateCandidateRestrictedSets(
        packedMembershipFilter.root,
        {
          pages: evaluatorPages,
          events: evaluatorEvents,
          coverageRange: { startMs: 0, endExclusiveMs: 250 },
        },
        membershipCandidateIds,
      );
      expect(
        new Set(actualMembershipRows.map((row) => row.session_id)),
      ).toEqual(expectedMembership);
      expect(
        actualMembershipRows.every((row) => row.site_pk === siteA.key),
      ).toBe(true);
      expect(membershipTrace.preparedSql).toHaveLength(1);
      expect(membershipTrace.bindings[0]).toHaveLength(
        packedMembership.query.bindings?.length ?? 0,
      );
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
            pageRangeIndexSearches: number;
            eventRangeIndexSearches: number;
            eventTimeRangeSearches: number;
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
              pageRangeIndexSearches: countExplain(
                /SEARCH \w+ USING INDEX idx_visits_site_pk_started_at \(site_pk=\? AND started_at>\? AND started_at<\?\)/u,
              ),
              eventRangeIndexSearches: countExplain(
                /SEARCH \w+ USING INDEX idx_custom_events_site_pk_time \(site_pk=\? AND occurred_at>\? AND occurred_at<\?\)/u,
              ),
              eventTimeRangeSearches: countExplain(
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
          ).toBe(3);
        }
      }

      expect(observedCosts["event-only"]).toMatchObject({
        statements: 1,
        bindings: 16,
        sqlLength: 13_940,
        explain: {
          eventTimeRangeSearches: 2,
          integerPrimaryKeyLookups: 3,
          ownerVisitIndexLookups: 3,
        },
      });
      expect(
        observedCosts["event-only"].explain.operations,
      ).toBeLessThanOrEqual(45);
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
      const candidateEventDomain = lowerAnalyticsPagePathSessionPlan(
        asLogicalPlan(eventDomain),
      );
      expect(candidateEventDomain.kind).toBe("supported");
      if (candidateEventDomain.kind !== "supported")
        throw new Error("Expected a candidate-domain Event plan to lower.");
      expect(candidateEventDomain.query.bindings).not.toEqual(
        eventLowering.query.bindings,
      );
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
      const largeTitleMembership = [
        "Checkout",
        ...Array.from(
          { length: 127 },
          (_, index) => `title-distractor-${index}`,
        ),
      ];
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
          name: "title-not-in-128-preserves-read-page-guard",
          document: filterDocument(
            fieldCondition("page.title", "notIn", largeTitleMembership),
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
          name: "root-not-title-includes-no-read-candidates",
          document: filterDocument({
            kind: "not",
            child: inCondition("page.title", largeTitleMembership),
          }),
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

      const primitiveNotInExpected = cases.find(
        (item) => item.name === "title-not-in-128-preserves-read-page-guard",
      )!.expected;
      const rootNotExpected = cases.find(
        (item) => item.name === "root-not-title-includes-no-read-candidates",
      )!.expected;
      expect(primitiveNotInExpected).not.toContain("s-no-read");
      expect(primitiveNotInExpected).not.toContain("s-event-only");
      expect(rootNotExpected).toContain("s-no-read");
      expect(rootNotExpected).toContain("s-event-only");
      expect(rootNotExpected).not.toEqual(primitiveNotInExpected);

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
