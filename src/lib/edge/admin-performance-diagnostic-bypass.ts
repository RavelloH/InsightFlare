import { errorResponse } from "@/lib/response";

import { requireActor } from "./admin-auth";
import { bad, forb, j, na } from "./admin-response";
import {
  DIAGNOSTIC_CACHE_BYPASS_HEADER,
  issueDiagnosticCacheBypassToken,
} from "./diagnostic-cache-bypass";
import type { Env } from "./types";

const ALLOWED_TARGET_PATHS = new Set([
  "/api/private/v2/journeys/visitors",
  "/api/private/v2/journeys/visitor-detail",
  "/api/private/v2/journeys/sessions",
  "/api/private/v2/journeys/session-detail",
  "/api/private/admin/v2/scheduled-tasks",
]);

function targetRequest(request: Request, target: unknown): Request | null {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.length > 2_048
  )
    return null;
  try {
    const base = new URL(request.url);
    const url = new URL(target, base.origin);
    if (url.origin !== base.origin || !ALLOWED_TARGET_PATHS.has(url.pathname)) {
      return null;
    }
    return new Request(url, { method: "GET" });
  } catch {
    return null;
  }
}

/** Mints a one-use, request-bound header for controlled origin diagnostics. */
export async function handlePerformanceDiagnosticBypassAdmin(
  request: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, request);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can mint diagnostic cache bypass tokens",
      undefined,
      request,
    );
  }
  if (request.method !== "POST") return na(request);
  const body = (await request.json().catch(() => null)) as {
    target?: unknown;
  } | null;
  const signedTarget = targetRequest(request, body?.target);
  if (!signedTarget) {
    return bad(
      "target must be an allowed private v2 GET URL",
      undefined,
      request,
    );
  }
  const token = await issueDiagnosticCacheBypassToken({
    actorId: actor.user.id,
    env,
    request: signedTarget,
  });
  if (!token) {
    return errorResponse(
      request,
      503,
      "diagnostic_bypass_unavailable",
      "The diagnostic bypass limiter is unavailable or has reached its limit",
    );
  }
  const targetUrl = new URL(signedTarget.url);
  return j({
    header: DIAGNOSTIC_CACHE_BYPASS_HEADER,
    target: `${targetUrl.pathname}${targetUrl.search}`,
    token,
  });
}
