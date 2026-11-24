/** Local-first Search Core. No provider may perform a server search on keystrokes. */
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import {
  analyticsFilterRegistry,
  FILTER_DOCUMENT_VERSION,
  type FilterFieldId,
  normalizeFilterDocument,
  serializeFilterParams,
} from "@/lib/filter-contract";

export type SearchMode = "global" | "context" | "value" | "explicit-lookup";
export type SearchKind =
  "navigation" | "page" | "referrer" | "event" | "campaign" | "browser";
export type SearchCoverage =
  "static-navigation" | "local-observed-only" | "server-verified";

export interface SearchScope {
  userId: string;
  teamId?: string;
  siteId?: string;
}
export interface SearchRequest {
  query: string;
  mode: SearchMode;
  scope: SearchScope;
  field?: string;
  locale: string;
  limit?: number;
  signal?: AbortSignal;
  /** Only the explicit user action may set this; never an input change. */
  userInitiated?: boolean;
}
/** Navigation is expressed as authorized entity IDs, never a provider-owned URL. */
export const SITE_SEARCH_SECTIONS = [
  "overview",
  "realtime",
  "pages",
  "referrers",
  "campaigns",
  "sessions",
  "visitors",
  "events",
  "funnels",
  "goals",
  "retention",
  "geo",
  "devices",
  "browsers",
  "performance",
  "settings",
] as const;
export type SiteSearchSection = (typeof SITE_SEARCH_SECTIONS)[number];
export const SITE_OVERVIEW_METRICS = [
  "views",
  "visitors",
  "sessions",
  "bounceRate",
  "pagesPerSession",
  "avgDuration",
] as const;
export type SiteOverviewMetric = (typeof SITE_OVERVIEW_METRICS)[number];
export type SearchCommandGroup =
  "workspace" | "team" | "site" | "metric" | "section";
export type SearchNavigationTarget =
  | { kind: "app" }
  | { kind: "team"; teamId: string }
  | {
      kind: "site";
      teamId: string;
      siteId: string;
      section: SiteSearchSection;
      pagePath?: string;
      metric?: SiteOverviewMetric;
      visitorId?: string;
      sessionId?: string;
      eventName?: string;
      eventRecordId?: string;
      filter?: {
        field:
          | "referrer.domain"
          | "utm.source"
          | "utm.medium"
          | "utm.campaign"
          | "client.browser";
        value: string;
      };
    };
export type SearchAction =
  | { type: "navigate"; target: SearchNavigationTarget }
  | { type: "apply-filter"; field: string; value: string }
  | { type: "explicit-search"; query: string };
export type ResolvedSearchAction =
  | { type: "navigate"; href: string }
  | Exclude<SearchAction, { type: "navigate" }>;
export interface SearchResult {
  kind: SearchKind;
  key: string;
  label: string;
  subtitle?: string;
  group?: SearchCommandGroup;
  keywords?: readonly string[];
  scope: SearchScope;
  source: string;
  coverage: SearchCoverage;
  action: SearchAction;
  observedAt?: number;
}
/** Explicit providers may preserve successful hits when another bounded lookup fails. */
export interface ExplicitSearchOutcome {
  results: readonly SearchResult[];
  failed?: boolean;
  revoked?: boolean;
}
export type SearchProviderValue =
  readonly SearchResult[] | ExplicitSearchOutcome;
export interface SearchProvider {
  id: string;
  modes: readonly SearchMode[];
  cost: "local" | "remote";
  search(
    request: SearchRequest,
  ): SearchProviderValue | Promise<SearchProviderValue>;
}
export interface SearchResolutionContext {
  userId: string;
  locale: string;
  allowedTeamIds: ReadonlySet<string>;
  allowedSiteIds: ReadonlySet<string>;
  /** Trusted server-authorized ID-to-path maps, never supplied by a provider. */
  teamRoutes: ReadonlyMap<string, string>;
  siteRoutes: ReadonlyMap<
    string,
    {
      teamId: string;
      baseHref: string;
      sections: ReadonlySet<SiteSearchSection>;
    }
  >;
}
export function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
export function tokenize(value: string): string[] {
  return normalized(value)
    .split(/[\s/._:,\-?&=]+/u)
    .filter(Boolean);
}
export function matchScore(label: string, query: string): number {
  const term = normalized(query);
  if (!term) return 1;
  const text = normalized(label);
  if (text === term) return 100;
  if (text.startsWith(term)) return 80;
  if (tokenize(label).some((word) => word.startsWith(term))) return 60;
  return 0;
}
function sameScope(a: SearchScope, b: SearchScope): boolean {
  return (
    a.userId === b.userId &&
    (!a.teamId || !b.teamId || a.teamId === b.teamId) &&
    (!a.siteId || !b.siteId || a.siteId === b.siteId)
  );
}
export function resultMatchScore(result: SearchResult, query: string): number {
  return Math.max(
    matchScore(result.label, query),
    ...(result.keywords?.map((value) => matchScore(value, query)) ?? []),
  );
}
export function resultIdentity(result: SearchResult): string {
  return JSON.stringify([
    result.scope.userId,
    result.scope.teamId,
    result.scope.siteId,
    result.kind,
    result.key,
  ]);
}
export function mergeSearchResults(
  request: SearchRequest,
  groups: readonly (readonly SearchResult[])[],
): SearchResult[] {
  if (request.signal?.aborted) return [];
  const dedup = new Map<string, SearchResult>();
  for (const result of groups.flat()) {
    if (!sameScope(result.scope, request.scope)) continue;
    if (
      request.mode === "value" &&
      (result.action.type !== "apply-filter" ||
        result.action.field !== request.field)
    )
      continue;
    const score = resultMatchScore(result, request.query);
    if (
      !score &&
      !(
        request.mode === "explicit-lookup" &&
        result.coverage === "server-verified"
      )
    )
      continue;
    const id = resultIdentity(result);
    const old = dedup.get(id);
    if (
      !old ||
      (old.coverage === "local-observed-only" &&
        result.coverage === "server-verified")
    ) {
      dedup.set(id, result);
    }
  }
  return [...dedup.values()]
    .sort(
      (a, b) =>
        resultMatchScore(b, request.query) -
          resultMatchScore(a, request.query) ||
        (b.observedAt ?? 0) - (a.observedAt ?? 0) ||
        a.label.localeCompare(b.label) ||
        resultIdentity(a).localeCompare(resultIdentity(b)),
    )
    .slice(0, Math.min(Math.max(request.limit ?? 12, 1), 50));
}
export function searchLocal(
  request: SearchRequest,
  providers: readonly SearchProvider[],
): SearchResult[] {
  if (request.mode === "explicit-lookup" || request.signal?.aborted) return [];
  const groups: SearchResult[][] = [];
  for (const provider of providers) {
    if (provider.cost !== "local" || !provider.modes.includes(request.mode))
      continue;
    const result = provider.search(request);
    if (!Array.isArray(result))
      throw new Error("Local providers must return synchronously");
    groups.push([...(result as readonly SearchResult[])]);
  }
  return mergeSearchResults(request, groups);
}
export async function searchExplicit(
  request: SearchRequest,
  providers: readonly SearchProvider[],
): Promise<{
  status: "ok" | "unavailable" | "cancelled" | "error" | "revoked";
  results: SearchResult[];
  failed?: boolean;
}> {
  if (request.mode !== "explicit-lookup" || !request.userInitiated) {
    return { status: "unavailable", results: [] };
  }
  if (request.signal?.aborted) return { status: "cancelled", results: [] };
  const available = providers.filter(
    (p) => p.cost === "remote" && p.modes.includes("explicit-lookup"),
  );
  if (!available.length) return { status: "unavailable", results: [] };
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<"cancelled">((resolve) => {
    if (!request.signal) return;
    onAbort = () => resolve("cancelled");
    request.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Providers receive the same AbortSignal; even an uncooperative provider
    // cannot hold the UI waiting after cancellation.
    const outcomes = await Promise.race([
      Promise.allSettled(
        available.map(async (provider) => {
          const value = await provider.search(request);
          if (Array.isArray(value))
            return { results: value as readonly SearchResult[] };
          const explicit = value as ExplicitSearchOutcome;
          if (
            explicit &&
            typeof explicit === "object" &&
            Array.isArray(explicit.results)
          )
            return explicit;
          throw new Error("Invalid explicit search provider result");
        }),
      ),
      cancelled,
    ]);
    if (outcomes === "cancelled" || request.signal?.aborted)
      return { status: "cancelled", results: [] };
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<ExplicitSearchOutcome> =>
        outcome.status === "fulfilled",
    );
    const rejectedCount = outcomes.length - fulfilled.length;
    const providerFailed = fulfilled.some((outcome) => outcome.value.failed);
    const failed = rejectedCount > 0 || providerFailed;
    const revoked = fulfilled.some((outcome) => outcome.value.revoked);
    if (revoked) {
      return {
        status: "revoked",
        results: [],
        ...(failed ? { failed: true } : {}),
      };
    }
    if (!fulfilled.length) return { status: "error", results: [] };
    if (
      failed &&
      !fulfilled.some((outcome) => outcome.value.results.length > 0)
    )
      return { status: "error", results: [], failed: true };
    const results = mergeSearchResults(
      request,
      fulfilled.map((outcome) => outcome.value.results),
    );
    return {
      status: "ok",
      results,
      ...(failed ? { failed: true } : {}),
    };
  } catch {
    return {
      status: request.signal?.aborted ? "cancelled" : "error",
      results: [],
    };
  } finally {
    if (onAbort && request.signal)
      request.signal.removeEventListener("abort", onAbort);
  }
}
export function resolveSearchAction(
  result: SearchResult,
  context: SearchResolutionContext,
): ResolvedSearchAction | null {
  if (result.scope.userId !== context.userId) return null;
  if (result.scope.teamId && !context.allowedTeamIds.has(result.scope.teamId))
    return null;
  if (result.scope.siteId && !context.allowedSiteIds.has(result.scope.siteId))
    return null;
  if (result.action.type === "navigate") {
    const target = result.action.target;
    const root = "/" + context.locale + "/app";
    // Validate the final URL built from trusted routes, not just the result's scope.
    if (target.kind === "app") {
      return result.scope.teamId || result.scope.siteId
        ? null
        : { type: "navigate", href: root };
    }
    if (target.kind === "team") {
      if (result.scope.teamId !== target.teamId || result.scope.siteId)
        return null;
      const href = context.teamRoutes.get(target.teamId);
      if (!href || !isSafeRoute(href, root, 1)) return null;
      return { type: "navigate", href };
    }
    if (
      result.scope.teamId !== target.teamId ||
      result.scope.siteId !== target.siteId ||
      !context.allowedTeamIds.has(target.teamId) ||
      !context.allowedSiteIds.has(target.siteId)
    )
      return null;
    const route = context.siteRoutes.get(target.siteId);
    if (
      !route ||
      route.teamId !== target.teamId ||
      !route.sections.has(target.section) ||
      !isSafeRoute(route.baseHref, root, 2) ||
      !SITE_SEARCH_SECTIONS.includes(target.section)
    )
      return null;
    if (
      target.metric !== undefined &&
      (target.section !== "overview" ||
        target.pagePath !== undefined ||
        target.visitorId !== undefined ||
        target.sessionId !== undefined ||
        target.eventName !== undefined ||
        target.eventRecordId !== undefined ||
        target.filter !== undefined ||
        !SITE_OVERVIEW_METRICS.includes(target.metric))
    )
      return null;
    if (target.pagePath !== undefined && target.section !== "pages")
      return null;
    if (
      target.pagePath !== undefined &&
      (typeof target.pagePath !== "string" ||
        target.pagePath.length > 120 ||
        !target.pagePath.startsWith("/") ||
        target.pagePath.startsWith("//") ||
        /[?&#\\<>\p{Cc}]/u.test(target.pagePath))
    )
      return null;
    const detailTargets = [
      target.visitorId,
      target.sessionId,
      target.eventName,
      target.eventRecordId,
      target.filter,
    ].filter((value) => value !== undefined);
    if (detailTargets.length > 1) return null;
    if (
      target.visitorId !== undefined &&
      (target.section !== "visitors" ||
        !isSafeSearchParameter(target.visitorId))
    )
      return null;
    if (
      target.sessionId !== undefined &&
      (target.section !== "sessions" ||
        !isSafeSearchParameter(target.sessionId))
    )
      return null;
    if (
      target.eventName !== undefined &&
      (target.section !== "events" || !isSafeSearchParameter(target.eventName))
    )
      return null;
    if (
      target.eventRecordId !== undefined &&
      (target.section !== "events" ||
        !isSafeSearchParameter(target.eventRecordId))
    )
      return null;
    if (
      target.filter !== undefined &&
      (!target.filter ||
        typeof target.filter !== "object" ||
        !isValidSearchFilterField(target.filter.field) ||
        !isSafeSearchParameter(target.filter.value) ||
        !isValidFilterSection(target.section, target.filter.field))
    )
      return null;
    const suffix = target.section === "overview" ? "" : "/" + target.section;
    const params = new URLSearchParams();
    if (target.pagePath !== undefined) params.set("pagePath", target.pagePath);
    if (target.visitorId !== undefined) params.set("detail", target.visitorId);
    if (target.sessionId !== undefined) params.set("detail", target.sessionId);
    if (target.eventName !== undefined) params.set("detail", target.eventName);
    if (target.eventRecordId !== undefined)
      params.set("eventRecordId", target.eventRecordId);
    let query = params.toString();
    if (target.filter !== undefined) {
      const filterDocument = normalizeFilterDocument(
        {
          version: FILTER_DOCUMENT_VERSION,
          root: {
            kind: "condition",
            target: {
              kind: "field",
              field: target.filter.field as FilterFieldId,
            },
            operator: "eq",
            value: target.filter.value,
          },
        },
        analyticsFilterRegistry,
      );
      for (const [key, value] of serializeFilterParams(
        filterDocument,
        analyticsFilterRegistry,
      ))
        params.append(key, value);
      query = serializeDashboardSearchParams(params);
    }
    const detail = query ? "?" + query : "";
    const anchor = target.metric ? "#overview-metric-" + target.metric : "";
    return {
      type: "navigate",
      href: route.baseHref + suffix + detail + anchor,
    };
  }
  if (
    result.action.type === "apply-filter" &&
    result.coverage !== "local-observed-only" &&
    result.coverage !== "server-verified"
  )
    return null;
  return result.action;
}
const SEARCH_FILTER_FIELDS = new Set([
  "referrer.domain",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "client.browser",
]);
function isValidSearchFilterField(field: string): boolean {
  return SEARCH_FILTER_FIELDS.has(field);
}
function isValidFilterSection(
  section: SiteSearchSection,
  field: string,
): boolean {
  return field === "referrer.domain"
    ? section === "referrers"
    : field === "client.browser"
      ? section === "browsers"
      : section === "campaigns" && field.startsWith("utm.");
}
function isSafeSearchParameter(value: unknown): value is string {
  return Boolean(
    typeof value === "string" &&
    value === value.trim() &&
    value &&
    value.length <= 120 &&
    !/[\p{Cc}<>"'@?#\\]/u.test(value),
  );
}
/** Only slug paths from the authorized route tree can become destinations. */
function isSafeRoute(href: string, root: string, segments: number): boolean {
  if (!href.startsWith(root + "/") || /[?#\\\p{Cc}]/u.test(href)) return false;
  const parts = href.slice(root.length + 1).split("/");
  return (
    parts.length === segments &&
    parts.every((part) => /^[a-z0-9-]+$/iu.test(part))
  );
}
export function navigationProvider(
  entries: readonly {
    key: string;
    label: string;
    target: SearchNavigationTarget;
    scope: SearchScope;
    subtitle?: string;
    group?: SearchCommandGroup;
    keywords?: readonly string[];
  }[],
): SearchProvider {
  return {
    id: "navigation",
    modes: ["global", "context"],
    cost: "local",
    search: () =>
      entries.map((entry) => ({
        kind: "navigation" as const,
        key: entry.key,
        label: entry.label,
        scope: entry.scope,
        subtitle: entry.subtitle,
        group: entry.group,
        keywords: entry.keywords,
        source: "navigation",
        coverage: "static-navigation" as const,
        action: { type: "navigate" as const, target: entry.target },
      })),
  };
}
