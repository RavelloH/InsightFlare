import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

import { aggregateCache } from "@/lib/api-v1/analytics/overview";
import { handlePlannedSiteOverview } from "@/lib/api-v1/analytics/overview-handler";
import type { DatabaseQueryObservation } from "@/lib/db";
import type { DatabaseQueryObserver } from "@/lib/db";
import {
  createD1DatabaseClient,
  registerDatabaseQueryObserver,
} from "@/lib/db";
import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition/edge-runtime";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import * as countSupport from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-support";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { ApiKeyPrincipal } from "@/lib/edge/auth/api-key-auth";
import { expandCustomEventDataJson } from "@/lib/edge/ingest/custom-event-json";
import { prepareCustomEventMutations } from "@/lib/edge/ingest/custom-event-write-mutations";
import type { BufferedCustomEventRow } from "@/lib/edge/ingest/types";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as filterEvaluator from "@/lib/filter-contract/filter-evaluator";

const COST_ENABLED = process.env.INSIGHTFLARE_WAVE91C_PAYLOAD_MINIFLARE === "1";
const CAPTURED_AT_MS = 31_000;
const COST_DSL =
  'count(page) gte 1 AND count(event { event.name eq "purchase" AND event.payload("/category") eq "paid" AND event.payload("/region") eq "north" }) gte 1';
const SCENARIOS = [
  {
    name: "small",
    siteId: "wave91c-payload-small-site",
    range: { startMs: 0, endExclusiveMs: 1_000 },
    pageCount: 8,
    eventCount: 4,
  },
  {
    name: "medium",
    siteId: "wave91c-payload-medium-site",
    range: { startMs: 1_000, endExclusiveMs: 3_000 },
    pageCount: 1_024,
    eventCount: 1_024,
  },
] as const;

type Metric = number | null;
type BindValue = string | number | boolean | Uint8Array | ArrayBuffer | null;
type CapturedOperation = "prepare" | "all" | "first" | "run" | "batch" | "exec";
type CapturedStatus = "started" | "success" | "failed";
type CapturedQuery = {
  readonly attemptId: number;
  readonly operation: CapturedOperation;
  readonly batchIndex?: number;
  readonly sql: string;
  readonly bindings: readonly BindValue[];
  status: CapturedStatus;
  error: { readonly name: string; readonly message: string } | null;
  resultCount: number | null;
  rows: readonly unknown[];
  rowsRead: Metric;
  rowsWritten: Metric;
  dbDurationMs: Metric;
  workerWallMs: number | null;
};
type CapturedPrepareAttempt = {
  readonly attemptId: number;
  readonly sql: string;
  status: CapturedStatus;
  error: { readonly name: string; readonly message: string } | null;
  workerWallMs: number;
};
const createdEvidencePaths = new Set<string>();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeEvidencePath(): string {
  const directory = join(process.cwd(), "plan", "execution-wave91");
  mkdirSync(directory, { recursive: true });
  return join(
    directory,
    `91c-payload-miniflare-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function persistEvidence(path: string, evidence: unknown): void {
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n", {
    encoding: "utf8",
    flag: createdEvidencePaths.has(path) ? "w" : "wx",
  });
  createdEvidencePaths.add(path);
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function copyBinding(value: BindValue): BindValue {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  return value;
}

function bindingEvidence(value: BindValue): unknown {
  const bytes =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : null;
  if (bytes)
    return {
      type: value instanceof ArrayBuffer ? "ArrayBuffer" : "Uint8Array",
      hex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ),
    };
  return value;
}

function errorRecord(error: unknown): CapturedQuery["error"] {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function captureResult(
  attempt: CapturedQuery,
  result: unknown,
  workerWallMs: number,
): void {
  const value = result as {
    readonly success?: unknown;
    readonly error?: unknown;
    readonly results?: readonly unknown[];
    readonly meta?: {
      readonly rows_read?: unknown;
      readonly rows_written?: unknown;
      readonly duration?: unknown;
      readonly timings?: { readonly sql_duration_ms?: unknown };
    };
  } | null;
  const rows =
    value && Array.isArray(value.results)
      ? value.results
      : attempt.operation === "first" && value !== null
        ? [value]
        : [];
  const sqlDuration = value?.meta?.timings?.sql_duration_ms;
  attempt.status = value?.success === false ? "failed" : "success";
  attempt.error =
    value?.success === false
      ? {
          name: "D1ResultFailure",
          message:
            typeof value.error === "string"
              ? value.error
              : "D1 returned success=false",
        }
      : null;
  attempt.resultCount = rows.length;
  attempt.rows = snapshot(rows);
  attempt.rowsRead = numeric(value?.meta?.rows_read);
  attempt.rowsWritten = numeric(value?.meta?.rows_written);
  attempt.dbDurationMs =
    numeric(sqlDuration) ?? numeric(value?.meta?.duration) ?? null;
  attempt.workerWallMs = workerWallMs;
}

function traceD1Database(database: D1Database) {
  const queries: CapturedQuery[] = [];
  const prepareAttempts: CapturedPrepareAttempt[] = [];
  let nextAttemptId = 1;
  const metadataByStatement = new WeakMap<
    object,
    {
      readonly native: D1PreparedStatement;
      readonly sql: string;
      readonly bindings: readonly BindValue[];
    }
  >();
  const wrapStatement = (
    statement: D1PreparedStatement,
    sql: string,
    bindings: readonly BindValue[],
  ): D1PreparedStatement => {
    const copiedBindings = bindings.map(copyBinding);
    const proxy = new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind")
          return (...values: BindValue[]) =>
            wrapStatement(
              Reflect.apply(
                Reflect.get(target, property, target) as (
                  ...input: BindValue[]
                ) => D1PreparedStatement,
                target,
                values,
              ),
              sql,
              values,
            );
        if (property === "all" || property === "first" || property === "run")
          return async (...args: unknown[]) => {
            const attempt: CapturedQuery = {
              attemptId: nextAttemptId++,
              operation: property,
              sql,
              bindings: copiedBindings.map(copyBinding),
              status: "started",
              error: null,
              resultCount: null,
              rows: [],
              rowsRead: null,
              rowsWritten: null,
              dbDurationMs: null,
              workerWallMs: null,
            };
            queries.push(attempt);
            const startedAt = performance.now();
            try {
              const result = await Reflect.apply(
                Reflect.get(target, property, target) as (
                  ...input: unknown[]
                ) => Promise<unknown>,
                target,
                args,
              );
              captureResult(attempt, result, performance.now() - startedAt);
              return result;
            } catch (error) {
              attempt.status = "failed";
              attempt.error = errorRecord(error);
              attempt.workerWallMs = performance.now() - startedAt;
              throw error;
            }
          };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    metadataByStatement.set(proxy, {
      native: statement,
      sql,
      bindings: copiedBindings,
    });
    return proxy;
  };
  const observed = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare")
        return (sql: string) => {
          const attempt: CapturedPrepareAttempt = {
            attemptId: nextAttemptId++,
            sql,
            status: "started",
            error: null,
            workerWallMs: 0,
          };
          prepareAttempts.push(attempt);
          const startedAt = performance.now();
          try {
            const statement = target.prepare(sql);
            attempt.status = "success";
            attempt.workerWallMs = performance.now() - startedAt;
            return wrapStatement(statement, sql, []);
          } catch (error) {
            attempt.status = "failed";
            attempt.error = errorRecord(error);
            attempt.workerWallMs = performance.now() - startedAt;
            throw error;
          }
        };
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const statementMetadata = statements.map((statement) =>
            metadataByStatement.get(statement as object),
          );
          const startedAt = performance.now();
          const attempts = statementMetadata.map((metadata, batchIndex) => {
            const attempt: CapturedQuery = {
              attemptId: nextAttemptId++,
              operation: "batch",
              batchIndex,
              sql: metadata?.sql ?? "",
              bindings: (metadata?.bindings ?? []).map(copyBinding),
              status: "started",
              error: metadata
                ? null
                : {
                    name: "UntrackedBatchStatement",
                    message:
                      "D1 batch received a statement outside the trace proxy",
                  },
              resultCount: null,
              rows: [],
              rowsRead: null,
              rowsWritten: null,
              dbDurationMs: null,
              workerWallMs: null,
            };
            if (!metadata) attempt.status = "failed";
            queries.push(attempt);
            return attempt;
          });
          const untracked = statementMetadata.some((metadata) => !metadata);
          if (untracked) throw new Error("wave91c_untracked_batch_statement");
          try {
            const results = await Reflect.apply(
              Reflect.get(target, property, target) as (
                input: D1PreparedStatement[],
              ) => Promise<readonly unknown[]>,
              target,
              statementMetadata.map((metadata) => metadata!.native),
            );
            const workerWallMs = performance.now() - startedAt;
            for (const [index, attempt] of attempts.entries()) {
              const result = results[index];
              if (result === undefined) {
                attempt.status = "failed";
                attempt.error = {
                  name: "D1BatchResultMissing",
                  message: "D1 batch returned fewer results than statements",
                };
                attempt.workerWallMs = workerWallMs;
              } else captureResult(attempt, result, workerWallMs);
            }
            return results;
          } catch (error) {
            const workerWallMs = performance.now() - startedAt;
            for (const attempt of attempts) {
              attempt.status = "failed";
              attempt.error = errorRecord(error);
              attempt.workerWallMs = workerWallMs;
            }
            throw error;
          }
        };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: observed, queries, prepareAttempts };
}

async function captureExplainPlans(
  database: D1Database,
  queries: readonly CapturedQuery[],
) {
  const evidence: Array<Record<string, unknown>> = [];
  for (const query of queries) {
    if (
      query.status !== "success" ||
      query.operation === "run" ||
      !/^\s*(?:SELECT|WITH)\b/iu.test(query.sql)
    )
      throw new Error("wave91c_cost_harness_unexpected_non_read_statement");
    const result = await database
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.bindings)
      .all<Record<string, unknown>>();
    const explainPlan = snapshot(result.results ?? []);
    evidence.push({
      traceAttemptId: query.attemptId,
      operation: query.operation,
      ...(query.batchIndex === undefined
        ? {}
        : { batchIndex: query.batchIndex }),
      sqlSha256: sha256(query.sql),
      sqlBytes: new TextEncoder().encode(query.sql).byteLength,
      bindings: query.bindings.map(bindingEvidence),
      explainPlan,
      explainPlanSha256: sha256(JSON.stringify(explainPlan)),
    });
  }
  return evidence;
}

const OBSERVER_INDEX_LIMIT = 256;
const OBSERVER_RELEASE_TIMEOUT_MS = 15_000;

function createObserverCapture() {
  type Session = {
    readonly sessionId: number;
    readonly operation: string;
    readonly statementCount: number;
    readonly selectedStatementCount: number;
    readonly released: Promise<void>;
    resolveRelease: () => void;
    releaseCount: number;
  };
  const sessions: Session[] = [];
  const records: Array<{
    readonly sessionId: number;
    readonly event: DatabaseQueryObservation;
  }> = [];
  const observer: DatabaseQueryObserver = {
    begin({ operation, statementCount }) {
      let resolveRelease = () => {};
      const released = new Promise<void>((resolvePromise) => {
        resolveRelease = resolvePromise;
      });
      const session: Session = {
        sessionId: sessions.length,
        operation,
        statementCount,
        selectedStatementCount: Math.min(statementCount, OBSERVER_INDEX_LIMIT),
        released,
        resolveRelease: () => resolveRelease(),
        releaseCount: 0,
      };
      sessions.push(session);
      return {
        statementIndexes: Array.from(
          { length: session.selectedStatementCount },
          (_, index) => index,
        ),
        includeBatchSummary: true,
        record(event: DatabaseQueryObservation) {
          records.push({
            sessionId: session.sessionId,
            event: snapshot(event),
          });
        },
        release() {
          session.releaseCount += 1;
          session.resolveRelease();
        },
      };
    },
  };
  return {
    observer,
    get sessionCount() {
      return sessions.length;
    },
    async waitForRelease(startIndex: number): Promise<void> {
      const pending = sessions.slice(startIndex);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(pending.map((session) => session.released)),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("wave91c_observer_release_timeout")),
              OBSERVER_RELEASE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
    recordsFor(startIndex: number) {
      return records.filter(({ sessionId }) => sessionId >= startIndex);
    },
    sessionsFor(startIndex: number) {
      return sessions.slice(startIndex).map((session) => ({
        sessionId: session.sessionId,
        operation: session.operation,
        statementCount: session.statementCount,
        selectedStatementCount: session.selectedStatementCount,
        fullySelected:
          session.statementCount === session.selectedStatementCount,
        releaseCount: session.releaseCount,
      }));
    },
  };
}

async function applySchema(
  database: D1Database,
  onProgress?: (progress: {
    readonly statementCount: number;
    readonly appliedCount: number;
  }) => void,
): Promise<void> {
  const schema = readFileSync(
    resolve(process.cwd(), "docs/schema.sql"),
    "utf8",
  );
  const statements = unstable_splitSqlQuery(schema).map((sql) =>
    database.prepare(sql),
  );
  let appliedCount = 0;
  onProgress?.({ statementCount: statements.length, appliedCount });
  for (let offset = 0; offset < statements.length; offset += 50) {
    const batch = statements.slice(offset, offset + 50);
    await database.batch(batch);
    appliedCount += batch.length;
    onProgress?.({ statementCount: statements.length, appliedCount });
  }
}

async function ensurePath(
  database: D1Database,
  cache: Map<string, number>,
  site: { readonly id: string; readonly pk: number },
  path: string,
): Promise<number> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const existing = await database
    .prepare(
      "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
    )
    .bind(site.pk, path)
    .first<{ readonly id: number }>();
  if (existing) {
    cache.set(path, existing.id);
    return existing.id;
  }
  await database
    .prepare(
      "INSERT INTO custom_event_json_paths (site_id, path, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    )
    .bind(site.id, path, CAPTURED_AT_MS, site.pk)
    .run();
  const inserted = await database
    .prepare(
      "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
    )
    .bind(site.pk, path)
    .first<{ readonly id: number }>();
  if (!inserted) throw new Error("wave91c_seed_path_insert_missing");
  cache.set(path, inserted.id);
  return inserted.id;
}

async function ensureKey(
  database: D1Database,
  cache: Map<string, number>,
  site: { readonly id: string; readonly pk: number },
  key: string,
): Promise<number> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const existing = await database
    .prepare(
      'SELECT id FROM custom_event_json_keys WHERE site_pk = ? AND "key" = ?',
    )
    .bind(site.pk, key)
    .first<{ readonly id: number }>();
  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }
  await database
    .prepare(
      'INSERT INTO custom_event_json_keys (site_id, "key", last_seen_at, site_pk) VALUES (?, ?, ?, ?)',
    )
    .bind(site.id, key, CAPTURED_AT_MS, site.pk)
    .run();
  const inserted = await database
    .prepare(
      'SELECT id FROM custom_event_json_keys WHERE site_pk = ? AND "key" = ?',
    )
    .bind(site.pk, key)
    .first<{ readonly id: number }>();
  if (!inserted) throw new Error("wave91c_seed_key_insert_missing");
  cache.set(key, inserted.id);
  return inserted.id;
}

async function seedSite(
  database: D1Database,
  scenario: (typeof SCENARIOS)[number],
  sitePk: number,
  onProgress?: (progress: Readonly<Record<string, number>>) => void,
): Promise<Record<string, number>> {
  const site = { id: scenario.siteId, pk: sitePk };
  const progress: Record<string, number> = {
    sites: 0,
    siteIdentities: 0,
    visits: 0,
    eventNames: 0,
    payloadEventsPrepared: 0,
    nodelessEvents: 0,
    writerMutationsCompleted: 0,
    writerBatchesCompleted: 0,
  };
  const reportProgress = () => onProgress?.(snapshot(progress));
  await database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, 0)",
    )
    .bind(
      site.id,
      "wave91c-payload-team",
      scenario.name,
      `${scenario.name}.wave91c.test`,
    )
    .run();
  progress.sites = 1;
  reportProgress();
  await database
    .prepare("INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)")
    .bind(site.pk, site.id)
    .run();
  progress.siteIdentities = 1;
  reportProgress();

  const pages = Array.from({ length: scenario.pageCount }, (_, index) => {
    const startedAt = scenario.range.startMs + 100 + index;
    const visitId = `${site.id}-visit-${index}`;
    return database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, status, started_at,
          last_activity_at, pathname, hostname, site_pk
        ) VALUES (?, ?, ?, ?, 'closed', ?, ?, '/', ?, ?)`,
      )
      .bind(
        visitId,
        site.id,
        `${site.id}-visitor-${index}`,
        `${site.id}-session-${index}`,
        startedAt,
        startedAt,
        `${scenario.name}.wave91c.test`,
        site.pk,
      );
  });
  for (let offset = 0; offset < pages.length; offset += 50) {
    const batch = pages.slice(offset, offset + 50);
    await database.batch(batch);
    progress.visits += batch.length;
    reportProgress();
  }

  await database.batch([
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(sitePk * 10 + 1, site.id, "purchase", CAPTURED_AT_MS, site.pk),
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(sitePk * 10 + 2, site.id, "refund", CAPTURED_AT_MS, site.pk),
  ]);
  progress.eventNames = 2;
  reportProgress();
  const nameIds = new Map([
    ["purchase", sitePk * 10 + 1],
    ["refund", sitePk * 10 + 2],
  ]);
  const pathIds = new Map<string, number>();
  const keyIds = new Map<string, number>();
  const mutations: Array<
    ReturnType<typeof prepareCustomEventMutations>[number]
  > = [];
  let writtenPayloadEvents = 0;
  let nodelessEvents = 0;
  let matchedEvents = 0;
  let payloadNonmatches = 0;
  let refundEvents = 0;

  for (let index = 0; index < scenario.eventCount; index += 1) {
    const visitId = `${site.id}-visit-${index}`;
    const occurredAt = scenario.range.startMs + 110 + index;
    const distribution = index % 5;
    const name = distribution === 3 ? "refund" : "purchase";
    if (distribution === 3) refundEvents += 1;
    if (scenario.name === "medium" && distribution === 4 && index % 10 === 4) {
      await database
        .prepare(
          `INSERT INTO custom_events (
            event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`,
        )
        .bind(
          `${site.id}-nodeless-event-${index}`,
          site.id,
          site.pk,
          visitId,
          nameIds.get(name),
          occurredAt,
          occurredAt,
          occurredAt,
        )
        .run();
      nodelessEvents += 1;
      progress.nodelessEvents += 1;
      reportProgress();
      continue;
    }

    const payload =
      distribution === 0 || distribution === 3
        ? { category: "paid", region: "north" }
        : distribution === 1
          ? { category: "free", region: "north" }
          : distribution === 2
            ? { category: "paid", region: "south" }
            : { region: "north" };
    if (distribution === 0) matchedEvents += 1;
    else payloadNonmatches += 1;
    const eventJson = JSON.stringify(payload);
    const expanded = expandCustomEventDataJson(eventJson);
    if (!expanded.ok) throw new Error(expanded.error);
    const resolvedPaths = new Map<string, number>();
    for (const path of expanded.data.paths)
      resolvedPaths.set(path, await ensurePath(database, pathIds, site, path));
    const resolvedKeys = new Map<string, number>();
    for (const key of expanded.data.keys)
      resolvedKeys.set(key, await ensureKey(database, keyIds, site, key));
    const row: BufferedCustomEventRow = {
      eventId: `${site.id}-event-${index}`,
      siteId: site.id,
      visitId,
      occurredAt,
      receivedAt: occurredAt,
      sequence: 1,
      eventName: name,
      eventDataJson: eventJson,
      userId: "",
      dirty: 1,
      flushAttempts: 0,
      createdAt: occurredAt,
    };
    mutations.push(
      ...prepareCustomEventMutations(
        row,
        expanded.data,
        {
          eventNameId: nameIds.get(name)!,
          pathIds: resolvedPaths,
          keyIds: resolvedKeys,
        },
        site.pk,
      ),
    );
    writtenPayloadEvents += 1;
    progress.payloadEventsPrepared = writtenPayloadEvents;
    reportProgress();
  }

  const writer = createD1DatabaseClient(database);
  for (let offset = 0; offset < mutations.length; offset += 50) {
    const batch = mutations.slice(offset, offset + 50);
    await writer.batch(batch);
    progress.writerMutationsCompleted += batch.length;
    progress.writerBatchesCompleted += 1;
    reportProgress();
  }
  const writerRootPathRows = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM custom_event_json_nodes n JOIN custom_events e ON e.event_pk = n.event_pk WHERE e.site_pk = ? AND n.parent_node_id IS NULL AND n.path_id IN (SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?)",
    )
    .bind(site.pk, site.pk, "/")
    .first<{ readonly count: number }>();
  if (!writerRootPathRows)
    throw new Error("wave91c_seed_root_path_count_missing");
  return {
    pages: scenario.pageCount,
    events: scenario.eventCount,
    writerPayloadEvents: writtenPayloadEvents,
    nodelessEvents,
    matchedPurchaseEvents: matchedEvents,
    payloadNonmatchEvents: payloadNonmatches,
    refundEvents,
    writerRootPathRows: Number(writerRootPathRows.count),
  };
}

async function seedInvalidUtf8Diagnostic(
  database: D1Database,
  sitePk: number,
  onProgress: (progress: Readonly<Record<string, unknown>>) => void,
): Promise<Record<string, unknown>> {
  const site = { id: "wave91c-invalid-utf8-site", pk: sitePk };
  const progress: Record<string, unknown> = {
    sites: 0,
    siteIdentities: 0,
    visits: 0,
    eventNames: 0,
    writerEvents: 0,
    writerMutationsCompleted: 0,
    corruptionApplied: false,
  };
  const report = () => onProgress(snapshot(progress));
  await database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, 0)",
    )
    .bind(
      site.id,
      "wave91c-payload-team",
      "invalid UTF-8 diagnostic",
      "invalid-utf8.wave91c.test",
    )
    .run();
  progress.sites = 1;
  report();
  await database
    .prepare("INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)")
    .bind(site.pk, site.id)
    .run();
  progress.siteIdentities = 1;
  report();
  await database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, site_pk
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, '/', ?, ?)`,
    )
    .bind(
      `${site.id}-visit`,
      site.id,
      `${site.id}-visitor`,
      `${site.id}-session`,
      100,
      200,
      "invalid-utf8.wave91c.test",
      site.pk,
    )
    .run();
  progress.visits = 1;
  report();
  const eventNameId = sitePk * 10 + 1;
  await database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(eventNameId, site.id, "purchase", CAPTURED_AT_MS, site.pk)
    .run();
  progress.eventNames = 1;
  report();

  const pathIds = new Map<string, number>();
  const keyIds = new Map<string, number>();
  const writeEvent = async (input: {
    readonly eventId: string;
    readonly occurredAt: number;
    readonly payload: Record<string, unknown>;
  }) => {
    const eventJson = JSON.stringify(input.payload);
    const expanded = expandCustomEventDataJson(eventJson);
    if (!expanded.ok) throw new Error(expanded.error);
    const resolvedPaths = new Map<string, number>();
    for (const path of expanded.data.paths)
      resolvedPaths.set(path, await ensurePath(database, pathIds, site, path));
    const resolvedKeys = new Map<string, number>();
    for (const key of expanded.data.keys)
      resolvedKeys.set(key, await ensureKey(database, keyIds, site, key));
    const row: BufferedCustomEventRow = {
      eventId: input.eventId,
      siteId: site.id,
      visitId: `${site.id}-visit`,
      occurredAt: input.occurredAt,
      receivedAt: input.occurredAt,
      sequence: input.occurredAt,
      eventName: "purchase",
      eventDataJson: eventJson,
      userId: "",
      dirty: 1,
      flushAttempts: 0,
      createdAt: input.occurredAt,
    };
    const mutations = prepareCustomEventMutations(
      row,
      expanded.data,
      { eventNameId, pathIds: resolvedPaths, keyIds: resolvedKeys },
      site.pk,
    );
    const writer = createD1DatabaseClient(database);
    for (let offset = 0; offset < mutations.length; offset += 50) {
      const batch = mutations.slice(offset, offset + 50);
      await writer.batch(batch);
      progress.writerMutationsCompleted =
        Number(progress.writerMutationsCompleted) + batch.length;
      report();
    }
    progress.writerEvents = Number(progress.writerEvents) + 1;
    report();
    const event = await database
      .prepare(
        "SELECT event_pk FROM custom_events WHERE event_id = ? AND site_pk = ?",
      )
      .bind(input.eventId, site.pk)
      .first<{ readonly event_pk: number }>();
    if (!event) throw new Error("wave91c_invalid_utf8_writer_event_missing");
    const value = await database
      .prepare(
        `SELECT v.node_id
         FROM custom_event_json_values v
         JOIN custom_event_json_paths p
           ON p.id = v.path_id AND p.site_pk = v.site_pk
         WHERE v.event_pk = ? AND p.path = '/value'`,
      )
      .bind(event.event_pk)
      .first<{ readonly node_id: number }>();
    if (!value) throw new Error("wave91c_invalid_utf8_writer_value_missing");
    return { eventPk: event.event_pk, valueNodeId: value.node_id };
  };

  const asciiEvent = await writeEvent({
    eventId: `${site.id}-ascii-event`,
    occurredAt: 110,
    payload: { value: "target" },
  });
  const emptyEvent = await writeEvent({
    eventId: `${site.id}-empty-event`,
    occurredAt: 120,
    payload: { value: "" },
  });
  await database
    .prepare(
      "UPDATE custom_event_json_values SET string_value = CAST(X'FF' AS TEXT) WHERE event_pk = ? AND node_id = ?",
    )
    .bind(asciiEvent.eventPk, asciiEvent.valueNodeId)
    .run();
  progress.corruptionApplied = true;
  report();
  const corrupted = await database
    .prepare(
      "SELECT typeof(string_value) AS storage_type, hex(CAST(string_value AS BLOB)) AS raw_hex FROM custom_event_json_values WHERE event_pk = ? AND node_id = ?",
    )
    .bind(asciiEvent.eventPk, asciiEvent.valueNodeId)
    .first<{ readonly storage_type: string; readonly raw_hex: string }>();
  if (!corrupted) throw new Error("wave91c_invalid_utf8_corruption_missing");
  return {
    siteId: site.id,
    sitePk: site.pk,
    events: 2,
    asciiEvent: { eventId: `${site.id}-ascii-event`, ...asciiEvent },
    emptyEvent: { eventId: `${site.id}-empty-event`, ...emptyEvent },
    corruptionSql:
      "UPDATE custom_event_json_values SET string_value = CAST(X'FF' AS TEXT) WHERE event_pk = ? AND node_id = ?",
    corruptedStorage: corrupted,
    progress: snapshot(progress),
  };
}

function requestInput(
  siteId: SiteId,
  range: { readonly startMs: number; readonly endExclusiveMs: number },
  dsl = COST_DSL,
) {
  const time = createQueryTime(
    range.startMs,
    range.endExclusiveMs,
    "UTC",
    CAPTURED_AT_MS,
  );
  const document = parseFilterDsl(dsl, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("overview", document, "session");
  if (!plan) throw new Error("wave91c_cost_scope_plan_missing");
  const filters = attachScopedFilterMetadata(document, {
    requestedScope: "session",
    resolvedScope: "session",
    plan,
    time,
    siteIds: [siteId],
  });
  return {
    context: siteQueryContext(siteId, "private-dashboard"),
    filters,
    scopePreference: "session" as const,
    scopePlan: plan,
    time,
  };
}

function publicOverviewRequest(
  siteId: SiteId,
  range: { readonly startMs: number; readonly endExclusiveMs: number },
  dsl = COST_DSL,
): Request {
  return new Request(
    `https://app.test/api/v1/sites/${encodeURIComponent(siteId)}/analytics/overview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timeRange: {
          kind: "absolute",
          from: new Date(range.startMs).toISOString(),
          to: new Date(range.endExclusiveMs).toISOString(),
          timeZone: "UTC",
        },
        filter: { type: "dsl", expression: dsl },
        scope: "session",
      }),
    },
  );
}

function overviewPrincipal(siteId: SiteId): ApiKeyPrincipal {
  return {
    keyId: "wave91c-payload-cost-key",
    teamId: "wave91c-payload-team",
    prefix: "wave91c",
    scopes: ["analytics:read"],
    siteIds: [siteId],
    status: "active",
  };
}

function payloadTarget(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(payloadTarget);
  const record = value as Record<string, unknown>;
  return (
    record.kind === "event-payload" || Object.values(record).some(payloadTarget)
  );
}

function outputIds(output: unknown): string[] {
  const scopePlan = (output as { readonly scopePlan?: Record<string, unknown> })
    .scopePlan;
  const matches = scopePlan?.advancedMatches as
    { readonly entityIds?: readonly { readonly id: string }[] } | undefined;
  return matches?.entityIds?.map(({ id }) => id).sort() ?? [];
}

function statementObservations(
  observations: readonly DatabaseQueryObservation[],
): DatabaseQueryObservation[] {
  return observations.filter(
    (observation) =>
      observation.operation !== "batch" || observation.batchIndex !== null,
  );
}

function traceObservationKey(input: {
  readonly operation: CapturedOperation;
  readonly batchIndex?: number | null;
  readonly sqlBytes: number;
  readonly bindingCount: number;
}): string {
  return JSON.stringify([
    input.operation,
    input.operation === "batch" ? input.batchIndex : null,
    input.sqlBytes,
    input.bindingCount,
  ]);
}

function correlateTraceAndObservations(
  queries: readonly CapturedQuery[],
  observations: readonly DatabaseQueryObservation[],
  observerSessions: readonly Record<string, unknown>[],
) {
  const statementEvents = statementObservations(observations);
  const indexesByKey = new Map<string, number[]>();
  for (const [index, observation] of statementEvents.entries()) {
    const key = traceObservationKey({
      operation: observation.operation,
      batchIndex:
        observation.operation === "batch" ? observation.batchIndex : undefined,
      sqlBytes: observation.sqlBytes ?? -1,
      bindingCount: observation.bindings ?? -1,
    });
    const indexes = indexesByKey.get(key) ?? [];
    indexes.push(index);
    indexesByKey.set(key, indexes);
  }
  const sqlFingerprintsByKey = new Map<string, Set<string>>();
  for (const query of queries) {
    const key = traceObservationKey({
      operation: query.operation,
      batchIndex: query.batchIndex,
      sqlBytes: new TextEncoder().encode(query.sql).byteLength,
      bindingCount: query.bindings.length,
    });
    const fingerprints = sqlFingerprintsByKey.get(key) ?? new Set<string>();
    fingerprints.add(sha256(query.sql));
    sqlFingerprintsByKey.set(key, fingerprints);
  }
  const ambiguousSignatures = [...sqlFingerprintsByKey.entries()]
    .filter(([, fingerprints]) => fingerprints.size > 1)
    .map(([signature, fingerprints]) => ({
      signature,
      candidateSqlSha256: [...fingerprints].sort(),
    }));
  const matches: Array<Record<string, unknown>> = [];
  const unmatchedTraceAttemptIds: number[] = [];
  const statusMismatches: number[] = [];
  for (const query of queries) {
    const key = traceObservationKey({
      operation: query.operation,
      batchIndex: query.batchIndex,
      sqlBytes: new TextEncoder().encode(query.sql).byteLength,
      bindingCount: query.bindings.length,
    });
    const indexes = indexesByKey.get(key);
    const matchingStatusIndex = indexes?.findIndex(
      (candidateIndex) =>
        statementEvents[candidateIndex]?.status === query.status,
    );
    const index =
      indexes && matchingStatusIndex !== undefined && matchingStatusIndex >= 0
        ? indexes.splice(matchingStatusIndex, 1)[0]
        : indexes?.shift();
    if (index === undefined) {
      unmatchedTraceAttemptIds.push(query.attemptId);
      continue;
    }
    const observation = statementEvents[index]!;
    if (observation.status !== query.status)
      statusMismatches.push(query.attemptId);
    matches.push({
      traceAttemptId: query.attemptId,
      sqlSha256: sha256(query.sql),
      sqlBytes: new TextEncoder().encode(query.sql).byteLength,
      bindingCount: query.bindings.length,
      observerStatementIndex: index,
      operation: observation.operation,
      batchIndex:
        observation.operation === "batch" ? observation.batchIndex : null,
      tag: observation.tag,
      associationConfidence:
        (sqlFingerprintsByKey.get(key)?.size ?? 0) > 1
          ? "candidate"
          : "signature-unique",
      candidateSqlSha256: [...(sqlFingerprintsByKey.get(key) ?? [])].sort(),
      observerPhysicalPlanHash: observation.physicalPlanHash,
      status: observation.status,
    });
  }
  const unmatchedObserverIndexes = [...indexesByKey.values()].flat();
  const sessionsReleasedExactlyOnce = observerSessions.every(
    (session) => session.releaseCount === 1,
  );
  const sessionsFullySelected = observerSessions.every(
    (session) => session.fullySelected === true,
  );
  const complete =
    unmatchedTraceAttemptIds.length === 0 &&
    unmatchedObserverIndexes.length === 0 &&
    matches.length === queries.length &&
    matches.length === statementEvents.length &&
    statusMismatches.length === 0 &&
    sessionsReleasedExactlyOnce &&
    sessionsFullySelected;
  return {
    complete,
    traceStatementCount: queries.length,
    observerStatementCount: statementEvents.length,
    observerBatchSummaryCount: observations.length - statementEvents.length,
    matchedStatementCount: matches.length,
    unmatchedTraceAttemptIds,
    unmatchedObserverIndexes,
    statusMismatches,
    sessionsReleasedExactlyOnce,
    sessionsFullySelected,
    correlationBasis:
      "operation + batchIndex + SQL byte length + binding count + status; observer does not expose SQL text",
    ambiguousSignatureCount: ambiguousSignatures.length,
    ambiguousSignatures,
    matches,
  };
}

function totalMetric(values: readonly (number | null)[]) {
  const available =
    values.length > 0 &&
    values.every((value) => value !== null && Number.isFinite(value));
  return {
    available,
    value: available
      ? (values as readonly number[]).reduce((sum, value) => sum + value, 0)
      : null,
  };
}

function measurementTotals(stage: Record<string, unknown>) {
  const allObservations =
    stage.observations as readonly DatabaseQueryObservation[];
  const observations = statementObservations(allObservations);
  const queries = stage.queries as readonly CapturedQuery[];
  const rowsRead = totalMetric(observations.map(({ rowsRead }) => rowsRead));
  const rowsWritten = totalMetric(
    observations.map(({ rowsWritten }) => rowsWritten),
  );
  const dbDurationMs = totalMetric(
    observations.map(({ dbDurationMs }) => dbDurationMs),
  );
  const observerElapsedMs = totalMetric(
    observations.map(({ elapsedMs }) => elapsedMs),
  );
  const returnedRows = totalMetric(
    queries.map(({ resultCount }) => resultCount),
  );
  return {
    rowsReadAvailable: rowsRead.available,
    rowsRead: rowsRead.value,
    rowsWrittenAvailable: rowsWritten.available,
    rowsWritten: rowsWritten.value,
    dbDurationAvailable: dbDurationMs.available,
    dbDurationMs: dbDurationMs.value,
    observerElapsedAvailable: observerElapsedMs.available,
    observerElapsedMs: observerElapsedMs.value,
    returnedRowsAvailable: returnedRows.available,
    returnedRows: returnedRows.value,
  };
}

describe("advanced payload count SQL actual Miniflare D1 cost", () => {
  it.skipIf(!COST_ENABLED)(
    "compares current payload SQL with the same-DSL 91A middleware once on small and medium data",
    async () => {
      const configDirectory = mkdtempSync(
        join(tmpdir(), "advanced-payload-miniflare-"),
      );
      const configPath = join(configDirectory, "wrangler.toml");
      writeFileSync(
        configPath,
        [
          'name = "advanced-payload-miniflare-test"',
          'compatibility_date = "2026-03-01"',
          "[[d1_databases]]",
          'binding = "DB"',
          'database_name = "advanced_payload_cost_test"',
          'database_id = "local-test"',
          "",
        ].join("\n"),
      );
      const evidencePath = makeEvidencePath();
      const evidence: {
        readonly phase: string;
        fixture: Record<string, unknown>;
        stages: Array<Record<string, unknown>>;
        explainPlans: Array<Record<string, unknown>>;
        explainPlansSha256?: string;
        explainPlanErrors: Array<Record<string, unknown>>;
        invalidUtf8Diagnostic?: Record<string, unknown>;
        comparison?: Record<string, unknown>;
        error: string | null;
      } = {
        phase: "91C same-DSL payload cost harness",
        fixture: { setupStatus: "starting" },
        stages: [],
        explainPlans: [],
        explainPlanErrors: [],
        invalidUtf8Diagnostic: { setupStatus: "pending", stages: [] },
        error: null,
      };
      let disposePlatform: (() => Promise<void>) | undefined;
      let legacyClassifier = false;
      const originalClassifier = countSupport.classifyAdvancedCountFilter;
      const classifierSpy = vi
        .spyOn(countSupport, "classifyAdvancedCountFilter")
        .mockImplementation((document, scope) => {
          const support = originalClassifier(document, scope);
          if (
            legacyClassifier &&
            payloadTarget(document.root) &&
            support.kind === "supported"
          )
            return {
              kind: "unsupported",
              path: support.path,
              code: "wave91_legacy_payload_baseline",
              reason:
                "Test-only 91A classification boundary; keep the production readers and evaluator.",
            };
          return support;
        });
      const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
      try {
        const platform = await getPlatformProxy<Env>({
          configPath,
          envFiles: [],
          persist: false,
          remoteBindings: false,
        });
        disposePlatform = platform.dispose;
        const schemaSql = readFileSync(
          resolve(process.cwd(), "docs/schema.sql"),
          "utf8",
        );
        const fixtureCounts: Record<string, unknown> = {
          schemaSqlSha256: sha256(schemaSql),
          schemaStatementCount: unstable_splitSqlQuery(schemaSql).length,
          schemaApplied: false,
          schemaProgress: { appliedCount: 0 },
          accountRows: { status: "pending" },
          siteCount: SCENARIOS.length,
          sites: {},
        };
        evidence.fixture = fixtureCounts;
        persistEvidence(evidencePath, evidence);
        await applySchema(platform.env.DB, (progress) => {
          fixtureCounts.schemaProgress = progress;
          persistEvidence(evidencePath, evidence);
        });
        fixtureCounts.schemaApplied = true;
        persistEvidence(evidencePath, evidence);
        fixtureCounts.accountRows = { status: "started" };
        persistEvidence(evidencePath, evidence);
        await platform.env.DB.batch([
          platform.env.DB.prepare(
            "INSERT INTO users (id, email) VALUES (?, ?)",
          ).bind("wave91c-payload-user", "wave91c-payload@example.test"),
          platform.env.DB.prepare(
            "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
          ).bind(
            "wave91c-payload-team",
            "Wave 91C payload cost",
            "wave91c-payload-team",
            "wave91c-payload-user",
          ),
        ]);
        fixtureCounts.accountRows = { status: "complete", users: 1, teams: 1 };
        persistEvidence(evidencePath, evidence);
        const sites: Record<string, { siteId: SiteId; sitePk: number }> = {};
        const sitesRecord = fixtureCounts.sites as Record<string, unknown>;
        for (const [index, scenario] of SCENARIOS.entries()) {
          const sitePk = index + 1;
          const siteProgress: Record<string, unknown> = {
            status: "seeding",
            sitePk,
            completedCounts: {},
          };
          sitesRecord[scenario.name] = siteProgress;
          persistEvidence(evidencePath, evidence);
          const counts = await seedSite(
            platform.env.DB,
            scenario,
            sitePk,
            (progress) => {
              siteProgress.completedCounts = progress;
              persistEvidence(evidencePath, evidence);
            },
          );
          sites[scenario.name] = {
            siteId: scenario.siteId as SiteId,
            sitePk,
          };
          sitesRecord[scenario.name] = {
            status: "complete",
            sitePk,
            counts,
          };
          persistEvidence(evidencePath, evidence);
        }
        evidence.fixture = snapshot(fixtureCounts);
        persistEvidence(evidencePath, evidence);

        const traced = traceD1Database(platform.env.DB);
        const env = { ...platform.env, DB: traced.database } as Env;
        const observerCapture = createObserverCapture();
        registerDatabaseQueryObserver(
          traced.database,
          observerCapture.observer,
        );
        const stageByKey = new Map<string, Record<string, unknown>>();
        const tracesByStage = new Map<string, CapturedQuery[]>();

        const captureRequestStage = async (input: {
          readonly scenario: string;
          readonly mode: "current-sql" | "91a-classification-seam";
          readonly requestKind:
            | "identity-diagnostic"
            | "public-overview"
            | "invalid-utf8-diagnostic";
          readonly siteId: SiteId;
          readonly range: {
            readonly startMs: number;
            readonly endExclusiveMs: number;
          };
          readonly dsl: string;
          readonly execute: () => Promise<unknown>;
          readonly expectedEntityIds?: readonly string[];
        }): Promise<Record<string, unknown>> => {
          aggregateCache.clear();
          evaluatorSpy.mockClear();
          const stage: Record<string, unknown> = {
            scenario: input.scenario,
            mode: input.mode,
            requestKind: input.requestKind,
            request: {
              dsl: input.dsl,
              siteId: input.siteId,
              range: input.range,
              scope: "session",
              capturedAtMs: CAPTURED_AT_MS,
            },
            ...(input.expectedEntityIds === undefined
              ? {}
              : { expectedEntityIds: [...input.expectedEntityIds] }),
            requestStatus: "started",
            requestError: null,
            evaluatorCallCount: null,
            workerWallMs: null,
            queries: [],
            prepareAttempts: [],
            observations: [],
            observerSessions: [],
            traceCoverage: null,
            measurementTotals: null,
          };
          evidence.stages.push(stage);
          persistEvidence(evidencePath, evidence);

          const queryOffset = traced.queries.length;
          const prepareOffset = traced.prepareAttempts.length;
          const observerOffset = observerCapture.sessionCount;
          const startedAt = performance.now();
          let barrierError: unknown;
          try {
            stage.result = snapshot(await input.execute());
            stage.requestStatus = "completed";
          } catch (error) {
            stage.requestStatus = "threw";
            stage.requestError = errorRecord(error);
          } finally {
            stage.workerWallMs = performance.now() - startedAt;
            const barrierStartedAt = performance.now();
            try {
              await observerCapture.waitForRelease(observerOffset);
              stage.observerBarrier = "released";
            } catch (error) {
              barrierError = error;
              stage.observerBarrier = "failed";
              stage.observerBarrierError = errorRecord(error);
            }
            stage.observerBarrierWaitMs = performance.now() - barrierStartedAt;

            const queryAttempts = traced.queries.slice(queryOffset);
            const prepareAttempts = traced.prepareAttempts.slice(prepareOffset);
            const observationRecords =
              observerCapture.recordsFor(observerOffset);
            const observations = observationRecords.map(({ event }) => event);
            const observerSessions =
              observerCapture.sessionsFor(observerOffset);
            const queryEvidence = queryAttempts.map((query) => ({
              ...query,
              bindings: query.bindings.map(bindingEvidence),
              sqlSha256: sha256(query.sql),
              sqlBytes: new TextEncoder().encode(query.sql).byteLength,
            }));
            stage.queries = snapshot(queryEvidence);
            stage.prepareAttempts = snapshot(prepareAttempts);
            stage.observations = snapshot(observations);
            stage.observerSessions = snapshot(observerSessions);
            stage.rawReturnedRows = queryAttempts.map((query) => ({
              attemptId: query.attemptId,
              operation: query.operation,
              ...(query.batchIndex === undefined
                ? {}
                : { batchIndex: query.batchIndex }),
              resultCount: query.resultCount,
              rows: snapshot(query.rows),
              error: query.error,
            }));
            stage.traceCoverage = correlateTraceAndObservations(
              queryAttempts,
              observations,
              observerSessions,
            );
            stage.evaluatorCallCount = evaluatorSpy.mock.calls.length;
            stage.measurementTotals = measurementTotals(stage);
            tracesByStage.set(
              `${input.scenario}:${input.mode}:${input.requestKind}`,
              queryAttempts,
            );
            persistEvidence(evidencePath, evidence);
          }
          if (barrierError) throw barrierError;
          return stage;
        };

        for (const scenario of SCENARIOS) {
          const siteId = sites[scenario.name]!.siteId;
          const expectedIds = Array.from(
            { length: scenario.eventCount },
            (_, index) => index,
          )
            .filter((index) => index % 5 === 0)
            .map((index) => `${siteId}-session-${index}`)
            .sort();
          for (const mode of [
            "current-sql",
            "91a-classification-seam",
          ] as const) {
            legacyClassifier = mode !== "current-sql";
            const identityKey = `${scenario.name}:${mode}:identity-diagnostic`;
            const identity = await captureRequestStage({
              scenario: scenario.name,
              mode,
              requestKind: "identity-diagnostic",
              siteId,
              range: scenario.range,
              dsl: COST_DSL,
              expectedEntityIds: expectedIds,
              execute: async () => {
                const output = await d1AdvancedFilterMiddleware(env)(
                  "overview",
                  requestInput(siteId, scenario.range, COST_DSL),
                  async (prepared) => prepared,
                );
                return { entityIds: outputIds(output) };
              },
            });
            stageByKey.set(identityKey, identity);

            const publicKey = `${scenario.name}:${mode}:public-overview`;
            const publicStage = await captureRequestStage({
              scenario: scenario.name,
              mode,
              requestKind: "public-overview",
              siteId,
              range: scenario.range,
              dsl: COST_DSL,
              execute: async () => {
                const runtime = createEdgeSiteAnalyticsRuntime({ env, siteId });
                const response = await handlePlannedSiteOverview(
                  publicOverviewRequest(siteId, scenario.range, COST_DSL),
                  overviewPrincipal(siteId),
                  siteId,
                  runtime,
                  { capturedAtMs: CAPTURED_AT_MS },
                );
                const body = await response.json();
                return {
                  httpStatus: response.status,
                  body,
                  bodyData: (body as { readonly data?: unknown }).data,
                };
              },
            });
            stageByKey.set(publicKey, publicStage);
          }
        }

        const explainQueries = [...tracesByStage.values()].flat();
        const explainCandidates = explainQueries.filter(
          (query) =>
            query.status === "success" &&
            query.operation !== "run" &&
            /^\s*(?:SELECT|WITH)\b/iu.test(query.sql),
        );
        evidence.explainPlans = [];
        evidence.explainPlanErrors = [];
        (evidence as Record<string, unknown>).explainPlanSkippedAttempts =
          explainQueries
            .filter((query) => !explainCandidates.includes(query))
            .map((query) => ({
              traceAttemptId: query.attemptId,
              operation: query.operation,
              status: query.status,
              reason: "not_a_successful_read_statement",
            }));
        persistEvidence(evidencePath, evidence);
        for (const query of explainCandidates) {
          try {
            evidence.explainPlans.push(
              ...(await captureExplainPlans(platform.env.DB, [query])),
            );
          } catch (error) {
            evidence.explainPlanErrors.push({
              traceAttemptId: query.attemptId,
              error: errorRecord(error),
            });
          }
          evidence.explainPlansSha256 = sha256(
            JSON.stringify(
              evidence.explainPlans.map(
                ({ traceAttemptId, explainPlanSha256 }) => ({
                  traceAttemptId,
                  explainPlanSha256,
                }),
              ),
            ),
          );
          persistEvidence(evidencePath, evidence);
        }
        evidence.explainPlansSha256 = sha256(
          JSON.stringify(
            evidence.explainPlans.map(
              ({ traceAttemptId, explainPlanSha256 }) => ({
                traceAttemptId,
                explainPlanSha256,
              }),
            ),
          ),
        );
        persistEvidence(evidencePath, evidence);

        const identityComparisons = SCENARIOS.map((scenario) => {
          const current = stageByKey.get(
            `${scenario.name}:current-sql:identity-diagnostic`,
          )!;
          const old = stageByKey.get(
            `${scenario.name}:91a-classification-seam:identity-diagnostic`,
          )!;
          const currentResult = current.result as
            { readonly entityIds?: readonly string[] } | undefined;
          const oldResult = old.result as
            { readonly entityIds?: readonly string[] } | undefined;
          return {
            scenario: scenario.name,
            currentIdentityEqualExpected:
              JSON.stringify(currentResult?.entityIds) ===
              JSON.stringify(current.expectedEntityIds),
            oldIdentityEqualExpected:
              JSON.stringify(oldResult?.entityIds) ===
              JSON.stringify(old.expectedEntityIds),
            identitiesEqual:
              JSON.stringify(currentResult?.entityIds) ===
              JSON.stringify(oldResult?.entityIds),
            currentEvaluatorCallCount: current.evaluatorCallCount,
            oldEvaluatorCallCount: old.evaluatorCallCount,
            currentTraceCoverageComplete:
              (current.traceCoverage as { readonly complete?: boolean } | null)
                ?.complete === true,
            oldTraceCoverageComplete:
              (old.traceCoverage as { readonly complete?: boolean } | null)
                ?.complete === true,
            currentRequestError: current.requestError,
            oldRequestError: old.requestError,
          };
        });
        const payloadMetricsComplete = (
          stage: Record<string, unknown>,
        ): boolean => {
          const metrics = stage.measurementTotals as Record<string, unknown>;
          const coverage = stage.traceCoverage as {
            readonly complete?: boolean;
          } | null;
          const queries = stage.queries as readonly CapturedQuery[];
          const prepareAttempts =
            stage.prepareAttempts as readonly CapturedPrepareAttempt[];
          const observations =
            stage.observations as readonly DatabaseQueryObservation[];
          return (
            metrics.rowsReadAvailable === true &&
            typeof metrics.rowsRead === "number" &&
            metrics.rowsWrittenAvailable === true &&
            typeof metrics.rowsWritten === "number" &&
            metrics.dbDurationAvailable === true &&
            typeof metrics.dbDurationMs === "number" &&
            metrics.observerElapsedAvailable === true &&
            typeof metrics.observerElapsedMs === "number" &&
            metrics.returnedRowsAvailable === true &&
            typeof metrics.returnedRows === "number" &&
            coverage?.complete === true &&
            stage.requestStatus === "completed" &&
            stage.requestError === null &&
            typeof stage.workerWallMs === "number" &&
            typeof stage.evaluatorCallCount === "number" &&
            queries.length > 0 &&
            queries.every(
              (query) => query.status === "success" && query.error === null,
            ) &&
            prepareAttempts.length > 0 &&
            prepareAttempts.every(
              (attempt) =>
                attempt.status === "success" && attempt.error === null,
            ) &&
            observations.length > 0 &&
            observations.every(({ status }) => status === "success")
          );
        };
        const payloadComparisons = SCENARIOS.map((scenario) => {
          const current = stageByKey.get(
            `${scenario.name}:current-sql:identity-diagnostic`,
          )!;
          const old = stageByKey.get(
            `${scenario.name}:91a-classification-seam:identity-diagnostic`,
          )!;
          const currentMetrics = current.measurementTotals as Record<
            string,
            unknown
          >;
          const oldMetrics = old.measurementTotals as Record<string, unknown>;
          const currentResult = current.result as
            { readonly entityIds?: readonly string[] } | undefined;
          const oldResult = old.result as
            { readonly entityIds?: readonly string[] } | undefined;
          return {
            scenario: scenario.name,
            measurementScope: "identity-diagnostic",
            currentMeasurement:
              "combined payload query plus shared setup reads",
            legacyMeasurement:
              "activity and payload readers plus shared setup reads",
            currentRequest: snapshot(current.request),
            legacyRequest: snapshot(old.request),
            requestsEqual:
              JSON.stringify(current.request) === JSON.stringify(old.request),
            currentMeasurementTotals: snapshot(currentMetrics),
            legacyMeasurementTotals: snapshot(oldMetrics),
            currentRowsRead: currentMetrics.rowsRead,
            legacyRowsRead: oldMetrics.rowsRead,
            rowsReadAvailable:
              currentMetrics.rowsReadAvailable === true &&
              oldMetrics.rowsReadAvailable === true,
            currentRowsWritten: currentMetrics.rowsWritten,
            legacyRowsWritten: oldMetrics.rowsWritten,
            rowsWrittenAvailable:
              currentMetrics.rowsWrittenAvailable === true &&
              oldMetrics.rowsWrittenAvailable === true,
            currentDbDurationMs: currentMetrics.dbDurationMs,
            legacyDbDurationMs: oldMetrics.dbDurationMs,
            dbDurationAvailable:
              currentMetrics.dbDurationAvailable === true &&
              oldMetrics.dbDurationAvailable === true,
            currentObserverElapsedMs: currentMetrics.observerElapsedMs,
            legacyObserverElapsedMs: oldMetrics.observerElapsedMs,
            observerElapsedAvailable:
              currentMetrics.observerElapsedAvailable === true &&
              oldMetrics.observerElapsedAvailable === true,
            currentReturnedRows: currentMetrics.returnedRows,
            legacyReturnedRows: oldMetrics.returnedRows,
            returnedRowsAvailable:
              currentMetrics.returnedRowsAvailable === true &&
              oldMetrics.returnedRowsAvailable === true,
            currentEvaluatorCallCount: current.evaluatorCallCount,
            legacyEvaluatorCallCount: old.evaluatorCallCount,
            currentIdentityEqualExpected:
              JSON.stringify(currentResult?.entityIds) ===
              JSON.stringify(current.expectedEntityIds),
            legacyIdentityEqualExpected:
              JSON.stringify(oldResult?.entityIds) ===
              JSON.stringify(old.expectedEntityIds),
            identitiesEqual:
              JSON.stringify(currentResult?.entityIds) ===
              JSON.stringify(oldResult?.entityIds),
            currentTraceCoverageComplete:
              (current.traceCoverage as { readonly complete?: boolean } | null)
                ?.complete === true,
            legacyTraceCoverageComplete:
              (old.traceCoverage as { readonly complete?: boolean } | null)
                ?.complete === true,
            currentMetricsComplete: payloadMetricsComplete(current),
            legacyMetricsComplete: payloadMetricsComplete(old),
            currentRequestError: current.requestError,
            legacyRequestError: old.requestError,
          };
        });
        const smallPayloadComparison = payloadComparisons[0]!;
        const mediumPayloadComparison = payloadComparisons[1]!;
        const smallPayloadCurrentRowsRead =
          typeof smallPayloadComparison.currentRowsRead === "number"
            ? smallPayloadComparison.currentRowsRead
            : null;
        const smallPayloadLegacyRowsRead =
          typeof smallPayloadComparison.legacyRowsRead === "number"
            ? smallPayloadComparison.legacyRowsRead
            : null;
        const mediumPayloadCurrentRowsRead =
          typeof mediumPayloadComparison.currentRowsRead === "number"
            ? mediumPayloadComparison.currentRowsRead
            : null;
        const mediumPayloadLegacyRowsRead =
          typeof mediumPayloadComparison.legacyRowsRead === "number"
            ? mediumPayloadComparison.legacyRowsRead
            : null;
        const publicComparisons = SCENARIOS.map((scenario) => {
          const current = stageByKey.get(
            `${scenario.name}:current-sql:public-overview`,
          )!;
          const old = stageByKey.get(
            `${scenario.name}:91a-classification-seam:public-overview`,
          )!;
          const currentResponse = current.result as
            | {
                readonly httpStatus?: number;
                readonly bodyData?: unknown;
              }
            | undefined;
          const oldResponse = old.result as
            | {
                readonly httpStatus?: number;
                readonly bodyData?: unknown;
              }
            | undefined;
          const currentMetrics = current.measurementTotals as Record<
            string,
            unknown
          >;
          const oldMetrics = old.measurementTotals as Record<string, unknown>;
          const currentCoverage = current.traceCoverage as {
            readonly complete?: boolean;
          } | null;
          const oldCoverage = old.traceCoverage as {
            readonly complete?: boolean;
          } | null;
          const currentMetricsComplete =
            currentMetrics.rowsReadAvailable === true &&
            currentMetrics.rowsWrittenAvailable === true &&
            currentMetrics.dbDurationAvailable === true &&
            currentMetrics.observerElapsedAvailable === true &&
            currentMetrics.returnedRowsAvailable === true &&
            currentCoverage?.complete === true &&
            current.requestError === null &&
            typeof current.workerWallMs === "number";
          const oldMetricsComplete =
            oldMetrics.rowsReadAvailable === true &&
            oldMetrics.rowsWrittenAvailable === true &&
            oldMetrics.dbDurationAvailable === true &&
            oldMetrics.observerElapsedAvailable === true &&
            oldMetrics.returnedRowsAvailable === true &&
            oldCoverage?.complete === true &&
            old.requestError === null &&
            typeof old.workerWallMs === "number";
          return {
            scenario: scenario.name,
            currentHttpStatus: currentResponse?.httpStatus ?? null,
            oldHttpStatus: oldResponse?.httpStatus ?? null,
            httpStatusEqual:
              currentResponse?.httpStatus === oldResponse?.httpStatus,
            currentBodyData: currentResponse?.bodyData ?? null,
            oldBodyData: oldResponse?.bodyData ?? null,
            bodyDataEqual:
              JSON.stringify(currentResponse?.bodyData) ===
              JSON.stringify(oldResponse?.bodyData),
            currentEvaluatorCallCount: current.evaluatorCallCount,
            oldEvaluatorCallCount: old.evaluatorCallCount,
            currentRowsRead: currentMetrics.rowsRead,
            oldRowsRead: oldMetrics.rowsRead,
            rowsReadAvailable:
              currentMetrics.rowsReadAvailable === true &&
              oldMetrics.rowsReadAvailable === true,
            currentRowsWritten: currentMetrics.rowsWritten,
            oldRowsWritten: oldMetrics.rowsWritten,
            rowsWrittenAvailable:
              currentMetrics.rowsWrittenAvailable === true &&
              oldMetrics.rowsWrittenAvailable === true,
            currentDbDurationMs: currentMetrics.dbDurationMs,
            oldDbDurationMs: oldMetrics.dbDurationMs,
            dbDurationAvailable:
              currentMetrics.dbDurationAvailable === true &&
              oldMetrics.dbDurationAvailable === true,
            currentObserverElapsedMs: currentMetrics.observerElapsedMs,
            oldObserverElapsedMs: oldMetrics.observerElapsedMs,
            observerElapsedAvailable:
              currentMetrics.observerElapsedAvailable === true &&
              oldMetrics.observerElapsedAvailable === true,
            currentReturnedRows: currentMetrics.returnedRows,
            oldReturnedRows: oldMetrics.returnedRows,
            returnedRowsAvailable:
              currentMetrics.returnedRowsAvailable === true &&
              oldMetrics.returnedRowsAvailable === true,
            currentTraceCoverageComplete: currentCoverage?.complete === true,
            oldTraceCoverageComplete: oldCoverage?.complete === true,
            currentMetricsComplete,
            oldMetricsComplete,
            currentRequestError: current.requestError,
            oldRequestError: old.requestError,
          };
        });
        const smallCurrentRowsRead = publicComparisons[0]!.currentRowsRead;
        const smallOldRowsRead = publicComparisons[0]!.oldRowsRead;
        const mediumCurrentRowsRead = publicComparisons[1]!.currentRowsRead;
        const mediumOldRowsRead = publicComparisons[1]!.oldRowsRead;
        const thresholdResults = {
          smallCurrentRowsReadNoGreaterThanLegacy:
            publicComparisons[0]!.currentHttpStatus === 200 &&
            publicComparisons[0]!.oldHttpStatus === 200 &&
            publicComparisons[0]!.currentMetricsComplete &&
            publicComparisons[0]!.oldMetricsComplete &&
            typeof smallCurrentRowsRead === "number" &&
            typeof smallOldRowsRead === "number" &&
            smallCurrentRowsRead <= smallOldRowsRead,
          mediumCurrentRowsReadStrictlyLessThanLegacy:
            publicComparisons[1]!.currentHttpStatus === 200 &&
            publicComparisons[1]!.oldHttpStatus === 200 &&
            publicComparisons[1]!.currentMetricsComplete &&
            publicComparisons[1]!.oldMetricsComplete &&
            typeof mediumCurrentRowsRead === "number" &&
            typeof mediumOldRowsRead === "number" &&
            mediumCurrentRowsRead < mediumOldRowsRead,
          allWritesEqualZero: publicComparisons.every(
            ({
              currentMetricsComplete,
              oldMetricsComplete,
              currentRowsWritten,
              oldRowsWritten,
            }) =>
              currentMetricsComplete &&
              oldMetricsComplete &&
              currentRowsWritten === 0 &&
              oldRowsWritten === 0,
          ),
          smallPayloadCurrentRowsReadNoGreaterThanLegacy:
            smallPayloadComparison.requestsEqual &&
            smallPayloadComparison.currentMetricsComplete &&
            smallPayloadComparison.legacyMetricsComplete &&
            smallPayloadComparison.currentIdentityEqualExpected &&
            smallPayloadComparison.legacyIdentityEqualExpected &&
            smallPayloadComparison.identitiesEqual &&
            smallPayloadComparison.currentEvaluatorCallCount === 0 &&
            Number(smallPayloadComparison.legacyEvaluatorCallCount) > 0 &&
            typeof smallPayloadCurrentRowsRead === "number" &&
            typeof smallPayloadLegacyRowsRead === "number" &&
            smallPayloadCurrentRowsRead <= smallPayloadLegacyRowsRead,
          mediumPayloadCurrentRowsReadStrictlyLessThanLegacy:
            mediumPayloadComparison.requestsEqual &&
            mediumPayloadComparison.currentMetricsComplete &&
            mediumPayloadComparison.legacyMetricsComplete &&
            mediumPayloadComparison.currentIdentityEqualExpected &&
            mediumPayloadComparison.legacyIdentityEqualExpected &&
            mediumPayloadComparison.identitiesEqual &&
            mediumPayloadComparison.currentEvaluatorCallCount === 0 &&
            Number(mediumPayloadComparison.legacyEvaluatorCallCount) > 0 &&
            typeof mediumPayloadCurrentRowsRead === "number" &&
            typeof mediumPayloadLegacyRowsRead === "number" &&
            mediumPayloadCurrentRowsRead < mediumPayloadLegacyRowsRead,
          allPayloadWritesEqualZero: payloadComparisons.every(
            ({
              currentMetricsComplete,
              legacyMetricsComplete,
              currentRowsWritten,
              legacyRowsWritten,
            }) =>
              currentMetricsComplete &&
              legacyMetricsComplete &&
              currentRowsWritten === 0 &&
              legacyRowsWritten === 0,
          ),
        };
        evidence.comparison = {
          requestIdentity: {
            dsl: COST_DSL,
            siteRangeAndScopeMatchAcrossModes: true,
            currentAndLegacy: identityComparisons,
          },
          payloadIdentityDiagnostic: payloadComparisons,
          publicOverview: publicComparisons,
          thresholds: {
            smallCurrentRowsReadNoGreaterThanLegacy: "current <= legacy",
            mediumCurrentRowsReadStrictlyLessThanLegacy: "current < legacy",
            allWritesEqualZero: "current and legacy writes are 0",
            smallPayloadCurrentRowsReadNoGreaterThanLegacy:
              "current combined <= legacy activity + payload",
            mediumPayloadCurrentRowsReadStrictlyLessThanLegacy:
              "current combined < legacy activity + payload",
            allPayloadWritesEqualZero: "current and legacy writes are 0",
            metricsRequired:
              "complete observer coverage, rowsRead, rowsWritten, dbDurationMs, elapsedMs, returnedRows, and workerWallMs",
            payloadMetricsRequired:
              "complete identity-stage trace, successful prepare/query/observer records, rowsRead, rowsWritten, dbDurationMs, elapsedMs, returnedRows, workerWallMs, matching identities, and evaluator boundary",
          },
          thresholdResults,
        };
        persistEvidence(evidencePath, evidence);

        const diagnostic = evidence.invalidUtf8Diagnostic!;
        diagnostic.setupStatus = "seeding";
        diagnostic.seedProgress = {};
        persistEvidence(evidencePath, evidence);
        const utf8SitePk = SCENARIOS.length + 1;
        diagnostic.fixture = await seedInvalidUtf8Diagnostic(
          platform.env.DB,
          utf8SitePk,
          (progress) => {
            diagnostic.seedProgress = progress;
            persistEvidence(evidencePath, evidence);
          },
        );
        diagnostic.setupStatus = "complete";
        persistEvidence(evidencePath, evidence);

        const invalidUtf8Cases = [
          {
            name: "ascii-equality",
            dsl: 'count(event { event.name eq "purchase" AND event.payload("/value") eq "target" }) gte 1',
          },
          {
            name: "empty-string",
            dsl: 'count(event { event.name eq "purchase" AND event.payload("/value") isEmpty }) gte 1',
          },
        ] as const;
        const diagnosticStages: Record<string, Record<string, unknown>> = {};
        const diagnosticSiteId = diagnostic.fixture as {
          readonly siteId: SiteId;
        };
        for (const testCase of invalidUtf8Cases) {
          for (const mode of [
            "current-sql",
            "91a-classification-seam",
          ] as const) {
            legacyClassifier = mode !== "current-sql";
            const key = `${testCase.name}:${mode}`;
            const stage = await captureRequestStage({
              scenario: `invalid-utf8-${testCase.name}`,
              mode,
              requestKind: "invalid-utf8-diagnostic",
              siteId: diagnosticSiteId.siteId,
              range: { startMs: 0, endExclusiveMs: 1_000 },
              dsl: testCase.dsl,
              execute: async () => {
                const output = await d1AdvancedFilterMiddleware(env)(
                  "overview",
                  requestInput(
                    diagnosticSiteId.siteId,
                    { startMs: 0, endExclusiveMs: 1_000 },
                    testCase.dsl,
                  ),
                  async (prepared) => prepared,
                );
                return { entityIds: outputIds(output) };
              },
            });
            diagnosticStages[key] = stage;
            const existing = diagnostic.stages as Array<
              Record<string, unknown>
            >;
            existing.push(stage);
            persistEvidence(evidencePath, evidence);
          }
        }
        const invalidUtf8Comparisons = invalidUtf8Cases.map((testCase) => {
          const current = diagnosticStages[`${testCase.name}:current-sql`]!;
          const old =
            diagnosticStages[`${testCase.name}:91a-classification-seam`]!;
          const currentResult = current.result as
            { readonly entityIds?: readonly string[] } | undefined;
          const oldResult = old.result as
            { readonly entityIds?: readonly string[] } | undefined;
          return {
            diagnostic: testCase.name,
            dsl: testCase.dsl,
            currentRequestError: current.requestError,
            legacyRequestError: old.requestError,
            currentEntityIds: currentResult?.entityIds ?? null,
            legacyEntityIds: oldResult?.entityIds ?? null,
            evaluatorCallCount: {
              current: current.evaluatorCallCount,
              legacy: old.evaluatorCallCount,
            },
            resultsEqual:
              current.requestError === null &&
              old.requestError === null &&
              JSON.stringify(currentResult?.entityIds) ===
                JSON.stringify(oldResult?.entityIds),
          };
        });
        diagnostic.comparisons = invalidUtf8Comparisons;
        diagnostic.behaviorMatches = invalidUtf8Comparisons.every(
          ({ resultsEqual }) => resultsEqual,
        );
        persistEvidence(evidencePath, evidence);

        expect(
          identityComparisons.every(
            (comparison) =>
              comparison.currentIdentityEqualExpected &&
              comparison.oldIdentityEqualExpected &&
              comparison.identitiesEqual &&
              comparison.currentEvaluatorCallCount === 0 &&
              Number(comparison.oldEvaluatorCallCount) > 0 &&
              comparison.currentTraceCoverageComplete &&
              comparison.oldTraceCoverageComplete &&
              comparison.currentRequestError === null &&
              comparison.oldRequestError === null,
          ),
        ).toBe(true);
        expect(
          publicComparisons.every(
            (comparison) =>
              comparison.currentHttpStatus === 200 &&
              comparison.oldHttpStatus === 200 &&
              comparison.httpStatusEqual &&
              comparison.bodyDataEqual &&
              comparison.currentEvaluatorCallCount === 0 &&
              Number(comparison.oldEvaluatorCallCount) > 0 &&
              comparison.currentMetricsComplete &&
              comparison.oldMetricsComplete,
          ),
        ).toBe(true);
        expect(evidence.explainPlanErrors).toHaveLength(0);
        expect(thresholdResults.allWritesEqualZero).toBe(true);
        expect(thresholdResults.smallCurrentRowsReadNoGreaterThanLegacy).toBe(
          true,
        );
        expect(
          thresholdResults.mediumCurrentRowsReadStrictlyLessThanLegacy,
        ).toBe(true);
        expect(
          thresholdResults.smallPayloadCurrentRowsReadNoGreaterThanLegacy,
        ).toBe(true);
        expect(
          thresholdResults.mediumPayloadCurrentRowsReadStrictlyLessThanLegacy,
        ).toBe(true);
        expect(thresholdResults.allPayloadWritesEqualZero).toBe(true);
        expect(diagnostic.behaviorMatches).toBe(true);
        expect(
          invalidUtf8Comparisons.every(
            ({ evaluatorCallCount }) =>
              evaluatorCallCount.current === 0 &&
              Number(evaluatorCallCount.legacy) > 0,
          ),
        ).toBe(true);
      } catch (error) {
        evidence.error = error instanceof Error ? error.message : String(error);
        persistEvidence(evidencePath, evidence);
        throw error;
      } finally {
        legacyClassifier = false;
        classifierSpy.mockRestore();
        evaluatorSpy.mockRestore();
        aggregateCache.clear();
        try {
          if (disposePlatform) await disposePlatform();
        } finally {
          try {
            unlinkSync(configPath);
            rmdirSync(configDirectory);
          } catch {
            // The config lives in a unique OS temp folder; failed cleanup does not change cost evidence.
          }
          persistEvidence(evidencePath, evidence);
        }
      }
    },
    // The real writer prepares over 5,000 mutations for this fixed fixture.
    // Keep seeding outside request measurements and allow the local D1 bridge
    // to finish them before the public-request cost comparison starts.
    900_000,
  );
});
