import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  join,
  limit,
  param,
  project,
  scan,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import {
  canAccessMemberSite,
  parseMemberSiteIdsJson,
} from "@/lib/edge/auth/member-site-access";
import { appNow } from "@/lib/edge/runtime/e2e-clock";
import type { Env } from "@/lib/edge/types";
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
    if (Math.floor(appNow() / 1000) >= Number(exp)) return null;

    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}
async function deriveSessionSecret(env: Env): Promise<string | null> {
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
  const sites = scan(schema.sites);
  const matchingSites = filter(sites, eq(sites.columns.id, param(siteId)));
  const client = createD1DatabaseClient(env.DB);

  if (session.systemRole === "admin") {
    const site = await client.first(
      compileD1Query(
        limit(project(matchingSites, { id: matchingSites.columns.id }), 1),
        { tag: "admin.sites.first" },
      ),
    );
    return Boolean(site?.id);
  }

  const teams = scan(schema.teams);
  const members = scan(schema.team_members);
  const siteTeams = join(
    sites,
    teams,
    eq(sites.columns.team_id, teams.columns.id),
    "inner",
  );
  const siteTeamMembers = join(
    siteTeams,
    members,
    and(
      eq(siteTeams.columns.left_team_id, members.columns.team_id),
      eq(members.columns.user_id, param(session.userId)),
    ),
    "left",
  );
  const matchingPrivateSites = filter(
    siteTeamMembers,
    eq(siteTeamMembers.columns.left_left_id, param(siteId)),
  );
  const privateSiteQuery = limit(
    project(matchingPrivateSites, {
      id: matchingPrivateSites.columns.left_left_id,
      ownerUserId: matchingPrivateSites.columns.left_right_owner_user_id,
      role: matchingPrivateSites.columns.right_role,
      siteIdsJson: matchingPrivateSites.columns.right_site_ids_json,
    }),
    1,
  );
  const site = await client.first(
    compileD1Query(privateSiteQuery, { tag: "admin.sites.first" }),
  );

  if (!site?.id) return false;
  if (site.ownerUserId === session.userId) return true;
  if (site.role === "owner" || site.role === "admin") return true;
  if (!site.role) return false;
  return canAccessMemberSite(parseMemberSiteIdsJson(site.siteIdsJson), siteId);
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
