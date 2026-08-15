import handler from "@tanstack/react-start/server-entry";

import { initializeE2eClock } from "@/lib/edge/e2e-clock";
import { runHourlyAggregation } from "@/lib/edge/hourly-rollup";
import { IngestDurableObject as BaseIngestDurableObject } from "@/lib/edge/ingest-do";
import { instrumentEnv } from "@/lib/edge/observability-bindings";
import { createInvocationLogger } from "@/lib/edge/observability-logger";
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

function pageRouteForLog(pathname: string): string {
  return isServerFunctionRequest(pathname) ? "server_function" : "page";
}

function markInternalPageRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("x-insightflare-internal-page-request", "1");
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    initializeE2eClock(env);
    const pathname = new URL(request.url).pathname;
    if (shouldUseHono(pathname)) {
      return apiApp.fetch(request, env, ctx);
    }

    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    logger.info("request.started");
    const instrumentedEnv = instrumentEnv(env, logger);

    try {
      // Server functions are protocol requests, not localized page navigations.
      // Let Start see the original /_serverFn path before page middleware can
      // redirect it beneath a locale segment.
      if (isServerFunctionRequest(pathname)) {
        const response = await logger.measure(
          "server_function.handler",
          async () =>
            handler.fetch(request, {
              context: { env: instrumentedEnv, executionCtx: ctx },
            }),
        );
        const result = withPageHeaders(
          response,
          pathname,
          null,
          env.DEMO_MODE === "1",
        );
        logger.setRequest({
          route: pageRouteForLog(pathname),
          method: request.method,
          status: result.status,
          outcome: result.status >= 400 ? "error" : "ok",
        });
        return result;
      }

      const decision = await logger.measure("page.middleware", () =>
        resolvePageRequest(request, env, async (internalRequest) =>
          apiApp.fetch(
            markInternalPageRequest(internalRequest),
            instrumentedEnv,
            ctx,
          ),
        ),
      );
      const result = decision.response
        ? withPageHeaders(
            decision.response,
            new URL(decision.response.headers.get("location") || request.url)
              .pathname,
            decision.locale,
            env.DEMO_MODE === "1",
          )
        : withPageHeaders(
            await logger.measure("page.handler", async () =>
              handler.fetch(request, {
                context: { env: instrumentedEnv, executionCtx: ctx },
              }),
            ),
            pathname,
            decision.locale,
            env.DEMO_MODE === "1",
          );
      logger.setRequest({
        route: pageRouteForLog(pathname),
        method: request.method,
        status: result.status,
        outcome: result.status >= 400 ? "error" : "ok",
      });
      return result;
    } catch (error) {
      logger.error("request.unhandled_error");
      logger.setRequest({
        route: pageRouteForLog(pathname),
        method: request.method,
        status: 500,
        outcome: "error",
      });
      throw error;
    } finally {
      logger.info("request.completed");
      logger.emit();
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "alarm",
    });
    logger.info("scheduled.started");
    const instrumentedEnv = instrumentEnv(env, logger);
    if (shouldSkipScheduledTasks(env)) {
      logger.info("scheduled.skipped");
      logger.emit();
      return;
    }
    const task = getScheduledTaskDefinition("visit_hourly_rollup");
    const notificationTask = getScheduledTaskDefinition("notification_tick");
    ctx.waitUntil(
      Promise.all([
        runScheduledTask(
          instrumentedEnv,
          {
            key: task?.key || "visit_hourly_rollup",
            name: task?.name || "Hourly visit aggregation",
            triggerType: "cron",
          },
          controller.scheduledTime,
          ({ logger: taskLogger }) =>
            logger.measure("scheduled.hourly_rollup", () =>
              runHourlyAggregation(instrumentedEnv, controller.scheduledTime, {
                logger: taskLogger,
              }),
            ),
          logger,
        ),
        runScheduledTask(
          instrumentedEnv,
          {
            key: notificationTask?.key || "notification_tick",
            name: notificationTask?.name || "Notification dispatch",
            triggerType: "cron",
          },
          controller.scheduledTime,
          (taskContext) =>
            logger.measure("scheduled.notification_tick", () =>
              runNotificationTick(taskContext),
            ),
          logger,
        ),
      ])
        .then(() => logger.info("scheduled.completed"))
        .catch((error) => {
          void error;
          logger.error("scheduled.failed");
          throw error;
        })
        .finally(() => logger.emit()),
    );
  },
};
