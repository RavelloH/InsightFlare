import { Hono } from "hono";

import { queryWidgetData } from "@/lib/edge/analytics/interfaces/dashboard/widget-query";
import type { EdgeSessionClaims } from "@/lib/edge/auth/session-auth";
import { resolvePrivateTeamForSession } from "@/lib/edge/auth/site-access";
import type { Env } from "@/lib/edge/types";
import { checkOriginOrReferer } from "@/lib/hono/middleware/public-api-gate";
import type { AppEnv } from "@/lib/hono/types";
import { bad, forb, jsonResponseFor, nf } from "@/lib/response";
import type { WidgetConfig } from "@/lib/widgets/contract";
import { widgetConfigSchema, widgetUuidSchema } from "@/lib/widgets/contract";
import {
  createWidget,
  deleteWidget,
  listTeamWidgets,
  publishWidget,
  readWidget,
  unpublishWidget,
  updateWidgetDraft,
  WidgetConflictError,
  widgetSiteBelongsToTeam,
  WidgetStorageUnavailableError,
} from "@/lib/widgets/store";

export const privateWidgetRoutes = new Hono<AppEnv>();

// UI Demo has synthetic sites and no KV/D1 widget bindings.
// Keep demo writes inside an ephemeral store instead of contacting real storage.
const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";
privateWidgetRoutes.use("/*", async (c, next) => {
  if (isDemoBuild) {
    const { handleDemoWidgetApi } = await import("@/lib/demo/widgets");
    return handleDemoWidgetApi(c.req.raw);
  }
  await next();
});

function responseError(request: Request, error: unknown): Response {
  if (error instanceof WidgetStorageUnavailableError) {
    return jsonResponseFor(
      request,
      {
        ok: false,
        error: {
          code: "widget_storage_unavailable",
          message: "Widget storage is unavailable",
        },
      },
      503,
    );
  }
  if (error instanceof WidgetConflictError) {
    return bad(
      "Widget identifier is already in use",
      "widget_conflict",
      request,
    );
  }
  throw error;
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function authorizeTeamManager(
  request: Request,
  env: Env,
  session: EdgeSessionClaims | undefined,
  teamId: string,
): Promise<Response | null> {
  if (!session) return nf("Team not found", "team_not_found", request);
  const url = new URL(request.url);
  url.searchParams.set("teamId", teamId);
  const team = await resolvePrivateTeamForSession(request, env, url, session);
  if (team instanceof Response) return team;
  if (team.allowedSiteIds !== undefined) {
    return forb(
      "Only team owners and admins can manage widgets",
      "team_management_required",
      request,
    );
  }
  return null;
}

function validTeamId(value: string | undefined): string | null {
  const teamId = value?.trim() ?? "";
  return teamId.length > 0 && teamId.length <= 120 ? teamId : null;
}

function validUuid(value: string | undefined): string | null {
  const parsed = widgetUuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function authorizeSite(
  env: Env,
  teamId: string,
  siteId: unknown,
): Promise<string | null> {
  if (typeof siteId !== "string" || !siteId.trim() || siteId.length > 120) {
    return null;
  }
  return (await widgetSiteBelongsToTeam(env, teamId, siteId)) ? siteId : null;
}

function sameOriginMutation(request: Request): Response | null {
  return checkOriginOrReferer(request)
    ? null
    : forb("Same-origin request required", "same_origin_required", request);
}

privateWidgetRoutes.get("/teams/:teamId", async (c) => {
  const teamId = validTeamId(c.req.param("teamId"));
  if (!teamId) return bad("teamId is invalid", "invalid_team_id", c.req.raw);
  const denied = await authorizeTeamManager(
    c.req.raw,
    c.env,
    c.get("session"),
    teamId,
  );
  if (denied) return denied;
  try {
    const result = await listTeamWidgets(c.env, teamId, c.req.query("cursor"));
    return jsonResponseFor(c.req.raw, { ok: true, ...result });
  } catch (error) {
    return responseError(c.req.raw, error);
  }
});

privateWidgetRoutes.post("/teams/:teamId/preview", async (c) => {
  const originError = sameOriginMutation(c.req.raw);
  if (originError) return originError;
  const teamId = validTeamId(c.req.param("teamId"));
  if (!teamId) return bad("teamId is invalid", "invalid_team_id", c.req.raw);
  const denied = await authorizeTeamManager(
    c.req.raw,
    c.env,
    c.get("session"),
    teamId,
  );
  if (denied) return denied;
  const body = await readJsonObject(c.req.raw);
  if (!body) return bad("JSON object required", "invalid_json_body", c.req.raw);
  const config = widgetConfigSchema.safeParse(body.config);
  if (!config.success)
    return bad("config is invalid", "invalid_widget_config", c.req.raw);
  const siteId = await authorizeSite(c.env, teamId, body.siteId);
  if (!siteId) return nf("Site not found", "site_not_found", c.req.raw);
  try {
    const data = await queryWidgetData(c.env, siteId, config.data);
    return jsonResponseFor(c.req.raw, { ok: true, data });
  } catch {
    return jsonResponseFor(
      c.req.raw,
      {
        ok: false,
        error: {
          code: "widget_preview_failed",
          message: "Widget preview failed",
        },
      },
      503,
    );
  }
});

privateWidgetRoutes.post("/teams/:teamId", async (c) => {
  const originError = sameOriginMutation(c.req.raw);
  if (originError) return originError;
  const teamId = validTeamId(c.req.param("teamId"));
  if (!teamId) return bad("teamId is invalid", "invalid_team_id", c.req.raw);
  const denied = await authorizeTeamManager(
    c.req.raw,
    c.env,
    c.get("session"),
    teamId,
  );
  if (denied) return denied;
  const body = await readJsonObject(c.req.raw);
  if (!body) return bad("JSON object required", "invalid_json_body", c.req.raw);
  const uuid = validUuid(typeof body.uuid === "string" ? body.uuid : undefined);
  if (!uuid) return bad("uuid is invalid", "invalid_widget_uuid", c.req.raw);
  const config = widgetConfigSchema.safeParse(body.config);
  if (!config.success)
    return bad("config is invalid", "invalid_widget_config", c.req.raw);
  if (body.publish !== undefined && typeof body.publish !== "boolean") {
    return bad("publish is invalid", "invalid_publish_state", c.req.raw);
  }
  const siteId = await authorizeSite(c.env, teamId, body.siteId);
  if (!siteId) return nf("Site not found", "site_not_found", c.req.raw);
  try {
    const data = await createWidget(c.env, {
      uuid,
      teamId,
      siteId,
      config: config.data,
      publish: body.publish === true,
    });
    return jsonResponseFor(c.req.raw, { ok: true, data }, 201);
  } catch (error) {
    return responseError(c.req.raw, error);
  }
});

privateWidgetRoutes.put("/teams/:teamId/:uuid", async (c) => {
  const originError = sameOriginMutation(c.req.raw);
  if (originError) return originError;
  const teamId = validTeamId(c.req.param("teamId"));
  const uuid = validUuid(c.req.param("uuid"));
  if (!teamId) return bad("teamId is invalid", "invalid_team_id", c.req.raw);
  if (!uuid) return nf("Widget not found", "widget_not_found", c.req.raw);
  const denied = await authorizeTeamManager(
    c.req.raw,
    c.env,
    c.get("session"),
    teamId,
  );
  if (denied) return denied;
  const body = await readJsonObject(c.req.raw);
  if (!body) return bad("JSON object required", "invalid_json_body", c.req.raw);
  const config = widgetConfigSchema.safeParse(body.config);
  if (!config.success)
    return bad("config is invalid", "invalid_widget_config", c.req.raw);
  try {
    const current = await readWidget(c.env, uuid);
    if (!current || current.teamId !== teamId) {
      return nf("Widget not found", "widget_not_found", c.req.raw);
    }
    if (!(await widgetSiteBelongsToTeam(c.env, teamId, current.siteId))) {
      return nf("Widget not found", "widget_not_found", c.req.raw);
    }
    const data = await updateWidgetDraft(c.env, teamId, uuid, config.data);
    return data
      ? jsonResponseFor(c.req.raw, { ok: true, data })
      : nf("Widget not found", "widget_not_found", c.req.raw);
  } catch (error) {
    return responseError(c.req.raw, error);
  }
});

privateWidgetRoutes.post("/teams/:teamId/:uuid/publish", async (c) => {
  const originError = sameOriginMutation(c.req.raw);
  if (originError) return originError;
  const teamId = validTeamId(c.req.param("teamId"));
  const uuid = validUuid(c.req.param("uuid"));
  if (!teamId) return bad("teamId is invalid", "invalid_team_id", c.req.raw);
  if (!uuid) return nf("Widget not found", "widget_not_found", c.req.raw);
  const denied = await authorizeTeamManager(
    c.req.raw,
    c.env,
    c.get("session"),
    teamId,
  );
  if (denied) return denied;
  let publishedConfig: WidgetConfig | undefined;
  const bodyText = await c.req.text();
  if (bodyText.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      return bad("JSON object required", "invalid_json_body", c.req.raw);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return bad("JSON object required", "invalid_json_body", c.req.raw);
    }
    const object = body as Record<string, unknown>;
    const config = widgetConfigSchema.safeParse(object.config);
    if (!config.success)
      return bad("config is invalid", "invalid_widget_config", c.req.raw);
    publishedConfig = config.data;
  }
  try {
    const current = await readWidget(c.env, uuid);
    if (
      !current ||
      current.teamId !== teamId ||
      !(await widgetSiteBelongsToTeam(c.env, teamId, current.siteId))
    ) {
      return nf("Widget not found", "widget_not_found", c.req.raw);
    }
    const data = await publishWidget(c.env, teamId, uuid, publishedConfig);
    return data
      ? jsonResponseFor(c.req.raw, { ok: true, data })
      : nf("Widget not found", "widget_not_found", c.req.raw);
  } catch (error) {
    return responseError(c.req.raw, error);
  }
});

privateWidgetRoutes.post("/teams/:teamId/:uuid/unpublish", async (c) => {
  const originError = sameOriginMutation(c.req.raw);
  if (originError) return originError;
  const teamId = validTeamId(c.req.param("teamId"));
  const uuid = validUuid(c.req.param("uuid"));
  if (!teamId) return bad("teamId is invalid", "invalid_team_id", c.req.raw);
  if (!uuid) return nf("Widget not found", "widget_not_found", c.req.raw);
  const denied = await authorizeTeamManager(
    c.req.raw,
    c.env,
    c.get("session"),
    teamId,
  );
  if (denied) return denied;
  try {
    const current = await readWidget(c.env, uuid);
    if (
      !current ||
      current.teamId !== teamId ||
      !(await widgetSiteBelongsToTeam(c.env, teamId, current.siteId))
    ) {
      return nf("Widget not found", "widget_not_found", c.req.raw);
    }
    const data = await unpublishWidget(c.env, teamId, uuid);
    return data
      ? jsonResponseFor(c.req.raw, { ok: true, data })
      : nf("Widget not found", "widget_not_found", c.req.raw);
  } catch (error) {
    return responseError(c.req.raw, error);
  }
});

privateWidgetRoutes.delete("/teams/:teamId/:uuid", async (c) => {
  const originError = sameOriginMutation(c.req.raw);
  if (originError) return originError;
  const teamId = validTeamId(c.req.param("teamId"));
  const uuid = validUuid(c.req.param("uuid"));
  if (!teamId) return bad("teamId is invalid", "invalid_team_id", c.req.raw);
  if (!uuid) return nf("Widget not found", "widget_not_found", c.req.raw);
  const denied = await authorizeTeamManager(
    c.req.raw,
    c.env,
    c.get("session"),
    teamId,
  );
  if (denied) return denied;
  try {
    const current = await readWidget(c.env, uuid);
    if (current && current.teamId !== teamId) {
      return nf("Widget not found", "widget_not_found", c.req.raw);
    }
    await deleteWidget(c.env, teamId, uuid);
    return new Response(null, { status: 204 });
  } catch (error) {
    return responseError(c.req.raw, error);
  }
});

privateWidgetRoutes.all("/*", (c) => nf("Not found", "not_found", c.req.raw));
