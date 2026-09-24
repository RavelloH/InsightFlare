import {
  type AnalyticsProviderRegistry,
  typedQueryProviderFor,
} from "@/lib/edge/analytics/application/provider-registry";
import {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/analytics/providers/realtime/operations/site-realtime";
import type { Env } from "@/lib/edge/types";

/** Realtime source providers are composed beside the D1 site query providers. */
export function registerSiteRealtimeProviders(
  registry: AnalyticsProviderRegistry,
  options: { readonly env: Env; readonly siteId: string },
): void {
  registry.register(
    "realtime",
    typedQueryProviderFor("realtime", async (query, execution) => {
      const configuredSiteId = query.siteId ?? options.siteId;
      const startMs = query.time.range.startMs;
      const endExclusiveMs = query.time.range.endExclusiveMs;
      const signal = execution?.signal;
      const limit = query.limit ?? 20;

      switch (query.mode) {
        case "snapshot":
          return {
            value: await readSiteRealtimeSnapshot({
              env: options.env,
              siteId: configuredSiteId,
              startMs,
              endExclusiveMs,
              limit,
              signal,
            }),
          };
        case "active-visitors":
          return {
            value: await readSiteRealtimeActiveVisitors({
              env: options.env,
              siteId: configuredSiteId,
              startMs,
              endExclusiveMs,
              signal,
            }),
          };
        case "events":
          return {
            value: await readSiteRealtimeEvents({
              env: options.env,
              siteId: configuredSiteId,
              startMs,
              endExclusiveMs,
              limit,
              signal,
            }),
          };
        case "sessions":
          return {
            value: await readSiteRealtimeSessions({
              env: options.env,
              siteId: configuredSiteId,
              startMs,
              endExclusiveMs,
              limit,
              signal,
            }),
          };
        default:
          throw new Error("unsupported-realtime-query-mode");
      }
    }),
  );
}
