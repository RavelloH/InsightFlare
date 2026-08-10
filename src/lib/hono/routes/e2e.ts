import { Hono } from "hono";

import { timingSafeEqualString } from "@/lib/edge/api-key-store";
import {
  advanceE2eClock,
  appNow,
  e2eClockNow,
  setE2eClock,
} from "@/lib/edge/e2e-clock";
import { runHourlyAggregation } from "@/lib/edge/hourly-rollup";
import { getScheduledTaskDefinition } from "@/lib/edge/scheduled-task-registry";
import { runScheduledTask } from "@/lib/edge/scheduled-task-runner";
import type { AppEnv } from "@/lib/hono/types";
import { runNotificationTick } from "@/lib/notifications/notification-task";

const CONTROL_TOKEN_HEADER = "x-insightflare-e2e-token";

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function isAuthorized(request: Request, env: AppEnv["Bindings"]): boolean {
  const expected = env.INSIGHTFLARE_E2E_CONTROL_TOKEN || "";
  const received = request.headers.get(CONTROL_TOKEN_HEADER) || "";
  return (
    env.INSIGHTFLARE_E2E === "1" &&
    expected.length > 0 &&
    timingSafeEqualString(received, expected)
  );
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function siteExists(
  env: AppEnv["Bindings"],
  siteId: string,
): Promise<boolean> {
  if (!siteId) return false;
  return Boolean(
    await env.DB.prepare("SELECT id FROM sites WHERE id=? LIMIT 1")
      .bind(siteId)
      .first<{ id: string }>(),
  );
}

export const e2eRoutes = new Hono<AppEnv>();

e2eRoutes.use("*", async (c, next) => {
  if (!isAuthorized(c.req.raw, c.env)) return notFound();
  await next();
});

e2eRoutes.get("/clock", (c) =>
  c.json({ ok: true, data: { nowMs: e2eClockNow() } }),
);

e2eRoutes.post("/clock/set", async (c) => {
  const input = await body(c.req.raw);
  const nowMs = Number(input?.nowMs);
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return c.json({ ok: false, error: "nowMs is required" }, 400);
  }
  return c.json({ ok: true, data: { nowMs: setE2eClock(nowMs) } });
});

e2eRoutes.post("/clock/advance", async (c) => {
  const input = await body(c.req.raw);
  const deltaMs = Number(input?.deltaMs);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return c.json({ ok: false, error: "deltaMs is required" }, 400);
  }
  return c.json({ ok: true, data: { nowMs: advanceE2eClock(deltaMs) } });
});

e2eRoutes.post("/scheduled/run", async (c) => {
  const input = await body(c.req.raw);
  const key = String(input?.key || "");
  if (key !== "notification_tick" && key !== "visit_hourly_rollup") {
    return c.json({ ok: false, error: "scheduled task key is required" }, 400);
  }
  const scheduledAt = appNow();
  const definition = getScheduledTaskDefinition(key);
  const taskDefinition = {
    key: definition?.key || key,
    name:
      definition?.name ||
      (key === "visit_hourly_rollup"
        ? "Hourly visit aggregation"
        : "Notification dispatch"),
    triggerType: "cron" as const,
  };
  if (key === "visit_hourly_rollup") {
    await runScheduledTask(c.env, taskDefinition, scheduledAt, ({ logger }) =>
      runHourlyAggregation(c.env, scheduledAt, { logger }),
    );
  } else {
    await runScheduledTask(
      c.env,
      taskDefinition,
      scheduledAt,
      runNotificationTick,
    );
  }
  return c.json({ ok: true, data: { key, scheduledAt } });
});

e2eRoutes.post("/ingest/flush", async (c) => {
  const input = await body(c.req.raw);
  const siteId = String(input?.siteId || "")
    .trim()
    .slice(0, 120);
  if (!(await siteExists(c.env, siteId))) {
    return c.json({ ok: false, error: "siteId is required" }, 400);
  }
  const response = await c.env.INGEST_DO.get(
    c.env.INGEST_DO.idFromName(siteId),
  ).fetch("https://ingest.internal/flush", { method: "POST" });
  if (!response.ok) return c.json({ ok: false, error: "flush_failed" }, 502);
  return c.json({ ok: true, data: { flushed: true, siteId } });
});

e2eRoutes.get("/ingest/status", async (c) => {
  const siteId = String(c.req.query("siteId") || "")
    .trim()
    .slice(0, 120);
  if (!(await siteExists(c.env, siteId))) return c.json({ ok: false }, 400);
  const response = await c.env.INGEST_DO.get(
    c.env.INGEST_DO.idFromName(siteId),
  ).fetch("https://ingest.internal/diagnostic");
  if (!response.ok) return c.json({ ok: false, error: "status_failed" }, 502);
  return new Response(response.body, {
    headers: { "content-type": "application/json" },
  });
});
