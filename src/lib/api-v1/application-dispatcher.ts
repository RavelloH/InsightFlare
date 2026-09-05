import {
  type ApiV1ApplicationService,
  GetTeamVisibleSavedFilterInputSchema,
  ListTeamVisibleSavedFiltersInputSchema,
} from "@/lib/api-v1/application-registry";
import { createSavedFilterApplicationService } from "@/lib/api-v1/saved-filters-service";
import {
  jsonError,
  jsonSuccess,
  methodNotAllowed,
} from "@/lib/api-v1/wire-helpers";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import { canAccessSiteId } from "@/lib/edge/api-key-auth";
import type { Env } from "@/lib/edge/types";
import { rootSecret } from "@/lib/secrets";

type SavedFilterRouteId = "site.saved-filters.list" | "site.saved-filters.get";

export interface ApiV1ApplicationDispatchInput {
  readonly request: Request;
  readonly env: Pick<Env, "DB" | "MAIN_SECRET" | "DAILY_SALT_SECRET">;
  readonly principal: ApiKeyPrincipal;
  readonly routeId: SavedFilterRouteId;
  readonly siteId: string;
  readonly savedFilterId?: string;
  readonly service?: ApiV1ApplicationService;
  readonly execution?: {
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
  };
}

function errorResponse(
  request: Request,
  code: "not_found" | "invalid_cursor" | "internal_error" | "validation_failed",
): Response {
  if (code === "validation_failed") {
    return jsonError(
      "validation_failed",
      "Request validation failed",
      400,
      undefined,
      request,
    );
  }
  if (code === "not_found") {
    return jsonError(
      "resource_not_found",
      "Saved filter not found",
      404,
      undefined,
      request,
    );
  }
  if (code === "invalid_cursor") {
    return jsonError(
      "invalid_cursor",
      "The saved-filter cursor is invalid",
      400,
      undefined,
      request,
    );
  }
  return jsonError(
    "internal_error",
    "An internal error occurred",
    500,
    undefined,
    request,
  );
}

function parseListInput(url: URL, siteId: string) {
  for (const key of url.searchParams.keys()) {
    if (key !== "limit" && key !== "cursor") return null;
  }
  const raw = {
    siteId,
    page: {
      ...(url.searchParams.has("limit")
        ? { limit: Number(url.searchParams.get("limit")) }
        : {}),
      ...(url.searchParams.has("cursor")
        ? { cursor: url.searchParams.get("cursor") }
        : {}),
    },
  };
  return ListTeamVisibleSavedFiltersInputSchema.safeParse(raw);
}

/**
 * Typed application boundary for API v1 resources. The dispatcher owns route
 * selection, transport validation, principal/site policy and error mapping;
 * the application service remains HTTP-free and receives only canonical input.
 */
export async function dispatchApiV1ApplicationRoute(
  input: ApiV1ApplicationDispatchInput,
): Promise<Response> {
  const {
    request,
    env,
    principal,
    routeId,
    siteId,
    savedFilterId,
    execution = {},
  } = input;

  if (request.method !== "GET") return methodNotAllowed(request, "GET");
  if (!principal.scopes.includes("analysis:read")) {
    return jsonError(
      "missing_scope",
      "The API key lacks analysis:read",
      403,
      undefined,
      request,
    );
  }
  if (!canAccessSiteId(principal, siteId)) {
    return errorResponse(request, "not_found");
  }
  const cursorSecret = rootSecret(env);
  if (!input.service && !cursorSecret) {
    return errorResponse(request, "internal_error");
  }

  const application =
    input.service ?? createSavedFilterApplicationService(env, cursorSecret!);
  const context = { teamId: principal.teamId, siteIds: principal.siteIds };
  if (routeId === "site.saved-filters.get") {
    if (!savedFilterId) return errorResponse(request, "validation_failed");
    const parsed = GetTeamVisibleSavedFilterInputSchema.safeParse({
      siteId,
      id: savedFilterId,
    });
    if (!parsed.success) return errorResponse(request, "validation_failed");
    const result = await application.execute(
      context,
      "savedFilters.get",
      parsed.data,
      execution,
    );
    if (!result.ok) return errorResponse(request, result.error.code);
    return jsonSuccess(result.value, { request });
  } else {
    const parsed = parseListInput(new URL(request.url), siteId);
    if (!parsed || !parsed.success) {
      return errorResponse(request, "validation_failed");
    }
    const result = await application.execute(
      context,
      "savedFilters.list",
      parsed.data,
      execution,
    );
    if (!result.ok) return errorResponse(request, result.error.code);
    return jsonSuccess(result.value, { request });
  }
}
