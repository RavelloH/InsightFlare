import { dispatchApiV1ApplicationRoute } from "@/lib/api-v1/application-dispatcher";
import type { ApiV1ApplicationService } from "@/lib/api-v1/application-registry";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { Env } from "@/lib/edge/types";

/**
 * Compatibility-named adapter retained for the route module while the actual
 * application boundary lives in the registry-driven dispatcher.
 */
export function handlePlannedSavedFilters(
  request: Request,
  env: Pick<Env, "DB" | "MAIN_SECRET">,
  principal: ApiKeyPrincipal,
  siteId: string,
  filterId?: string,
  service?: ApiV1ApplicationService,
): Promise<Response> {
  return dispatchApiV1ApplicationRoute({
    request,
    env,
    principal,
    siteId,
    ...(filterId ? { savedFilterId: filterId } : {}),
    routeId: filterId ? "site.saved-filters.get" : "site.saved-filters.list",
    ...(service ? { service } : {}),
  });
}
