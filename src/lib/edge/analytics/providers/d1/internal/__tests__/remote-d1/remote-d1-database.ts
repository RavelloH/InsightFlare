/**
 * A `D1Database` backed by the Cloudflare D1 REST API, used only by the
 * on-demand cost baseline (`pnpm run test:cost`). It lets the real engine run
 * against a real D1 database and records the `meta` D1 reports for every
 * statement (rows read, rows written, server-side duration).
 *
 * Safety: the database id and token come from the environment, and the
 * safety preflight requires the exact approved benchmark name and UUID.
 */

export const C01_DATABASE_NAME = "if-c01-bench-20261113";
export const C01_DATABASE_ID = "40c82ca3-8755-4d0d-b644-9d39b56df9f9";

export interface RemoteHttpAttempt {
  readonly operation?: "query" | "target-preflight";
  readonly attempt: number;
  readonly status: number | null;
  readonly elapsedMs: number;
  readonly elapsedScope?: "response-headers" | "response-json";
  /** Header arrival and body consumption remain separate from pacing/backoff. */
  readonly responseHeadersElapsedMs?: number;
  readonly responseBodyElapsedMs?: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /** Error responses only; never request headers or credentials. */
  readonly responseBody?: string;
  readonly responseErrors?: readonly unknown[];
  readonly responseBodyError?: {
    readonly name: string;
    readonly message: string;
  };
  readonly retry: boolean;
  readonly backoffMs: number;
  readonly outcome: "response" | "transport-error";
  /** Waiting imposed by the fixed request-start protocol, outside HTTP elapsed. */
  readonly pacingWaitMs?: number;
  readonly requestStartIntervalMs?: number;
}

export interface RemoteStatementMeta {
  readonly sql: string;
  readonly parameterCount: number;
  /** Actual REST bindings, kept so a heavy statement can be explained afterwards. */
  readonly params: readonly unknown[];
  /** Caller bindings before the native-compatible boolean normalization. */
  readonly inputParams?: readonly unknown[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly sqlDurationMs: number;
  readonly sqlDurationSource?: "timings.sql_duration_ms" | "duration";
  readonly durationRaw?: {
    readonly timingsSqlDurationMs: number | null;
    readonly duration: number | null;
  };
  readonly servedBy?: string | null;
  readonly servedByRegion?: string | null;
  readonly statementOrdinal?: number;
  readonly httpAttempts?: readonly RemoteHttpAttempt[];
  readonly resultRows: number;
}

export interface RemoteD1Options {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
  /** Candidate evidence may forbid retrying even a fully consumed error response. */
  readonly retryPolicy?: "none" | "bounded";
  readonly onStatement?: (meta: RemoteStatementMeta) => void;
  readonly onHttpAttempt?: (attempt: RemoteHttpAttempt) => void;
  /** Share one pacer across preflight, setup, provider and diagnostic clients. */
  readonly requestPacing?: RemoteRequestPacing;
}

export interface RemoteRequestPacing {
  readonly startIntervalMs: number;
  run<T>(request: (waitMs: number) => Promise<T>): Promise<T>;
}

/** Fixed start spacing plus serial HTTP completion; never adapts after errors. */
export function createRemoteRequestPacing(
  startIntervalMs: number,
): RemoteRequestPacing {
  if (!Number.isSafeInteger(startIntervalMs) || startIntervalMs <= 0)
    throw new Error("c01_invalid_request_start_interval");
  let lastStart = -Infinity;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    startIntervalMs,
    run<T>(request: (waitMs: number) => Promise<T>) {
      const queuedAt = performance.now();
      const pending = tail.then(async () => {
        const earliest = lastStart + startIntervalMs;
        while (performance.now() < earliest)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.ceil(earliest - performance.now())),
          );
        lastStart = performance.now();
        return request(lastStart - queuedAt);
      });
      // A rejected attempt releases the queue without hiding its rejection.
      tail = pending.catch(() => undefined);
      return pending;
    },
  };
}

function withRequestPacing<T>(
  options: RemoteD1Options,
  request: (
    observation: Pick<
      RemoteHttpAttempt,
      "pacingWaitMs" | "requestStartIntervalMs"
    >,
  ) => Promise<T>,
): Promise<T> {
  const pacing = options.requestPacing;
  return pacing
    ? pacing.run((waitMs) =>
        request({
          pacingWaitMs: waitMs,
          requestStartIntervalMs: pacing.startIntervalMs,
        }),
      )
    : request({});
}

interface RestResult {
  readonly success?: boolean;
  readonly results?: unknown[];
  readonly meta?: {
    readonly rows_read?: number;
    readonly rows_written?: number;
    readonly timings?: { readonly sql_duration_ms?: number };
    readonly duration?: number;
    readonly changes?: number;
    readonly served_by?: string;
    readonly served_by_region?: string;
  };
}

interface RestEnvelope {
  readonly success: boolean;
  readonly errors?: readonly {
    readonly code: number;
    readonly message: string;
  }[];
  readonly result?: RestResult[] | { readonly name?: string };
}

function apiBase(options: RemoteD1Options): string {
  return `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${options.databaseId}`;
}

const OBSERVED_RESPONSE_HEADERS = [
  "retry-after",
  "cf-ray",
  "cf-request-id",
  "x-request-id",
  "ratelimit",
  "ratelimit-policy",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-reset-after",
] as const;

function observedResponseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(
    OBSERVED_RESPONSE_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
}

/** Consume even retry bodies inside the shared serial request queue. */
async function readObservedResponse(response: Response, started: number) {
  const responseHeadersElapsedMs = performance.now() - started;
  const responseHeaders = observedResponseHeaders(response);
  let responseBody: string | undefined;
  let envelope: RestEnvelope | undefined;
  let error: unknown;
  let failed = false;
  try {
    responseBody = await response.text();
    envelope = JSON.parse(responseBody) as RestEnvelope;
  } catch (caught) {
    failed = true;
    error = caught;
  }
  return {
    envelope,
    failed,
    error,
    bodyConsumed: responseBody !== undefined,
    observation: {
      responseHeadersElapsedMs,
      responseBodyElapsedMs:
        performance.now() - started - responseHeadersElapsedMs,
      responseHeaders,
      ...(response.status >= 400 || failed || !envelope?.success
        ? { responseBody }
        : {}),
      ...(Array.isArray(envelope?.errors)
        ? { responseErrors: envelope.errors }
        : {}),
      ...(failed
        ? {
            responseBodyError: {
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            },
          }
        : {}),
    },
  };
}

async function call(
  options: RemoteD1Options,
  path: string,
  init: { readonly method: string; readonly body?: unknown },
): Promise<{ envelope: RestEnvelope; attempts: RemoteHttpAttempt[] }> {
  const attempts: RemoteHttpAttempt[] = [];
  const record = (attempt: RemoteHttpAttempt) => {
    const observation = { ...attempt, operation: "query" as const };
    attempts.push(observation);
    options.onHttpAttempt?.(observation);
  };
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await withRequestPacing(options, async (pacing) => {
      const started = performance.now();
      let response: Response;
      try {
        response = await fetch(`${apiBase(options)}${path}`, {
          method: init.method,
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
          },
          ...(init.body !== undefined
            ? { body: JSON.stringify(init.body) }
            : {}),
        });
      } catch (error) {
        record({
          attempt: attempt + 1,
          status: null,
          elapsedMs: performance.now() - started,
          elapsedScope: "response-headers",
          retry: false,
          backoffMs: 0,
          outcome: "transport-error",
          ...pacing,
        });
        throw error;
      }
      const retryEligible =
        options.retryPolicy !== "none" &&
        (response.status === 429 || response.status >= 500) &&
        attempt < 4;
      const parsed = await readObservedResponse(response, started);
      // A failed stream is a transport/body failure, not a consumed retry.
      const retry = retryEligible && parsed.bodyConsumed;
      const backoffMs = retry ? 500 * 2 ** attempt : 0;
      record({
        attempt: attempt + 1,
        status: response.status,
        elapsedMs: performance.now() - started,
        elapsedScope: "response-json",
        retry,
        backoffMs,
        outcome: "response",
        ...parsed.observation,
        ...pacing,
      });
      if (retry) return { retry: true as const, backoffMs };
      if (parsed.failed) throw parsed.error;
      const envelope = parsed.envelope;
      if (
        (options.retryPolicy === "none" && response.status !== 200) ||
        !envelope?.success
      )
        throw new Error(
          `d1_rest_error:${response.status}:${(envelope?.errors ?? [])
            .map((error) => `${error.code} ${error.message}`)
            .join("; ")}`,
        );
      return { retry: false as const, envelope };
    });
    if (outcome.retry) {
      await new Promise((resolve) => setTimeout(resolve, outcome.backoffMs));
      continue;
    }
    return { envelope: outcome.envelope, attempts };
  }
}

/** Refuses to run against anything but a disposable benchmark database. */
export async function assertDisposableDatabase(
  options: RemoteD1Options,
): Promise<void> {
  if (options.databaseId !== C01_DATABASE_ID)
    throw new Error("c01_refuses_unapproved_database_id");
  await withRequestPacing(options, async (pacing) => {
    const started = performance.now();
    let status: number | null = null;
    let envelope: RestEnvelope | undefined;
    let observation: Partial<RemoteHttpAttempt> = {};
    try {
      const response = await fetch(apiBase(options), {
        headers: { Authorization: `Bearer ${options.token}` },
      });
      status = response.status;
      const parsed = await readObservedResponse(response, started);
      observation = parsed.observation;
      if (parsed.failed) throw parsed.error;
      envelope = parsed.envelope;
    } finally {
      options.onHttpAttempt?.({
        operation: "target-preflight",
        attempt: 1,
        status,
        elapsedMs: performance.now() - started,
        elapsedScope: "response-json",
        retry: false,
        backoffMs: 0,
        outcome: status === null ? "transport-error" : "response",
        ...observation,
        ...pacing,
      });
    }
    const name = (envelope?.result as { readonly name?: string } | undefined)
      ?.name;
    if (!envelope?.success || typeof name !== "string")
      throw new Error("c01_database_lookup_failed");
    if (name !== C01_DATABASE_NAME)
      throw new Error(`c01_refuses_non_benchmark_database:${name}`);
  });
}

function requiredMetric(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`c01_remote_metric_unavailable:${name}`);
  return value;
}

function toMeta(
  sql: string,
  params: readonly unknown[],
  result: RestResult,
  attempts: readonly RemoteHttpAttempt[],
  statementOrdinal: number,
  inputParams: readonly unknown[] = params,
): RemoteStatementMeta {
  for (const [key, value] of Object.entries({
    timingsSqlDurationMs: result.meta?.timings?.sql_duration_ms,
    duration: result.meta?.duration,
  }))
    if (
      value != null &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    )
      throw new Error(`c01_remote_metric_unavailable:${key}`);
  return {
    sql,
    parameterCount: params.length,
    params,
    inputParams,
    rowsRead: requiredMetric(result.meta?.rows_read, "rows_read"),
    rowsWritten: requiredMetric(result.meta?.rows_written, "rows_written"),
    sqlDurationMs: requiredMetric(
      result.meta?.timings?.sql_duration_ms ?? result.meta?.duration,
      "sql_duration_ms",
    ),
    sqlDurationSource:
      result.meta?.timings?.sql_duration_ms != null
        ? "timings.sql_duration_ms"
        : "duration",
    durationRaw: {
      timingsSqlDurationMs: result.meta?.timings?.sql_duration_ms ?? null,
      duration: result.meta?.duration ?? null,
    },
    servedBy: result.meta?.served_by ?? null,
    servedByRegion: result.meta?.served_by_region ?? null,
    statementOrdinal,
    httpAttempts: attempts,
    resultRows: result.results?.length ?? 0,
  };
}

/** Executes one statement without parameters (schema and seed statements). */
export async function execRemote(
  options: RemoteD1Options,
  sql: string,
): Promise<RemoteStatementMeta> {
  const { envelope, attempts } = await call(options, "/query", {
    method: "POST",
    body: { sql },
  });
  const result = (envelope.result as RestResult[])[0] ?? {};
  const meta = toMeta(sql, [], result, attempts, 1);
  options.onStatement?.(meta);
  return meta;
}

export function createRemoteD1Database(options: RemoteD1Options): D1Database {
  let ordinal = 0;
  const run = async (
    statements: readonly { sql: string; params: unknown[] }[],
  ): Promise<RestResult[]> => {
    // REST binds JSON booleans as TEXT ('true'/'false'), unlike our native
    // adapter's numeric bindings. Preserve both representations for auditing.
    const transmitted = statements.map(({ sql, params }) => ({
      sql,
      params: params.map((value) =>
        typeof value === "boolean" ? (value ? 1 : 0) : value,
      ),
    }));
    const { envelope, attempts } = await call(options, "/query", {
      method: "POST",
      body: transmitted.length === 1 ? transmitted[0] : transmitted,
    });
    const results = envelope.result as RestResult[];
    statements.forEach((statement, index) => {
      const meta = toMeta(
        statement.sql,
        transmitted[index]!.params,
        results[index] ?? {},
        attempts,
        ++ordinal,
        statement.params,
      );
      options.onStatement?.(meta);
    });
    return results;
  };

  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const prepared = {
        bind(...values: unknown[]) {
          params = values;
          return prepared;
        },
        async first<Row>() {
          const [result] = await run([{ sql, params }]);
          return ((result?.results ?? [])[0] as Row | undefined) ?? null;
        },
        async all<Row>() {
          const [result] = await run([{ sql, params }]);
          return {
            success: true,
            results: (result?.results ?? []) as Row[],
            meta: result?.meta,
          } as unknown as D1Result<Row>;
        },
        async run() {
          const [result] = await run([{ sql, params }]);
          return {
            success: true,
            meta: { changes: result?.meta?.changes ?? 0 },
          } as unknown as D1Result;
        },
        // Read by `batch` below.
        __statement: () => ({ sql, params }),
      };
      return prepared as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const items = statements.map((statement) =>
        (
          statement as unknown as {
            __statement: () => { sql: string; params: unknown[] };
          }
        ).__statement(),
      );
      const results = await run(items);
      return results.map((result) => ({
        success: true,
        results: result.results ?? [],
        meta: result.meta,
      })) as unknown as D1Result[];
    },
  } as unknown as D1Database;
}
