import type { Env } from "./types";

export type EdgeSystemRole = "admin" | "user";

export interface EdgeSessionClaims {
  userId: string;
  username: string;
  displayName: string;
  systemRole: EdgeSystemRole;
  exp: number;
}

function sessionSecret(env: Env): string {
  return String(env.DASHBOARD_SESSION_SECRET || env.SESSION_SECRET || "insightflare-session-secret-change-me");
}

function bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function toBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function hmacSha256(message: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBuffer(bytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, toBuffer(bytes(message)));
  return new Uint8Array(sig);
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

export async function verifySessionToken(token: string, env: Env): Promise<EdgeSessionClaims | null> {
  if (!token || token.length < 20) return null;
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;

  const expectedSig = await hmacSha256(payloadPart, sessionSecret(env));
  let actualSig: Uint8Array;
  try {
    actualSig = base64UrlDecode(signaturePart);
  } catch {
    return null;
  }
  if (!bytesEqual(expectedSig, actualSig)) return null;

  let parsed: unknown;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadPart));
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const maybe = parsed as Partial<EdgeSessionClaims>;
  const userId = String(maybe.userId || "");
  const username = String(maybe.username || "");
  const displayName = String(maybe.displayName || "");
  const systemRole: EdgeSystemRole = maybe.systemRole === "admin" ? "admin" : "user";
  const exp = Number(maybe.exp || 0);
  if (!userId || !username || !Number.isFinite(exp) || exp <= 0) return null;
  if (Math.floor(Date.now() / 1000) >= exp) return null;

  return {
    userId,
    username,
    displayName,
    systemRole,
    exp,
  };
}

export async function requireSession(request: Request, env: Env): Promise<EdgeSessionClaims | null> {
  const token = extractSessionToken(request);
  if (!token) return null;
  return verifySessionToken(token, env);
}
