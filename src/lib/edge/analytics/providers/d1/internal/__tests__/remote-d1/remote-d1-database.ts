/**
 * A `D1Database` backed by the Cloudflare D1 REST API, used only by the
 * on-demand cost baseline (`pnpm run test:cost`). It lets the real engine run
 * against a real D1 database and records the `meta` D1 reports for every
 * statement (rows read, rows written, server-side duration).
 *
 * Safety: the database id and token come from the environment, and the
 * constructor refuses any database whose name does not start with the
 * disposable benchmark prefix.
 */

export const C01_DATABASE_PREFIX = "if-c01-bench-";

export interface RemoteStatementMeta {
  readonly sql: string;
  readonly parameterCount: number;
  /** Bound values, kept so a heavy statement can be explained afterwards. */
  readonly params: readonly unknown[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly sqlDurationMs: number;
  readonly resultRows: number;
}

export interface RemoteD1Options {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
  readonly onStatement?: (meta: RemoteStatementMeta) => void;
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

async function call(
  options: RemoteD1Options,
  path: string,
  init: { readonly method: string; readonly body?: unknown },
): Promise<RestEnvelope> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${apiBase(options)}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    const envelope = (await response.json()) as RestEnvelope;
    if (!envelope.success)
      throw new Error(
        `d1_rest_error:${response.status}:${(envelope.errors ?? [])
          .map((error) => `${error.code} ${error.message}`)
          .join("; ")}`,
      );
    return envelope;
  }
}

/** Refuses to run against anything but a disposable benchmark database. */
export async function assertDisposableDatabase(
  options: RemoteD1Options,
): Promise<void> {
  const response = await fetch(apiBase(options), {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  const envelope = (await response.json()) as RestEnvelope;
  const name = (envelope.result as { readonly name?: string } | undefined)
    ?.name;
  if (!envelope.success || typeof name !== "string")
    throw new Error("c01_database_lookup_failed");
  if (!name.startsWith(C01_DATABASE_PREFIX))
    throw new Error(`c01_refuses_non_benchmark_database:${name}`);
}

function toMeta(
  sql: string,
  params: readonly unknown[],
  result: RestResult,
): RemoteStatementMeta {
  return {
    sql,
    parameterCount: params.length,
    params,
    rowsRead: result.meta?.rows_read ?? 0,
    rowsWritten: result.meta?.rows_written ?? 0,
    sqlDurationMs:
      result.meta?.timings?.sql_duration_ms ?? result.meta?.duration ?? 0,
    resultRows: result.results?.length ?? 0,
  };
}

/** Executes one statement without parameters (schema and seed statements). */
export async function execRemote(
  options: RemoteD1Options,
  sql: string,
): Promise<RemoteStatementMeta> {
  const envelope = await call(options, "/query", {
    method: "POST",
    body: { sql },
  });
  const result = (envelope.result as RestResult[])[0] ?? {};
  const meta = toMeta(sql, [], result);
  options.onStatement?.(meta);
  return meta;
}

export function createRemoteD1Database(options: RemoteD1Options): D1Database {
  const run = async (
    statements: readonly { sql: string; params: unknown[] }[],
  ): Promise<RestResult[]> => {
    const envelope = await call(options, "/query", {
      method: "POST",
      body:
        statements.length === 1
          ? statements[0]
          : statements.map(({ sql, params }) => ({ sql, params })),
    });
    const results = envelope.result as RestResult[];
    statements.forEach((statement, index) =>
      options.onStatement?.(
        toMeta(statement.sql, statement.params, results[index] ?? {}),
      ),
    );
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
