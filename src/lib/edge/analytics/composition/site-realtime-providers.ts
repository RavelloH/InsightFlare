import {
  type AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/analytics/providers/realtime/operations/site-realtime";
import type { Env } from "@/lib/edge/types";

type RealtimeQuery = {
  readonly siteId?: unknown;
  readonly queryMode?: unknown;
  readonly time: {
    readonly range: {
      readonly startMs: number;
      readonly endExclusiveMs: number;
    };
  };
  readonly limit?: unknown;
};
type RealtimeQueryResult =
  | Awaited<ReturnType<typeof readSiteRealtimeSnapshot>>
  | Awaited<ReturnType<typeof readSiteRealtimeActiveVisitors>>
  | Awaited<ReturnType<typeof readSiteRealtimeEvents>>
  | Awaited<ReturnType<typeof readSiteRealtimeSessions>>;

function siteId(query: RealtimeQuery, configuredSiteId: string): string {
  return typeof query.siteId === "string" ? query.siteId : configuredSiteId;
}

function limit(query: RealtimeQuery, fallback: number): number {
  return typeof query.limit === "number" && Number.isFinite(query.limit)
    ? query.limit
    : fallback;
}

/** Realtime source providers are composed beside the D1 site query providers. */
export function registerSiteRealtimeProviders(
  registry: AnalyticsProviderRegistry,
  options: { readonly env: Env; readonly siteId: string },
): void {
  registry.register(
    "realtime",
    typedQueryProvider<RealtimeQueryResult>(async (input, execution) => {
      const query = input as unknown as RealtimeQuery;
      const configuredSiteId = siteId(query, options.siteId);
      const startMs = query.time.range.startMs;
      const endExclusiveMs = query.time.range.endExclusiveMs;
      const signal = execution?.signal;

      switch (query.queryMode) {
        case "snapshot":
          return {
            value: await readSiteRealtimeSnapshot({
              env: options.env,
              siteId: configuredSiteId,
              startMs,
              endExclusiveMs,
              limit: limit(query, 20),
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
              limit: limit(query, 20),
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
              limit: limit(query, 20),
              signal,
            }),
          };
        default:
          throw new Error("unsupported-realtime-query-mode");
      }
    }),
  );
}
