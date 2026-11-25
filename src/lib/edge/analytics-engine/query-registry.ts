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

/** Approved SQL execution sites; each ID maps to one real source template.
 * No SQL hash, tag, URL or request-derived component is ever accepted.
 */
const STATIC_SQL_TEMPLATES = [
  {
    id: "analytics.dimension.batch",
    ownerModule: "src/lib/edge/analytics/providers/d1/internal/dimensions.ts",
    variants: ["raw.filtered"],
  },
  {
    id: "analytics.overview.raw.summary",
    ownerModule: "src/lib/edge/analytics/providers/d1/internal/overview.ts",
    variants: ["raw.filtered", "raw.unfiltered"],
  },
  {
    id: "analytics.trend.raw.series",
    ownerModule: "src/lib/edge/analytics/providers/d1/internal/overview.ts",
    variants: ["raw.filtered", "raw.unfiltered"],
  },
  {
    id: "analytics.team-sites.raw.latest_activity",
    ownerModule: "src/lib/edge/analytics/providers/d1/internal/team.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "analytics.overview.raw.latest_activity",
    ownerModule: "src/lib/edge/analytics/providers/d1/internal/overview.ts",
    variants: ["raw.filtered", "raw.unfiltered"],
  },
  {
    id: "analytics.rollup.aggregation_state",
    ownerModule:
      "src/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries.ts",
    variants: ["rollup"],
  },
  {
    id: "analytics.rollup.visit_details",
    ownerModule:
      "src/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "analytics.rollup.hourly_rows",
    ownerModule:
      "src/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries.ts",
    variants: ["rollup"],
  },
  {
    id: "analytics.rollup.trend_visit_details",
    ownerModule:
      "src/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "auth.api_keys.lookup_by_id",
    ownerModule: "src/lib/edge/auth/api-key-store.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "auth.api_keys.lookup_by_prefix",
    ownerModule: "src/lib/edge/auth/api-key-store.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.site_identities.lookup",
    ownerModule: "src/lib/edge/ingest/flush-types.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.site_identities.insert",
    ownerModule: "src/lib/edge/ingest/flush-types.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.dictionary.name.upsert",
    ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.dictionary.name.lookup",
    ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.dictionary.key.upsert",
    ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.dictionary.key.lookup",
    ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.dictionary.path.upsert",
    ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.dictionary.path.lookup",
    ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.visits.confirm_persisted",
    ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
    variants: ["raw.unfiltered"],
  },
  {
    id: "ingest.custom_events.confirm_persisted",
    ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
    variants: ["raw.unfiltered"],
  },
] as const;
export type StaticSqlTemplateId = (typeof STATIC_SQL_TEMPLATES)[number]["id"];

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
    readonly family: "analytics" | "auth" | "ingest";
    readonly ownerModule: string;
    readonly baseSqlTemplateRef: string;
    readonly variants: readonly QueryVariant[];
    readonly revision: 1;
    readonly granularity:
      "provider-family" | "query-operation" | "sql-template";
  }
> = new Map(
  [
    ...PROVIDER_OPERATIONS.map((operation) => ({
      id: `analytics.${operation}`,
      ownerModule:
        PROVIDER_TEMPLATE_OWNERS[operation] ??
        "src/lib/edge/analytics/providers/d1",
      granularity: "provider-family" as const,
      variants: QUERY_VARIANTS as readonly QueryVariant[],
    })),
    ...SUBQUERY_TEMPLATES.map((name) => ({
      id: `analytics.${name}`,
      ownerModule: "src/lib/edge/analytics/composition/d1/events.ts",
      granularity: "query-operation" as const,
      variants: QUERY_VARIANTS as readonly QueryVariant[],
    })),
    ...STATIC_SQL_TEMPLATES.map((template) => ({
      ...template,
      granularity: "sql-template" as const,
      variants: template.variants as readonly QueryVariant[],
    })),
    {
      id: "ingest.flush.visits",
      ownerModule: "src/lib/edge/ingest/flush.ts",
      granularity: "provider-family" as const,
      variants: ["batch"] as readonly QueryVariant[],
    },
    {
      id: "ingest.flush.custom_events",
      ownerModule: "src/lib/edge/ingest/custom-event-flush.ts",
      granularity: "provider-family" as const,
      variants: ["batch"] as readonly QueryVariant[],
    },
  ].map(
    ({ id, ownerModule, granularity, variants }) =>
      [
        id,
        Object.freeze({
          id,
          family: (id.startsWith("auth.")
            ? "auth"
            : id.startsWith("ingest.")
              ? "ingest"
              : "analytics") as "analytics" | "auth" | "ingest",
          ownerModule,
          baseSqlTemplateRef: ownerModule,
          variants,
          revision: 1 as const,
          granularity,
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

export function runWithStaticSqlTemplate<T>(
  identity: {
    readonly id: StaticSqlTemplateId;
    readonly variant: QueryVariant;
  },
  action: () => T,
): T {
  // The declared ID must be a static template and its variant must be allowed.
  const entry = QUERY_REGISTRY.get(identity.id);
  if (
    entry?.granularity !== "sql-template" ||
    !entry.variants.includes(identity.variant)
  )
    return action();
  const parent = context.getStore();
  return context.run(
    {
      identity: { id: identity.id, variant: identity.variant },
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
    !QUERY_REGISTRY.get(identity.id)?.variants.includes(identity.variant)
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
