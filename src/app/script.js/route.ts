import { buildTrackerScript } from "@/lib/edge/script";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";

function parseScriptCacheTtlSeconds(raw: string | undefined): number {
  const parsed = Number(raw ?? "3600");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3600;
  }
  return Math.floor(parsed);
}

function isEUCountry(request: Request): boolean {
  const cf = (request as Request & { cf?: { isEUCountry?: boolean } }).cf;
  return Boolean(cf?.isEUCountry);
}

export async function GET(request: Request): Promise<Response> {
  const { env, request: requestWithCf } = await resolveEdgeRuntime(request);
  const euMode = isEUCountry(requestWithCf);
  const ttlSeconds = parseScriptCacheTtlSeconds(env.SCRIPT_CACHE_TTL_SECONDS);
  const script = buildTrackerScript({ isEUMode: euMode });

  return new Response(script, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
      "access-control-allow-origin": "*",
    },
  });
}
