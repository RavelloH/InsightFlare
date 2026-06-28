import {
  handleCollectOptionsRequest,
  handleCollectRequest,
} from "@/lib/edge/collect";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";

export async function OPTIONS(request: Request): Promise<Response> {
  return handleCollectOptionsRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  const {
    env,
    ctx,
    request: requestWithCf,
    url,
  } = await resolveEdgeRuntime(request);
  return handleCollectRequest(requestWithCf, env, ctx, url);
}
