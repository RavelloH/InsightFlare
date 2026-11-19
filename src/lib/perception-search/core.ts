/** Local-first Search Core. No provider may perform a server search on keystrokes. */
export type SearchMode = "global" | "context" | "value" | "explicit-fulltext";
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
export type SearchAction =
  | { type: "navigate"; href: string }
  | { type: "apply-filter"; field: string; value: string }
  | { type: "explicit-search"; query: string };
export interface SearchResult {
  kind: SearchKind;
  key: string;
  label: string;
  subtitle?: string;
  scope: SearchScope;
  source: string;
  coverage: SearchCoverage;
  action: SearchAction;
  observedAt?: number;
}
export interface SearchProvider {
  id: string;
  modes: readonly SearchMode[];
  cost: "local" | "remote";
  search(
    request: SearchRequest,
  ): readonly SearchResult[] | Promise<readonly SearchResult[]>;
}
export interface SearchResolutionContext {
  userId: string;
  locale: string;
  allowedTeamIds: ReadonlySet<string>;
  allowedSiteIds: ReadonlySet<string>;
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
    const score = matchScore(result.label, request.query);
    if (!score) continue;
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
        matchScore(b.label, request.query) -
          matchScore(a.label, request.query) ||
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
  if (request.mode === "explicit-fulltext" || request.signal?.aborted)
    return [];
  const groups: SearchResult[][] = [];
  for (const provider of providers) {
    if (provider.cost !== "local" || !provider.modes.includes(request.mode))
      continue;
    const result = provider.search(request);
    if (!Array.isArray(result))
      throw new Error("Local providers must return synchronously");
    groups.push([...result]);
  }
  return mergeSearchResults(request, groups);
}
export async function searchExplicit(
  request: SearchRequest,
  providers: readonly SearchProvider[],
): Promise<{
  status: "ok" | "unavailable" | "cancelled";
  results: SearchResult[];
}> {
  if (request.mode !== "explicit-fulltext" || !request.userInitiated) {
    return { status: "unavailable", results: [] };
  }
  const available = providers.filter(
    (p) => p.cost === "remote" && p.modes.includes("explicit-fulltext"),
  );
  if (!available.length) return { status: "unavailable", results: [] };
  const groups = await Promise.all(
    available.map((provider) => Promise.resolve(provider.search(request))),
  );
  if (request.signal?.aborted) return { status: "cancelled", results: [] };
  return { status: "ok", results: mergeSearchResults(request, groups) };
}
export function resolveSearchAction(
  result: SearchResult,
  context: SearchResolutionContext,
): SearchAction | null {
  if (result.scope.userId !== context.userId) return null;
  if (result.scope.teamId && !context.allowedTeamIds.has(result.scope.teamId))
    return null;
  if (result.scope.siteId && !context.allowedSiteIds.has(result.scope.siteId))
    return null;
  if (result.action.type === "navigate") {
    const path = result.action.href;
    if (
      !path.startsWith("/" + context.locale + "/app") ||
      (path.length > ("/" + context.locale + "/app").length &&
        !["/", "?"].includes(path[("/" + context.locale + "/app").length])) ||
      path.startsWith("//") ||
      /[\\\p{Cc}]/u.test(path)
    )
      return null;
  }
  if (
    result.action.type === "apply-filter" &&
    result.coverage !== "local-observed-only" &&
    result.coverage !== "server-verified"
  )
    return null;
  return result.action;
}
export function navigationProvider(
  entries: readonly {
    key: string;
    label: string;
    href: string;
    scope: SearchScope;
    subtitle?: string;
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
        source: "navigation",
        coverage: "static-navigation" as const,
        action: { type: "navigate" as const, href: entry.href },
      })),
  };
}
