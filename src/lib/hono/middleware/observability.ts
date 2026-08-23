import type { MiddlewareHandler } from "hono";

import { instrumentEnv } from "@/lib/edge/observability-bindings";
import {
  createInvocationLogger,
  errorLogData,
  type InvocationCacheState,
  type InvocationDataSource,
  runWithInvocationLogger,
} from "@/lib/edge/observability-logger";
import type { AppEnv } from "@/lib/hono/types";
import { getRequestId } from "@/lib/response";

function parseCacheState(
  value: string | null,
): InvocationCacheState | undefined {
  if (value === "HIT" || value === "MISS" || value === "BYPASS") {
    return value;
  }
  return undefined;
}

function parseDataSource(
  value: string | null,
): InvocationDataSource | undefined {
  if (value === "raw" || value === "rollup" || value === "mixed") {
    return value;
  }
  return undefined;
}

function parseRowsRead(value: string | null): number | undefined {
  if (value === null || value === "unavailable") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.trunc(parsed);
}

function routeForLog(routePath: string): string {
  return routePath && routePath !== "*" ? routePath : "unmatched";
}

export function observabilityMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Page routing can internally dispatch to Hono. That is not an external
    // Worker request, so its outer page invocation owns the single record.
    if (c.req.header("x-insightflare-internal-page-request") === "1") {
      await next();
      return;
    }
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
      traceId: c.get("requestId") || getRequestId(c.req.raw),
    });
    c.set("observabilityLogger", logger);
    c.env = instrumentEnv(c.env, logger);
    logger.info("request.started");

    try {
      await runWithInvocationLogger(logger, () =>
        logger.measure("route.handler", () => next()),
      );
    } catch (error) {
      logger.error("request.unhandled_error", errorLogData(error));
      throw error;
    } finally {
      const response = c.res;
      const status = response?.status ?? 500;
      const rowsReadHeader =
        response?.headers.get("x-insightflare-d1-rows-read") ?? null;
      const rowsRead = parseRowsRead(rowsReadHeader);
      const cache = parseCacheState(
        response?.headers.get("x-insightflare-cache") ?? null,
      );
      const dataSource = parseDataSource(
        response?.headers.get("x-insightflare-data-source") ?? null,
      );
      logger.setRequest({
        route: routeForLog(c.req.routePath),
        method: c.req.raw.method,
        status,
        outcome: status >= 400 ? "error" : "ok",
      });
      logger.setPerformance({
        ...(cache ? { cache } : {}),
        ...(dataSource ? { dataSource } : {}),
        // The binding proxy records every D1 operation, including authentication
        // and mutation queries. Retain the legacy handler value separately for
        // comparison while using binding metadata as the authoritative total.
        ...(rowsRead !== undefined ? { handlerD1RowsRead: rowsRead } : {}),
      });
      logger.info("request.completed");
      const emit = logger.emitWhenComplete();
      const executionCtx = c.executionCtx;
      if (executionCtx) {
        executionCtx.waitUntil(emit);
      } else {
        void emit;
      }
    }
  };
}
