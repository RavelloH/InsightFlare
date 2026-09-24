import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { resolveCrossBreakdownDimension } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import {
  queryBrowserCrossBreakdownFromD1,
  queryBrowserEngineTrendFromD1,
  queryBrowserTrendFromD1,
  queryBrowserVersionBreakdownFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/browser";
import { queryCrossDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
import {
  queryBrowserRadarFromD1,
  queryReferrerRadarFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/radar";
import {
  queryClientDimensionTrendFromD1,
  queryReferrerAndChannelTrendFromD1,
  queryReferrerTrendFromD1,
  queryUtmDimensionTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend";

import { type D1SiteRuntimeBindings, timeWindow } from "./shared";

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
        const value =
          variant === "browser"
            ? await queryBrowserTrendFromD1(
                options.env,
                options.siteId,
                window,
                interval,
                filters,
                limit,
              )
            : variant === "browser-engine"
              ? await queryBrowserEngineTrendFromD1(
                  options.env,
                  options.siteId,
                  window,
                  interval,
                  filters,
                  limit,
                )
              : variant === "client"
                ? await queryClientDimensionTrendFromD1(
                    options.env,
                    options.siteId,
                    window,
                    interval,
                    filters,
                    request.dimension,
                    limit,
                  )
                : variant === "utm"
                  ? await queryUtmDimensionTrendFromD1(
                      options.env,
                      options.siteId,
                      window,
                      interval,
                      filters,
                      request.dimension,
                      limit,
                    )
                  : variant === "referrer-channel"
                    ? await queryReferrerAndChannelTrendFromD1(
                        options.env,
                        options.siteId,
                        window,
                        interval,
                        filters,
                        limit,
                      )
                    : await queryReferrerTrendFromD1(
                        options.env,
                        options.siteId,
                        window,
                        interval,
                        filters,
                        limit,
                      );
        return { value };
      }),
    )
    .register(
      "radar",
      typedQueryProviderFor("radar", async (input) => {
        const request = input;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const value =
          request.variant === "version"
            ? await queryBrowserVersionBreakdownFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                request.browserLimit ?? 0,
                request.versionLimit ?? 5,
              )
            : request.variant === "referrer"
              ? await queryReferrerRadarFromD1(
                  options.env,
                  options.siteId,
                  window,
                  filters,
                  request.limit ?? 24,
                )
              : await queryBrowserRadarFromD1(
                  options.env,
                  options.siteId,
                  window,
                  filters,
                );
        return { value };
      }),
    )
    .register(
      "cross-dimension",
      typedQueryProviderFor("cross-dimension", async (input) => {
        const request = input;
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        if (request.variant === "browser") {
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
        const primaryDimension = resolveCrossBreakdownDimension(
          request.primaryDimension,
        );
        const secondaryDimension = resolveCrossBreakdownDimension(
          request.secondaryDimension,
        );
        if (
          !primaryDimension ||
          !secondaryDimension ||
          request.primaryDimension === request.secondaryDimension
        ) {
          throw new Error("unsupported-dimension");
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
