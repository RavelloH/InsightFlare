import {
  navigationProvider,
  searchLocal,
  type SearchProvider,
  type SearchRequest,
  type SearchResolutionContext,
  type SearchResult,
  type SearchScope,
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
  href: string;
  scope: SearchScope;
  subtitle?: string;
};
let current: RuntimeContext | null = null;
let authorizationEpoch = 0;
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
    event: MessageEvent<{ type?: string; userId?: string }>,
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
    if (
      event.data?.type === "scope-clear" &&
      event.data.userId === current?.userId
    ) {
      perceptionIndex.resetMemory();
      if (
        current?.activeTeamId &&
        current.activeSiteId &&
        current.allowedTeamIds.has(current.activeTeamId) &&
        current.allowedSiteIds.has(current.activeSiteId)
      )
        void perceptionIndex.load({
          userId: current.userId,
          teamId: current.activeTeamId,
          siteId: current.activeSiteId,
        });
    }
  };
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
    (previous.userId !== context.userId ||
      !context.allowedTeamIds.has(previous.activeTeamId) ||
      !context.allowedSiteIds.has(previous.activeSiteId))
  ) {
    void perceptionIndex.clearScope({
      userId: previous.userId,
      teamId: previous.activeTeamId,
      siteId: previous.activeSiteId,
    });
    channel?.postMessage({ type: "scope-clear", userId: previous.userId });
  }
  current = context;
  entries = navigation;
  if (
    context.activeTeamId &&
    context.activeSiteId &&
    context.allowedTeamIds.has(context.activeTeamId) &&
    context.allowedSiteIds.has(context.activeSiteId)
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
    !current.allowedTeamIds.has(current.activeTeamId)
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
                  href: current?.activeSiteBase
                    ? current.activeSiteBase +
                      (item.field === "page.path"
                        ? "/pages?pagePath=" + encodeURIComponent(item.value)
                        : item.field === "referrer.domain"
                          ? "/referrers"
                          : item.field === "event.name"
                            ? "/events"
                            : item.field.startsWith("utm.")
                              ? "/campaigns"
                              : item.field === "client.browser"
                                ? "/browsers"
                                : "")
                    : "/",
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
    (request.scope.siteId && !auth.allowedSiteIds.has(request.scope.siteId))
  )
    return [];
  return searchLocal(request, [
    navigationProvider(entries),
    observedProvider(),
  ]);
}
export function revokePerceptionSite(siteId: string): void {
  if (current?.activeSiteId === siteId && current?.activeTeamId) {
    const scope = {
      userId: current.userId,
      teamId: current.activeTeamId,
      siteId,
    };
    void perceptionIndex.clearScope(scope);
  }
  channel?.postMessage({ type: "scope-clear", userId: current?.userId });
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
  }
  notify();
}
