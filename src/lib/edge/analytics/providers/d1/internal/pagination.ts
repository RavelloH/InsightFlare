import type { Env } from "@/lib/edge/types";
import { sha256Hex } from "@/lib/edge/utils";
import { rootSecret } from "@/lib/secrets";

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

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const raw = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
  );
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  );
}

export async function paginationBinding(
  parts: readonly unknown[],
): Promise<string> {
  return sha256Hex(JSON.stringify(parts));
}

export async function encodePageCursor<T>(
  env: Env,
  binding: string,
  key: T,
): Promise<string> {
  const secret = rootSecret(env);
  if (!secret) throw new Error("data-unavailable");
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({ binding, key })),
  );
  return `${payload}.${await sign(secret, payload)}`;
}

export async function decodePageCursor<T>(
  env: Env,
  binding: string,
  cursor: string | null | undefined,
): Promise<T | null> {
  if (!cursor) return null;
  const secret = rootSecret(env);
  if (!secret) return null;
  const [payload, signature, extra] = cursor.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    (await sign(secret, payload)) !== signature
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload)),
    ) as { binding?: unknown; key?: T };
    return parsed.binding === binding && parsed.key !== undefined
      ? parsed.key
      : null;
  } catch {
    return null;
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
