import { env as cloudflareEnv } from "cloudflare:workers";

import type { Env } from "@/lib/edge/types";

interface EdgeRuntimeContext {
  env: Env;
  ctx: ExecutionContext;
  request: Request;
  url: URL;
}

export async function resolveEdgeRuntime(
  request: Request,
  options?: {
    env?: Env;
    ctx?: ExecutionContext;
    cf?: unknown;
  },
): Promise<EdgeRuntimeContext> {
  const nextRequest = new Request(request.url, request);
  try {
    Object.defineProperty(nextRequest, "cf", {
      value: options?.cf ?? null,
      configurable: true,
    });
  } catch {
    // Ignore if the runtime doesn't allow redefining request fields.
  }

  return {
    env: options?.env ?? (cloudflareEnv as unknown as Env),
    ctx:
      options?.ctx ??
      ({ waitUntil: () => undefined } as unknown as ExecutionContext),
    request: nextRequest,
    url: new URL(nextRequest.url),
  };
}
