import { handlePublicQuery } from "@/lib/edge/query";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";

export async function GET(request: Request): Promise<Response> {
  const { request: requestWithCf, env, url } = await resolveEdgeRuntime(request);
  return handlePublicQuery(requestWithCf, env, url);
}

