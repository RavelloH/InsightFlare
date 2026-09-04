import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { mapVisitors } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  queryVisitorsFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  queryJourneyEventDetailFromD1,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
  stripSessionDetailCollections,
  stripVisitorDetailCollections,
} from "@/lib/edge/analytics/providers/d1/internal/journeys";
import {
  readSiteSessionEvents,
  readSiteVisitorEvents,
  readSiteVisitorSessions,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";

import {
  type D1SiteQueryRuntimeOptions,
  numberField,
  query,
  stringField,
  timeWindow,
} from "./shared";

export function registerJourneyProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry
    .register(
      "visitors",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const pageSize = numberField(request, "pageSize", 80);
        const page = request.paged
          ? await queryVisitorListPageFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              {
                pageSize,
                sort: request.sort as never,
                search: stringField(request, "search") || undefined,
                cursor: (request.cursor as never) ?? null,
              },
            )
          : {
              rows: await queryVisitorsFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                request.filters ?? EMPTY_FILTER_DOCUMENT,
                pageSize,
                undefined,
                0,
                request.sort as never,
                stringField(request, "search") || undefined,
              ),
              nextCursor: null,
            };
        return {
          value: {
            data: mapVisitors(page.rows),
            meta: {
              pageSize,
              returned: page.rows.length,
              hasMore: page.nextCursor !== null,
              nextCursor: page.nextCursor
                ? serializeVisitorListCursor(page.nextCursor)
                : null,
            },
          },
        };
      }),
    )
    .register(
      "sessions",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const pageSize = numberField(request, "pageSize", 80);
        const page = request.paged
          ? await querySessionListPageFromD1(
              options.env,
              options.siteId,
              timeWindow(request.time),
              request.filters ?? EMPTY_FILTER_DOCUMENT,
              {
                pageSize,
                sort: request.sort as never,
                search: stringField(request, "search") || undefined,
                cursor: (request.cursor as never) ?? null,
              },
            )
          : {
              rows: await querySessionsFromD1(
                options.env,
                options.siteId,
                timeWindow(request.time),
                request.filters ?? EMPTY_FILTER_DOCUMENT,
                pageSize,
                undefined,
                0,
                request.sort as never,
                stringField(request, "search") || undefined,
              ),
              nextCursor: null,
            };
        return {
          value: {
            data: page.rows,
            meta: {
              pageSize,
              returned: page.rows.length,
              hasMore: page.nextCursor !== null,
              nextCursor: page.nextCursor
                ? serializeSessionListCursor(page.nextCursor)
                : null,
            },
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
