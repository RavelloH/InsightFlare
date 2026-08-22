import { Hono } from "hono";

import { SESSION_COOKIE, SESSION_DURATION_SECONDS } from "@/lib/constants";
import {
  handleLegacyAuthLogin,
  handleLegacyAuthLogout,
} from "@/lib/edge/legacy-auth";
import type { AppEnv } from "@/lib/hono/types";
import { jsonResponseFor, nf as notFound } from "@/lib/response";

const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

export const publicSessionRoutes = new Hono<AppEnv>();

async function demoLogin(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.clone().json()) as Record<string, unknown>;
  } catch {
    // Demo login intentionally accepts an empty credential payload.
  }
  const requestedNext = typeof body.next === "string" ? body.next : "/app";
  const cleanNext = requestedNext.split("?")[0].replace(/\/+$/, "");
  const next =
    requestedNext.startsWith("/") &&
    !requestedNext.startsWith("//") &&
    cleanNext !== "/login" &&
    !cleanNext.endsWith("/login")
      ? requestedNext
      : "/app";
  const { getDemoTeams, getDemoUser } =
    await import("@/lib/realtime/mock/admin");
  const response = jsonResponseFor(request, {
    ok: true,
    data: { next, user: getDemoUser(), teams: getDemoTeams() },
  });
  response.headers.set(
    "set-cookie",
    `${SESSION_COOKIE}=demo-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_SECONDS}`,
  );
  return response;
}

publicSessionRoutes.post("/", (c) =>
  isDemoBuild ? demoLogin(c.req.raw) : handleLegacyAuthLogin(c.req.raw, c.env),
);
publicSessionRoutes.delete("/", (c) => handleLegacyAuthLogout(c.req.raw));
publicSessionRoutes.all("/*", () => notFound());
