/**
 * Bounded request/body inspection shared by API v1 JSON boundaries.
 *
 * The byte limits are deliberately measured on UTF-8/raw bytes, not JS
 * string length.  Callers must run this before parsing a recursive schema.
 */
export const API_V1_JSON_BODY_MAX_BYTES = 64 * 1024;
export const API_V1_BATCH_BODY_MAX_BYTES = 256 * 1024;
export const API_V1_BATCH_ITEM_BODY_MAX_BYTES = 64 * 1024;
export const API_V1_JSON_MAX_DEPTH = 32;
export const API_V1_JSON_MAX_NODES = 10_000;
export const API_V1_JSON_MAX_ARRAY_LENGTH = 1_000;
export const API_V1_JSON_MAX_STRING_BYTES = 64 * 1024;

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function serializedUtf8ByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

export interface JsonBudget {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxArrayLength?: number;
  readonly maxStringBytes?: number;
}

export type JsonBudgetResult =
  | { readonly ok: true; readonly nodes: number; readonly stringBytes: number }
  | {
      readonly ok: false;
      readonly reason: "depth" | "nodes" | "array" | "string";
    };

/** Iterative walk so hostile nesting cannot exhaust the JS call stack. */
export function inspectJsonBudget(
  value: unknown,
  budget: JsonBudget = {},
): JsonBudgetResult {
  const maxDepth = budget.maxDepth ?? API_V1_JSON_MAX_DEPTH;
  const maxNodes = budget.maxNodes ?? API_V1_JSON_MAX_NODES;
  const maxArrayLength = budget.maxArrayLength ?? API_V1_JSON_MAX_ARRAY_LENGTH;
  const maxStringBytes = budget.maxStringBytes ?? API_V1_JSON_MAX_STRING_BYTES;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let stringBytes = 0;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) return { ok: false, reason: "nodes" };
    if (entry.depth > maxDepth) return { ok: false, reason: "depth" };
    if (typeof entry.value === "string") {
      stringBytes += utf8ByteLength(entry.value);
      if (stringBytes > maxStringBytes) return { ok: false, reason: "string" };
      continue;
    }
    if (Array.isArray(entry.value)) {
      if (entry.value.length > maxArrayLength)
        return { ok: false, reason: "array" };
      for (let index = entry.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entry.value[index], depth: entry.depth + 1 });
      }
      continue;
    }
    if (entry.value !== null && typeof entry.value === "object") {
      for (const [key, child] of Object.entries(entry.value)) {
        stringBytes += utf8ByteLength(key);
        if (stringBytes > maxStringBytes)
          return { ok: false, reason: "string" };
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
  return { ok: true, nodes, stringBytes };
}

export type BoundedBodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "empty" | "too_large" };

interface BoundedBodyRequest {
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array<ArrayBufferLike>> | null;
}

/** Read at most maxBytes from a request body, independent of Content-Length. */
export async function readBoundedBody(
  request: BoundedBodyRequest,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > maxBytes)
      return { ok: false, reason: "too_large" };
  }
  if (!request.body) return { ok: false, reason: "empty" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return { ok: false, reason: "empty" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** Bounded UTF-8 JSON parse plus structural preflight for typed JSON routes. */
export async function readBoundedJson(
  request: Request,
  maxBytes = API_V1_JSON_BODY_MAX_BYTES,
): Promise<unknown> {
  const result = await readBoundedBody(request, maxBytes);
  if (!result.ok)
    throw new Error(
      result.reason === "too_large" ? "body_too_large" : "invalid_body",
    );
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
    ) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
  const budget = inspectJsonBudget(value);
  if (!budget.ok) throw new Error("invalid_body");
  return value;
}
