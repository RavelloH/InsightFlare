import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryAudience,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import {
  deferredCrossDimensionQualificationFromQuery,
  deferredRadarQualificationFromQuery,
  deferredShareTrendQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
  prepareDeferredPageVisitQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { resolveCrossBreakdownPageDimension } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import {
  mapBrowserCrossDimensionRows,
  mapBrowserVersionBreakdownRows,
  queryBrowserCrossBreakdownFromD1,
  queryBrowserEngineTrendFromD1,
  queryBrowserTrendFromD1,
  queryBrowserVersionBreakdownFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/browser";
import {
  mapCrossDimensionRows,
  queryCrossDimensionFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
import { executeCrossQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/technology/cross-qualification-program";
import {
  type TechnologyPageVisitConsumer,
  type TechnologyPageVisitQualification,
  technologyPageVisitQualificationConsumerKey,
} from "@/lib/edge/analytics/providers/d1/internal/technology/page-visit-qualification";
import {
  mapTechnologyRadarRows,
  queryBrowserRadarFromD1,
  queryReferrerRadarFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/radar";
import { executeRadarQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/technology/radar-qualification-program";
import {
  mapQualifiedShareTrendRows,
  queryClientDimensionTrendFromD1,
  queryReferrerAndChannelTrendFromD1,
  queryReferrerTrendFromD1,
  queryUtmDimensionTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend";
import { executeShareTrendQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend-qualification-program";

import { type D1SiteRuntimeBindings, timeWindow } from "./shared";

async function prepareTechnologyPageVisitQualification(input: {
  readonly deferred: unknown;
  readonly qualification: {
    readonly metadata: { readonly plan: ScopedFilterPlan };
    readonly requestTime?: QueryTime;
    readonly time: QueryTime;
  };
  readonly consumer: TechnologyPageVisitConsumer;
  readonly configuration: unknown;
  readonly readerQueryTime: QueryTime;
  readonly readerAudience: QueryAudience;
}): Promise<TechnologyPageVisitQualification | undefined> {
  const consumerKey = technologyPageVisitQualificationConsumerKey(
    input.consumer,
    input.configuration,
  );
  const preparation = await prepareDeferredPageVisitQualification(
    input.deferred,
    consumerKey,
    {
      readerQueryTime: input.readerQueryTime,
      readerAudience: input.readerAudience,
    },
  );
  return preparation
    ? {
        preparation,
        queryTime: input.readerQueryTime,
        preparationQueryTime:
          input.qualification.requestTime ?? input.qualification.time,
        scopePlan: input.qualification.metadata.plan,
        consumerKey,
      }
    : undefined;
}

export function registerTechnologyProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteRuntimeBindings,
): void {
  registry
    .register(
      "share-trend",
      typedQueryProviderFor("share-trend", async (input) => {
        const request = input;
        const window = timeWindow(request.time);
        const interval = request.interval;
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const limit = request.limit ?? 5;
        const variant = request.variant;
        const readLegacy = async (
          legacyFilters: typeof filters,
          qualification?: TechnologyPageVisitQualification,
        ) =>
          variant === "browser"
            ? await queryBrowserTrendFromD1(
                options.env,
                options.siteId,
                window,
                interval,
                legacyFilters,
                limit,
                ...(qualification ? [qualification] : []),
              )
            : variant === "browser-engine"
              ? await queryBrowserEngineTrendFromD1(
                  options.env,
                  options.siteId,
                  window,
                  interval,
                  legacyFilters,
                  limit,
                  ...(qualification ? [qualification] : []),
                )
              : variant === "client"
                ? await queryClientDimensionTrendFromD1(
                    options.env,
                    options.siteId,
                    window,
                    interval,
                    legacyFilters,
                    request.dimension,
                    limit,
                    ...(qualification ? [qualification] : []),
                  )
                : variant === "utm"
                  ? await queryUtmDimensionTrendFromD1(
                      options.env,
                      options.siteId,
                      window,
                      interval,
                      legacyFilters,
                      request.dimension,
                      limit,
                      ...(qualification ? [qualification] : []),
                    )
                  : variant === "referrer-channel"
                    ? await queryReferrerAndChannelTrendFromD1(
                        options.env,
                        options.siteId,
                        window,
                        interval,
                        legacyFilters,
                        limit,
                        ...(qualification ? [qualification] : []),
                      )
                    : await queryReferrerTrendFromD1(
                        options.env,
                        options.siteId,
                        window,
                        interval,
                        legacyFilters,
                        limit,
                        ...(qualification ? [qualification] : []),
                      );
        const deferred = deferredShareTrendQualificationFromQuery(request);
        if (deferred) {
          const execution = await executeShareTrendQualificationProgram({
            env: options.env,
            deferred,
            query: request,
            configuration: deferred.configuration,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (execution.kind === "executed")
            return {
              value: mapQualifiedShareTrendRows(
                execution.rows,
                window,
                interval,
                deferred.configuration,
              ),
            };
          const readerQueryTime = queryWindowToTime(window);
          const pageVisitQualification =
            await prepareTechnologyPageVisitQualification({
              deferred: deferred.qualification,
              qualification: deferred.qualification,
              consumer: "share-trend",
              configuration: deferred.configuration,
              readerQueryTime,
              readerAudience: request.context.policy.audience,
            });
          if (pageVisitQualification)
            return { value: await readLegacy(filters, pageVisitQualification) };
          const fallbackFilters =
            await prepareDeferredEventQualificationFallback(
              deferred.qualification,
            );
          return { value: await readLegacy(fallbackFilters) };
        }
        const value = await readLegacy(filters);
        return { value };
      }),
    )
    .register(
      "radar",
      typedQueryProviderFor("radar", async (input) => {
        const request = input;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const readLegacy = async (
          legacyFilters: typeof filters,
          qualification?: TechnologyPageVisitQualification,
        ) =>
          request.variant === "version"
            ? await queryBrowserVersionBreakdownFromD1(
                options.env,
                options.siteId,
                window,
                legacyFilters,
                request.browserLimit ?? 0,
                request.versionLimit ?? 5,
                ...(qualification ? [qualification] : []),
              )
            : request.variant === "referrer"
              ? await queryReferrerRadarFromD1(
                  options.env,
                  options.siteId,
                  window,
                  legacyFilters,
                  request.limit ?? 24,
                  ...(qualification ? [qualification] : []),
                )
              : await queryBrowserRadarFromD1(
                  options.env,
                  options.siteId,
                  window,
                  legacyFilters,
                  ...(qualification ? [qualification] : []),
                );
        const deferred = deferredRadarQualificationFromQuery(request);
        if (deferred) {
          const execution = await executeRadarQualificationProgram({
            env: options.env,
            deferred,
            query: request,
            configuration: deferred.configuration,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (execution.kind === "executed") {
            if (deferred.configuration.dimension === "version")
              return {
                value: mapBrowserVersionBreakdownRows(
                  execution.rows,
                  deferred.configuration.versionLimit,
                ),
              };
            const rows =
              deferred.configuration.dimension === "browser"
                ? mapTechnologyRadarRows(execution.rows, "browser").filter(
                    (row) => row.browser.length > 0 && row.visitors > 0,
                  )
                : mapTechnologyRadarRows(execution.rows, "referrer").filter(
                    (row) => row.visitors > 0,
                  );
            return { value: rows };
          }
          const readerQueryTime = queryWindowToTime(window);
          const pageVisitQualification =
            await prepareTechnologyPageVisitQualification({
              deferred: deferred.qualification,
              qualification: deferred.qualification,
              consumer: "radar",
              configuration: deferred.configuration,
              readerQueryTime,
              readerAudience: request.context.policy.audience,
            });
          if (pageVisitQualification)
            return { value: await readLegacy(filters, pageVisitQualification) };
          const fallbackFilters =
            await prepareDeferredEventQualificationFallback(
              deferred.qualification,
            );
          return { value: await readLegacy(fallbackFilters) };
        }
        return { value: await readLegacy(filters) };
      }),
    )
    .register(
      "cross-dimension",
      typedQueryProviderFor("cross-dimension", async (input) => {
        const request = input;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        if (request.variant === "browser") {
          const deferred =
            deferredCrossDimensionQualificationFromQuery(request);
          if (
            deferred &&
            "family" in deferred.configuration &&
            deferred.configuration.family === "browser"
          ) {
            const execution = await executeCrossQualificationProgram({
              env: options.env,
              deferred,
              query: request,
              configuration: deferred.configuration,
              ...(options.diagnostics
                ? { diagnostics: options.diagnostics }
                : {}),
            });
            if (execution.kind === "browser-executed")
              return {
                value: {
                  operatingSystem: mapBrowserCrossDimensionRows(
                    execution.operatingSystemRows,
                    "os",
                  ),
                  deviceType: mapBrowserCrossDimensionRows(
                    execution.deviceTypeRows,
                    "device",
                  ),
                },
              };
            const readerQueryTime = queryWindowToTime(window);
            const pageVisitQualification =
              await prepareTechnologyPageVisitQualification({
                deferred: deferred.qualification,
                qualification: deferred.qualification,
                consumer: "browser-cross",
                configuration: deferred.configuration,
                readerQueryTime,
                readerAudience: request.context.policy.audience,
              });
            if (pageVisitQualification)
              return {
                value: await queryBrowserCrossBreakdownFromD1(
                  options.env,
                  options.siteId,
                  window,
                  filters,
                  request.browserLimit ?? 8,
                  request.osLimit ?? 6,
                  request.deviceTypeLimit ?? 5,
                  pageVisitQualification,
                ),
              };
            const fallbackFilters =
              await prepareDeferredEventQualificationFallback(
                deferred.qualification,
              );
            return {
              value: await queryBrowserCrossBreakdownFromD1(
                options.env,
                options.siteId,
                window,
                fallbackFilters,
                request.browserLimit ?? 8,
                request.osLimit ?? 6,
                request.deviceTypeLimit ?? 5,
              ),
            };
          }
          const value = await queryBrowserCrossBreakdownFromD1(
            options.env,
            options.siteId,
            window,
            filters,
            request.browserLimit ?? 8,
            request.osLimit ?? 6,
            request.deviceTypeLimit ?? 5,
          );
          return { value };
        }
        const primaryDimension = resolveCrossBreakdownPageDimension(
          request.primaryDimension,
        );
        const secondaryDimension = resolveCrossBreakdownPageDimension(
          request.secondaryDimension,
        );
        if (
          !primaryDimension ||
          !secondaryDimension ||
          request.primaryDimension === request.secondaryDimension
        ) {
          throw new Error("unsupported-dimension");
        }
        const deferred = deferredCrossDimensionQualificationFromQuery(request);
        if (deferred) {
          if (!("primarySelection" in deferred.configuration))
            throw new Error(
              "cross_dimension_qualification_configuration_invalid",
            );
          const configuration = deferred.configuration;
          const execution = await executeCrossQualificationProgram({
            env: options.env,
            deferred,
            query: request,
            configuration,
            ...(options.diagnostics
              ? { diagnostics: options.diagnostics }
              : {}),
          });
          if (execution.kind === "executed")
            return {
              value: mapCrossDimensionRows(
                execution.rows,
                {
                  selection: configuration.primarySelection,
                  fallbackKeyBase: configuration.primaryFallbackKeyBase,
                },
                {
                  selection: configuration.secondarySelection,
                  fallbackKeyBase: configuration.secondaryFallbackKeyBase,
                },
              ),
            };
          const readerQueryTime = queryWindowToTime(window);
          const pageVisitQualification =
            await prepareTechnologyPageVisitQualification({
              deferred: deferred.qualification,
              qualification: deferred.qualification,
              consumer: "cross",
              configuration,
              readerQueryTime,
              readerAudience: request.context.policy.audience,
            });
          if (pageVisitQualification)
            return {
              value: await queryCrossDimensionFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                request.primaryLimit,
                request.secondaryLimit,
                primaryDimension,
                secondaryDimension,
                pageVisitQualification,
              ),
            };
          const fallbackFilters =
            await prepareDeferredEventQualificationFallback(
              deferred.qualification,
            );
          return {
            value: await queryCrossDimensionFromD1(
              options.env,
              options.siteId,
              window,
              fallbackFilters,
              request.primaryLimit,
              request.secondaryLimit,
              primaryDimension,
              secondaryDimension,
            ),
          };
        }
        const value = await queryCrossDimensionFromD1(
          options.env,
          options.siteId,
          window,
          filters,
          request.primaryLimit,
          request.secondaryLimit,
          primaryDimension,
          secondaryDimension,
        );
        return { value };
      }),
    );
}
