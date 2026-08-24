import {
  type QueryContext,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

export type ApiV1QueryContextResult =
  | { readonly ok: true; readonly context: QueryContext }
  | {
      readonly ok: false;
      readonly error: "missing_scope" | "site_not_found" | "token_inactive";
    };

/**
 * Converts an authenticated API-key principal to a trusted query context.
 * Untrusted request bodies never participate in subject or policy selection.
 */
export function createApiV1SiteQueryContext(
  principal: ApiKeyPrincipal,
  siteId: string,
): ApiV1QueryContextResult {
  if ((principal.status ?? "active") !== "active") {
    return { ok: false, error: "token_inactive" };
  }
  if (!principal.scopes.includes("analytics:read")) {
    return { ok: false, error: "missing_scope" };
  }
  if (principal.siteIds.length > 0 && !principal.siteIds.includes(siteId)) {
    // Site access intentionally uses not-found semantics for API-key callers.
    return { ok: false, error: "site_not_found" };
  }
  return { ok: true, context: siteQueryContext(siteId, "api-v1") };
}
