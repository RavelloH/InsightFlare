import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { aggregateCache } from "@/lib/api-v1/analytics/overview";
import { handlePlannedSiteOverview } from "@/lib/api-v1/analytics/overview-handler";
import { createD1DatabaseClient } from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition/edge-runtime";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import { preparedMembershipIdentities } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import * as countSupport from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-support";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { ApiKeyPrincipal } from "@/lib/edge/auth/api-key-auth";
import type { ExpandedCustomEventData } from "@/lib/edge/ingest/custom-event-json";
import { expandCustomEventDataJson } from "@/lib/edge/ingest/custom-event-json";
import { prepareCustomEventMutations } from "@/lib/edge/ingest/custom-event-write-mutations";
import type { BufferedCustomEventRow } from "@/lib/edge/ingest/types";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as filterEvaluator from "@/lib/filter-contract/filter-evaluator";

const SITE_ID = "wave91c-payload-execution" as SiteId;
const PAYLOAD_COUNT_DSL =
  'count(event { event.name eq "purchase" AND event.payload("/value") eq "match" }) gte 1';
const databases = new Set<DatabaseSync>();
const createdEvidencePaths = new Set<string>();
type Scope = "session" | "visitor";
type TraceRecord = {
  readonly operation: "prepare" | "all" | "first" | "run";
  readonly sql: string;
  readonly bindings: readonly unknown[];
  readonly rows: readonly Record<string, unknown>[];
  readonly ok: boolean;
  readonly error: string | null;
};

function cloned<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function evidencePath(label: string): string {
  const directory = join(process.cwd(), "plan", "execution-wave91");
  mkdirSync(directory, { recursive: true });
  return join(
    directory,
    `91c-node-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function persistEvidence(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    flag: createdEvidencePaths.has(path) ? "w" : "wx",
  });
  createdEvidencePaths.add(path);
}

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  if (
    (database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys !== 0
  )
    database.exec("PRAGMA foreign_keys = OFF");

  database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain, public_enabled, created_at) VALUES (?, ?, ?, ?, 1, 0)",
    )
    .run(SITE_ID, "wave91c-team", "Wave 91C", "wave91c.example.test");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const sitePk = (
    database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(SITE_ID) as { readonly site_pk: number }
  ).site_pk;

  const trace: TraceRecord[] = [];
  let afterQueryHook: ((sql: string) => void) | undefined;
  const baseDatabase = createSqliteD1Database(database);
  const d1 = {
    prepare(sql: string) {
      let prepared: ReturnType<typeof baseDatabase.prepare>;
      try {
        prepared = baseDatabase.prepare(sql);
      } catch (error) {
        trace.push({
          operation: "prepare",
          sql,
          bindings: [],
          rows: [],
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return {
        bind(...bindings: unknown[]) {
          const bound = prepared.bind(
            ...(bindings as Parameters<typeof prepared.bind>),
          );
          return {
            async all<Row>() {
              try {
                const result = await bound.all<Row>();
                trace.push({
                  operation: "all",
                  sql,
                  bindings: cloned(bindings),
                  rows: cloned(result.results as Record<string, unknown>[]),
                  ok: true,
                  error: null,
                });
                afterQueryHook?.(sql);
                return result;
              } catch (error) {
                trace.push({
                  operation: "all",
                  sql,
                  bindings: cloned(bindings),
                  rows: [],
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
                throw error;
              }
            },
            async first<Row>() {
              try {
                const row = await bound.first<Row>();
                trace.push({
                  operation: "first",
                  sql,
                  bindings: cloned(bindings),
                  rows:
                    row === null
                      ? []
                      : cloned([row as Record<string, unknown>]),
                  ok: true,
                  error: null,
                });
                afterQueryHook?.(sql);
                return row;
              } catch (error) {
                trace.push({
                  operation: "first",
                  sql,
                  bindings: cloned(bindings),
                  rows: [],
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
                throw error;
              }
            },
            async run() {
              try {
                const result = await bound.run();
                trace.push({
                  operation: "run",
                  sql,
                  bindings: cloned(bindings),
                  rows: [],
                  ok: true,
                  error: null,
                });
                afterQueryHook?.(sql);
                return result;
              } catch (error) {
                trace.push({
                  operation: "run",
                  sql,
                  bindings: cloned(bindings),
                  rows: [],
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                });
                throw error;
              }
            },
          };
        },
      };
    },
    batch: baseDatabase.batch.bind(baseDatabase),
  } as unknown as D1Database;
  const env = {
    DB: d1,
    DAILY_SALT_SECRET: "wave91c-test-secret",
    INGEST_DO: {},
  } as unknown as Env;

  const nameIds = new Map<string, number>();
  const pathIds = new Map<string, number>();
  const keyIds = new Map<string, number>();
  const eventNameId = (name: string): number => {
    const existing = nameIds.get(name);
    if (existing !== undefined) return existing;
    const id = 100 + nameIds.size;
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, 1, ?)",
      )
      .run(id, SITE_ID, name, sitePk);
    nameIds.set(name, id);
    return id;
  };

  const visit = (input: {
    readonly visitId: string;
    readonly sessionId: string | null;
    readonly visitorId: string | null;
    readonly startedAt: number;
  }): void => {
    database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname
        ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, '/', 'wave91c.example.test')`,
      )
      .run(
        input.visitId,
        SITE_ID,
        sitePk,
        input.visitorId,
        input.sessionId,
        input.startedAt,
        input.startedAt,
      );
  };

  const dictionaryIds = (name: string, expanded: ExpandedCustomEventData) => {
    const ensurePath = (path: string): number => {
      const cached = pathIds.get(path);
      if (cached !== undefined) return cached;
      const existing = database
        .prepare(
          "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
        )
        .get(sitePk, path) as { readonly id: number } | undefined;
      if (existing) {
        pathIds.set(path, existing.id);
        return existing.id;
      }
      database
        .prepare(
          "INSERT INTO custom_event_json_paths (site_id, path, last_seen_at, site_pk) VALUES (?, ?, 1, ?)",
        )
        .run(SITE_ID, path, sitePk);
      const id = (
        database
          .prepare(
            "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
          )
          .get(sitePk, path) as { readonly id: number }
      ).id;
      pathIds.set(path, id);
      return id;
    };
    const ensureKey = (key: string): number => {
      const cached = keyIds.get(key);
      if (cached !== undefined) return cached;
      const existing = database
        .prepare(
          'SELECT id FROM custom_event_json_keys WHERE site_pk = ? AND "key" = ?',
        )
        .get(sitePk, key) as { readonly id: number } | undefined;
      if (existing) {
        keyIds.set(key, existing.id);
        return existing.id;
      }
      database
        .prepare(
          'INSERT INTO custom_event_json_keys (site_id, "key", last_seen_at, site_pk) VALUES (?, ?, 1, ?)',
        )
        .run(SITE_ID, key, sitePk);
      const id = (
        database
          .prepare(
            'SELECT id FROM custom_event_json_keys WHERE site_pk = ? AND "key" = ?',
          )
          .get(sitePk, key) as { readonly id: number }
      ).id;
      keyIds.set(key, id);
      return id;
    };
    return {
      eventNameId: eventNameId(name),
      keyIds: new Map(expanded.keys.map((key) => [key, ensureKey(key)])),
      pathIds: new Map(expanded.paths.map((path) => [path, ensurePath(path)])),
    };
  };

  const eventMany = async (
    inputs: readonly {
      readonly id: string;
      readonly visitId: string;
      readonly name: string;
      readonly occurredAt: number;
      readonly payload: Readonly<Record<string, unknown>>;
    }[],
  ): Promise<void> => {
    const mutations: ReturnType<typeof prepareCustomEventMutations> = [];
    for (const input of inputs) {
      const json = JSON.stringify(input.payload);
      if (json === undefined) throw new Error("wave91c_payload_json_missing");
      const expansion = expandCustomEventDataJson(json);
      if (!expansion.ok) throw new Error(expansion.error);
      const row: BufferedCustomEventRow = {
        eventId: input.id,
        siteId: SITE_ID,
        visitId: input.visitId,
        occurredAt: input.occurredAt,
        receivedAt: input.occurredAt,
        sequence: 1,
        eventName: input.name,
        eventDataJson: json,
        userId: "",
        dirty: 1,
        flushAttempts: 0,
        createdAt: input.occurredAt,
      };
      mutations.push(
        ...prepareCustomEventMutations(
          row,
          expansion.data,
          dictionaryIds(input.name, expansion.data),
          sitePk,
        ),
      );
    }
    const writer = createD1DatabaseClient(createSqliteD1Database(database));
    for (let offset = 0; offset < mutations.length; offset += 50)
      await writer.batch(mutations.slice(offset, offset + 50));
  };
  const event = async (input: {
    readonly id: string;
    readonly visitId: string;
    readonly name: string;
    readonly occurredAt: number;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void> => eventMany([input]);

  const seedPayloadRows = (input: {
    readonly count: number;
    readonly visitId: string;
    readonly payloadAt: (index: number) => Readonly<Record<string, unknown>>;
    readonly orphanIndex?: number;
    readonly missingRootIndex?: number;
    readonly startMs?: number;
  }): void => {
    const name = "purchase";
    const nameId = eventNameId(name);
    const prepared = {
      event: database.prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ),
      node: database.prepare(
        `INSERT INTO custom_event_json_nodes (
          event_pk, node_id, parent_node_id, key_id, path_id, value_type,
          member_order, array_index, depth
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      value: database.prepare(
        `INSERT INTO custom_event_json_values (
          event_pk, node_id, site_id, site_pk, event_name_id, path_id,
          occurred_at, scope_node_id, value_type, string_value, string_hash,
          number_value, boolean_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      removeRoot: database.prepare(
        "DELETE FROM custom_event_json_nodes WHERE event_pk = ? AND parent_node_id IS NULL",
      ),
    };
    const startMs = input.startMs ?? 100;
    database.exec("BEGIN");
    try {
      for (let index = 0; index < input.count; index += 1) {
        const payload = input.payloadAt(index);
        const json = JSON.stringify(payload);
        if (json === undefined)
          throw new Error("wave91c_stress_payload_json_missing");
        const expansion = expandCustomEventDataJson(json);
        if (!expansion.ok) throw new Error(expansion.error);
        const ids = dictionaryIds(name, expansion.data);
        const occurredAt = startMs + index;
        const inserted = prepared.event.run(
          `wave91c-stress-event-${Math.random().toString(36).slice(2)}-${index}`,
          SITE_ID,
          sitePk,
          index === input.orphanIndex
            ? "wave91c-stress-unmatched-owner"
            : input.visitId,
          nameId,
          occurredAt,
          occurredAt,
          expansion.data.nodes.length,
          expansion.data.values.length,
          occurredAt,
        );
        const eventPk = Number(inserted.lastInsertRowid);
        for (const node of expansion.data.nodes) {
          prepared.node.run(
            eventPk,
            node.nodeId,
            node.parentNodeId,
            node.key === null ? null : ids.keyIds.get(node.key)!,
            ids.pathIds.get(node.path)!,
            node.valueType,
            node.memberOrder,
            node.arrayIndex,
            node.depth,
          );
        }
        for (const value of expansion.data.values) {
          prepared.value.run(
            eventPk,
            value.nodeId,
            SITE_ID,
            sitePk,
            nameId,
            ids.pathIds.get(value.path)!,
            occurredAt,
            value.scopeNodeId,
            value.valueType,
            value.stringValue,
            value.stringHash,
            value.numberValue,
            value.booleanValue,
          );
        }
        if (index === input.missingRootIndex) prepared.removeRoot.run(eventPk);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const nodelessEvent = (input: {
    readonly id: string;
    readonly visitId: string;
    readonly name: string;
    readonly occurredAt: number;
  }): void => {
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`,
      )
      .run(
        input.id,
        SITE_ID,
        sitePk,
        input.visitId,
        eventNameId(input.name),
        input.occurredAt,
        input.occurredAt,
        input.occurredAt,
      );
  };

  const seedNodelessEvents = (input: {
    readonly count: number;
    readonly visitId: string;
    readonly orphanIndex?: number;
    readonly startMs?: number;
  }): void => {
    const nameId = eventNameId("purchase");
    const startMs = input.startMs ?? 100;
    database
      .prepare(
        `WITH RECURSIVE seq(n) AS (
          SELECT 0
          UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ?
        )
        INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count, created_at
        )
        SELECT ? || seq.n, ?, ?,
               CASE WHEN seq.n = ? THEN ? ELSE ? END,
               ?, ? + seq.n, ? + seq.n,
               1, 0, 0, ? + seq.n
        FROM seq`,
      )
      .run(
        input.count,
        "wave91c-nodeless-stress-",
        SITE_ID,
        sitePk,
        input.orphanIndex ?? -1,
        "wave91c-nodeless-stress-unmatched",
        input.visitId,
        nameId,
        startMs,
        startMs,
        startMs,
      );
  };

  return {
    database,
    sitePk,
    env,
    trace,
    visit,
    event,
    eventMany,
    nodelessEvent,
    seedNodelessEvents,
    seedPayloadRows,
    setAfterQueryHook(hook: ((sql: string) => void) | undefined) {
      afterQueryHook = hook;
    },
  };
}

function filterInput(
  filterDsl: string,
  scope: Scope,
  range = { startMs: 0, endExclusiveMs: 10_000 },
) {
  const time = createQueryTime(
    range.startMs,
    range.endExclusiveMs,
    "UTC",
    Math.max(10_000, range.endExclusiveMs),
  );
  const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("overview", document, scope);
  if (!plan) throw new Error("wave91c_scoped_filter_plan_missing");
  const filters = attachScopedFilterMetadata(document, {
    requestedScope: scope,
    resolvedScope: scope,
    plan,
    time,
    siteIds: [SITE_ID],
  });
  return {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    filters,
    scopePreference: scope,
    scopePlan: plan,
    time,
  };
}

function entityIds(output: unknown): string[] {
  const plan = (output as { readonly scopePlan?: Record<string, unknown> })
    .scopePlan;
  return preparedMembershipIdentities(plan?.preparedMembership)
    .entityIds.map(({ id }) => id)
    .sort();
}

function hasPayloadSelector(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasPayloadSelector);
  const record = value as Record<string, unknown>;
  if (record.kind === "event-payload") return true;
  return Object.values(record).some(hasPayloadSelector);
}

function traceRecordWithPayloadGuard(
  trace: readonly TraceRecord[],
): TraceRecord | undefined {
  return trace.find((attempt) =>
    attempt.rows.some((row) => row.rowKind === "guard"),
  );
}

describe("finite payload count middleware execution", () => {
  afterAll(() => {
    for (const database of databases) database.close();
    databases.clear();
  });

  it("uses SQL for the finite payload slice and matches the same-DSL legacy middleware", async () => {
    const fixture = createFixture();
    const activities = [
      {
        visitId: "wave91c-collision",
        sessionId: "wave91c-session-shared",
        visitorId: "wave91c-visitor-shared",
        name: "purchase",
        payload: { left: "yes", right: "yes" },
      },
      {
        visitId: "wave91c-left-only",
        sessionId: "wave91c-session-shared",
        visitorId: "wave91c-visitor-shared",
        name: "purchase",
        payload: { left: "yes" },
      },
      {
        visitId: "wave91c-split-left",
        sessionId: "wave91c-session-split",
        visitorId: "wave91c-visitor-split",
        name: "purchase",
        payload: { left: "yes" },
      },
      {
        visitId: "wave91c-split-right",
        sessionId: "wave91c-session-split",
        visitorId: "wave91c-visitor-split",
        name: "purchase",
        payload: { right: "yes" },
      },
      {
        visitId: "wave91c-refund",
        sessionId: "wave91c-session-refund",
        visitorId: "wave91c-visitor-refund",
        name: "refund",
        payload: { left: "yes", right: "yes" },
      },
      {
        visitId: "wave91c-nodeless",
        sessionId: "wave91c-session-nodeless",
        visitorId: "wave91c-visitor-nodeless",
        name: "purchase",
        nodeless: true,
      },
    ] as const;
    for (const [index, activity] of activities.entries()) {
      fixture.visit({
        visitId: activity.visitId,
        sessionId: activity.sessionId,
        visitorId: activity.visitorId,
        startedAt: 100 + index * 100,
      });
      const eventInput = {
        id:
          index === 0 || index === 4
            ? activity.visitId
            : `wave91c-event-${activity.visitId}`,
        visitId: activity.visitId,
        name: activity.name,
        occurredAt: 110 + index * 100,
      };
      if ("nodeless" in activity) fixture.nodelessEvent(eventInput);
      else await fixture.event({ ...eventInput, payload: activity.payload });
    }

    const dsl =
      'count(event { event.name eq "purchase" AND event.payload("/left") eq "yes" AND event.payload("/right") eq "yes" }) gte 1';
    const originalClassifier = countSupport.classifyAdvancedCountFilter;
    let forceLegacyPayloadAdmission = false;
    const classifierSpy = vi
      .spyOn(countSupport, "classifyAdvancedCountFilter")
      .mockImplementation((document, scope) => {
        const result = originalClassifier(document, scope);
        if (
          forceLegacyPayloadAdmission &&
          hasPayloadSelector(document.root) &&
          result.kind === "supported"
        )
          return {
            kind: "unsupported",
            path: result.path,
            code: "wave91_legacy_payload_baseline",
            reason:
              "Test-only 91A compatibility admission for the unchanged DSL.",
          };
        return result;
      });
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const evidence = {
      dsl,
      fixture: activities,
      stages: [] as Array<Record<string, unknown>>,
      error: null as string | null,
    };
    const path = evidencePath("same-event");

    const runStage = async (scope: Scope, legacy: boolean) => {
      forceLegacyPayloadAdmission = legacy;
      fixture.trace.length = 0;
      const evaluatorOffset = evaluatorSpy.mock.calls.length;
      const output = await d1AdvancedFilterMiddleware(fixture.env)(
        "overview",
        filterInput(dsl, scope),
        async (prepared) => prepared,
      );
      const stage = {
        scope,
        mode: legacy ? "91a-classification-seam" : "current-sql",
        entityIds: entityIds(output),
        evaluatorCallCount: evaluatorSpy.mock.calls.length - evaluatorOffset,
        classifierCalls: classifierSpy.mock.calls.length,
        queries: cloned(fixture.trace),
      };
      evidence.stages.push(stage);
      persistEvidence(path, evidence);
      return stage;
    };

    try {
      for (const scope of ["session", "visitor"] as const) {
        const current = await runStage(scope, false);
        const old = await runStage(scope, true);
        const expected = [
          scope === "session"
            ? "wave91c-session-shared"
            : "wave91c-visitor-shared",
        ];
        expect(current.entityIds).toEqual(expected);
        expect(current.evaluatorCallCount).toBe(0);
        expect(old.entityIds).toEqual(expected);
        expect(old.evaluatorCallCount).toBeGreaterThan(0);
        expect(
          old.queries.some((query) =>
            /custom_event_json_nodes/iu.test(query.sql),
          ),
        ).toBe(true);
      }
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      persistEvidence(path, evidence);
      throw error;
    } finally {
      forceLegacyPayloadAdmission = false;
      classifierSpy.mockRestore();
      evaluatorSpy.mockRestore();
      persistEvidence(path, evidence);
    }
  });

  it("preserves payload resource-domain results for NULL and unmatched owners", async () => {
    const fixture = createFixture();
    fixture.visit({
      visitId: "wave91c-domain-outside-c-owner",
      sessionId: "wave91c-domain-session",
      visitorId: "wave91c-domain-visitor",
      startedAt: 50,
    });
    await fixture.event({
      id: "wave91c-domain-outside-c-event",
      visitId: "wave91c-domain-outside-c-owner",
      name: "purchase",
      occurredAt: 150,
      payload: { region: "north" },
    });
    await fixture.event({
      id: "wave91c-domain-unmatched-event",
      visitId: "wave91c-domain-unmatched-owner",
      name: "purchase",
      occurredAt: 160,
      payload: { region: "north" },
    });
    const dsl =
      'page notExists AND count(event { event.name eq "purchase" AND event.payload("/region") eq "north" }) gte 1';
    const range = { startMs: 100, endExclusiveMs: 200 } as const;
    const evidence = {
      dsl,
      range,
      stages: [] as Array<Record<string, unknown>>,
      error: null as string | null,
    };
    const path = evidencePath("resource-domain");
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const originalClassifier = countSupport.classifyAdvancedCountFilter;
    let legacy = false;
    const classifierSpy = vi
      .spyOn(countSupport, "classifyAdvancedCountFilter")
      .mockImplementation((document, scope) => {
        const result = originalClassifier(document, scope);
        return legacy &&
          hasPayloadSelector(document.root) &&
          result.kind === "supported"
          ? {
              kind: "unsupported",
              path: result.path,
              code: "wave91_legacy_payload_baseline",
              reason: "Test-only restoration of the 91A admission boundary.",
            }
          : result;
      });

    try {
      for (const scope of ["session", "visitor"] as const) {
        const expected = [
          scope === "session"
            ? "wave91c-domain-session"
            : "wave91c-domain-visitor",
        ];
        for (const mode of [
          "current-sql",
          "91a-classification-seam",
        ] as const) {
          legacy = mode !== "current-sql";
          fixture.trace.length = 0;
          const evaluatorOffset = evaluatorSpy.mock.calls.length;
          const output = await d1AdvancedFilterMiddleware(fixture.env)(
            "overview",
            filterInput(dsl, scope, range),
            async (prepared) => prepared,
          );
          const stage = {
            scope,
            mode,
            dsl,
            entityIds: entityIds(output),
            evaluatorCallCount:
              evaluatorSpy.mock.calls.length - evaluatorOffset,
            queries: cloned(fixture.trace),
          };
          evidence.stages.push(stage);
          persistEvidence(path, evidence);
          expect(stage.entityIds).toEqual(expected);
          if (mode === "current-sql") expect(stage.evaluatorCallCount).toBe(0);
          else expect(stage.evaluatorCallCount).toBeGreaterThan(0);
        }
        expect(evidence.stages.at(-1)?.entityIds).toEqual(
          evidence.stages.at(-2)?.entityIds,
        );
      }
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      persistEvidence(path, evidence);
      throw error;
    } finally {
      legacy = false;
      classifierSpy.mockRestore();
      evaluatorSpy.mockRestore();
      persistEvidence(path, evidence);
    }
  });

  it("keeps missing, null, cross-type and raw-string semantics in both scopes", async () => {
    const fixture = createFixture();
    const cases = [
      { label: "missing", payload: {} },
      { label: "null", payload: { value: null } },
      { label: "empty", payload: { value: "" } },
      { label: "number", payload: { value: 7 } },
      { label: "string", payload: { value: "7" } },
      { label: "padded", payload: { value: " 7 " } },
      { label: "boolean", payload: { value: true } },
      { label: "object", payload: { value: { child: "nested" } } },
      { label: "empty-array", payload: { value: [] } },
      { label: "array", payload: { value: [7] } },
      { label: "prefix", payload: { value: "7ish" } },
      { label: "suffix", payload: { value: "ish7" } },
      { label: "unicode-data", payload: { value: "黄金" } },
      { label: "unicode-key", payload: { "雪'quoted": "gold" } },
    ] as const;
    for (const [index, payloadCase] of cases.entries()) {
      const visitId = `wave91c-contract-${payloadCase.label}`;
      fixture.visit({
        visitId,
        sessionId: `wave91c-contract-session-${payloadCase.label}`,
        visitorId: `wave91c-contract-visitor-${payloadCase.label}`,
        startedAt: 100 + index * 100,
      });
      await fixture.event({
        id: `wave91c-contract-event-${payloadCase.label}`,
        visitId,
        name: "purchase",
        occurredAt: 110 + index * 100,
        payload: payloadCase.payload,
      });
    }

    const expectedByPredicate: Readonly<Record<string, readonly string[]>> = {
      'event.payload("/value") eq "7"': ["string"],
      'event.payload("/value") neq "7"': [
        "empty",
        "empty-array",
        "number",
        "padded",
        "boolean",
        "object",
        "array",
        "prefix",
        "suffix",
        "unicode-data",
      ],
      'NOT (event.payload("/value") eq "7")': [
        "missing",
        "null",
        "empty",
        "number",
        "padded",
        "boolean",
        "object",
        "empty-array",
        "array",
        "prefix",
        "suffix",
        "unicode-data",
        "unicode-key",
      ],
      'event.payload("/value") in ["7", "7ish"]': ["string", "prefix"],
      'event.payload("/value") notIn ["7"]': [
        "empty",
        "empty-array",
        "number",
        "padded",
        "boolean",
        "object",
        "array",
        "prefix",
        "suffix",
        "unicode-data",
      ],
      'event.payload("/value") isEmpty': ["empty"],
      'event.payload("/value") notEmpty': [
        "string",
        "padded",
        "prefix",
        "suffix",
        "unicode-data",
      ],
      'event.payload("/雪\'quoted") eq "gold"': ["unicode-key"],
    };
    const evidence = {
      fixture: cases,
      stages: [] as Array<Record<string, unknown>>,
      error: null as string | null,
    };
    const path = evidencePath("operators");
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const originalClassifier = countSupport.classifyAdvancedCountFilter;
    let legacy = false;
    const classifierSpy = vi
      .spyOn(countSupport, "classifyAdvancedCountFilter")
      .mockImplementation((document, scope) => {
        const result = originalClassifier(document, scope);
        return legacy &&
          hasPayloadSelector(document.root) &&
          result.kind === "supported"
          ? {
              kind: "unsupported",
              path: result.path,
              code: "wave91_legacy_payload_baseline",
              reason: "Test-only restoration of the 91A admission boundary.",
            }
          : result;
      });
    try {
      for (const scope of ["session", "visitor"] as const) {
        for (const [predicate, labels] of Object.entries(expectedByPredicate)) {
          const dsl = `count(event { event.name eq "purchase" AND ${predicate} }) gte 1`;
          legacy = false;
          fixture.trace.length = 0;
          const evaluatorOffset = evaluatorSpy.mock.calls.length;
          const current = await d1AdvancedFilterMiddleware(fixture.env)(
            "overview",
            filterInput(dsl, scope),
            async (prepared) => prepared,
          );
          const stage = {
            scope,
            mode: "current-sql",
            dsl,
            entityIds: entityIds(current),
            evaluatorCallCount:
              evaluatorSpy.mock.calls.length - evaluatorOffset,
            queries: cloned(fixture.trace),
          };
          evidence.stages.push(stage);
          persistEvidence(path, evidence);
          expect(stage.entityIds).toEqual(
            labels.map((label) => `wave91c-contract-${scope}-${label}`).sort(),
          );
          expect(stage.evaluatorCallCount).toBe(0);

          legacy = true;
          fixture.trace.length = 0;
          const legacyEvaluatorOffset = evaluatorSpy.mock.calls.length;
          const legacyOutput = await d1AdvancedFilterMiddleware(fixture.env)(
            "overview",
            filterInput(dsl, scope),
            async (prepared) => prepared,
          );
          const oldStage = {
            scope,
            mode: "91a-classification-seam",
            dsl,
            entityIds: entityIds(legacyOutput),
            evaluatorCallCount:
              evaluatorSpy.mock.calls.length - legacyEvaluatorOffset,
            queries: cloned(fixture.trace),
          };
          evidence.stages.push(oldStage);
          persistEvidence(path, evidence);
          legacy = false;
          expect(oldStage.entityIds).toEqual(stage.entityIds);
          expect(oldStage.evaluatorCallCount).toBeGreaterThan(0);
          expect(
            oldStage.queries.some((query) =>
              /custom_event_json_nodes/iu.test(String(query.sql)),
            ),
          ).toBe(true);
        }
      }
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      persistEvidence(path, evidence);
      throw error;
    } finally {
      legacy = false;
      classifierSpy.mockRestore();
      evaluatorSpy.mockRestore();
      persistEvidence(path, evidence);
    }
  }, 20_000);

  it("propagates a failed C data read without evaluator retry", async () => {
    const fixture = createFixture();
    fixture.visit({
      visitId: "wave91c-c-failure-owner",
      sessionId: "wave91c-c-failure-session",
      visitorId: "wave91c-c-failure-visitor",
      startedAt: 100,
    });
    await fixture.event({
      id: "wave91c-c-failure-event",
      visitId: "wave91c-c-failure-owner",
      name: "purchase",
      occurredAt: 110,
      payload: { value: "match" },
    });
    fixture.database.exec("DROP TABLE custom_event_json_values");
    const diagnostics = createD1ReadDiagnostics();
    const evaluator = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const next = vi.fn(async (prepared: unknown) => prepared);
    const error = await d1AdvancedFilterMiddleware(fixture.env, diagnostics)(
      "overview",
      filterInput(PAYLOAD_COUNT_DSL, "session"),
      next,
    ).catch((failure: unknown) => failure);
    try {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/custom_event_json_values/iu);
      expect(
        fixture.trace.some(
          (attempt) =>
            /custom_event_json_values/iu.test(attempt.sql) && !attempt.ok,
        ),
      ).toBe(true);
      expect(evaluator).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    } finally {
      evaluator.mockRestore();
    }
  });

  it("checks abort immediately after the successful C merged read", async () => {
    const fixture = createFixture();
    fixture.visit({
      visitId: "wave91c-c-abort-owner",
      sessionId: "wave91c-c-abort-session",
      visitorId: "wave91c-c-abort-visitor",
      startedAt: 100,
    });
    await fixture.event({
      id: "wave91c-c-abort-event",
      visitId: "wave91c-c-abort-owner",
      name: "purchase",
      occurredAt: 110,
      payload: { value: "match" },
    });
    const controller = new AbortController();
    fixture.setAfterQueryHook((sql) => {
      if (/custom_event_json_values/iu.test(sql)) controller.abort();
    });
    const evaluator = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const next = vi.fn(async (prepared: unknown) => prepared);
    try {
      const abortResult = await d1AdvancedFilterMiddleware(fixture.env)(
        "overview",
        filterInput(PAYLOAD_COUNT_DSL, "session"),
        next,
        { signal: controller.signal },
      ).catch((error: unknown) => error);
      expect(abortResult).toMatchObject({ name: "AbortError" });
      expect(
        fixture.trace.some(
          (attempt) =>
            /custom_event_json_values/iu.test(attempt.sql) && attempt.ok,
        ),
      ).toBe(true);
      expect(evaluator).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(
        fixture.trace.filter((attempt) =>
          /custom_event_json_values/iu.test(attempt.sql),
        ),
      ).toHaveLength(1);
    } finally {
      fixture.setAfterQueryHook(undefined);
      evaluator.mockRestore();
    }
  });

  it("applies the raw activity cap before invalid payload controls or identities", async () => {
    const fixture = createFixture();
    fixture.visit({
      visitId: "wave91c-raw-cap-owner",
      sessionId: "wave91c-raw-cap-session",
      visitorId: "wave91c-raw-cap-visitor",
      startedAt: 100,
    });
    fixture.seedNodelessEvents({
      count: 20_001,
      visitId: "wave91c-raw-cap-owner",
      startMs: 100,
      orphanIndex: 20_000,
    });
    await fixture.event({
      id: "wave91c-raw-cap-corrupt-event",
      visitId: "wave91c-raw-cap-owner",
      name: "purchase",
      occurredAt: 21_000,
      payload: { value: "match" },
    });
    const corruptEventPk = (
      fixture.database
        .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
        .get("wave91c-raw-cap-corrupt-event") as {
        readonly event_pk: number;
      }
    ).event_pk;
    fixture.database
      .prepare(
        "DELETE FROM custom_event_json_nodes WHERE event_pk = ? AND parent_node_id IS NULL",
      )
      .run(corruptEventPk);
    const diagnostics = createD1ReadDiagnostics();
    const evaluator = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const next = vi.fn(async (prepared: unknown) => prepared);
    try {
      const error = await d1AdvancedFilterMiddleware(fixture.env, diagnostics)(
        "overview",
        filterInput(PAYLOAD_COUNT_DSL, "session", {
          startMs: 0,
          endExclusiveMs: 30_000,
        }),
        next,
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        domainError: {
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "filter_activity_limit_exceeded" }),
          ]),
        },
      });
      const merged = traceRecordWithPayloadGuard(fixture.trace);
      expect(merged?.ok).toBe(true);
      expect(merged?.rows).toEqual(
        expect.arrayContaining([expect.objectContaining({ rowKind: "guard" })]),
      );
      const scopeRows =
        merged?.rows.filter((row) => row.rowKind === "scope") ?? [];
      expect(
        scopeRows.reduce((sum, row) => sum + Number(row.rawCount), 0),
      ).toBeGreaterThan(20_000);
      expect(
        Number(
          merged?.rows.find((row) => row.rowKind === "guard")
            ?.payloadStructureInvalidCount,
        ),
      ).toBeGreaterThan(0);
      expect(evaluator).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    } finally {
      evaluator.mockRestore();
    }
  }, 90_000);

  it("applies the payload node cap before structure fallback or identity release", async () => {
    const fixture = createFixture();
    fixture.visit({
      visitId: "wave91c-node-cap-owner",
      sessionId: "wave91c-node-cap-session",
      visitorId: "wave91c-node-cap-visitor",
      startedAt: 100,
    });
    await fixture.event({
      id: "wave91c-node-cap-event",
      visitId: "wave91c-node-cap-owner",
      name: "refund",
      occurredAt: 110,
      payload: { value: "match" },
    });
    fixture.visit({
      visitId: "wave91c-node-cap-matched-owner",
      sessionId: "wave91c-node-cap-matched-session",
      visitorId: "wave91c-node-cap-matched-visitor",
      startedAt: 120,
    });
    await fixture.event({
      id: "wave91c-node-cap-matched-event",
      visitId: "wave91c-node-cap-matched-owner",
      name: "purchase",
      occurredAt: 130,
      payload: { value: "match" },
    });
    fixture.visit({
      visitId: "wave91c-node-cap-nodeless-owner",
      sessionId: "wave91c-node-cap-nodeless-session",
      visitorId: "wave91c-node-cap-nodeless-visitor",
      startedAt: 140,
    });
    await fixture.event({
      id: "wave91c-node-cap-nodeless-event",
      visitId: "wave91c-node-cap-nodeless-owner",
      name: "purchase",
      occurredAt: 150,
      payload: {},
    });
    const nodelessEventPk = (
      fixture.database
        .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
        .get("wave91c-node-cap-nodeless-event") as { readonly event_pk: number }
    ).event_pk;
    fixture.database
      .prepare(
        "DELETE FROM custom_event_json_nodes WHERE event_pk = ? AND parent_node_id IS NULL",
      )
      .run(nodelessEventPk);
    const eventPk = (
      fixture.database
        .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
        .get("wave91c-node-cap-event") as { readonly event_pk: number }
    ).event_pk;
    const payloadNode = fixture.database
      .prepare(
        `SELECT n.node_id, n.parent_node_id, n.key_id, n.path_id,
                n.value_type, n.member_order, n.array_index, n.depth,
                v.site_id, v.site_pk, v.event_name_id, v.occurred_at,
                v.scope_node_id, v.string_value, v.string_hash,
                v.number_value, v.boolean_value
         FROM custom_event_json_nodes n
         JOIN custom_event_json_values v
           ON v.event_pk = n.event_pk AND v.node_id = n.node_id
         JOIN custom_event_json_paths p ON p.id = n.path_id
         WHERE n.event_pk = ? AND p.path = '/value'`,
      )
      .get(eventPk) as {
      readonly node_id: number;
      readonly parent_node_id: number;
      readonly key_id: number;
      readonly path_id: number;
      readonly value_type: number;
      readonly member_order: number;
      readonly array_index: number | null;
      readonly depth: number;
      readonly site_id: string;
      readonly site_pk: number;
      readonly event_name_id: number;
      readonly occurred_at: number;
      readonly scope_node_id: number | null;
      readonly string_value: string;
      readonly string_hash: string;
      readonly number_value: number | null;
      readonly boolean_value: number | null;
    };
    const insertNode = fixture.database.prepare(
      `INSERT INTO custom_event_json_nodes (
        event_pk, node_id, parent_node_id, key_id, path_id, value_type,
        member_order, array_index, depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertValue = fixture.database.prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, site_pk, event_name_id, path_id,
        occurred_at, scope_node_id, value_type, string_value, string_hash,
        number_value, boolean_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    fixture.database.exec("BEGIN");
    try {
      for (let nodeId = 3; nodeId <= 50_003; nodeId += 1) {
        insertNode.run(
          eventPk,
          nodeId,
          payloadNode.parent_node_id,
          payloadNode.key_id,
          payloadNode.path_id,
          payloadNode.value_type,
          payloadNode.member_order,
          payloadNode.array_index,
          payloadNode.depth,
        );
        insertValue.run(
          eventPk,
          nodeId,
          payloadNode.site_id,
          payloadNode.site_pk,
          payloadNode.event_name_id,
          payloadNode.path_id,
          payloadNode.occurred_at,
          payloadNode.scope_node_id,
          payloadNode.value_type,
          payloadNode.string_value,
          payloadNode.string_hash,
          payloadNode.number_value,
          payloadNode.boolean_value,
        );
      }
      fixture.database
        .prepare(
          "DELETE FROM custom_event_json_nodes WHERE event_pk = ? AND parent_node_id IS NULL",
        )
        .run(eventPk);
      fixture.database.exec("COMMIT");
    } catch (error) {
      fixture.database.exec("ROLLBACK");
      throw error;
    }
    const diagnostics = createD1ReadDiagnostics();
    const evaluator = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const next = vi.fn(async (prepared: unknown) => prepared);
    try {
      const error = await d1AdvancedFilterMiddleware(fixture.env, diagnostics)(
        "overview",
        filterInput(PAYLOAD_COUNT_DSL, "session", {
          startMs: 0,
          endExclusiveMs: 10_000,
        }),
        next,
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        domainError: {
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: "filter_payload_node_limit_exceeded",
            }),
          ]),
        },
      });
      const merged = traceRecordWithPayloadGuard(fixture.trace);
      expect(merged?.ok).toBe(true);
      const guard = merged?.rows.find((row) => row.rowKind === "guard");
      expect(Number(guard?.payloadNodeCount)).toBeGreaterThan(50_000);
      expect(Number(guard?.payloadStructureInvalidCount)).toBe(0);
      expect(Number(guard?.payloadMissingFactCount)).toBe(0);
      expect(evaluator).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    } finally {
      evaluator.mockRestore();
    }
  }, 30_000);

  it.each([
    "missing-root",
    "invalid-value-storage",
    "foreign-key-owner",
    "foreign-path-owner",
  ] as const)(
    "falls back atomically for %s payload corruption",
    async (kind) => {
      const fixture = createFixture();
      for (const [index, suffix] of ["good", "corrupt"].entries()) {
        const visitId = `wave91c-corrupt-${kind}-${suffix}-owner`;
        fixture.visit({
          visitId,
          sessionId: `wave91c-corrupt-${kind}-${suffix}-session`,
          visitorId: `wave91c-corrupt-${kind}-${suffix}-visitor`,
          startedAt: 100 + index * 100,
        });
        await fixture.event({
          id: `wave91c-corrupt-${kind}-${suffix}-event`,
          visitId,
          name: "purchase",
          occurredAt: 110 + index * 100,
          payload: { value: "match" },
        });
      }
      const foreignSiteId = `wave91c-corrupt-${kind}-foreign`;
      fixture.database
        .prepare(
          "INSERT INTO sites (id, team_id, name, domain, public_enabled, created_at) VALUES (?, ?, ?, ?, 1, 0)",
        )
        .run(
          foreignSiteId,
          "wave91c-team",
          foreignSiteId,
          `${foreignSiteId}.example.test`,
        );
      fixture.database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(foreignSiteId);
      const foreignPk = (
        fixture.database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(foreignSiteId) as { readonly site_pk: number }
      ).site_pk;
      const corruptEventId = `wave91c-corrupt-${kind}-corrupt-event`;
      const eventPk = (
        fixture.database
          .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
          .get(corruptEventId) as { readonly event_pk: number }
      ).event_pk;
      const payloadNode = fixture.database
        .prepare(
          `SELECT n.node_id, n.key_id, n.path_id
         FROM custom_event_json_nodes n
         JOIN custom_event_json_paths p ON p.id = n.path_id
         WHERE n.event_pk = ? AND p.path = '/value'`,
        )
        .get(eventPk) as {
        readonly node_id: number;
        readonly key_id: number;
        readonly path_id: number;
      };
      if (kind === "missing-root")
        fixture.database
          .prepare(
            "DELETE FROM custom_event_json_nodes WHERE event_pk = ? AND parent_node_id IS NULL",
          )
          .run(eventPk);
      else if (kind === "invalid-value-storage")
        fixture.database
          .prepare(
            "UPDATE custom_event_json_values SET string_value = CAST(X'FF' AS BLOB) WHERE event_pk = ? AND node_id = ?",
          )
          .run(eventPk, payloadNode.node_id);
      else if (kind === "foreign-key-owner") {
        fixture.database
          .prepare(
            'INSERT INTO custom_event_json_keys (site_id, "key", last_seen_at, site_pk) VALUES (?, ?, 1, ?)',
          )
          .run(foreignSiteId, "value", foreignPk);
        const foreignKeyId = (
          fixture.database
            .prepare(
              'SELECT id FROM custom_event_json_keys WHERE site_pk = ? AND "key" = ?',
            )
            .get(foreignPk, "value") as { readonly id: number }
        ).id;
        fixture.database
          .prepare(
            "UPDATE custom_event_json_nodes SET key_id = ? WHERE event_pk = ? AND node_id = ?",
          )
          .run(foreignKeyId, eventPk, payloadNode.node_id);
      } else {
        fixture.database
          .prepare(
            "INSERT INTO custom_event_json_paths (site_id, path, last_seen_at, site_pk) VALUES (?, ?, 1, ?)",
          )
          .run(foreignSiteId, "/value", foreignPk);
        const foreignPathId = (
          fixture.database
            .prepare(
              "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
            )
            .get(foreignPk, "/value") as { readonly id: number }
        ).id;
        fixture.database
          .prepare(
            "UPDATE custom_event_json_nodes SET path_id = ? WHERE event_pk = ? AND node_id = ?",
          )
          .run(foreignPathId, eventPk, payloadNode.node_id);
        fixture.database
          .prepare(
            "UPDATE custom_event_json_values SET path_id = ? WHERE event_pk = ? AND node_id = ?",
          )
          .run(foreignPathId, eventPk, payloadNode.node_id);
      }

      const originalClassifier = countSupport.classifyAdvancedCountFilter;
      let forceLegacy = false;
      const classifier = vi
        .spyOn(countSupport, "classifyAdvancedCountFilter")
        .mockImplementation((document, scope) => {
          const support = originalClassifier(document, scope);
          return forceLegacy && hasPayloadSelector(document.root)
            ? {
                kind: "unsupported",
                path: support.path,
                code: "wave91_forced_legacy_control",
                reason: "Test-only same-DSL legacy comparison.",
              }
            : support;
        });
      const evaluator = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
      const diagnostics = createD1ReadDiagnostics();
      const run = async (legacy: boolean) => {
        forceLegacy = legacy;
        fixture.trace.length = 0;
        const output = await d1AdvancedFilterMiddleware(
          fixture.env,
          legacy ? undefined : diagnostics,
        )(
          "overview",
          filterInput(PAYLOAD_COUNT_DSL, "session"),
          async (prepared) => prepared,
        );
        return { ids: entityIds(output), queries: cloned(fixture.trace) };
      };
      try {
        const current = await run(false);
        const currentEvaluatorCalls = evaluator.mock.calls.length;
        const legacy = await run(true);
        expect(current.ids).toEqual(legacy.ids);
        expect(current.ids).toContain(`wave91c-corrupt-${kind}-good-session`);
        expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
          kind: "payload-data-domain",
        });
        expect(currentEvaluatorCalls).toBeGreaterThan(0);
        expect(evaluator.mock.calls.length).toBeGreaterThan(
          currentEvaluatorCalls,
        );
        expect(
          current.queries.some((attempt) =>
            /custom_event_json_nodes/iu.test(attempt.sql),
          ),
        ).toBe(true);
        expect(
          current.queries.some((attempt) =>
            attempt.rows.some((row) => row.rowKind === "guard"),
          ),
        ).toBe(true);
      } finally {
        forceLegacy = false;
        classifier.mockRestore();
        evaluator.mockRestore();
      }
    },
  );

  it("keeps a legitimate nodeless event on the current C query", async () => {
    const fixture = createFixture();
    fixture.visit({
      visitId: "wave91c-nodeless-c-owner",
      sessionId: "wave91c-nodeless-c-session",
      visitorId: "wave91c-nodeless-c-visitor",
      startedAt: 100,
    });
    fixture.nodelessEvent({
      id: "wave91c-nodeless-c-event",
      visitId: "wave91c-nodeless-c-owner",
      name: "purchase",
      occurredAt: 110,
    });
    const diagnostics = createD1ReadDiagnostics();
    const evaluator = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const output = await d1AdvancedFilterMiddleware(fixture.env, diagnostics)(
        "overview",
        filterInput(PAYLOAD_COUNT_DSL, "session"),
        async (prepared) => prepared,
      );
      expect(entityIds(output)).toEqual([]);
      expect(evaluator).not.toHaveBeenCalled();
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(
        fixture.trace.some(
          (attempt) =>
            /custom_event_json_values/iu.test(attempt.sql) && attempt.ok,
        ),
      ).toBe(true);
    } finally {
      evaluator.mockRestore();
    }
  });

  it("routes unsupported trees and compile-budget overflow to the whole evaluator before C reads", async () => {
    const fixture = createFixture();
    fixture.visit({
      visitId: "wave91c-preflight-owner",
      sessionId: "wave91c-preflight-session",
      visitorId: "wave91c-preflight-visitor",
      startedAt: 100,
    });
    await fixture.event({
      id: "wave91c-preflight-event",
      visitId: "wave91c-preflight-owner",
      name: "purchase",
      occurredAt: 110,
      payload: { value: "v0" },
    });
    const unsupportedDsl =
      'count(event { event.name eq "purchase" AND event.payload("/value") contains "v0" }) gte 1';
    const budgetDsl = `count(event { event.name eq "purchase" AND event.payload("/value") in [${Array.from(
      { length: 101 },
      (_, index) => JSON.stringify(`v${index}`),
    ).join(", ")}] }) gte 1`;
    const evaluator = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      for (const [label, dsl, expectedBudgetItem] of [
        ["unsupported", unsupportedDsl, null],
        ["bindings-budget", budgetDsl, "bindings"],
      ] as const) {
        fixture.trace.length = 0;
        evaluator.mockClear();
        const diagnostics = createD1ReadDiagnostics();
        const output = await d1AdvancedFilterMiddleware(
          fixture.env,
          diagnostics,
        )(
          "overview",
          filterInput(dsl, "session"),
          async (prepared) => prepared,
        );
        expect(entityIds(output)).toEqual(["wave91c-preflight-session"]);
        expect(evaluator).toHaveBeenCalled();
        expect(
          fixture.trace.some((attempt) =>
            attempt.rows.some((row) => row.rowKind === "guard"),
          ),
        ).toBe(false);
        if (expectedBudgetItem === null)
          expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        else
          expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
            kind: "compile-budget",
            item: expectedBudgetItem,
            actual: expect.any(Number),
            limit: 100,
          });
        expect(label).toBeTruthy();
      }
    } finally {
      evaluator.mockRestore();
    }
  });

  it("preserves the payload result through the public overview DTO", async () => {
    const fixture = createFixture();
    const inputPages = [
      {
        visitId: "wave91c-dto-paid",
        sessionId: "wave91c-dto-session-paid",
        visitorId: "wave91c-dto-visitor-paid",
        payload: { category: "paid" },
      },
      {
        visitId: "wave91c-dto-free",
        sessionId: "wave91c-dto-session-free",
        visitorId: "wave91c-dto-visitor-free",
        payload: { category: "free" },
      },
    ] as const;
    for (const [index, page] of inputPages.entries()) {
      fixture.visit({ ...page, startedAt: 500 + index * 1000 });
      await fixture.event({
        id: `wave91c-dto-event-${index}`,
        visitId: page.visitId,
        name: "purchase",
        occurredAt: 600 + index * 1000,
        payload: page.payload,
      });
    }
    const dsl =
      'count(event { event.name eq "purchase" AND event.payload("/category") eq "paid" }) gte 1';
    const principal: ApiKeyPrincipal = {
      keyId: "wave91c-dto-key",
      teamId: "wave91c-team",
      prefix: "wave91c",
      scopes: ["analytics:read"],
      siteIds: [SITE_ID],
      status: "active",
    };
    const runtime = createEdgeSiteAnalyticsRuntime({
      env: fixture.env,
      siteId: SITE_ID,
    });
    const makeRequest = () =>
      new Request("https://app.test/api/v1/sites/site/analytics/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeRange: {
            kind: "absolute",
            from: "1970-01-01T00:00:00.000Z",
            to: "1970-01-01T00:00:03.000Z",
            timeZone: "UTC",
          },
          filter: { type: "dsl", expression: dsl },
          scope: "session",
        }),
      });
    const originalClassifier = countSupport.classifyAdvancedCountFilter;
    let legacy = false;
    const classifierSpy = vi
      .spyOn(countSupport, "classifyAdvancedCountFilter")
      .mockImplementation((document, scope) => {
        const result = originalClassifier(document, scope);
        return legacy &&
          hasPayloadSelector(document.root) &&
          result.kind === "supported"
          ? {
              kind: "unsupported",
              path: result.path,
              code: "wave91_legacy_payload_baseline",
              reason: "Test-only restoration of the 91A admission boundary.",
            }
          : result;
      });
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const evidence = {
      dsl,
      stages: [] as Array<Record<string, unknown>>,
      error: null as string | null,
    };
    const path = evidencePath("public-dto");
    try {
      for (const mode of ["current-sql", "91a-classification-seam"] as const) {
        legacy = mode !== "current-sql";
        fixture.trace.length = 0;
        const evaluatorOffset = evaluatorSpy.mock.calls.length;
        aggregateCache.clear();
        const response = await handlePlannedSiteOverview(
          makeRequest(),
          principal,
          SITE_ID,
          runtime,
          { capturedAtMs: 4_000 },
        );
        const body = await response.json();
        const stage = {
          mode,
          status: response.status,
          body: cloned(body),
          evaluatorCallCount: evaluatorSpy.mock.calls.length - evaluatorOffset,
          queries: cloned(fixture.trace),
        };
        evidence.stages.push(stage);
        persistEvidence(path, evidence);
        expect(response.status).toBe(200);
        if (mode === "current-sql") expect(stage.evaluatorCallCount).toBe(0);
        else expect(stage.evaluatorCallCount).toBeGreaterThan(0);
      }
      expect(
        (evidence.stages[0]?.body as { readonly data?: unknown })?.data,
      ).toEqual(
        (evidence.stages[1]?.body as { readonly data?: unknown })?.data,
      );
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      persistEvidence(path, evidence);
      throw error;
    } finally {
      legacy = false;
      classifierSpy.mockRestore();
      evaluatorSpy.mockRestore();
      aggregateCache.clear();
      persistEvidence(path, evidence);
    }
  });
});
