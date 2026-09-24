import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import type { LegacyJourneyQuery } from "@/lib/edge/analytics/contract/canonical-operation-map";
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

import { type D1SiteRuntimeBindings, stringField, timeWindow } from "./shared";

function pageFromRequest(
  request: LegacyJourneyQuery,
  fallback: number,
): { readonly limit: number; readonly cursor: string | null } {
  const limit = request.page?.limit ?? request.limit ?? fallback;
  const cursor = request.page?.cursor ?? request.cursor ?? null;
  return { limit, cursor };
}

function listSortFromRequest(
  request: LegacyJourneyQuery,
  kind: "visitors",
): {
  readonly field: "firstSeenAt" | "lastSeenAt" | "sessions" | "views";
  readonly direction: "asc" | "desc";
};
function listSortFromRequest(
  request: LegacyJourneyQuery,
  kind: "sessions",
): {
  readonly field: "startedAt" | "durationMs" | "views";
  readonly direction: "asc" | "desc";
};
function listSortFromRequest(
  request: LegacyJourneyQuery,
  kind: "visitors" | "sessions",
): { readonly field: string; readonly direction: "asc" | "desc" } {
  const candidate = request.sort;
  const key = candidate?.key;
  const allowed =
    kind === "visitors"
      ? new Set(["firstSeenAt", "lastSeenAt", "sessions", "views"])
      : new Set(["startedAt", "durationMs", "views"]);
  const defaultKey = kind === "visitors" ? "lastSeenAt" : "startedAt";
  const field = typeof key === "string" && allowed.has(key) ? key : defaultKey;
  const direction = candidate?.direction === "asc" ? "asc" : "desc";
  return { field, direction };
}

export function registerJourneyProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteRuntimeBindings,
): void {
  registry
    .register(
      "visitors",
      typedQueryProviderFor("visitors", async (input) => {
        const request = input;
        const page = await readSiteVisitors({
          env: options.env,
          siteId: options.siteId,
          window: timeWindow(request.time),
          filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          sort: listSortFromRequest(request, "visitors"),
          search: stringField(request, "search") || undefined,
          page: pageFromRequest(request, 80),
          audience: request.context.policy.audience,
          analysisContext: request.analysisContext,
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
      typedQueryProviderFor("sessions", async (input) => {
        const request = input;
        const page = await readSiteSessions({
          env: options.env,
          siteId: options.siteId,
          window: timeWindow(request.time),
          filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          sort: listSortFromRequest(request, "sessions"),
          search: stringField(request, "search") || undefined,
          page: pageFromRequest(request, 80),
          audience: request.context.policy.audience,
          analysisContext: request.analysisContext,
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
      typedQueryProviderFor("visitor-events", async (input) => {
        const request = input;
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
      typedQueryProviderFor("visitor-sessions", async (input) => {
        const request = input;
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
      typedQueryProviderFor("session-events", async (input) => {
        const request = input;
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
      typedQueryProviderFor("journey-event-detail", async (input) => {
        const request = input;
        return {
          value: await queryJourneyEventDetailFromD1(
            options.env,
            options.siteId,
            stringField(request, "eventId"),
            timeWindow(request.time),
            request.eventKind,
          ),
        };
      }),
    )
    .register(
      "visitor-detail",
      typedQueryProviderFor("visitor-detail", async (input) => {
        const request = input;
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
      typedQueryProviderFor("session-detail", async (input) => {
        const request = input;
        const detail = await querySessionDetailFromD1(
          options.env,
          options.siteId,
          stringField(request, "sessionId"),
        );
        return { value: detail ? stripSessionDetailCollections(detail) : null };
      }),
    );
}
