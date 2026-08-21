import type { ApiV1CoreRouteId } from "@/lib/api-v1/core-registry";
import { TokenCheckSchema } from "@/lib/api-v1/core-registry";
import { epochSecondsToIso } from "@/lib/api-v1/normalization";
import {
  API_V1_VERSION,
  BATCH_MAX_REQUESTS,
  jsonError,
  jsonSuccess,
  methodNotAllowed,
} from "@/lib/api-v1/wire-helpers";
import {
  type ApiKeyPrincipal,
  canAccessSiteId,
  hasFullSiteAccess,
} from "@/lib/edge/api-key-auth";
import type { Env } from "@/lib/edge/types";

export interface CoreDispatchInput {
  readonly routeId: ApiV1CoreRouteId;
  readonly request: Request;
  readonly env: Env;
  readonly principal?: ApiKeyPrincipal;
}

interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

async function teamByPrincipal(
  env: Env,
  principal: ApiKeyPrincipal,
): Promise<TeamRow> {
  const row = await env.DB.prepare(
    `
      SELECT id, name, created_at AS createdAt
      FROM teams
      WHERE id=?
      LIMIT 1
    `,
  )
    .bind(principal.teamId)
    .first<TeamRow>();
  return (
    row ?? {
      id: principal.teamId,
      name: principal.teamId,
      createdAt: principal.createdAt ?? 0,
    }
  );
}

async function visibleSiteCount(
  env: Env,
  principal: ApiKeyPrincipal,
): Promise<number> {
  const rows = await env.DB.prepare("SELECT id FROM sites WHERE team_id=?")
    .bind(principal.teamId)
    .all<{ id: string }>();
  if (hasFullSiteAccess(principal)) return rows.results.length;
  return rows.results.filter((site) => canAccessSiteId(principal, site.id))
    .length;
}

function rootResponse(request: Request): Response {
  if (request.method !== "GET") return methodNotAllowed(request, "GET");
  return jsonSuccess(
    {
      version: API_V1_VERSION,
      service: "insightflare",
      links: {
        openapi: "/.well-known/openapi.json",
        skills: "/.well-known/skills.json",
        token: "/api/v1/token",
        capabilities: "/api/v1/capabilities",
        team: "/api/v1/team",
        sites: "/api/v1/sites",
        batch: "/api/v1/batch",
      },
    },
    { request },
  );
}

async function tokenCheckResponse(
  request: Request,
  principal: ApiKeyPrincipal,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, "POST");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(
      "invalid_json",
      "Invalid JSON body",
      400,
      undefined,
      request,
    );
  }
  const parsed = TokenCheckSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    return jsonError(
      "validation_failed",
      message || "Validation failed",
      400,
      { issues: parsed.error.issues },
      request,
    );
  }
  const active = (principal.status ?? "active") === "active";
  return jsonSuccess(
    {
      checks: parsed.data.checks.map((check) => {
        const hasScope = principal.scopes.includes(check.scope as never);
        const hasSite =
          !check.siteId || canAccessSiteId(principal, check.siteId);
        return {
          scope: check.scope,
          ...(check.siteId ? { siteId: check.siteId } : {}),
          allowed: hasScope && hasSite && active,
          ...(!hasScope
            ? { reason: "missing_scope" as const }
            : !hasSite
              ? { reason: "site_not_allowed" as const }
              : !active
                ? { reason: "token_inactive" as const }
                : {}),
        };
      }),
    },
    { request },
  );
}

/** Typed implementation for discovery, token, and team API v1 routes. */
export async function dispatchApiV1CoreRoute(
  input: CoreDispatchInput,
): Promise<Response> {
  const { request, env, routeId, principal } = input;
  if (routeId === "core.root") return rootResponse(request);
  if (!principal)
    throw new Error(`${routeId} requires an authenticated principal`);

  if (routeId === "core.token.check")
    return tokenCheckResponse(request, principal);
  if (request.method !== "GET") return methodNotAllowed(request, "GET");

  if (routeId === "core.token.get") {
    const team = await teamByPrincipal(env, principal);
    return jsonSuccess(
      {
        id: principal.keyId,
        name: principal.name ?? "",
        status: principal.status ?? "active",
        createdAt: epochSecondsToIso(principal.createdAt),
        expiresAt: epochSecondsToIso(principal.expiresAt),
        lastUsedAt: epochSecondsToIso(principal.lastUsedAt),
        team: { id: team.id, name: team.name },
        scopes: principal.scopes,
        siteAccess: {
          mode: hasFullSiteAccess(principal) ? "all" : "restricted",
          siteIds: principal.siteIds,
        },
      },
      { request },
    );
  }

  if (routeId === "core.capabilities") {
    const has = (scope: string) => principal.scopes.includes(scope as never);
    return jsonSuccess(
      {
        apiVersion: API_V1_VERSION,
        features: {
          sites: has("site:read") || has("site:write"),
          tracking: has("site_config:read") || has("site_config:write"),
          privacy: has("site_config:read") || has("site_config:write"),
          sharing: has("site_config:read") || has("site_config:write"),
          analytics: has("analytics:read"),
          events: has("analytics:read"),
          visitors: has("analytics:read"),
          sessions: has("analytics:read"),
          funnels: has("analytics:read"),
          performance: has("analytics:read"),
          realtime: has("analytics:read"),
          exports: false,
          batch: true,
        },
        limits: {
          batchMaxRequests: BATCH_MAX_REQUESTS,
          defaultTimeRangeDays: 7,
          maxTimeRangeDays: 365,
          defaultPageLimit: 100,
          maxPageLimit: 1000,
        },
        links: {
          token: "/api/v1/token",
          sites: "/api/v1/sites",
          batch: "/api/v1/batch",
        },
      },
      { request },
    );
  }

  if (routeId === "core.team.get") {
    const team = await teamByPrincipal(env, principal);
    return jsonSuccess(
      {
        id: team.id,
        name: team.name,
        createdAt: epochSecondsToIso(team.createdAt),
        links: {
          usage: "/api/v1/team/usage",
          sites: "/api/v1/sites",
          analyticsOverview: "/api/v1/team/analytics/overview",
        },
      },
      { request },
    );
  }

  return jsonSuccess(
    { sites: await visibleSiteCount(env, principal) },
    { request },
  );
}
