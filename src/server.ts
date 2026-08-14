import handler from "@tanstack/react-start/server-entry";

import { runHourlyAggregation } from "@/lib/edge/hourly-rollup";
import { IngestDurableObject as BaseIngestDurableObject } from "@/lib/edge/ingest-do";
import { getScheduledTaskDefinition } from "@/lib/edge/scheduled-task-registry";
import { runScheduledTask } from "@/lib/edge/scheduled-task-runner";
import type { Env } from "@/lib/edge/types";
import apiApp from "@/lib/hono/app";
import { shouldUseHono } from "@/lib/hono/path-match";
import { runNotificationTick } from "@/lib/notifications/notification-task";
import { localeCookie, resolvePageRequest } from "@/middleware";

export interface AppServerContext {
  env: Env;
  executionCtx: ExecutionContext;
}

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: AppServerContext;
    };
  }
}

export class IngestDurableObject extends BaseIngestDurableObject {}

function withPageHeaders(
  response: Response,
  pathname: string,
  locale: string | null,
  demoMode: boolean,
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-pathname", pathname);
  if (locale) headers.append("set-cookie", localeCookie(locale));
  headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  headers.set("X-Frame-Options", demoMode ? "SAMEORIGIN" : "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://ajax.cloudflare.com https://challenges.cloudflare.com https://insight.ravelloh.com https://static.cloudflareinsights.com",
      "script-src-elem 'self' 'unsafe-inline' https://ajax.cloudflare.com https://challenges.cloudflare.com https://insight.ravelloh.com https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "worker-src 'self' blob:",
      "frame-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function shouldSkipScheduledTasks(env: Env): boolean {
  return env.DISABLE_CRON_TASKS === "1" || env.DEMO_MODE === "1";
}

function isServerFunctionRequest(pathname: string): boolean {
  return pathname === "/_serverFn" || pathname.startsWith("/_serverFn/");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    if (shouldUseHono(pathname)) {
      return apiApp.fetch(request, env, ctx);
    }

    // Server functions are protocol requests, not localized page navigations.
    // Let Start see the original /_serverFn path before page middleware can
    // redirect it beneath a locale segment.
    if (isServerFunctionRequest(pathname)) {
      const response = await handler.fetch(request, {
        context: { env, executionCtx: ctx },
      });
      return withPageHeaders(response, pathname, null, env.DEMO_MODE === "1");
    }

    const decision = await resolvePageRequest(
      request,
      env,
      async (internalRequest) => apiApp.fetch(internalRequest, env, ctx),
    );
    if (decision.response) {
      return withPageHeaders(
        decision.response,
        new URL(decision.response.headers.get("location") || request.url)
          .pathname,
        decision.locale,
        env.DEMO_MODE === "1",
      );
    }

    const response = await handler.fetch(request, {
      context: { env, executionCtx: ctx },
    });
    return withPageHeaders(
      response,
      pathname,
      decision.locale,
      env.DEMO_MODE === "1",
    );
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    if (shouldSkipScheduledTasks(env)) return;
    const task = getScheduledTaskDefinition("visit_hourly_rollup");
    const notificationTask = getScheduledTaskDefinition("notification_tick");
    ctx.waitUntil(
      Promise.all([
        runScheduledTask(
          env,
          {
            key: task?.key || "visit_hourly_rollup",
            name: task?.name || "Hourly visit aggregation",
            triggerType: "cron",
          },
          controller.scheduledTime,
          ({ logger }) =>
            runHourlyAggregation(env, controller.scheduledTime, { logger }),
        ),
        runScheduledTask(
          env,
          {
            key: notificationTask?.key || "notification_tick",
            name: notificationTask?.name || "Notification dispatch",
            triggerType: "cron",
          },
          controller.scheduledTime,
          runNotificationTick,
        ),
      ]),
    );
  },
};
