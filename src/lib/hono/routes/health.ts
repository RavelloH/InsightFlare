import { Hono } from "hono";

import type { AppEnv } from "@/lib/hono/types";

const HEALTH_HEADERS = { "content-type": "application/json" };

function healthResponse(env: AppEnv["Bindings"]): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "insightflare",
      now: new Date().toISOString(),
      bindings: {
        d1: Boolean(env.DB),
        durableObject: Boolean(env.INGEST_DO),
        r2Archive: Boolean(env.ARCHIVE_BUCKET),
      },
    }),
    {
      status: 200,
      headers: HEALTH_HEADERS,
    },
  );
}

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/healthz", (c) => healthResponse(c.env));
