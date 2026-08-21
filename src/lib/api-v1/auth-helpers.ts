import { jsonError } from "@/lib/api-v1/wire-helpers";
import type { ApiKeyScope } from "@/lib/edge/api-key-store";

export function requireScope(
  scopes: ApiKeyScope[],
  scope: ApiKeyScope,
  request: Request,
): Response | null {
  if (scopes.includes(scope)) return null;
  return jsonError(
    "insufficient_scope",
    "The API key does not have the required scope.",
    403,
    { requiredScope: scope },
    request,
  );
}
