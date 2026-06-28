import { toTeamRole } from "@/lib/dashboard/permissions";
import { handlePrivateAdmin } from "@/lib/edge/admin";
import { bad, jsonResponseFor } from "@/lib/edge/admin-response";
import type { Env } from "@/lib/edge/types";
import { requireSameOrigin } from "@/lib/edge/utils";
import {
  assertContentSize,
  BODY_SIZE_LIMITS,
  bodyStr,
  parseFormBool,
  parseRequestBody,
} from "@/lib/form-helpers";
import { errorResponse, normalizeErrorMessage } from "@/lib/response";

type AdminMethod = "POST" | "PATCH";

async function callPrivateAdmin<T>(
  request: Request,
  env: Env,
  pathname: string,
  method: AdminMethod,
  body: Record<string, unknown>,
  legacyErrorCode: string,
): Promise<T | Response> {
  const url = new URL(pathname, request.url);
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  const subRequest = new Request(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const response = await handlePrivateAdmin(subRequest, env, url);
  const text = await response.text();
  if (!response.ok) {
    return errorResponse(
      request,
      500,
      legacyErrorCode,
      normalizeErrorMessage(text),
    );
  }
  try {
    const payload = JSON.parse(text) as { data?: T };
    return payload.data as T;
  } catch {
    return errorResponse(
      request,
      500,
      legacyErrorCode,
      "Private admin response payload is invalid JSON",
    );
  }
}

async function parseLegacyAdminBody(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const sizeError = assertContentSize(request, BODY_SIZE_LIMITS.ADMIN_API);
  if (sizeError) return sizeError;

  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;

  return parseRequestBody(request);
}

function buildLegacyConfig(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    privacy: {
      maskQueryHashDetails: parseFormBool(body.maskQueryHashDetails, true),
      maskVisitorTrajectory: parseFormBool(body.maskVisitorTrajectory, true),
      maskDetailedReferrerUrl: parseFormBool(
        body.maskDetailedReferrerUrl,
        true,
      ),
    },
  };
}

export async function handleLegacyAdminUser(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseLegacyAdminBody(request);
  if (body instanceof Response) return body;
  const intent = bodyStr(body, "intent") || "create";

  if (intent === "remove" || intent === "delete") {
    const userId = bodyStr(body, "userId");
    if (!userId) return bad("Missing user ID", "missing_user_id", request);
    const result = await callPrivateAdmin(
      request,
      env,
      "/api/private/admin/users",
      "PATCH",
      { userId, intent: "remove" },
      "user_mutation_failed",
    );
    return result instanceof Response
      ? result
      : jsonResponseFor(request, { ok: true, data: result });
  }

  if (intent === "update") {
    const userId = bodyStr(body, "userId");
    if (!userId) return bad("Missing user ID", "missing_user_id", request);
    const result = await callPrivateAdmin(
      request,
      env,
      "/api/private/admin/users",
      "PATCH",
      {
        userId,
        username: bodyStr(body, "username") || undefined,
        email: bodyStr(body, "email") || undefined,
        name: bodyStr(body, "name") || undefined,
        password: bodyStr(body, "password") || undefined,
        systemRole:
          bodyStr(body, "systemRole").toLowerCase() === "admin"
            ? "admin"
            : "user",
      },
      "user_mutation_failed",
    );
    return result instanceof Response
      ? result
      : jsonResponseFor(request, { ok: true, data: result });
  }

  const username = bodyStr(body, "username");
  const email = bodyStr(body, "email");
  const password = String(body.password ?? "");
  const name = bodyStr(body, "name");
  const systemRole =
    bodyStr(body, "systemRole").toLowerCase() === "admin" ? "admin" : "user";
  if (!username || !email || password.length < 8) {
    return bad("Invalid user input", "invalid_user_input", request);
  }

  const result = await callPrivateAdmin(
    request,
    env,
    "/api/private/admin/users",
    "POST",
    { username, email, password, name: name || undefined, systemRole },
    "user_mutation_failed",
  );
  return result instanceof Response
    ? result
    : jsonResponseFor(request, { ok: true, data: result });
}

export async function handleLegacyAdminTeam(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseLegacyAdminBody(request);
  if (body instanceof Response) return body;
  const intent = bodyStr(body, "intent");
  const teamId = bodyStr(body, "teamId");
  const name = bodyStr(body, "name");
  const slug = bodyStr(body, "slug");

  if (intent === "transfer_owner") {
    const newOwnerUserId = bodyStr(body, "newOwnerUserId");
    if (!teamId || !newOwnerUserId) {
      return bad("Missing transfer input", "missing_transfer_input", request);
    }
    const result = await callPrivateAdmin(
      request,
      env,
      "/api/private/admin/teams",
      "PATCH",
      { teamId, newOwnerUserId, intent: "transfer_owner" },
      "transfer_team_failed",
    );
    return result instanceof Response
      ? result
      : jsonResponseFor(request, { ok: true, data: result });
  }

  if (intent === "remove" || intent === "delete") {
    if (!teamId) return bad("Missing team ID", "missing_team_id", request);
    const result = await callPrivateAdmin(
      request,
      env,
      "/api/private/admin/teams",
      "PATCH",
      { teamId, intent: "remove" },
      "remove_team_failed",
    );
    return result instanceof Response
      ? result
      : jsonResponseFor(request, { ok: true, data: result });
  }

  if (name.length < 2) {
    return bad("Invalid team name", "invalid_team_name", request);
  }
  const result = await callPrivateAdmin(
    request,
    env,
    "/api/private/admin/teams",
    teamId ? "PATCH" : "POST",
    teamId ? { teamId, name, slug: slug || undefined } : { name, slug },
    teamId ? "update_team_failed" : "create_team_failed",
  );
  return result instanceof Response
    ? result
    : jsonResponseFor(request, { ok: true, data: result });
}

export async function handleLegacyAdminSite(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseLegacyAdminBody(request);
  if (body instanceof Response) return body;
  const intent = bodyStr(body, "intent") || "create";
  const teamId = bodyStr(body, "teamId");
  const siteId = bodyStr(body, "siteId");
  const name = bodyStr(body, "name");
  const domain = bodyStr(body, "domain");
  const publicEnabled = parseFormBool(body.publicEnabled);
  const publicSlug = bodyStr(body, "publicSlug");

  if (intent === "remove") {
    if (!siteId) return bad("Missing site ID", "missing_site_id", request);
    const result = await callPrivateAdmin(
      request,
      env,
      "/api/private/admin/sites",
      "PATCH",
      { siteId, intent: "remove" },
      "site_mutation_failed",
    );
    return result instanceof Response
      ? result
      : jsonResponseFor(request, { ok: true, data: result });
  }

  if (intent === "update") {
    if (!siteId) return bad("Missing site ID", "missing_site_id", request);
    const result = await callPrivateAdmin(
      request,
      env,
      "/api/private/admin/sites",
      "PATCH",
      {
        siteId,
        teamId: teamId || undefined,
        name: name || undefined,
        domain: domain || undefined,
        publicEnabled,
        publicSlug: publicSlug || undefined,
      },
      "site_mutation_failed",
    );
    return result instanceof Response
      ? result
      : jsonResponseFor(request, { ok: true, data: result });
  }

  if (!teamId || !name || !domain) {
    return bad("Invalid site input", "invalid_site_input", request);
  }
  const result = await callPrivateAdmin(
    request,
    env,
    "/api/private/admin/sites",
    "POST",
    {
      teamId,
      name,
      domain,
      publicEnabled,
      publicSlug: publicSlug || undefined,
    },
    "site_mutation_failed",
  );
  return result instanceof Response
    ? result
    : jsonResponseFor(request, { ok: true, data: result });
}

export async function handleLegacyAdminMember(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseLegacyAdminBody(request);
  if (body instanceof Response) return body;
  const intent = bodyStr(body, "intent") || "add";
  const teamId = bodyStr(body, "teamId");

  if (intent === "remove") {
    const userId = bodyStr(body, "userId");
    if (!teamId || !userId) {
      return bad(
        "Invalid member remove input",
        "invalid_member_remove_input",
        request,
      );
    }
    const result = await callPrivateAdmin(
      request,
      env,
      "/api/private/admin/members",
      "PATCH",
      { teamId, userId },
      "remove_member_failed",
    );
    return result instanceof Response
      ? result
      : jsonResponseFor(request, { ok: true, data: result });
  }

  if (intent === "update_role") {
    const userId = bodyStr(body, "userId");
    const role = toTeamRole(bodyStr(body, "role"));
    if (!teamId || !userId || role === "owner") {
      return bad(
        "Invalid member role input",
        "invalid_member_role_input",
        request,
      );
    }
    const result = await callPrivateAdmin(
      request,
      env,
      "/api/private/admin/members",
      "PATCH",
      { teamId, userId, role, intent: "update_role" },
      "update_member_role_failed",
    );
    return result instanceof Response
      ? result
      : jsonResponseFor(request, { ok: true, data: result });
  }

  const identifier = bodyStr(body, "identifier");
  if (!teamId || identifier.length < 2) {
    return bad("Invalid member input", "invalid_member_input", request);
  }

  const requestedRoleRaw = bodyStr(body, "role");
  const requestedRole = requestedRoleRaw ? toTeamRole(requestedRoleRaw) : null;
  if (requestedRole === "owner") {
    return bad("Cannot assign owner role", "invalid_member_input", request);
  }

  const result = await callPrivateAdmin(
    request,
    env,
    "/api/private/admin/members",
    "POST",
    requestedRole
      ? { teamId, identifier, role: requestedRole }
      : { teamId, identifier },
    "add_member_failed",
  );
  return result instanceof Response
    ? result
    : jsonResponseFor(request, { ok: true, data: result });
}

export async function handleLegacyAdminSiteConfig(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseLegacyAdminBody(request);
  if (body instanceof Response) return body;
  const siteId = bodyStr(body, "siteId");
  if (!siteId) return bad("Missing site ID", "missing_site_id", request);

  const config =
    body.config && typeof body.config === "object"
      ? (body.config as Record<string, unknown>)
      : buildLegacyConfig(body);
  const result = await callPrivateAdmin(
    request,
    env,
    "/api/private/admin/site-config",
    "POST",
    { siteId, config },
    "save_site_config_failed",
  );
  return result instanceof Response
    ? result
    : jsonResponseFor(request, { ok: true, data: result });
}

export async function handleLegacyAdminProfile(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseLegacyAdminBody(request);
  if (body instanceof Response) return body;
  const hasTimeZone = Object.prototype.hasOwnProperty.call(body, "timeZone");
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const result = await callPrivateAdmin(
    request,
    env,
    "/api/private/admin/profile",
    "POST",
    {
      username: bodyStr(body, "username") || undefined,
      email: bodyStr(body, "email") || undefined,
      name: hasName ? bodyStr(body, "name") : undefined,
      currentPassword: bodyStr(body, "currentPassword") || undefined,
      password: bodyStr(body, "password") || undefined,
      ...(hasTimeZone ? { timeZone: bodyStr(body, "timeZone") } : {}),
    },
    "profile_update_failed",
  );
  return result instanceof Response
    ? result
    : jsonResponseFor(request, { ok: true, data: result });
}
