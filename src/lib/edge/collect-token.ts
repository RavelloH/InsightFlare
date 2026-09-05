import { collectTokenSigningSecret } from "@/lib/secrets";

import { appNow } from "./e2e-clock";
import type { Env } from "./types";

const COLLECT_TOKEN_AUDIENCE = "collect";
const COLLECT_TOKEN_KEY_ID = "collect-v1";
export const COLLECT_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export type CollectTokenVerificationResult =
  { ok: true; payload: CollectTokenPayload } | { ok: false; reason: string };

export interface CollectTokenPayload {
  aud: string;
  siteId: string;
  ip: string;
  iat: number;
  exp: number;
}

interface CollectTokenHeader {
  alg: string;
  typ: string;
  kid: string;
}

function bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function toBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

function base64UrlEncode(input: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < input.length; index += 1) {
    binary += String.fromCharCode(input[index]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

async function signingSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
): Promise<string | null> {
  return collectTokenSigningSecret(env);
}

async function hmacSha256(
  message: string,
  secret: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBuffer(bytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toBuffer(bytes(message)),
  );
  return new Uint8Array(signature);
}

function normalizeIp(ip: string): string {
  return String(ip || "")
    .trim()
    .slice(0, 80);
}

export function requestIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return normalizeIp(cfIp);
  const forwarded = request.headers.get("x-forwarded-for")?.trim();
  if (forwarded) return normalizeIp(forwarded.split(",")[0] || "");
  const realIp = request.headers.get("x-real-ip")?.trim();
  // Local Workers and self-hosted deployments can legitimately lack a proxy
  // forwarding header. Keep token issuance and verification consistent there.
  return realIp ? normalizeIp(realIp) : "0.0.0.0";
}

function encodePayload(payload: CollectTokenPayload): string {
  return base64UrlEncode(bytes(JSON.stringify(payload)));
}

function encodeHeader(): string {
  return base64UrlEncode(
    bytes(
      JSON.stringify({
        alg: "HS256",
        typ: "JWT",
        kid: COLLECT_TOKEN_KEY_ID,
      } satisfies CollectTokenHeader),
    ),
  );
}

function decodeHeader(value: string): CollectTokenHeader | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(value)),
    ) as Partial<CollectTokenHeader> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const alg = String(parsed.alg || "");
    const typ = String(parsed.typ || "");
    const kid = String(parsed.kid || "");
    if (alg !== "HS256" || typ !== "JWT" || kid !== COLLECT_TOKEN_KEY_ID) {
      return null;
    }
    return { alg, typ, kid };
  } catch {
    return null;
  }
}

function decodePayload(value: string): CollectTokenPayload | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(value)),
    ) as Partial<CollectTokenPayload> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const aud = String(parsed.aud || "");
    const siteId = String(parsed.siteId || "");
    const ip = String(parsed.ip || "");
    const iat = Number(parsed.iat || 0);
    const exp = Number(parsed.exp || 0);
    if (
      aud !== COLLECT_TOKEN_AUDIENCE ||
      !siteId ||
      !ip ||
      !Number.isFinite(iat) ||
      !Number.isFinite(exp)
    ) {
      return null;
    }
    return { aud, siteId, ip, iat, exp };
  } catch {
    return null;
  }
}

export async function issueCollectToken(input: {
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">;
  siteId: string;
  ip: string;
  nowSeconds?: number;
}): Promise<string> {
  const secret = await signingSecret(input.env);
  if (!secret) {
    throw new Error(
      "MAIN_SECRET or DAILY_SALT_SECRET is required to sign collect tokens",
    );
  }
  const now = Math.floor(input.nowSeconds ?? appNow() / 1000);
  const payload = encodePayload({
    aud: COLLECT_TOKEN_AUDIENCE,
    siteId: input.siteId,
    ip: normalizeIp(input.ip),
    iat: now,
    exp: now + COLLECT_TOKEN_TTL_SECONDS,
  });
  const header = encodeHeader();
  const signature = await hmacSha256(`${header}.${payload}`, secret);
  return `${header}.${payload}.${base64UrlEncode(signature)}`;
}

export async function verifyCollectToken(input: {
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">;
  token: string;
  siteId: string;
  ip: string;
  nowSeconds?: number;
}): Promise<CollectTokenVerificationResult> {
  const token = String(input.token || "").trim();
  if (!token) return { ok: false, reason: "missing_collect_token" };

  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (
    !headerPart ||
    !payloadPart ||
    !signaturePart ||
    token.split(".").length !== 3
  ) {
    return { ok: false, reason: "invalid_collect_token_format" };
  }

  if (!decodeHeader(headerPart)) {
    return { ok: false, reason: "invalid_collect_token_header" };
  }

  const secret = await signingSecret(input.env);
  if (!secret) return { ok: false, reason: "collect_token_secret_missing" };

  let actualSignature: Uint8Array;
  try {
    actualSignature = base64UrlDecode(signaturePart);
  } catch {
    return { ok: false, reason: "invalid_collect_token_signature_encoding" };
  }

  const expectedSignature = await hmacSha256(
    `${headerPart}.${payloadPart}`,
    secret,
  );
  if (!bytesEqual(expectedSignature, actualSignature)) {
    return { ok: false, reason: "invalid_collect_token_signature" };
  }

  const payload = decodePayload(payloadPart);
  if (!payload) return { ok: false, reason: "invalid_collect_token_payload" };

  const now = Math.floor(input.nowSeconds ?? appNow() / 1000);
  if (payload.exp <= now) return { ok: false, reason: "expired_collect_token" };
  if (payload.iat > now + 60)
    return { ok: false, reason: "future_collect_token" };
  if (payload.siteId !== input.siteId) {
    return { ok: false, reason: "collect_token_site_mismatch" };
  }
  if (payload.ip !== normalizeIp(input.ip)) {
    return { ok: false, reason: "collect_token_ip_mismatch" };
  }

  return { ok: true, payload };
}
