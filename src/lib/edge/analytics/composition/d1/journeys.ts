import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import {
  EMPTY_FILTER_DOCUMENT,
  type QueryInput,
} from "@/lib/edge/analytics/contract";
import type { LegacyJourneyQuery } from "@/lib/edge/analytics/contract/canonical-operation-map";
import type { JourneyListAnalysis } from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import {
  deferredEventQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { prepareEventMembershipFallback } from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import { executeJourneyEventPageQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/journey-event-page-qualification-program";
import { deferredJourneyEventPageQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/journey-event-page-qualification-request";
import {
  queryJourneyEventDetailFromD1,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
  stripSessionDetailCollections,
  stripVisitorDetailCollections,
} from "@/lib/edge/analytics/providers/d1/internal/journeys";
import { executeSessionListQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-program";
import { deferredSessionListQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import { executeVisitorListQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-program";
import { deferredVisitorListQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-request";
import {
  readSiteSessionEvents,
  readSiteSessions,
  readSiteSessionsWithResolvedAnalysis,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
  readSiteVisitorsWithResolvedAnalysis,
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

/** Report and resolved analysis stages read one request-owned entity relation. */
async function prepareJourneyListMembership(input: {
  readonly request: object;
  readonly deferred: {
    readonly qualification: Parameters<
      typeof prepareDeferredEventQualificationFallback
    >[0];
  };
  readonly operation:
    | "visitors"
    | "sessions"
    | "visitor-sessions"
    | "visitor-events"
    | "session-events";
  readonly sort: unknown;
  readonly search: string | undefined;
  readonly page: unknown;
  readonly resolvedAnalysis?: JourneyListAnalysis;
}) {
  const qualification = input.deferred.qualification;
  if (
    ((input.request as { readonly analysisContext?: unknown })
      .analysisContext &&
      !input.resolvedAnalysis) ||
    !("metadata" in qualification) ||
    qualification.metadata.plan.mode !== "entity"
  )
    return undefined;
  return prepareEventMembershipFallback({
    deferred: qualification as never,
    operation: input.operation,
    operations: [input.operation],
    configuration: {
      sort: input.sort,
      search: input.search ?? null,
      page: input.page,
      ...(input.resolvedAnalysis ? { analysis: input.resolvedAnalysis } : {}),
    },
    maxPlans: 1,
    // Base Page/Event Sources plus the finite, already resolved analysis stages.
    // Each Funnel step can read both roles, with one optional empty Page source.
    maxSourcesPerRole:
      input.resolvedAnalysis?.type === "goal"
        ? 4
        : input.resolvedAnalysis?.type === "funnel"
          ? 3 + 2 * (input.resolvedAnalysis.stepIndex + 1)
          : 2,
  });
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
        const deferred = deferredVisitorListQualificationFromQuery(
          request as unknown as QueryInput & Record<string, unknown>,
        );
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const sort = listSortFromRequest(request, "visitors");
        const search = stringField(request, "search") || undefined;
        const pageRequest = pageFromRequest(request, 80);
        if (deferred) {
          const qualified = await executeVisitorListQualificationProgram({
            env: options.env,
            query: request as unknown as Record<string, unknown>,
            deferred,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (qualified.kind === "executed") return { value: qualified.result };
          if (options.diagnostics)
            options.diagnostics.advancedCountSqlFallbackReason =
              qualified.fallbackReason;
          // The report and any resolved Goal/Funnel stages share the request's
          // entity membership through an explicit plan dependency.
          const membership = await prepareJourneyListMembership({
            request,
            deferred,
            operation: "visitors",
            sort,
            search,
            page: pageRequest,
            resolvedAnalysis: qualified.resolvedAnalysis,
          });
          const fallbackFilters = membership
            ? deferred.qualification.filters
            : await prepareDeferredEventQualificationFallback(
                deferred.qualification,
              );
          if (qualified.postFallbackError)
            throw qualified.postFallbackError.error;
          const fallbackInput = {
            env: options.env,
            siteId: options.siteId,
            window,
            filters: fallbackFilters,
            sort,
            search,
            page: pageRequest,
            audience: request.context.policy.audience,
            analysisContext: request.analysisContext,
            ...(membership ? { membership } : {}),
          };
          const page = qualified.resolvedAnalysis
            ? await readSiteVisitorsWithResolvedAnalysis(
                fallbackInput,
                qualified.resolvedAnalysis,
              )
            : await readSiteVisitors(fallbackInput);
          return {
            value: {
              items: page.items,
              pagination: page.pagination,
            },
          };
        }
        const page = await readSiteVisitors({
          env: options.env,
          siteId: options.siteId,
          window,
          filters,
          sort,
          search,
          page: pageRequest,
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
        const deferred = deferredSessionListQualificationFromQuery(
          request as unknown as QueryInput & Record<string, unknown>,
        );
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const sort = listSortFromRequest(request, "sessions");
        const search = stringField(request, "search") || undefined;
        const pageRequest = pageFromRequest(request, 80);
        if (deferred) {
          const qualified = await executeSessionListQualificationProgram({
            env: options.env,
            query: request as unknown as Record<string, unknown>,
            deferred,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (qualified.kind === "executed") return { value: qualified.result };
          if (options.diagnostics)
            options.diagnostics.advancedCountSqlFallbackReason =
              qualified.fallbackReason;
          // The report and any resolved Goal/Funnel stages share the request's
          // entity membership through an explicit plan dependency.
          const membership = await prepareJourneyListMembership({
            request,
            deferred,
            operation: "sessions",
            sort,
            search,
            page: pageRequest,
            resolvedAnalysis: qualified.resolvedAnalysis,
          });
          const fallbackFilters = membership
            ? deferred.qualification.filters
            : await prepareDeferredEventQualificationFallback(
                deferred.qualification,
              );
          if (qualified.postFallbackError)
            throw qualified.postFallbackError.error;
          const fallbackInput = {
            env: options.env,
            siteId: options.siteId,
            window,
            filters: fallbackFilters,
            sort,
            search,
            page: pageRequest,
            audience: request.context.policy.audience,
            analysisContext: request.analysisContext,
            ...(membership ? { membership } : {}),
          };
          const page = qualified.resolvedAnalysis
            ? await readSiteSessionsWithResolvedAnalysis(
                fallbackInput,
                qualified.resolvedAnalysis,
              )
            : await readSiteSessions(fallbackInput);
          return {
            value: {
              items: page.items,
              pagination: page.pagination,
            },
          };
        }
        const page = await readSiteSessions({
          env: options.env,
          siteId: options.siteId,
          window,
          filters,
          sort,
          search,
          page: pageRequest,
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
        const deferred = deferredJourneyEventPageQualificationFromQuery(
          request as unknown as QueryInput & Record<string, unknown>,
          "visitor-events",
        );
        const page =
          request.page && typeof request.page === "object"
            ? (request.page as {
                readonly limit?: unknown;
                readonly cursor?: unknown;
              })
            : {};
        if (deferred) {
          const qualified = await executeJourneyEventPageQualificationProgram({
            env: options.env,
            query: request as unknown as Record<string, unknown>,
            deferred,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (qualified.kind === "executed") return { value: qualified.result };
          if (options.diagnostics)
            options.diagnostics.advancedCountSqlFallbackReason =
              qualified.fallbackReason;
          const genericQualification = deferredEventQualificationFromQuery(
            request,
            "visitor-events",
          );
          if (genericQualification !== deferred.qualification)
            throw new Error("journey_event_page_qualification_request_invalid");
          // Session and visitor filters read one request-private entity
          // membership instead of the legacy ID bridge.
          const membership = await prepareJourneyListMembership({
            request,
            deferred,
            operation: "visitor-events",
            sort: null,
            search: undefined,
            page: deferred.configuration.page,
          });
          const fallbackFilters = membership
            ? deferred.qualification.filters
            : await prepareDeferredEventQualificationFallback(
                deferred.qualification,
              );
          return {
            value: await readSiteVisitorEvents({
              env: options.env,
              siteId: options.siteId,
              visitorId: deferred.configuration.target,
              window: timeWindow(request.time),
              filters: fallbackFilters,
              ...(membership ? { membership } : {}),
              audience: deferred.configuration.audience,
              page: deferred.configuration.page,
            }),
          };
        }
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
        const deferred = deferredSessionListQualificationFromQuery(
          request as unknown as QueryInput & Record<string, unknown>,
        );
        const page =
          request.page && typeof request.page === "object"
            ? (request.page as {
                readonly limit?: unknown;
                readonly cursor?: unknown;
              })
            : {};
        let filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        let membership:
          Awaited<ReturnType<typeof prepareJourneyListMembership>> | undefined;
        if (deferred) {
          if (deferred.operation !== "visitor-sessions")
            throw new Error("session_list_qualification_request_invalid");
          const qualified = await executeSessionListQualificationProgram({
            env: options.env,
            query: request as unknown as Record<string, unknown>,
            deferred,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (qualified.kind === "executed") return { value: qualified.result };
          if (options.diagnostics)
            options.diagnostics.advancedCountSqlFallbackReason =
              qualified.fallbackReason;
          membership = await prepareJourneyListMembership({
            request,
            deferred,
            operation: "visitor-sessions",
            sort: null,
            search: undefined,
            page,
          });
          filters = membership
            ? deferred.qualification.filters
            : await prepareDeferredEventQualificationFallback(
                deferred.qualification,
              );
        }
        return {
          value: await readSiteVisitorSessions({
            env: options.env,
            siteId: options.siteId,
            visitorId: stringField(request, "visitorId"),
            window: timeWindow(request.time),
            filters,
            ...(membership ? { membership } : {}),
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
        const deferred = deferredJourneyEventPageQualificationFromQuery(
          request as unknown as QueryInput & Record<string, unknown>,
          "session-events",
        );
        const page =
          request.page && typeof request.page === "object"
            ? (request.page as {
                readonly limit?: unknown;
                readonly cursor?: unknown;
              })
            : {};
        if (deferred) {
          const qualified = await executeJourneyEventPageQualificationProgram({
            env: options.env,
            query: request as unknown as Record<string, unknown>,
            deferred,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (qualified.kind === "executed") return { value: qualified.result };
          if (options.diagnostics)
            options.diagnostics.advancedCountSqlFallbackReason =
              qualified.fallbackReason;
          const genericQualification = deferredEventQualificationFromQuery(
            request,
            "session-events",
          );
          if (genericQualification !== deferred.qualification)
            throw new Error("journey_event_page_qualification_request_invalid");
          // Session and visitor filters read one request-private entity
          // membership instead of the legacy ID bridge.
          const membership = await prepareJourneyListMembership({
            request,
            deferred,
            operation: "session-events",
            sort: null,
            search: undefined,
            page: deferred.configuration.page,
          });
          const fallbackFilters = membership
            ? deferred.qualification.filters
            : await prepareDeferredEventQualificationFallback(
                deferred.qualification,
              );
          return {
            value: await readSiteSessionEvents({
              env: options.env,
              siteId: options.siteId,
              sessionId: deferred.configuration.target,
              window: timeWindow(request.time),
              filters: fallbackFilters,
              ...(membership ? { membership } : {}),
              audience: deferred.configuration.audience,
              page: deferred.configuration.page,
            }),
          };
        }
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
