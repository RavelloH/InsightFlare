import { diagnosticsCacheBypassSecret } from "@/lib/secrets";

import { DIAGNOSTICS_CACHE_BYPASS_SAMPLER_NAME } from "./diagnostics-sampler";
import type { Env } from "./types";

export const DIAGNOSTIC_CACHE_BYPASS_HEADER =
  "x-insightflare-diagnostics-bypass";
const TOKEN_AUDIENCE = "diagnostics-cache-bypass";
const TOKEN_VERSION = "v1";
const MAX_TOKEN_TTL_MS = 60_000;

interface DiagnosticCacheBypassPayload {
  actorId: string;
  audience: typeof TOKEN_AUDIENCE;
  expiresAtMs: number;
  method: string;
  nonce: string;
  requestPath: string;
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function canonicalRequestPath(request: Request): string {
  const url = new URL(request.url);
  const params = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
      return 0;
    },
  );
  const search = new URLSearchParams();
  for (const [key, value] of params) search.append(key, value);
  return `${url.pathname}${search.size > 0 ? `?${search}` : ""}`;
}

async function sign(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(new TextEncoder().encode(value)),
    ),
  );
}

function parsePayload(value: string): DiagnosticCacheBypassPayload | null {
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(value)),
    ) as Partial<DiagnosticCacheBypassPayload>;
    if (!payload || typeof payload !== "object") return null;
    const actorId = String(payload.actorId ?? "").trim();
    const requestPath = String(payload.requestPath ?? "");
    const nonce = String(payload.nonce ?? "");
    const expiresAtMs = Number(payload.expiresAtMs);
    if (
      payload.audience !== TOKEN_AUDIENCE ||
      !actorId ||
      !requestPath.startsWith("/") ||
      !/^[A-Za-z0-9_-]{16,96}$/.test(nonce) ||
      !Number.isFinite(expiresAtMs)
    ) {
      return null;
    }
    return {
      actorId,
      audience: TOKEN_AUDIENCE,
      expiresAtMs,
      method: String(payload.method ?? "").toUpperCase(),
      nonce,
      requestPath,
    };
  } catch {
    return null;
  }
}

export async function issueDiagnosticCacheBypassToken(input: {
  actorId: string;
  env: Env;
  nowMs?: number;
  request: Request;
  ttlMs?: number;
}): Promise<string | null> {
  const secret = await diagnosticsCacheBypassSecret(input.env);
  const actorId = input.actorId.trim();
  const sampler = input.env.DIAGNOSTICS_SAMPLER;
  if (!secret || !actorId || !sampler) return null;
  const nowMs = input.nowMs ?? Date.now();
  try {
    const reserved = await sampler
      .getByName(DIAGNOSTICS_CACHE_BYPASS_SAMPLER_NAME)
      .reserveCacheBypass(actorId, nowMs);
    if (!reserved) return null;
  } catch {
    return null;
  }
  const ttlMs = Math.min(
    MAX_TOKEN_TTL_MS,
    Math.max(1_000, Math.trunc(input.ttlMs ?? MAX_TOKEN_TTL_MS)),
  );
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        actorId,
        audience: TOKEN_AUDIENCE,
        expiresAtMs: nowMs + ttlMs,
        method: input.request.method.toUpperCase(),
        nonce: crypto.randomUUID().replace(/-/g, ""),
        requestPath: canonicalRequestPath(input.request),
      } satisfies DiagnosticCacheBypassPayload),
    ),
  );
  const signature = base64UrlEncode(
    await sign(`${TOKEN_VERSION}.${payload}`, secret),
  );
  return `${TOKEN_VERSION}.${payload}.${signature}`;
}

export async function verifyDiagnosticCacheBypass(input: {
  actorId: string | undefined;
  env: Env;
  nowMs?: number;
  request: Request;
}): Promise<boolean> {
  const token = input.request.headers
    .get(DIAGNOSTIC_CACHE_BYPASS_HEADER)
    ?.trim();
  if (!token || token.length > 768 || !input.actorId) return false;
  const [version, payloadPart, signaturePart, extra] = token.split(".");
  if (
    !version ||
    !payloadPart ||
    !signaturePart ||
    extra ||
    version !== TOKEN_VERSION
  ) {
    return false;
  }
  const payload = parsePayload(payloadPart);
  const secret = await diagnosticsCacheBypassSecret(input.env);
  if (!payload || !secret) return false;
  let actualSignature: Uint8Array;
  try {
    actualSignature = base64UrlDecode(signaturePart);
  } catch {
    return false;
  }
  if (
    !bytesEqual(
      await sign(`${version}.${payloadPart}`, secret),
      actualSignature,
    )
  ) {
    return false;
  }
  const nowMs = input.nowMs ?? Date.now();
  if (
    payload.actorId !== input.actorId ||
    payload.method !== input.request.method.toUpperCase() ||
    payload.requestPath !== canonicalRequestPath(input.request) ||
    payload.expiresAtMs <= nowMs ||
    payload.expiresAtMs > nowMs + MAX_TOKEN_TTL_MS
  ) {
    return false;
  }
  const sampler = input.env.DIAGNOSTICS_SAMPLER;
  if (!sampler) return false;
  try {
    return await sampler
      .getByName(DIAGNOSTICS_CACHE_BYPASS_SAMPLER_NAME)
      .consumeBypassNonce(payload.nonce, payload.expiresAtMs, nowMs);
  } catch {
    return false;
  }
}
