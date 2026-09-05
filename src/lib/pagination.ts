import { sha256Hex } from "@/lib/edge/utils";
import { rootSecret, type SecretSource } from "@/lib/secrets";

export const MAX_CURSOR_LENGTH = 12_288;
export const MAX_CURSOR_PAYLOAD_BYTES = 8_192;
export const CURSOR_CODEC_VERSION = 1 as const;

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string | null;
}

export interface PaginationMeta {
  readonly limit: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface PageResult<T> {
  readonly items: readonly T[];
  readonly pagination: PaginationMeta;
}

export class InvalidCursorError extends Error {
  readonly kind = "invalid-cursor" as const;

  constructor(readonly cursorKind: string) {
    super("invalid-cursor");
    this.name = "InvalidCursorError";
  }
}

type CursorEnvelope = {
  readonly v: typeof CURSOR_CODEC_VERSION;
  readonly binding: string;
  readonly key: unknown;
};

export type CursorKeyDecoder<T> = (value: unknown) => T | null;

/** Cursor keys are fixed keyset tuples, not extensible metadata objects. */
export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
    const decoded = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (value.length % 4)) % 4),
    );
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function sign(secret: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, ["sign"]),
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(signature));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value === undefined ? null : value;
}

export async function paginationBinding(
  parts: readonly unknown[],
): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize(parts)));
}

/**
 * API v1 may bind cursors to the original request shape so rolling presets do
 * not change identity between page requests. Non-API callers continue to use
 * their parsed semantic binding.
 */
export function paginationBindingForWindow(
  window: { readonly paginationBinding?: string },
  parts: readonly unknown[],
): Promise<string> {
  return window.paginationBinding
    ? Promise.resolve(window.paginationBinding)
    : paginationBinding(parts);
}

export async function encodePageCursor<T>(
  env: SecretSource,
  binding: string,
  key: T,
): Promise<string> {
  const secret = rootSecret(env);
  if (!secret) throw new Error("data-unavailable");
  const envelope: CursorEnvelope = {
    v: CURSOR_CODEC_VERSION,
    binding,
    key: canonicalize(key),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(envelope));
  if (encoded.byteLength > MAX_CURSOR_PAYLOAD_BYTES) {
    throw new Error("cursor-payload-too-large");
  }
  const payload = base64Url(encoded);
  const cursor = `${payload}.${await sign(secret, payload)}`;
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new Error("cursor-too-large");
  }
  return cursor;
}

export async function decodePageCursor<T>(
  env: SecretSource,
  binding: string,
  cursor: string | null | undefined,
  cursorKind: string,
  decodeKey: CursorKeyDecoder<T>,
): Promise<T | null> {
  if (!cursor) return null;
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new InvalidCursorError(cursorKind);
  }
  const secret = rootSecret(env);
  if (!secret) throw new Error("data-unavailable");
  const [payload, signature, extra] = cursor.split(".");
  if (!payload || !signature || extra) {
    throw new InvalidCursorError(cursorKind);
  }
  const signatureBytes = decodeBase64Url(signature);
  const payloadBytes = decodeBase64Url(payload);
  if (
    !signatureBytes ||
    !payloadBytes ||
    payloadBytes.byteLength > MAX_CURSOR_PAYLOAD_BYTES
  ) {
    throw new InvalidCursorError(cursorKind);
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    arrayBuffer(signatureBytes),
    new TextEncoder().encode(payload),
  );
  if (!valid) throw new InvalidCursorError(cursorKind);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      v?: unknown;
      binding?: unknown;
      key?: unknown;
    };
    if (
      !hasExactKeys(parsed as Record<string, unknown>, [
        "v",
        "binding",
        "key",
      ]) ||
      parsed.v !== CURSOR_CODEC_VERSION ||
      parsed.binding !== binding ||
      parsed.key === undefined
    ) {
      throw new InvalidCursorError(cursorKind);
    }
    const decoded = decodeKey(parsed.key);
    if (decoded === null || decoded === undefined) {
      throw new InvalidCursorError(cursorKind);
    }
    return decoded;
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError(cursorKind);
  }
}

export function pageResult<T>(
  rows: readonly T[],
  limit: number,
): {
  readonly rows: readonly T[];
  readonly hasMore: boolean;
  readonly last: T | undefined;
} {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return { rows: pageRows, hasMore, last: pageRows.at(-1) };
}

export function pageResponse<T>(
  rows: readonly T[],
  limit: number,
  nextCursor: string | null,
): PageResult<T> {
  return {
    items: rows,
    pagination: {
      limit,
      returned: rows.length,
      hasMore: nextCursor !== null,
      nextCursor,
    },
  };
}
