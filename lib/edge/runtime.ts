import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Env } from "./types";

interface EdgeRuntimeContext {
  env: Env;
  ctx: ExecutionContext;
  request: Request;
  url: URL;
}

export async function resolveEdgeRuntime(request: Request): Promise<EdgeRuntimeContext> {
  const { env, ctx, cf } = await getCloudflareContext({ async: true });
  const nextRequest = new Request(request);
  try {
    Object.defineProperty(nextRequest, "cf", {
      value: cf ?? null,
      configurable: true,
    });
  } catch {
    // Ignore if the runtime doesn't allow redefining request fields.
  }

  return {
    env: env as unknown as Env,
    ctx,
    request: nextRequest,
    url: new URL(nextRequest.url),
  };
}
