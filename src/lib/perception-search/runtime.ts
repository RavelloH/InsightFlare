import {
  navigationProvider,
  searchLocal,
  type SearchNavigationTarget,
  type SearchProvider,
  type SearchRequest,
  type SearchResolutionContext,
  type SearchResult,
  type SearchScope,
  type SiteSearchSection,
} from "./core";
import {
  type ObservedCandidate,
  perceptionIndex,
  safeCandidate,
  type SafeField,
} from "./index";

interface RuntimeContext extends SearchResolutionContext {
  activeTeamId?: string;
  activeSiteId?: string;
  activeSiteBase?: string;
}
type NavigationEntry = {
  key: string;
  label: string;
  target: SearchNavigationTarget;
  scope: SearchScope;
  subtitle?: string;
};
let current: RuntimeContext | null = null;
let authorizationEpoch = 0;
/** A revoked scope stays denied for this page session, even after failed IDB cleanup. */
const revokedScopes = new Set<string>();
const revocationKey = (scope: Required<SearchScope>) =>
  JSON.stringify([scope.userId, scope.teamId, scope.siteId]);
function isRevoked(scope: Required<SearchScope>): boolean {
  return revokedScopes.has(revocationKey(scope));
}
function isAuthorizedScope(
  scope: SearchScope,
  context: RuntimeContext | null = current,
): boolean {
  if (!context || scope.userId !== context.userId) return false;
  if (scope.teamId && !context.allowedTeamIds.has(scope.teamId)) return false;
  if (scope.siteId) {
    if (
      !scope.teamId ||
      !context.allowedSiteIds.has(scope.siteId) ||
      context.siteRoutes.get(scope.siteId)?.teamId !== scope.teamId ||
      isRevoked({
        userId: scope.userId,
        teamId: scope.teamId,
        siteId: scope.siteId,
      })
    )
      return false;
  }
  return true;
}
export interface ObservationGuard {
  userId: string;
  teamId: string;
  siteId: string;
  epoch: number;
}
let entries: readonly NavigationEntry[] = [];
const listeners = new Set<() => void>();
let runtimeRevision = 0;
const notify = () => {
  runtimeRevision++;
  for (const listener of listeners) listener();
};
export function getPerceptionVersion(): string {
  return runtimeRevision + ":" + perceptionIndex.getRevision();
}
let channel: BroadcastChannel | null = null;
function ensureChannel() {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel("insightflare-perception-v1");
  channel.onmessage = (
    event: MessageEvent<{
      type?: string;
      userId?: string;
      teamId?: string;
      siteId?: string;
    }>,
  ) => {
    if (event.data?.type === "clear" && event.data.userId) {
      if (current?.userId === event.data.userId) {
        current = null;
        authorizationEpoch++;
        entries = [];
        perceptionIndex.resetMemory();
        notify();
      }
      void perceptionIndex.clearUser(event.data.userId);
    }
    const active = current;
    if (
      event.data?.type === "scope-clear" &&
      active &&
      event.data.userId === active.userId
    ) {
      // Never reload from stale permissions before a fresh authorized response.
      const teamId = event.data.teamId ?? active.activeTeamId;
      const siteId = event.data.siteId ?? active.activeSiteId;
      if (teamId && siteId)
        invalidateScope({ userId: active.userId, teamId, siteId }, false);
    }
  };
}
/** Fail closed immediately, before any async IndexedDB operation. */
function invalidateScope(
  scope: Required<SearchScope>,
  broadcast: boolean,
): void {
  revokedScopes.add(revocationKey(scope));
  authorizationEpoch++;
  if (current?.userId === scope.userId) {
    if (current.activeTeamId === scope.teamId) {
      current = {
        ...current,
        allowedSiteIds: new Set(
          [...current.allowedSiteIds].filter((id) => id !== scope.siteId),
        ),
        siteRoutes: new Map(
          [...current.siteRoutes].filter(([id]) => id !== scope.siteId),
        ),
      };
    }
    entries = entries.filter(
      (entry) =>
        entry.scope.userId !== scope.userId ||
        entry.scope.teamId !== scope.teamId ||
        entry.scope.siteId !== scope.siteId,
    );
  }
  // clearScope synchronously evicts memory and invalidates in-flight loads,
  // then queues the persistent deletion after any already queued writes.
  void perceptionIndex.clearScope(scope);
  if (broadcast) channel?.postMessage({ type: "scope-clear", ...scope });
  notify();
}
export function setPerceptionAuthorization(
  context: RuntimeContext,
  navigation: readonly NavigationEntry[],
) {
  ensureChannel();
  const previous = current;
  if (
    !previous ||
    previous.userId !== context.userId ||
    previous.activeTeamId !== context.activeTeamId ||
    previous.activeSiteId !== context.activeSiteId ||
    Boolean(
      previous.activeSiteId &&
      previous.allowedSiteIds.has(previous.activeSiteId),
    ) !==
      Boolean(
        context.activeSiteId &&
        context.allowedSiteIds.has(context.activeSiteId),
      )
  ) {
    authorizationEpoch++;
  }
  if (previous && previous.userId !== context.userId) {
    perceptionIndex.resetMemory();
    void perceptionIndex.clearUser(previous.userId);
  }
  if (
    previous?.activeTeamId !== context.activeTeamId ||
    previous?.activeSiteId !== context.activeSiteId
  ) {
    perceptionIndex.resetMemory();
  }
  if (
    previous &&
    previous.activeTeamId &&
    previous.activeSiteId &&
    previous.userId === context.userId &&
    previous.activeTeamId === context.activeTeamId &&
    !context.allowedSiteIds.has(previous.activeSiteId)
  ) {
    invalidateScope(
      {
        userId: previous.userId,
        teamId: previous.activeTeamId,
        siteId: previous.activeSiteId,
      },
      true,
    );
  }
  // A stale React tree must not re-grant a site revoked by a live API response.
  const teamId = context.activeTeamId;
  current = {
    ...context,
    allowedTeamIds: new Set(context.allowedTeamIds),
    allowedSiteIds: new Set(
      [...context.allowedSiteIds].filter(
        (id) =>
          !teamId || !isRevoked({ userId: context.userId, teamId, siteId: id }),
      ),
    ),
    teamRoutes: new Map(context.teamRoutes),
    siteRoutes: new Map(
      [...context.siteRoutes].filter(
        ([id]) =>
          !teamId || !isRevoked({ userId: context.userId, teamId, siteId: id }),
      ),
    ),
  };
  entries = navigation.filter((entry) => isAuthorizedScope(entry.scope));
  if (
    context.activeTeamId &&
    context.activeSiteId &&
    current.allowedTeamIds.has(context.activeTeamId) &&
    current.allowedSiteIds.has(context.activeSiteId) &&
    !isRevoked({
      userId: context.userId,
      teamId: context.activeTeamId,
      siteId: context.activeSiteId,
    })
  ) {
    void perceptionIndex.load({
      userId: context.userId,
      teamId: context.activeTeamId,
      siteId: context.activeSiteId,
    });
  }
  notify();
}
export function getPerceptionAuthorization(): RuntimeContext | null {
  return current;
}
export function subscribePerception(listener: () => void): () => void {
  listeners.add(listener);
  const off = perceptionIndex.subscribe(listener);
  return () => {
    listeners.delete(listener);
    off();
  };
}
export function currentPerceptionScope(
  siteId: string,
): Required<SearchScope> | null {
  if (
    !current?.userId ||
    !current.activeTeamId ||
    !current.activeSiteId ||
    current.activeSiteId !== siteId ||
    !current.allowedSiteIds.has(siteId) ||
    !current.allowedTeamIds.has(current.activeTeamId) ||
    isRevoked({ userId: current.userId, teamId: current.activeTeamId, siteId })
  )
    return null;
  return { userId: current.userId, teamId: current.activeTeamId, siteId };
}
/** Snapshot permissions before starting an existing Analytics request. */
export function capturePerceptionGuard(
  siteId: string,
): ObservationGuard | null {
  const scope = currentPerceptionScope(siteId);
  return scope ? { ...scope, epoch: authorizationEpoch } : null;
}
/** Called only on successful, authorized Analytics results with the original request guard. */
export function observeLoadedDimension(
  siteId: string,
  field: SafeField,
  values: readonly (string | null | undefined)[],
  guard: ObservationGuard | null,
): void {
  const scope = currentPerceptionScope(siteId);
  if (
    !scope ||
    !guard ||
    guard.epoch !== authorizationEpoch ||
    guard.userId !== scope.userId ||
    guard.teamId !== scope.teamId ||
    guard.siteId !== scope.siteId
  )
    return;
  const candidates: ObservedCandidate[] = values.flatMap((value) => {
    const safe = safeCandidate(field, value);
    return safe ? [safe] : [];
  });
  perceptionIndex.observe(scope, candidates);
}
function observedProvider(): SearchProvider {
  return {
    id: "observed-dimensions",
    modes: ["global", "context", "value"],
    cost: "local",
    search: (request) =>
      perceptionIndex
        .search(
          request.scope,
          request.query,
          request.mode === "value" ? request.field : undefined,
          request.limit,
        )
        .map((item): SearchResult => ({
          kind: item.kind,
          key: item.id,
          label: item.value,
          source: "perception-index",
          coverage: "local-observed-only",
          scope: item.scope,
          observedAt: item.observedAt,
          subtitle: item.field,
          action:
            request.mode === "value"
              ? { type: "apply-filter", field: item.field, value: item.value }
              : {
                  type: "navigate",
                  target: {
                    kind: "site",
                    teamId: item.scope.teamId,
                    siteId: item.scope.siteId,
                    section: (item.field === "page.path"
                      ? "pages"
                      : item.field === "referrer.domain"
                        ? "referrers"
                        : item.field === "event.name"
                          ? "events"
                          : item.field.startsWith("utm.")
                            ? "campaigns"
                            : item.field === "client.browser"
                              ? "browsers"
                              : "overview") satisfies SiteSearchSection,
                    ...(item.field === "page.path"
                      ? { pagePath: item.value }
                      : {}),
                  },
                },
        })),
  };
}
export function localPerceptionSearch(request: SearchRequest): SearchResult[] {
  const auth = current;
  if (
    !auth ||
    request.scope.userId !== auth.userId ||
    (request.scope.teamId && !auth.allowedTeamIds.has(request.scope.teamId)) ||
    !isAuthorizedScope(request.scope, auth)
  )
    return [];
  return searchLocal(request, [
    navigationProvider(entries),
    observedProvider(),
  ]).filter((result) => isAuthorizedScope(result.scope, auth));
}
/** Navigation-only suggestions for an empty command palette. */
export function localPerceptionNavigation(
  request: SearchRequest,
): SearchResult[] {
  const auth = current;
  if (
    !auth ||
    request.scope.userId !== auth.userId ||
    (request.scope.teamId && !auth.allowedTeamIds.has(request.scope.teamId)) ||
    !isAuthorizedScope(request.scope, auth)
  )
    return [];
  return searchLocal(request, [navigationProvider(entries)]).filter((result) =>
    isAuthorizedScope(result.scope, auth),
  );
}
export function revokePerceptionSite(siteId: string): void {
  if (!current?.activeTeamId || !current.allowedSiteIds.has(siteId)) return;
  invalidateScope(
    { userId: current.userId, teamId: current.activeTeamId, siteId },
    true,
  );
}
export async function clearPerceptionSession(): Promise<void> {
  const userId = current?.userId;
  current = null;
  authorizationEpoch++;
  entries = [];
  perceptionIndex.resetMemory();
  if (userId) {
    channel?.postMessage({ type: "clear", userId });
    await perceptionIndex.clearUser(userId);
    for (const key of revokedScopes)
      if (key.startsWith(JSON.stringify([userId]).slice(0, -1) + ","))
        revokedScopes.delete(key);
  }
  notify();
}
