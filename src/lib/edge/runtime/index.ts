import { env as cloudflareEnv } from "cloudflare:workers";

import { instrumentEnv } from "@/lib/edge/observability/bindings";
import { currentInvocationLogger } from "@/lib/edge/observability/logger";
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

  const rawEnv = options?.env ?? (cloudflareEnv as unknown as Env);
  const logger = currentInvocationLogger();
  return {
    // SSR helpers resolve bindings directly, outside the Hono middleware.
    // Reuse the active invocation logger and never wrap an instrumented env twice.
    env: logger ? instrumentEnv(rawEnv, logger) : rawEnv,
    ctx:
      options?.ctx ??
      ({ waitUntil: () => undefined } as unknown as ExecutionContext),
    request: nextRequest,
    url: new URL(nextRequest.url),
  };
}
