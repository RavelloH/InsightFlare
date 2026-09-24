import { appNow } from "@/lib/edge/runtime/e2e-clock";
import type { Env } from "@/lib/edge/types";
import { dashboardSessionSecret } from "@/lib/secrets";

export type EdgeSystemRole = "admin" | "user";

export interface EdgeSessionClaims {
  userId: string;
  username: string;
  displayName: string;
  systemRole: EdgeSystemRole;
  exp: number;
}

// The secret is deployment configuration, so this cache cannot grow from
// request input. Cache the import promise to also coalesce concurrent starts.
const sessionHmacKeyCache = new Map<string, Promise<CryptoKey>>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function sessionHmacKey(env: Env): Promise<CryptoKey> {
  const secret = await dashboardSessionSecret(env);
  if (!secret) {
    throw new Error(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for sessions",
    );
  }
  let keyPromise = sessionHmacKeyCache.get(secret);
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      toBuffer(bytes(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    sessionHmacKeyCache.set(secret, keyPromise);
  }
  try {
    return await keyPromise;
  } catch (error) {
    if (sessionHmacKeyCache.get(secret) === keyPromise) {
      sessionHmacKeyCache.delete(secret);
    }
    throw error;
  }
}

function bytes(input: string): Uint8Array {
  return textEncoder.encode(input);
}

function toBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function verifyHmacSha256(
  message: string,
  signature: Uint8Array,
  key: CryptoKey,
): Promise<boolean> {
  return crypto.subtle.verify(
    "HMAC",
    key,
    toBuffer(signature),
    toBuffer(bytes(message)),
  );
}

function extractBearerToken(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function extractCookieToken(request: Request): string {
  const cookie = request.headers.get("cookie") || "";
  if (!cookie) return "";
  const parts = cookie.split(";");
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === "if_session") {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return "";
}

export function extractSessionToken(request: Request): string {
  return extractBearerToken(request) || extractCookieToken(request);
}

export async function verifySessionToken(
  token: string,
  env: Env,
): Promise<EdgeSessionClaims | null> {
  if (!token || token.length < 20) return null;
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;

  const key = await sessionHmacKey(env);
  let actualSig: Uint8Array;
  try {
    actualSig = base64UrlDecode(signaturePart);
  } catch {
    return null;
  }
  if (!(await verifyHmacSha256(payloadPart, actualSig, key))) return null;

  let parsed: unknown;
  try {
    const payloadJson = textDecoder.decode(base64UrlDecode(payloadPart));
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const maybe = parsed as Partial<EdgeSessionClaims>;
  const userId = String(maybe.userId || "");
  const username = String(maybe.username || "");
  const displayName = String(maybe.displayName || "");
  const systemRole: EdgeSystemRole =
    maybe.systemRole === "admin" ? "admin" : "user";
  const exp = Number(maybe.exp || 0);
  if (!userId || !username || !Number.isFinite(exp) || exp <= 0) return null;
  if (Math.floor(appNow() / 1000) >= exp) return null;

  return {
    userId,
    username,
    displayName,
    systemRole,
    exp,
  };
}

export async function requireSession(
  request: Request,
  env: Env,
): Promise<EdgeSessionClaims | null> {
  const token = extractSessionToken(request);
  if (!token) return null;
  return verifySessionToken(token, env);
}
