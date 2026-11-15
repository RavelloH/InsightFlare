import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { vi } from "vitest";

import {
  prepareScopedQuery,
  type QueryInput,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import * as countSupport from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import {
  d1AdvancedFilterMiddleware,
  deferredReferrersQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  queryQualifiedReferrerSummaryFromD1,
  queryReferrerSummaryFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "./seed";

export const COST_TIME = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
export const COST_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
export const COST_STRATEGIES = ["fused", "member-relation", "core"] as const;
export type CostStrategy = (typeof COST_STRATEGIES)[number];

export function seedFingerprint(visits: number) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        readFileSync(resolve("docs/schema.sql"), "utf8").replace(
          /\r\n/gu,
          "\n",
        ),
        buildSiteStatements(),
        buildDataStatements({ visits }),
      ]),
    )
    .digest("hex");
}

/** Same request, including middleware, measured through existing production seams. */
export async function executeCostStrategy(
  env: Env,
  scope: "session" | "visitor",
  strategy: CostStrategy,
  filterDsl = COST_FILTER,
) {
  const query = {
    ...prepareScopedQuery("referrers", {
      context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
      time: COST_TIME,
      filters: parseFilterDsl(filterDsl, analyticsFilterRegistry),
      scopePreference: scope,
    } as QueryInput & { readonly time: typeof COST_TIME }),
    variant: "summary",
    topN: 10,
  };
  const diagnostics = createD1ReadDiagnostics();
  const started = performance.now();
  const forwarded = await d1AdvancedFilterMiddleware(
    env,
    diagnostics,
    SEED_SITE_ID,
  )("referrers", query, async (prepared) => prepared);
  const deferred = deferredReferrersQualificationFromQuery(forwarded);
  if (!deferred)
    throw new Error(`c01_strategy_unsupported:${strategy}:${scope}`);
  let value: unknown;
  let coreCalls = 0;
  if (strategy === "fused") {
    const execution = await queryQualifiedReferrerSummaryFromD1({
      env,
      deferred,
      siteId: SEED_SITE_ID,
      topN: 10,
      diagnostics,
    });
    if (execution.kind !== "executed")
      throw new Error(`c01_fused_unsupported:${JSON.stringify(execution)}`);
    value = execution.summary;
  } else {
    const core = vi.spyOn(evaluator, "evaluateFilterDocument");
    const classify =
      strategy === "core"
        ? vi
            .spyOn(countSupport, "classifyAdvancedCountFilter")
            .mockReturnValue({
              kind: "unsupported",
              path: "root",
              code: "forced_core_oracle",
              reason: "Cost harness forces the independent Core oracle.",
            })
        : undefined;
    try {
      const filters = await prepareDeferredEventQualificationFallback(deferred);
      value = await queryReferrerSummaryFromD1(
        env,
        SEED_SITE_ID,
        {
          startMs: COST_TIME.range.startMs,
          endExclusiveMs: COST_TIME.range.endExclusiveMs,
          nowMs: COST_TIME.capturedAtMs,
          timeZone: "UTC",
        },
        filters,
        10,
        diagnostics,
      );
      coreCalls = core.mock.calls.length;
      if ((strategy === "core") !== coreCalls > 0)
        throw new Error(`c01_unexpected_evaluator:${strategy}:${coreCalls}`);
    } finally {
      classify?.mockRestore();
      core.mockRestore();
    }
  }
  return {
    value,
    strategy,
    scope,
    filterDsl,
    coreCalls,
    diagnostics,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  };
}

export interface CostObservation {
  readonly sql: string;
  readonly parameters: number;
  readonly params: readonly unknown[];
  readonly rowsRead: number | null;
  readonly rowsWritten: number | null;
  readonly sqlDurationMs: number | null;
}

/** Trace executions, including first/run and every statement submitted by batch. */
export function observeCostDatabase(database: D1Database) {
  const observations: CostObservation[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const inputs = new WeakMap<
    D1PreparedStatement,
    { sql: string; params: readonly unknown[] }
  >();
  function record(sql: string, params: readonly unknown[], result: unknown) {
    const meta = (result as { meta?: Record<string, unknown> } | null)?.meta;
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    observations.push({
      sql,
      parameters: params.length,
      params,
      rowsRead: number(meta?.rows_read),
      rowsWritten: number(meta?.rows_written),
      sqlDurationMs: number(meta?.duration),
    });
  }
  function wrap(
    statement: D1PreparedStatement,
    sql: string,
    params: readonly unknown[] = [],
  ): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrap(target.bind(...values), sql, values);
        if (property === "first")
          return async (column?: string) => {
            // D1 first() hides meta; all() has identical SQL and exposes its cost.
            const result = await target.all<Record<string, unknown>>();
            record(sql, params, result);
            const row = result.results[0] ?? null;
            return column && row ? row[column] : row;
          };
        if (property === "all" || property === "run" || property === "raw")
          return async (...args: unknown[]) => {
            if (property === "raw")
              throw new Error("c01_raw_cost_metadata_unsupported");
            const result = await Reflect.apply(
              Reflect.get(target, property) as (...args: unknown[]) => unknown,
              target,
              args,
            );
            record(sql, params, result);
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    inputs.set(proxy, { sql, params });
    return proxy;
  }
  const traced = new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(
            statements.map(
              (statement) => originals.get(statement) ?? statement,
            ),
          );
          statements.forEach((statement, index) => {
            const input = inputs.get(statement);
            if (!input) throw new Error("c01_untraced_batch_statement");
            record(input.sql, input.params, results[index]);
          });
          return results;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: traced, observations };
}

export function summarizeCost(
  observations: readonly CostObservation[],
  requireMetadata = false,
) {
  const supported =
    observations.length > 0 &&
    observations.every(
      (row) =>
        row.rowsRead !== null &&
        row.rowsWritten !== null &&
        row.sqlDurationMs !== null,
    );
  if (requireMetadata && !supported)
    throw new Error("c01_cost_metadata_unavailable");
  return {
    statements: observations.length,
    metadataStatus: supported ? "available" : "unsupported",
    rowsRead: supported
      ? observations.reduce((sum, row) => sum + row.rowsRead!, 0)
      : null,
    rowsWritten: supported
      ? observations.reduce((sum, row) => sum + row.rowsWritten!, 0)
      : null,
    sqlDurationMs: supported
      ? observations.reduce((sum, row) => sum + row.sqlDurationMs!, 0)
      : null,
    maxParameters: Math.max(0, ...observations.map((row) => row.parameters)),
    maxSqlBytes: Math.max(
      0,
      ...observations.map((row) => Buffer.byteLength(row.sql)),
    ),
  };
}
