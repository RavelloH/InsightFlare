import type { Env } from "./types";

function base64UrlDecode(input: string): Uint8Array {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function hmacSha256(
  message: string,
  secret: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return new Uint8Array(sig);
}

async function verifySessionToken(
  token: string,
  secret: string,
): Promise<Record<string, string> | null> {
  if (!token || token.length < 20) return null;
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;

  const expectedSig = await hmacSha256(payloadPart, secret);
  let actualSig: Uint8Array;
  try {
    actualSig = base64UrlDecode(signaturePart);
  } catch {
    return null;
  }
  if (!bytesEqual(expectedSig, actualSig)) return null;

  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadPart));
    const parsed = JSON.parse(payloadJson) as Record<string, string | number>;
    if (!parsed || typeof parsed !== "object") return null;

    const { userId, username, exp } = parsed;
    if (!userId || !username || !exp) return null;
    if (Math.floor(Date.now() / 1000) >= Number(exp)) return null;

    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

async function deriveSessionSecret(env: Env): Promise<string | null> {
  const explicit = env.DASHBOARD_SESSION_SECRET || env.SESSION_SECRET;
  if (explicit) return explicit;

  const root = env.MAIN_SECRET || env.DAILY_SALT_SECRET;
  if (!root) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(root),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("insightflare:dashboard-session:v1"),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractSessionToken(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  const cookie = request.headers.get("cookie") || "";
  if (!cookie) return "";
  const parts = cookie.split(";");
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === "if_session") {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return rawValue.join("=");
      }
    }
  }
  return "";
}

async function canSessionReadSite(
  env: Env,
  session: Record<string, string>,
  siteId: string,
): Promise<boolean> {
  if (session.systemRole === "admin") {
    const site = await env.DB.prepare("SELECT id FROM sites WHERE id=? LIMIT 1")
      .bind(siteId)
      .first<{ id: string }>();
    return Boolean(site?.id);
  }

  const site = await env.DB.prepare(
    `SELECT s.id
     FROM sites s
     INNER JOIN teams t ON t.id = s.team_id
     LEFT JOIN team_members tm ON tm.team_id = s.team_id AND tm.user_id = ?
     WHERE s.id = ? AND (t.owner_user_id = ? OR tm.user_id IS NOT NULL)
     LIMIT 1`,
  )
    .bind(session.userId, siteId, session.userId)
    .first<{ id: string }>();

  return Boolean(site?.id);
}

export async function handleAdminWs(
  request: Request,
  env: Env,
): Promise<Response> {
  const secret = await deriveSessionSecret(env);
  if (!secret) {
    return new Response("Service unavailable", { status: 503 });
  }

  const token = extractSessionToken(request);
  const session = await verifySessionToken(token, secret);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const incomingUrl = new URL(request.url);
  const siteId = incomingUrl.searchParams.get("siteId");
  if (!siteId) {
    return new Response("siteId is required", { status: 400 });
  }

  const allowed = await canSessionReadSite(env, session, siteId);
  if (!allowed) {
    return new Response("Forbidden", { status: 403 });
  }

  const doId = env.INGEST_DO.idFromName(siteId);
  const stub = env.INGEST_DO.get(doId);
  const forwardUrl = "https://ingest.internal/ws" + incomingUrl.search;
  return stub.fetch(new Request(forwardUrl, request));
}
