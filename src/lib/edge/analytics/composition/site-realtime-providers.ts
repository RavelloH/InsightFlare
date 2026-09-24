import {
  type AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import type { QueryInput } from "@/lib/edge/analytics/contract";
import {
  type RealtimeQuery,
  type RealtimeQueryMode,
  type RealtimeQueryResult,
} from "@/lib/edge/analytics/contract";
import {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/analytics/providers/realtime/operations/site-realtime";
import type { Env } from "@/lib/edge/types";

function isRealtimeMode(value: unknown): value is RealtimeQueryMode {
  return (
    value === "snapshot" ||
    value === "active-visitors" ||
    value === "events" ||
    value === "sessions"
  );
}
function isRealtimeQuery(input: QueryInput): input is RealtimeQuery {
  return "time" in input && "mode" in input && isRealtimeMode(input.mode);
}

/** Realtime source providers are composed beside the D1 site query providers. */
export function registerSiteRealtimeProviders(
  registry: AnalyticsProviderRegistry,
  options: { readonly env: Env; readonly siteId: string },
): void {
  registry.register(
    "realtime",
    typedQueryProvider<RealtimeQueryResult>(async (input, execution) => {
      if (!input || !isRealtimeQuery(input)) {
        throw new Error("unsupported-realtime-query-mode");
      }
      const query = input;
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
