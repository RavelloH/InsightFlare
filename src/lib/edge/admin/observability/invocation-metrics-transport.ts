export type InvocationQueryError =
  | "invalid_request"
  | "invalid_query"
  | "concurrency_limited"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "service_unavailable"
  | "insufficient_storage"
  | "timeout"
  | "aborted"
  | "malformed_response"
  | "response_too_large"
  | "too_many_rows"
  | "redirect_rejected"
  | "upstream_error"
  | "network_error";

export type InvocationProviderReason =
  | "invalid_count_arguments"
  | "invalid_column"
  | "type_mismatch"
  | "sql_parse_error"
  | "invalid_query";

type InvocationQueryResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | {
      ok: false;
      code: InvocationQueryError;
      retryAfterSeconds: number | null;
      providerStatus?: number;
      reason?: InvocationProviderReason;
    };

type InvocationQueryInput = {
  apiUrl: string;
  accountId: string;
  token: string;
  sql: string;
  limit: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

const MAX_CONCURRENT_QUERIES = 4;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ROWS = 100;
const QUERY_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_ERROR_BYTES = 2_048;

let activeQueries = 0;

function failure(
  code: InvocationQueryError,
  retryAfterSeconds: number | null = null,
  diagnostic?: { providerStatus?: number; reason?: InvocationProviderReason },
): InvocationQueryResult {
  return { ok: false, code, retryAfterSeconds, ...diagnostic };
}

function endpointFor(input: InvocationQueryInput): URL | null {
  try {
    const base = input.apiUrl.trim().replace(/\/+$/, "");
    const endpoint = new URL(
      `${base}/${encodeURIComponent(input.accountId)}/analytics_engine/sql`,
    );
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      return null;
    }
    return endpoint;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function errorForSignal(signal: AbortSignal): "timeout" | "aborted" {
  const reason = signal.reason;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  ) {
    return "timeout";
  }
  return "aborted";
}

function errorForStatus(status: number): InvocationQueryError {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 429:
      return "rate_limited";
    case 503:
      return "service_unavailable";
    case 507:
      return "insufficient_storage";
    default:
      return "upstream_error";
  }
}

/** Match only code-owned patterns. Never return provider text or a raw SQL fragment. */
async function classifyProviderError(
  response: Response,
): Promise<InvocationProviderReason> {
  const reader = response.body?.getReader();
  if (!reader) return "invalid_query";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_PROVIDER_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const count = Math.min(value.byteLength, MAX_PROVIDER_ERROR_BYTES - size);
      chunks.push(value.subarray(0, count));
      size += count;
    }
  } catch {
    return "invalid_query";
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const message = new TextDecoder().decode(bytes).toLowerCase();
  if (message.includes("count() function must have 0 arguments"))
    return "invalid_count_arguments";
  if (message.includes("unable to find type of column"))
    return "invalid_column";
  if (message.includes("must have the same type")) return "type_mismatch";
  if (message.includes("sql parser error")) return "sql_parse_error";
  return "invalid_query";
}

function cancelBody(response: Response): void {
  const cancellation = response.body?.cancel();
  if (cancellation) void cancellation.catch(() => undefined);
}

async function readBoundedBody(
  response: Response,
): Promise<
  { ok: true; text: string } | { ok: false; code: InvocationQueryError }
> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    return { ok: false, code: "response_too_large" };
  }

  if (!response.body) return { ok: true, text: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, code: "response_too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { ok: false, code: "malformed_response" };
  }
}

function parseJsonEachRow(
  text: string,
  limit: number,
):
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; code: InvocationQueryError } {
  if (text === "") return { ok: true, rows: [] };

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const rows: Record<string, unknown>[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return { ok: false, code: "malformed_response" };

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { ok: false, code: "malformed_response" };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, code: "malformed_response" };
    }
    rows.push(value as Record<string, unknown>);
    if (rows.length > limit || rows.length > MAX_ROWS) {
      return { ok: false, code: "too_many_rows" };
    }
  }
  return { ok: true, rows };
}

export async function queryInvocationMetrics(
  input: InvocationQueryInput,
): Promise<InvocationQueryResult> {
  const endpoint = endpointFor(input);
  if (
    !endpoint ||
    !input.accountId.trim() ||
    !input.token.trim() ||
    /[\r\n]/.test(input.token) ||
    !input.sql.trim() ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_ROWS
  ) {
    return failure("invalid_request");
  }
  if (input.signal?.aborted) return failure(errorForSignal(input.signal));
  if (activeQueries >= MAX_CONCURRENT_QUERIES) {
    return failure("concurrency_limited");
  }

  activeQueries += 1;
  const controller = new AbortController();
  let cancellationCode: "timeout" | "aborted" | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    cancellationCode = input.signal ? errorForSignal(input.signal) : "aborted";
    controller.abort();
    rejectAbort?.(new Error("aborted"));
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  if (input.signal?.aborted) onAbort();

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      cancellationCode = "timeout";
      controller.abort();
      reject(new Error("timeout"));
    }, QUERY_TIMEOUT_MS);
  });

  const operation = (async (): Promise<InvocationQueryResult> => {
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "text/plain",
        accept: "text/plain",
      },
      body: input.sql,
      redirect: "manual",
      signal: controller.signal,
    });
    const retryAfterSeconds = parseRetryAfter(
      response.headers.get("retry-after"),
    );

    if (response.status >= 300 && response.status < 400) {
      cancelBody(response);
      return failure("redirect_rejected", retryAfterSeconds);
    }
    if (!response.ok) {
      if (response.status === 422) {
        const reason = await classifyProviderError(response);
        return failure("invalid_query", retryAfterSeconds, {
          providerStatus: response.status,
          reason,
        });
      }
      cancelBody(response);
      return failure(errorForStatus(response.status), retryAfterSeconds, {
        providerStatus: response.status,
      });
    }

    const body = await readBoundedBody(response);
    if (!body.ok) return failure(body.code);

    const parsed = parseJsonEachRow(body.text, input.limit);
    if (!parsed.ok) return failure(parsed.code);
    return { ok: true, rows: parsed.rows };
  })();

  try {
    return await Promise.race([operation, timeoutPromise, abortPromise]);
  } catch {
    if (cancellationCode) return failure(cancellationCode);
    return failure("network_error");
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    input.signal?.removeEventListener("abort", onAbort);
    activeQueries -= 1;
  }
}
