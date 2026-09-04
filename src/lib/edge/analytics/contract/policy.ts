import {
  ANALYTICS_FILTER_REGISTRY_REVISION,
  filterIdsForAudience,
} from "./filter-registry";
import type {
  AnalyticsDomainError,
  DetailCapability,
  QueryAudience,
  QueryContext,
  QueryLimits,
  QueryOperation,
  QueryPolicy,
  SiteId,
  TeamId,
} from "./types";

const DEFAULT_LIMITS: QueryLimits = {
  maxBuckets: 2_000,
  maxCursorBytes: 12_288,
  maxFilterClauses: 96,
  maxLimit: 500,
  maxOffset: 20_000,
};

const ALL_OPERATIONS: readonly QueryOperation[] = [
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
  "geo-points",
  "retention",
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
  "event-record-detail",
  "journey-event-detail",
  "visitor-events",
  "visitor-sessions",
  "session-events",
  "visitors",
  "visitor-detail",
  "sessions",
  "session-detail",
  "funnel-analysis",
  "team-dashboard",
  "explore",
];

const PUBLIC_OPERATIONS: readonly QueryOperation[] = [
  "overview",
  "trend",
  "dimension",
  "cross-dimension",
  "share-trend",
  "radar",
  "pages",
  "pages-dashboard",
  "referrers",
  "channels",
  "filter-values",
  "geo-points",
  "retention",
  "performance",
  "event-types",
];

const PRIVATE_DETAILS = new Set<DetailCapability>([
  "page.query",
  "page.hash",
  "referrer.url",
  "precise-location",
  "event.payload",
  "event.context",
  "event.breakdowns",
  "event.fields",
  "visitor.trajectory",
  "session.trajectory",
]);

function policy(
  audience: QueryAudience,
  allowedOperations: readonly QueryOperation[],
  allowedDetails: ReadonlySet<DetailCapability>,
): QueryPolicy {
  return {
    revision: `query-contract-v1/${ANALYTICS_FILTER_REGISTRY_REVISION}`,
    audience,
    allowedOperations: new Set(allowedOperations),
    allowedDimensions: new Set(),
    allowedFilters: filterIdsForAudience(audience),
    allowedDetails,
    limits: DEFAULT_LIMITS,
    allowedPagination: new Set(["none", "offset", "keyset"]),
  };
}

export function queryPolicyForAudience(audience: QueryAudience): QueryPolicy {
  return audience === "public-share"
    ? policy(audience, PUBLIC_OPERATIONS, new Set())
    : policy(audience, ALL_OPERATIONS, PRIVATE_DETAILS);
}

export function siteQueryContext(
  siteId: string,
  audience: QueryAudience,
): QueryContext {
  return {
    subject: { kind: "site", siteId: siteId as SiteId },
    policy: queryPolicyForAudience(audience),
  };
}

export function teamQueryContext(
  teamId: string,
  audience: QueryAudience,
  authorizedSiteIds: readonly string[] = [],
): QueryContext {
  return {
    subject: {
      kind: "team",
      teamId: teamId as TeamId,
      authorizedSiteIds: authorizedSiteIds as readonly SiteId[],
    },
    policy: queryPolicyForAudience(audience),
  };
}

export function assertOperationAllowed(
  context: QueryContext,
  operation: QueryOperation,
): AnalyticsDomainError | null {
  return context.policy.allowedOperations.has(operation)
    ? null
    : { kind: "capability-denied", capability: operation };
}

export function assertDetailAllowed(
  context: QueryContext,
  detail: DetailCapability,
): AnalyticsDomainError | null {
  return context.policy.allowedDetails.has(detail)
    ? null
    : { kind: "capability-denied", capability: detail };
}
