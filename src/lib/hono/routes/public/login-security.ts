import { Hono } from "hono";

import { readPublicLoginTurnstileRuntimeConfig } from "@/lib/edge/login-turnstile-runtime";
import type { AppEnv } from "@/lib/hono/types";
import { jsonResponseFor, nf as notFound } from "@/lib/response";

const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

export const publicLoginSecurityRoutes = new Hono<AppEnv>();

publicLoginSecurityRoutes.get("/", async (c) => {
  const turnstile = isDemoBuild
    ? { enabled: false as const, siteKey: "", mode: "invisible" as const }
    : await readPublicLoginTurnstileRuntimeConfig(c.env);
  return jsonResponseFor(
    c.req.raw,
    {
      ok: true,
      data: { turnstile },
    },
    200,
    {
      "cache-control": "no-store",
    },
  );
});

publicLoginSecurityRoutes.all("/*", () => notFound());
