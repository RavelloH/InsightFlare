import { Hono } from "hono";

import { requireActor } from "@/lib/edge/admin-auth";
import { forb, nf } from "@/lib/edge/admin-response";
import { performanceV2StubResponse } from "@/lib/edge/performance-v2";
import { requireMethodMiddleware } from "@/lib/hono/middleware/method";
import { resolvePrivateSiteMiddleware } from "@/lib/hono/middleware/site";
import type { AppEnv } from "@/lib/hono/types";

const JOURNEY_V2_PATHS = [
  "visitors",
  "visitor-detail",
  "sessions",
  "session-detail",
];

export const privatePerformanceV2Routes = new Hono<AppEnv>();
export const privateAdminPerformanceV2Routes = new Hono<AppEnv>();

for (const path of JOURNEY_V2_PATHS) {
  privatePerformanceV2Routes.use(
    `/journeys/${path}`,
    requireMethodMiddleware("GET"),
    resolvePrivateSiteMiddleware(),
  );
  privatePerformanceV2Routes.all(`/journeys/${path}`, (c) =>
    performanceV2StubResponse(c.req.raw, c.env, "journey-v2"),
  );
}

privatePerformanceV2Routes.all("/*", () => nf());

privateAdminPerformanceV2Routes.use(
  "/scheduled-tasks",
  requireMethodMiddleware("GET"),
);
privateAdminPerformanceV2Routes.all("/scheduled-tasks", async (c) => {
  const actor = await requireActor(c.env, c.req.raw);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can access scheduled task performance v2",
      undefined,
      c.req.raw,
    );
  }
  return performanceV2StubResponse(c.req.raw, c.env, "scheduled-tasks-v2");
});
privateAdminPerformanceV2Routes.all("/*", () => nf());
