import type { z } from "zod";

import {
  type ApiV1ApplicationOperationId,
  CreateFunnelInputSchema,
  CreateSiteInputSchema,
  DeleteSiteInputSchema,
  GetFunnelInputSchema,
  GetSiteInputSchema,
  ListSitesInputSchema,
  SiteSettingsInputSchema,
  TrackingScriptInputSchema,
  UpdateFunnelInputSchema,
  UpdatePrivacySettingsInputSchema,
  UpdateSharingSettingsInputSchema,
  UpdateSiteInputSchema,
  UpdateTrackingSettingsInputSchema,
} from "@/lib/api-v1/application-registry";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { createResourceApplicationService } from "@/lib/api-v1/resource-application-service";
import {
  jsonError,
  jsonSuccess,
  methodNotAllowed,
} from "@/lib/api-v1/wire-helpers";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import { canAccessSiteId } from "@/lib/edge/api-key-auth";
import type { Env } from "@/lib/edge/types";

type ResourceRouteId =
  | "sites.list"
  | "sites.create"
  | "sites.get"
  | "sites.update"
  | "sites.delete"
  | "settings.tracking.get"
  | "settings.tracking.update"
  | "settings.privacy.get"
  | "settings.privacy.update"
  | "settings.sharing.get"
  | "settings.sharing.update"
  | "settings.trackingScript.get"
  | "funnels.list"
  | "funnels.create"
  | "funnels.get"
  | "funnels.update"
  | "funnels.delete";

interface ResourceRouteConfig {
  readonly operation: ResourceRouteId;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly scope:
    | "site:read"
    | "site:write"
    | "site_config:read"
    | "site_config:write"
    | "analysis:read"
    | "analysis:write";
  readonly schema: z.ZodType;
  readonly successStatus?: 200 | 201 | 204;
}

const routeConfigs: Record<ResourceRouteId, ResourceRouteConfig> = {
  "sites.list": {
    operation: "sites.list",
    method: "GET",
    scope: "site:read",
    schema: ListSitesInputSchema,
  },
  "sites.create": {
    operation: "sites.create",
    method: "POST",
    scope: "site:write",
    schema: CreateSiteInputSchema,
    successStatus: 201,
  },
  "sites.get": {
    operation: "sites.get",
    method: "GET",
    scope: "site:read",
    schema: GetSiteInputSchema,
  },
  "sites.update": {
    operation: "sites.update",
    method: "PATCH",
    scope: "site:write",
    schema: UpdateSiteInputSchema,
  },
  "sites.delete": {
    operation: "sites.delete",
    method: "DELETE",
    scope: "site:write",
    schema: DeleteSiteInputSchema,
    successStatus: 204,
  },
  "settings.tracking.get": {
    operation: "settings.tracking.get",
    method: "GET",
    scope: "site_config:read",
    schema: SiteSettingsInputSchema,
  },
  "settings.tracking.update": {
    operation: "settings.tracking.update",
    method: "PATCH",
    scope: "site_config:write",
    schema: UpdateTrackingSettingsInputSchema,
  },
  "settings.privacy.get": {
    operation: "settings.privacy.get",
    method: "GET",
    scope: "site_config:read",
    schema: SiteSettingsInputSchema,
  },
  "settings.privacy.update": {
    operation: "settings.privacy.update",
    method: "PATCH",
    scope: "site_config:write",
    schema: UpdatePrivacySettingsInputSchema,
  },
  "settings.sharing.get": {
    operation: "settings.sharing.get",
    method: "GET",
    scope: "site_config:read",
    schema: SiteSettingsInputSchema,
  },
  "settings.sharing.update": {
    operation: "settings.sharing.update",
    method: "PATCH",
    scope: "site_config:write",
    schema: UpdateSharingSettingsInputSchema,
  },
  "settings.trackingScript.get": {
    operation: "settings.trackingScript.get",
    method: "GET",
    scope: "site_config:read",
    schema: TrackingScriptInputSchema,
  },
  "funnels.list": {
    operation: "funnels.list",
    method: "GET",
    scope: "analysis:read",
    schema: SiteSettingsInputSchema,
  },
  "funnels.create": {
    operation: "funnels.create",
    method: "POST",
    scope: "analysis:write",
    schema: CreateFunnelInputSchema,
    successStatus: 201,
  },
  "funnels.get": {
    operation: "funnels.get",
    method: "GET",
    scope: "analysis:read",
    schema: GetFunnelInputSchema,
  },
  "funnels.update": {
    operation: "funnels.update",
    method: "PATCH",
    scope: "analysis:write",
    schema: UpdateFunnelInputSchema,
  },
  "funnels.delete": {
    operation: "funnels.delete",
    method: "DELETE",
    scope: "analysis:write",
    schema: GetFunnelInputSchema,
    successStatus: 204,
  },
};

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  return (
    !accept ||
    accept.split(",").some((part) => {
      const type = part.split(";", 1)[0]?.trim().toLowerCase();
      return (
        type === "application/json" ||
        type === "application/*" ||
        type === "*/*"
      );
    })
  );
}

function error(
  request: Request,
  code:
    | "validation_failed"
    | "payload_too_large"
    | "resource_not_found"
    | "missing_scope"
    | "unsupported_media_type"
    | "not_acceptable"
    | "internal_error"
    | "conflict",
): Response {
  const map = {
    validation_failed: [400, "Request validation failed"],
    payload_too_large: [
      413,
      "The request payload exceeds the configured size limit",
    ],
    resource_not_found: [404, "Resource not found"],
    missing_scope: [403, "The API key lacks the required scope"],
    unsupported_media_type: [415, "Expected application/json"],
    not_acceptable: [406, "Only application/json is supported"],
    internal_error: [500, "An internal error occurred"],
    conflict: [409, "The resource conflicts with an existing resource"],
  } as const;
  const [status, message] = map[code];
  return jsonError(code, message, status, undefined, request);
}

/** Strict HTTP adapter for typed non-analytics API v1 resources. */
export async function handlePlannedResourceRoute(input: {
  readonly request: Request;
  readonly env: Env;
  readonly principal: ApiKeyPrincipal;
  readonly routeId: ResourceRouteId;
  readonly siteId?: string;
  readonly funnelId?: string;
  readonly allow?: string;
}): Promise<Response> {
  const config = routeConfigs[input.routeId];
  const { request, principal } = input;
  if (request.method !== config.method) {
    return methodNotAllowed(request, input.allow ?? config.method);
  }
  if (request.headers.has("content-encoding")) {
    return error(request, "unsupported_media_type");
  }
  if (!principal.scopes.includes(config.scope))
    return error(request, "missing_scope");
  if (input.siteId && !canAccessSiteId(principal, input.siteId))
    return error(request, "resource_not_found");
  if (!acceptsJson(request)) return error(request, "not_acceptable");
  if (config.method !== "GET" && config.method !== "DELETE") {
    if (
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      return error(request, "unsupported_media_type");
    }
  }
  let body: unknown = {};
  if (config.method === "POST" || config.method === "PATCH") {
    try {
      body = await readBoundedJson(request);
    } catch (readError) {
      return error(
        request,
        readError instanceof Error && readError.message === "body_too_large"
          ? "payload_too_large"
          : "validation_failed",
      );
    }
  }
  const base = {
    ...(body && typeof body === "object" ? body : {}),
    ...(input.siteId ? { siteId: input.siteId } : {}),
    ...(input.funnelId ? { funnelId: input.funnelId } : {}),
    ...(config.operation === "settings.trackingScript.get"
      ? { origin: new URL(request.url).origin }
      : {}),
  };
  const parsed = config.schema.safeParse(base);
  if (!parsed.success) return error(request, "validation_failed");
  const service = createResourceApplicationService(input.env);
  const result = await service.execute(
    { teamId: principal.teamId, siteIds: principal.siteIds },
    config.operation as ApiV1ApplicationOperationId,
    parsed.data as never,
    { signal: request.signal },
  );
  if (!result.ok) {
    const code = result.error.code;
    return error(
      request,
      code === "not_found"
        ? "resource_not_found"
        : code === "conflict"
          ? "conflict"
          : code === "forbidden"
            ? "missing_scope"
            : "internal_error",
    );
  }
  if (config.successStatus === 204) return new Response(null, { status: 204 });
  return jsonSuccess(result.value, { request, status: config.successStatus });
}
