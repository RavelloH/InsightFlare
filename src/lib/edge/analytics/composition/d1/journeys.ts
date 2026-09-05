import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import {
  queryJourneyEventDetailFromD1,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
  stripSessionDetailCollections,
  stripVisitorDetailCollections,
} from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  readSiteSessionEvents,
  readSiteSessions,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";

import {
  type D1SiteQueryRuntimeOptions,
  query,
  stringField,
  timeWindow,
} from "./shared";

function pageFromRequest(
  request: ReturnType<typeof query>,
  fallback: number,
): { readonly limit: number; readonly cursor: string | null } {
  const raw = request.page;
  const page =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const limit =
    page && typeof page.limit === "number" && Number.isFinite(page.limit)
      ? page.limit
      : typeof request.limit === "number" && Number.isFinite(request.limit)
        ? request.limit
        : fallback;
  const cursor =
    page && typeof page.cursor === "string"
      ? page.cursor
      : typeof request.cursor === "string"
        ? request.cursor
        : null;
  return { limit, cursor };
}

function listSortFromRequest(
  request: ReturnType<typeof query>,
  kind: "visitors" | "sessions",
): Record<string, string> {
  const raw = request.sort;
  const candidate =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const key = candidate.field ?? candidate.key;
  const allowed =
    kind === "visitors"
      ? new Set(["firstSeenAt", "lastSeenAt", "sessions", "views"])
      : new Set(["startedAt", "durationMs", "views"]);
  const defaultKey = kind === "visitors" ? "lastSeenAt" : "startedAt";
  const field = typeof key === "string" && allowed.has(key) ? key : defaultKey;
  const direction = candidate.direction === "asc" ? "asc" : "desc";
  return { field, direction };
}

export function registerJourneyProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry
    .register(
      "visitors",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const page = await readSiteVisitors({
          env: options.env,
          siteId: options.siteId,
          window: timeWindow(request.time),
          filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          sort: listSortFromRequest(request, "visitors") as never,
          search: stringField(request, "search") || undefined,
          page: pageFromRequest(request, 80),
          audience: request.context.policy.audience,
        });
        return {
          value: {
            items: page.items,
            pagination: page.pagination,
          },
        };
      }),
    )
    .register(
      "sessions",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const page = await readSiteSessions({
          env: options.env,
          siteId: options.siteId,
          window: timeWindow(request.time),
          filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          sort: listSortFromRequest(request, "sessions") as never,
          search: stringField(request, "search") || undefined,
          page: pageFromRequest(request, 80),
          audience: request.context.policy.audience,
        });
        return {
          value: {
            items: page.items,
            pagination: page.pagination,
          },
        };
      }),
    )
    .register(
      "visitor-events",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const page =
          request.page && typeof request.page === "object"
            ? (request.page as {
                readonly limit?: unknown;
                readonly cursor?: unknown;
              })
            : {};
        return {
          value: await readSiteVisitorEvents({
            env: options.env,
            siteId: options.siteId,
            visitorId: stringField(request, "visitorId"),
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            audience: request.context.policy.audience,
            page: {
              limit:
                typeof page.limit === "number" && Number.isFinite(page.limit)
                  ? page.limit
                  : 100,
              cursor: typeof page.cursor === "string" ? page.cursor : null,
            },
          }),
        };
      }),
    )
    .register(
      "visitor-sessions",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const page =
          request.page && typeof request.page === "object"
            ? (request.page as {
                readonly limit?: unknown;
                readonly cursor?: unknown;
              })
            : {};
        return {
          value: await readSiteVisitorSessions({
            env: options.env,
            siteId: options.siteId,
            visitorId: stringField(request, "visitorId"),
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            audience: request.context.policy.audience,
            page: {
              limit:
                typeof page.limit === "number" && Number.isFinite(page.limit)
                  ? page.limit
                  : 100,
              cursor: typeof page.cursor === "string" ? page.cursor : null,
            },
          }),
        };
      }),
    )
    .register(
      "session-events",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const page =
          request.page && typeof request.page === "object"
            ? (request.page as {
                readonly limit?: unknown;
                readonly cursor?: unknown;
              })
            : {};
        return {
          value: await readSiteSessionEvents({
            env: options.env,
            siteId: options.siteId,
            sessionId: stringField(request, "sessionId"),
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            audience: request.context.policy.audience,
            page: {
              limit:
                typeof page.limit === "number" && Number.isFinite(page.limit)
                  ? page.limit
                  : 100,
              cursor: typeof page.cursor === "string" ? page.cursor : null,
            },
          }),
        };
      }),
    )
    .register(
      "journey-event-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        return {
          value: await queryJourneyEventDetailFromD1(
            options.env,
            options.siteId,
            stringField(request, "eventId"),
            timeWindow(request.time),
            (stringField(request, "eventKind") || undefined) as never,
          ),
        };
      }),
    )
    .register(
      "visitor-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const detail = await queryVisitorDetailFromD1(
          options.env,
          options.siteId,
          stringField(request, "visitorId"),
          stringField(request, "timeZone", "UTC"),
        );
        return { value: detail ? stripVisitorDetailCollections(detail) : null };
      }),
    )
    .register(
      "session-detail",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const detail = await querySessionDetailFromD1(
          options.env,
          options.siteId,
          stringField(request, "sessionId"),
        );
        return { value: detail ? stripSessionDetailCollections(detail) : null };
      }),
    );
}
