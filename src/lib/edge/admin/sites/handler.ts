import { BlockingRulesValidationError } from "@/lib/blocking";
import { createDatabaseRuntime } from "@/lib/db";
import {
  canManageSite,
  canManageTeam,
  canReadSite,
  canReadTeam,
  teamById,
  teamMembershipAccess,
  toSlug,
} from "@/lib/edge/admin/access";
import { type Actor, requireActor } from "@/lib/edge/admin/auth";
import {
  bad,
  bool,
  forb,
  type JsonRecord,
  jsonResponseFor,
  na,
  nf,
  parseJson,
} from "@/lib/edge/admin/response";
import { SITE_PK_FROM_SITE_ID_SQL } from "@/lib/edge/sites/identity-sql";
import {
  deleteSiteScriptSettings,
  readSiteTrackingConfig,
  upsertSiteScriptSettings,
  upsertSiteTrackingConfig,
} from "@/lib/edge/sites/settings-store";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import { DEFAULT_SITE_SCRIPT_SETTINGS } from "@/lib/site-settings";
export async function ensurePublicSlugAvailable(
  env: Env,
  slug: string,
  excludeSiteId?: string,
): Promise<boolean> {
  const row = excludeSiteId
    ? await createDatabaseRuntime(env.DB).first<{ ok: number }>({
        sql: "SELECT 1 AS ok FROM sites WHERE public_slug=? AND id<>? LIMIT 1",
        bindings: [slug, excludeSiteId],
        tag: "admin.sites.first",
      })
    : await createDatabaseRuntime(env.DB).first<{ ok: number }>({
        sql: "SELECT 1 AS ok FROM sites WHERE public_slug=? LIMIT 1",
        bindings: [slug],
        tag: "admin.sites.first",
      });
  return !row?.ok;
}
export async function createSiteWithDefaultSettings(
  env: Env,
  input: {
    teamId: string;
    name: string;
    domain: string;
    publicEnabled: boolean;
    publicSlug: string | null;
  },
): Promise<string> {
  const siteId = crypto.randomUUID();
  await createDatabaseRuntime(env.DB).run({
    sql: "INSERT INTO sites (id,team_id,name,domain,public_enabled,public_slug,created_at,updated_at) VALUES (?,?,?,?,?,?,unixepoch(),unixepoch())",
    bindings: [
      siteId,
      input.teamId,
      input.name,
      input.domain,
      input.publicEnabled ? 1 : 0,
      input.publicEnabled ? input.publicSlug : null,
    ],
    tag: "admin.sites.insert",
  });
  try {
    await upsertSiteScriptSettings(env, siteId, {
      siteDomain: input.domain,
      settings: DEFAULT_SITE_SCRIPT_SETTINGS,
    });
  } catch (error) {
    await createDatabaseRuntime(env.DB).run({
      sql: "DELETE FROM sites WHERE id=?",
      bindings: [siteId],
      tag: "admin.sites.compensate_insert",
    });
    throw error;
  }
  return siteId;
}
async function filterReadableSitesForActor<T extends { id: string }>(
  env: Env,
  actor: Actor,
  teamId: string,
  sites: T[],
): Promise<T[]> {
  if (actor.isAdmin) return sites;
  const team = await teamById(env, teamId);
  if (team?.ownerUserId === actor.user.id) return sites;
  const membership = await teamMembershipAccess(env, teamId, actor.user.id);
  if (!membership) return [];
  if (membership.role === "owner" || membership.role === "admin") return sites;
  if (membership.siteIds.length === 0) return sites;
  const allowed = new Set(membership.siteIds);
  return sites.filter((site) => allowed.has(site.id));
}
export async function deleteSiteData(env: Env, siteId: string): Promise<void> {
  await createDatabaseRuntime(env.DB).run({
    sql: "DELETE FROM configs WHERE config_key=?",
    bindings: [`site:${siteId}`],
    tag: "admin.sites.delete_config",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM custom_event_json_values WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL}`,
    bindings: [siteId],
    tag: "admin.sites.delete_custom_event_json_values",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM custom_event_json_nodes WHERE event_pk IN (SELECT event_pk FROM custom_events WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL})`,
    bindings: [siteId],
    tag: "admin.sites.delete_custom_event_json_nodes",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM custom_events WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL}`,
    bindings: [siteId],
    tag: "admin.sites.delete_custom_events",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM custom_event_names WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL}`,
    bindings: [siteId],
    tag: "admin.sites.delete_custom_event_names",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM custom_event_json_keys WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL}`,
    bindings: [siteId],
    tag: "admin.sites.delete_custom_event_json_keys",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM custom_event_json_paths WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL}`,
    bindings: [siteId],
    tag: "admin.sites.delete_custom_event_json_paths",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM visits WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL}`,
    bindings: [siteId],
    tag: "admin.sites.delete_visits",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM visit_hourly_rollups WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL}`,
    bindings: [siteId],
    tag: "admin.sites.delete_hourly_rollups",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: `DELETE FROM visit_hourly_aggregation_state WHERE site_pk=${SITE_PK_FROM_SITE_ID_SQL}`,
    bindings: [siteId],
    tag: "admin.sites.delete_hourly_aggregation_state",
  });
  await createDatabaseRuntime(env.DB).run({
    sql: "DELETE FROM sites WHERE id=?",
    bindings: [siteId],
    tag: "admin.sites.delete",
  });
  try {
    await deleteSiteScriptSettings(env, siteId);
  } catch {
    // Best effort cleanup for KV-backed settings.
  }
}
export async function handleSitesAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    const teamId = clampString(url.searchParams.get("teamId") || "", 120);
    if (!teamId) return bad("Missing teamId", undefined, req);
    if (!(await canReadTeam(env, a, teamId)))
      return forb("Team access denied", undefined, req);
    const rows = await createDatabaseRuntime(env.DB).all<{
      id: string;
      teamId: string;
      name: string;
      domain: string;
      publicEnabled: number;
      publicSlug: string | null;
      createdAt: number;
      updatedAt: number;
    }>({
      sql: "SELECT id,team_id AS teamId,name,domain,public_enabled AS publicEnabled,public_slug AS publicSlug,created_at AS createdAt,updated_at AS updatedAt FROM sites WHERE team_id=? ORDER BY created_at DESC",
      bindings: [teamId],
      tag: "admin.sites.all",
    });
    return jsonResponseFor(req, {
      ok: true,
      data: await filterReadableSitesForActor(env, a, teamId, rows.results),
    });
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const teamId = clampString(String(body.teamId || ""), 120);
    const name = clampString(String(body.name || ""), 120);
    const domain = clampString(String(body.domain || ""), 255);
    const pub = bool(body.publicEnabled, false);
    const pubSlug = clampString(
      String(body.publicSlug || toSlug(name || domain || `site-${Date.now()}`)),
      120,
    );
    if (!teamId || !name || !domain)
      return bad("teamId, name and domain are required", undefined, req);
    if (!(await canManageTeam(env, a, teamId)))
      return forb("Only team owner can create sites", undefined, req);
    if (pub && pubSlug && !(await ensurePublicSlugAvailable(env, pubSlug))) {
      return bad("Public slug already exists", undefined, req);
    }
    const siteId = await createSiteWithDefaultSettings(env, {
      teamId,
      name,
      domain,
      publicEnabled: pub,
      publicSlug: pub ? pubSlug : null,
    });
    return jsonResponseFor(req, {
      ok: true,
      data: {
        id: siteId,
        teamId,
        name,
        domain,
        publicEnabled: pub,
        publicSlug: pub ? pubSlug : "",
      },
    });
  }
  if (req.method === "PATCH") {
    const body = await parseJson(req);
    const siteId = clampString(String(body.siteId || ""), 120);
    const intent = clampString(String(body.intent || ""), 20);
    if (!siteId) return bad("siteId is required", undefined, req);
    const e = await createDatabaseRuntime(env.DB).first<{
      id: string;
      teamId: string;
      name: string;
      domain: string;
      publicEnabled: number;
      publicSlug: string | null;
    }>({
      sql: "SELECT id,team_id AS teamId,name,domain,public_enabled AS publicEnabled,public_slug AS publicSlug FROM sites WHERE id=? LIMIT 1",
      bindings: [siteId],
      tag: "admin.sites.first",
    });
    if (!e) return nf("Site not found", undefined, req);
    if (!(await canManageTeam(env, a, e.teamId)))
      return forb("Only team owner can update sites", undefined, req);
    if (intent === "remove") {
      await deleteSiteData(env, siteId);
      return jsonResponseFor(req, {
        ok: true,
        data: { siteId, teamId: e.teamId, removed: true },
      });
    }
    const nextTeamId = clampString(String(body.teamId ?? e.teamId), 120);
    if (!nextTeamId) return bad("teamId is required", undefined, req);
    if (nextTeamId !== e.teamId && !(await canManageTeam(env, a, nextTeamId))) {
      return forb("Only team owner can transfer sites", undefined, req);
    }
    const name = clampString(String(body.name ?? e.name), 120);
    const domain = clampString(String(body.domain ?? e.domain), 255);
    const pub = bool(body.publicEnabled, e.publicEnabled === 1);
    const pubSlug = clampString(
      String(body.publicSlug ?? e.publicSlug ?? toSlug(name || domain)),
      120,
    );
    if (pub && pubSlug) {
      const available = await ensurePublicSlugAvailable(env, pubSlug, siteId);
      if (!available) return bad("Public slug already exists", undefined, req);
    }
    await createDatabaseRuntime(env.DB).run({
      sql: "UPDATE sites SET team_id=?,name=?,domain=?,public_enabled=?,public_slug=?,updated_at=unixepoch() WHERE id=?",
      bindings: [
        nextTeamId,
        name,
        domain,
        pub ? 1 : 0,
        pub ? pubSlug : null,
        siteId,
      ],
      tag: "admin.sites.update",
    });
    await upsertSiteScriptSettings(env, siteId, {
      siteDomain: domain,
    });
    return jsonResponseFor(req, {
      ok: true,
      data: {
        id: siteId,
        teamId: nextTeamId,
        name,
        domain,
        publicEnabled: pub,
        publicSlug: pub ? pubSlug : "",
      },
    });
  }
  return na(req);
}
export async function handleSiteConfigAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (req.method === "GET") {
    const siteId = clampString(url.searchParams.get("siteId") || "", 120);
    if (!siteId) return bad("Missing siteId", undefined, req);
    if (!(await canReadSite(env, a, siteId)))
      return forb("Site access denied", undefined, req);
    try {
      const settings = await readSiteTrackingConfig(env, siteId);
      return jsonResponseFor(req, {
        ok: true,
        data: settings ?? {
          siteId,
          siteDomain: "",
          allowedHostnames: [],
          ...DEFAULT_SITE_SCRIPT_SETTINGS,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "load_site_config_failed";
      return jsonResponseFor(req, { ok: false, error: message }, 500);
    }
  }
  if (req.method === "POST") {
    const body = await parseJson(req);
    const siteId = clampString(String(body.siteId || ""), 120);
    if (!siteId) return bad("siteId is required", undefined, req);
    if (!(await canManageSite(env, a, siteId)))
      return forb("Only team owner can update site config", undefined, req);
    const cfg = (
      body.config && typeof body.config === "object" ? body.config : {}
    ) as JsonRecord;
    try {
      const site = await createDatabaseRuntime(env.DB).first<{
        domain: string;
      }>({
        sql: "SELECT domain FROM sites WHERE id=? LIMIT 1",
        bindings: [siteId],
        tag: "admin.sites.first",
      });
      if (!site?.domain) return nf("Site not found", undefined, req);
      const next = await upsertSiteTrackingConfig(env, siteId, {
        siteDomain: site.domain,
        settings: cfg,
        ...(body.blockingPatch !== undefined
          ? { blockingPatch: body.blockingPatch }
          : {}),
      });
      return jsonResponseFor(req, { ok: true, data: next });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "save_site_config_failed";
      return jsonResponseFor(
        req,
        { ok: false, error: message },
        error instanceof BlockingRulesValidationError ? 422 : 500,
      );
    }
  }
  return na(req);
}
export async function handleScriptSnippetAdmin(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (req.method !== "GET") return na(req);
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  const siteId = clampString(url.searchParams.get("siteId") || "", 120);
  if (!siteId) return bad("Missing siteId", undefined, req);
  if (!(await canReadSite(env, a, siteId)))
    return forb("Site access denied", undefined, req);
  const edgeBase = `${url.protocol}//${url.host}`;
  const src = `${edgeBase.replace(/\/$/, "")}/script.js?siteId=${encodeURIComponent(siteId)}`;
  return jsonResponseFor(req, {
    ok: true,
    data: { siteId, src, snippet: `<script defer src="${src}"></script>` },
  });
}
