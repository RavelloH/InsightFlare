import { validateAnalyticsEngineConfig } from "@/lib/analytics-engine-config";
import { requireActor } from "@/lib/edge/admin/auth";
import { bad, forb, jsonResponseFor, na } from "@/lib/edge/admin/response";
import { isAnalyticsEngineDisabled } from "@/lib/edge/analytics-engine/config";
import { INVOCATION_METRICS_DATASET } from "@/lib/edge/analytics-engine/invocation-schema";
import { INVOCATION_METRICS_SCHEMA_V2 } from "@/lib/edge/analytics-engine/invocation-schema-v2";
import {
  analyticsEngineReaderToken,
  readAnalyticsEngineReaderConfig,
} from "@/lib/edge/analytics-engine/reader-config";
import type { Env } from "@/lib/edge/types";

import { type InvocationQuery } from "./invocation-metrics-input";
import { normalizeInvocationView } from "./invocation-metrics-model";
import {
  buildInvocationStatements,
  type InvocationStatement,
} from "./invocation-metrics-sql";
import {
  type InvocationQueryError,
  queryInvocationMetrics,
} from "./invocation-metrics-transport";
import { analyticsEngineSqlEndpoint } from "./request-observation-model";

type InvocationViewResult = ReturnType<typeof normalizeInvocationView>;
type ReadFailure = {
  code:
    | InvocationQueryError
    | "reader_config_failed"
    | "reader_decryption_failed"
    | "invalid_query_result";
  retryAfterSeconds: number | null;
  retryable: boolean;
};
type Unavailable =
  | {
      view: InvocationQuery["view"];
      status: "disabled" | "reader_not_configured" | "writer_not_bound";
      data: null;
    }
  | {
      view: InvocationQuery["view"];
      status: "query_failed";
      data: null;
      error: ReadFailure;
    };

type ReadMetadata = {
  dataset: typeof INVOCATION_METRICS_DATASET;
  schemaVersion: typeof INVOCATION_METRICS_SCHEMA_V2;
  generatedAt: number;
  window: InvocationQuery["window"];
  interval: InvocationQuery["interval"];
  timeZone: string;
  limit: number;
  sampling: {
    aggregatesWeighted: true;
    detailsAreRetainedSamples: true;
    invocationIsNotExternalRequest: true;
  };
  resultLimitsReached: InvocationStatement["name"][];
};

const RETRYABLE_CODES = new Set<ReadFailure["code"]>([
  "reader_config_failed",
  "concurrency_limited",
  "rate_limited",
  "service_unavailable",
  "insufficient_storage",
  "timeout",
  "network_error",
]);

export type InvocationMetricsResponse = ReadMetadata &
  (InvocationViewResult | Unavailable);

export async function handleInvocationMetricsAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin)
    return forb(
      "Only system admin can view system performance",
      undefined,
      req,
    );
  if (req.method !== "GET") return na(req);

  const generatedAt = Date.now();
  const built = buildInvocationStatements(url.searchParams, generatedAt);
  if (!built)
    return bad(
      "Invalid invocation metrics query",
      "invalid_invocation_metrics_query",
      req,
    );
  const { query, statements } = built;
  const { view, window, interval, timeZone, limit } = query;
  const metadata: ReadMetadata = {
    dataset: INVOCATION_METRICS_DATASET,
    schemaVersion: INVOCATION_METRICS_SCHEMA_V2,
    generatedAt,
    window,
    interval,
    timeZone,
    limit,
    sampling: {
      aggregatesWeighted: true,
      detailsAreRetainedSamples: true,
      invocationIsNotExternalRequest: true,
    },
    resultLimitsReached: [],
  };
  const respond = (result: InvocationViewResult | Unavailable) => {
    const payload: InvocationMetricsResponse = { ...metadata, ...result };
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (
      result.status === "query_failed" &&
      result.error.retryAfterSeconds !== null
    ) {
      headers["retry-after"] = String(result.error.retryAfterSeconds);
    }
    return jsonResponseFor(req, { ok: true, data: payload }, 200, headers);
  };
  const fail = (
    code: ReadFailure["code"],
    retryAfterSeconds: number | null = null,
  ) =>
    respond({
      view,
      status: "query_failed",
      data: null,
      error: { code, retryAfterSeconds, retryable: RETRYABLE_CODES.has(code) },
    });
  if (isAnalyticsEngineDisabled(env))
    return respond({ view, status: "disabled", data: null });
  if (!env.INVOCATION_METRICS)
    return respond({ view, status: "writer_not_bound", data: null });

  let config;
  try {
    config = await readAnalyticsEngineReaderConfig(env);
  } catch {
    return fail("reader_config_failed");
  }
  const apiUrl = analyticsEngineSqlEndpoint(env);
  if (!apiUrl || !config?.configured || validateAnalyticsEngineConfig(config))
    return respond({ view, status: "reader_not_configured", data: null });

  let token;
  try {
    token = await analyticsEngineReaderToken(env, config);
    if (!token) return fail("reader_decryption_failed");
  } catch {
    return fail("reader_decryption_failed");
  }

  const results: Parameters<typeof normalizeInvocationView>[1] = {};
  const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]);
  for (const { name, sql, limit: rowLimit } of statements) {
    const result = await queryInvocationMetrics({
      apiUrl,
      accountId: config.accountId,
      token,
      sql,
      limit: rowLimit,
      signal: deadline,
    });
    if (!result.ok) return fail(result.code, result.retryAfterSeconds);
    if (
      rowLimit === limit &&
      result.rows.length === limit &&
      name !== "summary" &&
      name !== "legacy"
    )
      metadata.resultLimitsReached.push(name);
    results[name] = result.rows;
  }
  try {
    return respond(normalizeInvocationView(view, results));
  } catch {
    return fail("invalid_query_result");
  }
}
