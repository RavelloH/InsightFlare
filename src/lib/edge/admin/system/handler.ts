import { createDatabaseRuntime } from "@/lib/db";
import { parseJson } from "@/lib/edge/admin/response";
import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";
import { bad, forb, jsonResponseFor, na, nf } from "@/lib/response";

type AdminActor = { isAdmin: boolean };
type AdminActorResolver = (
  env: Env,
  req: Request,
) => Promise<AdminActor | Response>;
/** E2E-only deterministic flush; unavailable unless the generated local config opts in. */
export async function handleE2eFlushAdmin(
  req: Request,
  env: Env,
  _url: URL,
  requireActor: AdminActorResolver,
): Promise<Response> {
  if (env.INSIGHTFLARE_E2E !== "1") return nf();
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin)
    return forb("Only system admin can flush E2E ingest", undefined, req);
  if (req.method !== "POST") return na(req);
  const body = await parseJson(req);
  const siteId = clampString(String(body.siteId || ""), 120);
  if (!siteId) return bad("siteId is required", undefined, req);
  const site = await createDatabaseRuntime(env.DB).first<{ id: string }>({
    sql: "SELECT id FROM sites WHERE id=? LIMIT 1",
    bindings: [siteId],
    tag: "admin.sites.first",
  });
  if (!site) return nf("Site not found", undefined, req);
  const stub = env.INGEST_DO.get(env.INGEST_DO.idFromName(siteId));
  const response = await stub.fetch("https://ingest.internal/flush?force=1", {
    method: "POST",
  });
  if (!response.ok)
    return jsonResponseFor(req, { ok: false, error: "flush_failed" }, 502);
  return jsonResponseFor(req, { ok: true, data: { flushed: true, siteId } });
}
