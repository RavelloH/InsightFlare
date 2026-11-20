import { AsyncLocalStorage } from "node:async_hooks";

import type { QueryOperation } from "@/lib/edge/analytics/contract";

import type { SafeFilterShape } from "./filter-shape";

/**
 * Explicit, code-owned logical query families. Each entry is tied to a
 * canonical provider operation, never to a request tag or SQL string.
 * Template changes remain versioned by the source module and git SHA.
 */
const PROVIDER_OPERATIONS = [
  "overview",
  "trend",
  "team-sites",
  "comparison",
  "comparison-breakdown",
  "dimension",
  "cross-dimension",
  "share-trend",
  "radar",
  "pages",
  "pages-dashboard",
  "referrers",
  "channels",
  "filter-values",
  "retention",
  "geo-points",
  "performance",
  "realtime",
  "event-summary",
  "event-trend",
  "event-types",
  "event-type-detail",
  "event-fields",
  "event-field-values",
  "event-context",
  "event-records",
  "visitor-events",
  "visitor-sessions",
  "session-events",
  "event-record-detail",
  "journey-event-detail",
  "visitors",
  "visitor-detail",
  "sessions",
  "session-detail",
  "funnel-analysis",
  "goal-summary",
  "goal-timeseries",
  "team-dashboard",
  "explore",
] as const satisfies readonly QueryOperation[];

const PROVIDER_TEMPLATE_OWNERS: Partial<Record<QueryOperation, string>> = {
  overview: "src/lib/edge/analytics/providers/d1/operations/overview-reader.ts",
  trend: "src/lib/edge/analytics/providers/d1/operations/overview-reader.ts",
  pages: "src/lib/edge/analytics/providers/d1/internal/pages.ts",
  "filter-values":
    "src/lib/edge/analytics/providers/d1/operations/site-filter-values.ts",
  performance:
    "src/lib/edge/analytics/providers/d1/operations/site-performance.ts",
  dimension: "src/lib/edge/analytics/providers/d1/operations/site-breakdown.ts",
  "event-summary":
    "src/lib/edge/analytics/providers/d1/operations/site-events.ts",
  "event-type-detail": "src/lib/edge/analytics/composition/d1/events.ts",
  "team-dashboard":
    "src/lib/edge/analytics/providers/d1/operations/team-dashboard.ts",
};

const SUBQUERY_TEMPLATES = [
  "event_type_detail.overview",
  "event_type_detail.trend",
  "event_type_detail.context_cards",
  "event_type_context",
] as const;

export const QUERY_VARIANTS = [
  "unknown",
  "raw.filtered",
  "raw.unfiltered",
  "rollup",
  "batch",
] as const;
export type QueryVariant = (typeof QUERY_VARIANTS)[number];
export const UNKNOWN_QUERY_ID = "unknown_d1" as const;

export type TrustedQueryIdentity = {
  readonly id: string;
  readonly variant: QueryVariant;
};

/** Small immutable registry; only literal code-owned IDs can be persisted. */
export const QUERY_REGISTRY: ReadonlyMap<
  string,
  {
    readonly id: string;
    readonly family: "analytics";
    readonly ownerModule: string;
    readonly baseSqlTemplateRef: string;
    readonly variants: readonly QueryVariant[];
    readonly revision: 1;
  }
> = new Map(
  [
    ...PROVIDER_OPERATIONS.map((operation) => ({
      id: `analytics.${operation}`,
      ownerModule:
        PROVIDER_TEMPLATE_OWNERS[operation] ??
        "src/lib/edge/analytics/providers/d1",
    })),
    ...SUBQUERY_TEMPLATES.map((name) => ({
      id: `analytics.${name}`,
      ownerModule: "src/lib/edge/analytics/composition/d1/events.ts",
    })),
  ].map(
    ({ id, ownerModule }) =>
      [
        id,
        Object.freeze({
          id,
          family: "analytics" as const,
          ownerModule,
          baseSqlTemplateRef: ownerModule,
          variants: QUERY_VARIANTS,
          revision: 1 as const,
        }),
      ] as const,
  ),
);

export function runWithRegisteredSubquery<T>(
  operation: string,
  action: () => T,
): T {
  // No arbitrary tag is accepted. Unknown wrappers retain their parent.
  const id = `analytics.${operation}`;
  if (!SUBQUERY_TEMPLATES.some((name) => `analytics.${name}` === id))
    return action();
  const parent = context.getStore();
  return context.run(
    {
      identity: verifiedQueryIdentity({
        id,
        variant: parent?.identity.variant ?? "unknown",
      }),
      ...(parent?.filter ? { filter: parent.filter } : {}),
    },
    action,
  );
}

export function registeredProviderQuery(operation: QueryOperation): string {
  const id = `analytics.${operation}`;
  return QUERY_REGISTRY.has(id) ? id : UNKNOWN_QUERY_ID;
}
export function verifiedQueryIdentity(
  identity: TrustedQueryIdentity | undefined,
): TrustedQueryIdentity {
  if (
    !identity ||
    !QUERY_REGISTRY.has(identity.id) ||
    !QUERY_VARIANTS.includes(identity.variant)
  )
    return { id: UNKNOWN_QUERY_ID, variant: "unknown" };
  return identity;
}
type QueryState = { identity: TrustedQueryIdentity; filter?: SafeFilterShape };
const context = new AsyncLocalStorage<QueryState | undefined>();

export function runWithQueryIdentity<T>(
  identity: TrustedQueryIdentity,
  action: () => T,
): T {
  return context.run({ identity: verifiedQueryIdentity(identity) }, action);
}
export function setCurrentQueryVariant(variant: QueryVariant): void {
  const state = context.getStore();
  if (state && QUERY_VARIANTS.includes(variant))
    state.identity = verifiedQueryIdentity({ ...state.identity, variant });
}
export function setCurrentQueryFilterShape(filter: SafeFilterShape): void {
  const state = context.getStore();
  if (state) state.filter = filter;
}
export function currentQueryFilterShape(): SafeFilterShape | undefined {
  return context.getStore()?.filter;
}
export function currentQueryIdentity(): TrustedQueryIdentity {
  return verifiedQueryIdentity(context.getStore()?.identity);
}
