import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  type CompiledQuery,
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
  lowerFilterDocumentToScope,
  planSemanticAggregateQuery,
} from "@/lib/edge/analytics/engine";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  lowerAnalyticsFilteredSessionCountPlan,
  lowerAnalyticsFilteredSessionViewsPlan,
  lowerAnalyticsPagePathToSessionQuery,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-page-session-lowering";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import { createInvocationLogger } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
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

const SITE_ID = "string-match-site";
const CANDIDATE_RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const READ_RANGE = { startMs: 0, endExclusiveMs: 100 } as const;

/** node:sqlite expects booleans as SQLite integers; D1 accepts boolean bindings. */
function sqliteCompatibleQuery<Row extends object>(
  query: CompiledQuery<Row>,
): CompiledQuery<Row> {
  const bindings = query.bindings?.map((binding) =>
    typeof binding === "boolean" ? Number(binding) : binding,
  );
  return { ...query, ...(bindings ? { bindings } : {}) };
}

interface PageSeed {
  readonly visitId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly pathname: string;
  readonly title: string;
  readonly query: string;
  readonly hash: string;
}

interface EventSeed {
  readonly eventId: string;
  readonly visit: PageSeed;
  readonly occurredAt: number;
  readonly name: string;
}

function filterDocument(root: unknown): FilterDocument {
  return { version: 1, root } as unknown as FilterDocument;
}

function fieldCondition(
  field: "page.path" | "page.title" | "page.query" | "page.hash" | "event.name",
  operator: "contains" | "startsWith" | "endsWith",
  value: string,
) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator,
    value,
  } as const;
}

function setupSite(db: DatabaseSync): number {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(SITE_ID);
  const row = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  return row.site_pk;
}

function insertPage(
  db: DatabaseSync,
  sitePk: number,
  input: Omit<PageSeed, "title" | "query" | "hash"> & {
    readonly title?: string;
    readonly query?: string;
    readonly hash?: string;
  },
): PageSeed {
  const page: PageSeed = {
    ...input,
    title: input.title ?? "",
    query: input.query ?? "",
    hash: input.hash ?? "",
  };
  db.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, title, query_string, hash_fragment, site_pk
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, 'example.test', ?, ?, ?, ?)`,
  ).run(
    page.visitId,
    SITE_ID,
    `visitor-${page.visitId}`,
    page.sessionId,
    page.startedAt,
    page.startedAt,
    page.pathname,
    page.title,
    page.query,
    page.hash,
    sitePk,
  );
  return page;
}

function insertEvent(db: DatabaseSync, sitePk: number, event: EventSeed): void {
  db.prepare(
    "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?) ON CONFLICT(site_pk, name) DO NOTHING",
  ).run(SITE_ID, event.name, event.occurredAt, sitePk);
  const name = db
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(sitePk, event.name) as { readonly id: number };
  db.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(
    event.eventId,
    SITE_ID,
    sitePk,
    event.visit.visitId,
    name.id,
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
      "page.title": page.title,
      "page.query": page.query,
      "page.hash": page.hash,
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
    fields: { "event.name": event.name },
    payload: {},
  };
}

function makeContext() {
  return {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: CANDIDATE_RANGE as never,
      read: { kind: "bounded", range: READ_RANGE as never },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 200 as never,
    }),
    scope: resolveAnalyticsScope("session"),
  };
}

function buildSessionPlan(
  input: unknown,
  output: "identity" | "sessions" | "views" = "identity",
): ValidatedLogicalPlan {
  const document = normalizeFilterDocument(input, analyticsFilterRegistry);
  const context = makeContext();
  const builder = new LogicalPlanBuilder(context);
  const lowered = lowerFilterDocumentToScope(
    builder,
    analyzeFilterDocument(document, analyticsFilterRegistry),
    { targetScope: "session", resolveTemporalDomain: () => "read" },
  );
  if (lowered.kind !== "supported")
    throw new Error(
      `Expected a supported Session filter, got ${lowered.kind === "unsupported" ? lowered.reason : lowered.kind}.`,
    );

  if (output === "identity") {
    builder.output("matches", lowered.selection.relation, [
      { name: "session", slot: "entity" },
    ]);
    return builder.finish();
  }

  if (output === "sessions") {
    const sessionDataset = new LazyEligibleDataset({
      subject: context.subject,
      scope: {
        kind: "matching",
        target: "session",
        relation: lowered.selection.relation,
        entitySlotName: "entity",
      },
      resolveRelation(entity) {
        if (entity === "session") return lowered.selection.relation;
        return builder.source(entity);
      },
      resolveAssociation() {
        throw new Error("The ungrouped sessions count uses no associations.");
      },
    });
    return planSemanticAggregateQuery(
      builder,
      { context, dimensions: [], metrics: ["sessions"], sort: [] },
      sessionDataset,
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
  const viewsDataset = new LazyEligibleDataset({
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
      throw new Error("The ungrouped views count uses no associations.");
    },
  });
  return planSemanticAggregateQuery(
    builder,
    { context, dimensions: [], metrics: ["views"], sort: [] },
    viewsDataset,
  );
}

function evaluateCandidateSets(
  expression: unknown,
  dataset: {
    readonly pages: readonly FilterEvaluationEntity[];
    readonly events: readonly FilterEvaluationEntity[];
    readonly coverageRange: {
      readonly startMs: number;
      readonly endExclusiveMs: number;
    };
  },
  candidates: ReadonlySet<string>,
): ReadonlySet<string> {
  const evaluate = (input: unknown): Set<string> => {
    if (!input || typeof input !== "object")
      throw new Error("Expected a Filter v1 Boolean expression.");
    const node = input as Record<string, unknown>;
    if (node.kind === "condition") {
      const ids = evaluateFilterDocument(filterDocument(node), dataset, {
        scope: "session",
        candidateRange: CANDIDATE_RANGE,
        filterRange: READ_RANGE,
        readRange: READ_RANGE,
        reportingTimeZone: "UTC",
        capturedAtMs: 200,
      }).matchingScopeEntityIds;
      return new Set([...ids].filter((id) => candidates.has(id)));
    }
    if (node.kind === "not") {
      const child = evaluate(node.child);
      return new Set([...candidates].filter((id) => !child.has(id)));
    }
    if (node.kind === "and" || node.kind === "or") {
      if (!Array.isArray(node.children))
        throw new Error("Expected Boolean children.");
      const children = node.children.map(evaluate);
      if (node.kind === "and")
        return new Set(
          [...(children[0] ?? [])].filter((id) =>
            children.slice(1).every((child) => child.has(id)),
          ),
        );
      return new Set(children.flatMap((child) => [...child]));
    }
    throw new Error(`Unsupported Filter v1 node '${String(node.kind)}'.`);
  };
  return evaluate(expression);
}

describe("Analytics shared exact string matching", () => {
  it("lowers all five native Page/Event fields with literal Unicode matching", async () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const sitePk = setupSite(db);
      const pages: PageSeed[] = [];
      const events: EventSeed[] = [];
      const addPage = (
        visitId: string,
        sessionId: string,
        startedAt: number,
        values: Partial<
          Pick<PageSeed, "pathname" | "title" | "query" | "hash">
        > = {},
      ) => {
        const page = insertPage(db, sitePk, {
          visitId,
          sessionId,
          startedAt,
          pathname: values.pathname ?? "",
          title: values.title,
          query: values.query,
          hash: values.hash,
        });
        pages.push(page);
        return page;
      };
      const addEvent = (
        eventId: string,
        visit: PageSeed,
        occurredAt: number,
        name: string,
      ) => {
        const event = { eventId, visit, occurredAt, name };
        insertEvent(db, sitePk, event);
        events.push(event);
      };

      addPage("read-alpha", "s-alpha", 10, {
        pathname: "/Straße/Root/✨tail",
        title: "\uFEFFNeedle\u200A",
        query: "utm=gold;tag=%_\0x",
        hash: "section\0tail",
      });
      addPage("candidate-alpha", "s-alpha", 110);
      addPage("read-blocked", "s-blocked", 11, {
        pathname: "/Straße/Root/blocked",
        title: "Blocked page",
        query: "utm=gold",
        hash: "section-tail",
      });
      addPage("candidate-blocked", "s-blocked", 111);
      addPage("read-event", "s-event", 12, {
        pathname: "/plain",
        title: "Ready",
        query: "utm=gold",
        hash: "section-tail",
      });
      addPage("candidate-event", "s-event", 112);
      addEvent(
        "event-purchase",
        addPage("event-owner", "s-event", 350, { title: "Ready" }),
        52,
        "PurchaseComplete",
      );
      addPage("read-selector-miss", "s-selector-miss", 13, {
        pathname: "/Straße/Root",
        title: "Ready",
        query: "campaign=none",
        hash: "section-tail",
      });
      addPage("candidate-selector-miss", "s-selector-miss", 113);
      addPage("read-empty", "s-empty", 14, {
        pathname: "",
        title: "",
        query: "",
        hash: "",
      });
      addPage("candidate-empty", "s-empty", 114);
      addPage("read-empty-fields", "s-empty-fields", 15, {
        pathname: "/plain",
        title: "",
        query: "utm=gold",
        hash: "section-tail",
      });
      addPage("candidate-empty-fields", "s-empty-fields", 115);
      addPage("candidate-no-read", "s-no-read", 116);

      const ecmaWhitespace = [
        0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000,
        0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
        0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
      ];
      ecmaWhitespace.forEach((codePoint, index) => {
        const whitespace = String.fromCodePoint(codePoint);
        addPage(
          `read-whitespace-${index}`,
          `s-whitespace-${index}`,
          20 + index,
          {
            title: `${whitespace}Needle${whitespace}`,
          },
        );
        addPage(
          `candidate-whitespace-${index}`,
          `s-whitespace-${index}`,
          120 + index,
        );
      });

      const dataset = {
        pages: pages.map(pageEntity),
        events: events.map(eventEntity),
        coverageRange: { startMs: 0, endExclusiveMs: 400 },
      };
      const candidateIds = new Set(
        pages
          .filter(
            (page) =>
              page.startedAt >= CANDIDATE_RANGE.startMs &&
              page.startedAt < CANDIDATE_RANGE.endExclusiveMs,
          )
          .map((page) => page.sessionId),
      );
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const logger = createInvocationLogger({
        source: "worker",
        trigger: "request",
      });
      const env = instrumentEnv(
        {
          DB: createSqliteD1Database(db, trace),
          INGEST_DO: {} as DurableObjectNamespace,
        } as Env,
        logger,
      );
      const client = createD1DatabaseClient(env.DB);

      let whitespaceTitleMatches = new Set<string>();
      let emptyPatternBindings = -1;
      let titlePatternBindings = -1;
      const cases = [
        fieldCondition("page.path", "contains", "Straße"),
        fieldCondition("page.path", "startsWith", "/Straße"),
        fieldCondition("page.path", "endsWith", "✨tail"),
        fieldCondition("page.title", "contains", "Needle"),
        fieldCondition("page.title", "startsWith", "Needle"),
        fieldCondition("page.title", "endsWith", "Needle"),
        fieldCondition("page.query", "contains", "%_\0x"),
        fieldCondition("page.query", "startsWith", "utm="),
        fieldCondition("page.hash", "endsWith", "\0tail"),
        fieldCondition("event.name", "startsWith", "Purchase"),
        fieldCondition("page.path", "contains", "/straße"),
        fieldCondition("page.title", "contains", ""),
      ] as const;
      for (const condition of cases) {
        const document = filterDocument(condition);
        const lowered = lowerAnalyticsPagePathToSessionQuery({
          document,
          siteIds: [SITE_ID as never],
          candidateRange: CANDIDATE_RANGE as never,
          readRange: READ_RANGE as never,
          reportingTimeZone: "UTC" as never,
          capturedAtMs: 200 as never,
        });
        expect(
          lowered.kind,
          `${condition.target.field} ${condition.operator}`,
        ).toBe("supported");
        if (lowered.kind !== "supported")
          throw new Error("Expected native string matching to lower.");
        const actual = new Set(
          (
            (await client.all(sqliteCompatibleQuery(lowered.query)))
              .results as Array<{
              readonly session_id: string;
            }>
          ).map((row) => row.session_id),
        );
        const expected = evaluateFilterDocument(document, dataset, {
          scope: "session",
          candidateRange: CANDIDATE_RANGE,
          filterRange: READ_RANGE,
          readRange: READ_RANGE,
          reportingTimeZone: "UTC",
          capturedAtMs: 200,
        }).matchingScopeEntityIds;
        expect(
          actual,
          `${condition.target.field} ${condition.operator}`,
        ).toEqual(expected);
        if (
          condition.target.field === "page.title" &&
          condition.operator === "contains" &&
          condition.value === "Needle"
        ) {
          whitespaceTitleMatches = actual;
          titlePatternBindings = lowered.query.bindings?.length ?? 0;
        }
        if (
          condition.target.field === "page.title" &&
          condition.operator === "contains" &&
          condition.value.length === 0
        )
          emptyPatternBindings = lowered.query.bindings?.length ?? 0;
        else if (condition.value.length > 0) {
          expect(lowered.query.bindings).toContain(condition.value.trim());
          expect(lowered.query.sql).not.toContain(condition.value.trim());
        }
      }
      expect(titlePatternBindings).toBe(emptyPatternBindings + 1);
      expect(
        ecmaWhitespace.map((_, index) =>
          whitespaceTitleMatches.has(`s-whitespace-${index}`),
        ),
      ).toEqual(ecmaWhitespace.map(() => true));
      expect(whitespaceTitleMatches.has("s-empty")).toBe(false);

      const selectorDocument = filterDocument({
        kind: "and",
        children: [
          {
            kind: "or",
            children: [
              fieldCondition("page.path", "contains", "Root"),
              fieldCondition("event.name", "endsWith", "Complete"),
            ],
          },
          {
            kind: "not",
            child: fieldCondition("page.title", "startsWith", "Blocked"),
          },
          {
            kind: "condition",
            target: {
              kind: "selector",
              collection: { kind: "entity-root", entity: "event" },
              predicate: {
                kind: "and",
                children: [
                  fieldCondition("event.name", "contains", "Purchase"),
                  fieldCondition("event.name", "endsWith", "Complete"),
                ],
              },
            },
            operator: "exists",
          },
        ],
      });
      const identityPlan = buildSessionPlan(selectorDocument);
      const identityOutput = identityPlan.outputs[0]!;
      const identityLowerer = new AnalyticsLogicalToDbLowerer(identityPlan, {
        siteId: SITE_ID as never,
        time: identityPlan.context.time,
      });
      const identityRelation = identityLowerer.lower(identityOutput);
      const identityQuery = compileD1Query(
        identityLowerer.projectOutput(identityRelation, [
          {
            name: "site_pk",
            slot: identityOutput.fields[0]!.slot,
            component: 0,
          },
          {
            name: "session_id",
            slot: identityOutput.fields[0]!.slot,
            component: 1,
          },
        ]),
        { tag: "analytics.string-match.wave-24" },
      );
      const complexRows = (
        await client.all(sqliteCompatibleQuery(identityQuery))
      ).results as Array<{
        readonly site_pk: number;
        readonly session_id: string;
      }>;
      const expectedComplex = evaluateCandidateSets(
        selectorDocument.root,
        dataset,
        candidateIds,
      );
      const actualComplex = new Set(complexRows.map((row) => row.session_id));
      expect(actualComplex).toEqual(expectedComplex);
      expect([...actualComplex].sort()).toEqual(["s-event"]);
      expect(complexRows.every((row) => row.site_pk > 0)).toBe(true);

      const countLowering = lowerAnalyticsFilteredSessionCountPlan(
        buildSessionPlan(selectorDocument, "sessions"),
      );
      expect(countLowering.kind, JSON.stringify(countLowering)).toBe(
        "supported",
      );
      if (countLowering.kind !== "supported")
        throw new Error("Expected selector Session count to lower.");
      expect(
        (await client.all(sqliteCompatibleQuery(countLowering.query))).results,
      ).toEqual([{ sessions: 1 }]);

      const viewsLowering = lowerAnalyticsFilteredSessionViewsPlan(
        buildSessionPlan(selectorDocument, "views"),
        {
          siteId: SITE_ID,
          candidateRange: CANDIDATE_RANGE as never,
          readRange: READ_RANGE as never,
        },
      );
      expect(viewsLowering.kind).toBe("supported");
      if (viewsLowering.kind !== "supported")
        throw new Error("Expected selector Page views to lower.");
      expect(
        (await client.all(sqliteCompatibleQuery(viewsLowering.query))).results,
      ).toEqual([{ views: 1 }]);

      for (const [name, query] of Object.entries({
        identity: identityQuery,
        count: countLowering.query,
        views: viewsLowering.query,
      })) {
        const sqlBytes = new TextEncoder().encode(query.sql).byteLength;
        expect(sqlBytes, `${name} SQL bytes`).toBeLessThanOrEqual(
          D1_MAX_SQL_UTF8_BYTES,
        );
        expect(
          query.bindings?.length ?? 0,
          `${name} bindings`,
        ).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
        expect(query.sql).not.toContain("LIKE");
      }
      const queryPlan = explainQueryPlan(
        db,
        sqliteCompatibleQuery(identityQuery),
      );
      expect(queryPlan.join("\n")).toMatch(
        /idx_visits_site_pk_(?:started_at|session_started_at)/u,
      );
      expect(trace.preparedSql).toHaveLength(cases.length + 3);

      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      let record;
      try {
        record = await logger.emitWhenComplete();
      } finally {
        consoleLog.mockRestore();
      }
      const observed = record.logs.find(
        (entry) =>
          entry.message.startsWith("db.query.v1.all.success") &&
          entry.data?.tag === "analytics.string-match.wave-24",
      );
      expect(observed?.data).toMatchObject({
        status: "success",
        rowsRead: null,
        rowsWritten: null,
        physicalPlanHash: expect.stringMatching(/^v1:/u),
        sqlBytes: new TextEncoder().encode(identityQuery.sql).byteLength,
        bindings: identityQuery.bindings?.length ?? 0,
      });
      expect(record.performance.d1Statements).toBe(trace.preparedSql.length);
    } finally {
      db.close();
    }
  });

  it.each([
    {
      caseSensitive: false,
      normalization: undefined,
      message: /Case-insensitive matching is not supported/u,
    },
    {
      caseSensitive: true,
      normalization: "trim-case-fold",
      message: /case-fold normalization/u,
    },
  ] as const)(
    "keeps unsupported normalization located at the shared expression boundary ($caseSensitive)",
    ({ caseSensitive, normalization, message }) => {
      const builder = new LogicalPlanBuilder(makeContext());
      const pages = builder.source("page", {
        temporalDomain: "read",
        attributes: ["page.path"],
      });
      const match = builder.stringMatch(
        "contains",
        builder.slot(pages, "attribute:page.path"),
        "root",
        caseSensitive,
        normalization,
      );
      const filtered = builder.filter(pages, match);
      builder.output("unsupported-case-fold", filtered, [
        { name: "page", slot: "entity" },
      ]);
      const plan = builder.finish();
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_ID as never,
        time: plan.context.time,
      });
      let thrown: unknown;
      try {
        lowerer.lower(plan.outputs[0]!);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        node: expect.stringMatching(/^nodes\[\d+\]\.predicate/u),
        message: expect.stringMatching(message),
      });
    },
  );

  it("keeps unpaired-surrogate pattern errors at the Filter value path", () => {
    const builder = new LogicalPlanBuilder(makeContext());
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.path"],
    });
    const predicate = builder.stringMatch(
      "contains",
      builder.slot(pages, "attribute:page.path"),
      "\ud800",
      true,
    );
    const filtered = builder.filter(pages, predicate);
    builder.output("invalid-string-pattern", filtered, [
      { name: "page", slot: "entity" },
    ]);
    const plan = builder.finish();
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE_ID as never,
      time: plan.context.time,
    });
    let thrown: unknown;
    try {
      lowerer.lower(plan.outputs[0]!);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      node: expect.stringMatching(/^nodes\[\d+\]\.predicate\.value$/u),
      message: expect.stringMatching(
        /textContains\(\).*unpaired UTF-16 surrogate at index 0/u,
      ),
    });

    const wrapped = lowerAnalyticsPagePathToSessionQuery({
      document: filterDocument(
        fieldCondition("page.path", "contains", "\ud800"),
      ),
      siteIds: [SITE_ID as never],
      candidateRange: CANDIDATE_RANGE as never,
      readRange: READ_RANGE as never,
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 200 as never,
    });
    expect(wrapped).toMatchObject({
      kind: "unsupported",
      node: expect.stringMatching(/^nodes\[\d+\]\.predicate\.value$/u),
      reason: expect.stringMatching(
        /textContains\(\).*unpaired UTF-16 surrogate at index 0/u,
      ),
    });
  });
});
