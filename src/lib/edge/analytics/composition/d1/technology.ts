import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
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

import {
  type D1SiteQueryRuntimeOptions,
  numberField,
  query,
  stringField,
  timeWindow,
} from "./shared";

export function registerTechnologyProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry
    .register(
      "share-trend",
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const window = timeWindow(request.time);
        const interval = request.interval as never;
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const limit = numberField(request, "limit", 5);
        const variant = stringField(request, "variant", "browser");
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
                    stringField(request, "dimension") as never,
                    limit,
                  )
                : variant === "utm"
                  ? await queryUtmDimensionTrendFromD1(
                      options.env,
                      options.siteId,
                      window,
                      interval,
                      filters,
                      stringField(request, "dimension") as never,
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
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const variant = stringField(request, "variant", "browser");
        const value =
          variant === "version"
            ? await queryBrowserVersionBreakdownFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                numberField(request, "browserLimit", 0),
                numberField(request, "versionLimit", 5),
              )
            : variant === "referrer"
              ? await queryReferrerRadarFromD1(
                  options.env,
                  options.siteId,
                  window,
                  filters,
                  numberField(request, "limit", 24),
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
      typedQueryProvider(async (input) => {
        const request = query(input!);
        const window = timeWindow(request.time);
        const filters = request.filters ?? EMPTY_FILTER_DOCUMENT;
        const value =
          stringField(request, "variant") === "browser"
            ? await queryBrowserCrossBreakdownFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                numberField(request, "browserLimit", 8),
                numberField(request, "osLimit", 6),
                numberField(request, "deviceTypeLimit", 5),
              )
            : await queryCrossDimensionFromD1(
                options.env,
                options.siteId,
                window,
                filters,
                numberField(request, "primaryLimit", 5),
                numberField(request, "secondaryLimit", 6),
                request.primaryDimension as never,
                request.secondaryDimension as never,
              );
        return { value };
      }),
    );
}
