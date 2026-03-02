import { resolveEdgeRuntime } from "@/lib/edge/runtime";

export async function GET(request: Request): Promise<Response> {
  const { env } = await resolveEdgeRuntime(request);
  return new Response(
    JSON.stringify({
      ok: true,
      service: "insightflare",
      now: new Date().toISOString(),
      bindings: {
        d1: Boolean(env.DB),
        durableObject: Boolean(env.INGEST_DO),
        analyticsEngine: Boolean(env.ANALYTICS),
        r2Archive: Boolean(env.ARCHIVE_BUCKET),
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

