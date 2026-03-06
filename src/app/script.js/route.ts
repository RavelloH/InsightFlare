import { handleTrackerScriptRequest } from "@/lib/edge/script-endpoint";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";

export async function GET(request: Request): Promise<Response> {
  const { env, request: requestWithCf } = await resolveEdgeRuntime(request);
  return handleTrackerScriptRequest(requestWithCf, env);
}
