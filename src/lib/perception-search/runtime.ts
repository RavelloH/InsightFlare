import { fetchEventRecordDetail } from "@/lib/dashboard/client/data/events";
import { fetchSessionDetail } from "@/lib/dashboard/client/data/sessions";
import { fetchFilterValues } from "@/lib/dashboard/client/data/tabs";
import type { DashboardFilterOptionKey } from "@/lib/dashboard/client/data/types";
import { fetchVisitorDetail } from "@/lib/dashboard/client/data/visitors";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument, FilterFieldId } from "@/lib/filter-contract";

import {
  navigationProvider,
  type SearchCommandGroup,
  searchExplicit,
  searchLocal,
  type SearchNavigationTarget,
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
  target: SearchNavigationTarget;
  scope: SearchScope;
  subtitle?: string;
  group?: SearchCommandGroup;
  keywords?: readonly string[];
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
        clearRecentNavigation();
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
                  target: perceptionTarget(
                    item.scope.teamId,
                    item.scope.siteId,
                    item.field,
                    item.value,
                  ),
                },
        })),
  };
}
export function perceptionTarget(
  teamId: string,
  siteId: string,
  field:
    | "visitor"
    | "session"
    | "event-id"
    | "page.path"
    | "event.name"
    | "referrer.domain"
    | "utm.source"
    | "utm.medium"
    | "utm.campaign"
    | "client.browser",
  value: string,
): SearchNavigationTarget {
  const base = { kind: "site" as const, teamId, siteId };
  switch (field) {
    case "visitor":
      return { ...base, section: "visitors", visitorId: value };
    case "session":
      return { ...base, section: "sessions", sessionId: value };
    case "event-id":
      return { ...base, section: "events", eventRecordId: value };
    case "page.path":
      return { ...base, section: "pages", pagePath: value };
    case "event.name":
      return { ...base, section: "events", eventName: value };
    case "referrer.domain":
      return {
        ...base,
        section: "referrers",
        filter: { field, value },
      };
    case "utm.source":
    case "utm.medium":
    case "utm.campaign":
      return {
        ...base,
        section: "campaigns",
        filter: { field, value },
      };
    case "client.browser":
      return {
        ...base,
        section: "browsers",
        filter: { field, value },
      };
  }
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
  groups?: readonly SearchCommandGroup[],
): SearchResult[] {
  const auth = current;
  if (
    !auth ||
    request.scope.userId !== auth.userId ||
    (request.scope.teamId && !auth.allowedTeamIds.has(request.scope.teamId)) ||
    !isAuthorizedScope(request.scope, auth)
  )
    return [];
  const candidates = groups
    ? entries.filter((entry) => entry.group && groups.includes(entry.group))
    : entries;
  return searchLocal(request, [navigationProvider(candidates)]).filter(
    (result) => isAuthorizedScope(result.scope, auth),
  );
}
export function localPerceptionObservations(
  request: SearchRequest,
): SearchResult[] {
  if (!request.scope.siteId || !isAuthorizedScope(request.scope)) return [];
  return searchLocal(request, [observedProvider()]);
}

const recentNavigationKey = "insightflare-perception-navigation";
type RecentNavigation = Record<string, string[]>;

function readRecentNavigation(): RecentNavigation {
  try {
    return JSON.parse(localStorage.getItem(recentNavigationKey) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function recentPerceptionNavigation(scope: SearchScope): string[] {
  const recent = readRecentNavigation()[recentNavigationScope(scope)];
  return Array.isArray(recent)
    ? recent.filter((key) => typeof key === "string")
    : [];
}

function recentNavigationScope(scope: SearchScope): string {
  return JSON.stringify([
    scope.userId,
    scope.teamId || null,
    scope.siteId || null,
  ]);
}

export function rememberPerceptionNavigation(
  scope: SearchScope,
  result: SearchResult,
): void {
  if (
    result.coverage !== "static-navigation" ||
    !isAuthorizedScope(result.scope)
  )
    return;
  try {
    const recent = readRecentNavigation();
    const key = recentNavigationScope(scope);
    recent[key] = [
      result.key,
      ...recentPerceptionNavigation(scope).filter((id) => id !== result.key),
    ].slice(0, 5);
    localStorage.setItem(recentNavigationKey, JSON.stringify(recent));
  } catch {
    // Navigation still works when browser storage is unavailable.
  }
}

export function rememberCurrentPerceptionNavigation(section: string): void {
  const auth = current;
  if (!auth) return;
  const { userId, activeTeamId: teamId, activeSiteId: siteId } = auth;
  let scope: SearchScope = { userId };
  for (const [key, nextScope] of [
    [teamId && "team:" + teamId, { userId, teamId }],
    [siteId && "site:" + siteId, { userId, teamId, siteId }],
    [siteId && "section:" + siteId + ":" + section, { userId, teamId, siteId }],
  ] as const) {
    const candidate = entries.find((entry) => entry.key === key);
    if (candidate) {
      const result = navigationProvider([candidate]).search({
        query: "",
        mode: "global",
        locale: auth.locale,
        scope,
      });
      if (Array.isArray(result) && result[0])
        rememberPerceptionNavigation(scope, result[0]);
    }
    scope = nextScope;
  }
}

function clearRecentNavigation(): void {
  try {
    localStorage.removeItem(recentNavigationKey);
  } catch {
    // Browser storage can be disabled.
  }
}
export function revokePerceptionSite(siteId: string): void {
  if (!current?.activeTeamId || !current.allowedSiteIds.has(siteId)) return;
  invalidateScope(
    { userId: current.userId, teamId: current.activeTeamId, siteId },
    true,
  );
}
export async function clearPerceptionSession(): Promise<void> {
  clearRecentNavigation();
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

export type LookupKind =
  "visitor" | "session" | "event-id" | "id" | "page" | "event" | "referrer";
export type PerceptionLookupHit = {
  kind: Exclude<LookupKind, "id">;
  value: string;
  label?: string;
};
export type PerceptionLookupResult = {
  hits: PerceptionLookupHit[];
  failed: boolean;
  revoked: boolean;
};
type LookupOptions = {
  kind: LookupKind;
  value: string;
  scope: Required<SearchScope>;
  window: TimeWindow;
  signal: AbortSignal;
};
const lookupFilterKey = {
  page: "page.path" as DashboardFilterOptionKey,
  event: "event.name" as DashboardFilterOptionKey,
  referrer: "referrer.domain" as DashboardFilterOptionKey,
} as const;
type LookupFieldKind = keyof typeof lookupFilterKey;

function isExplicitAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = /^Request failed \((\d{3}) /u.exec(error.message)?.[1];
  return (
    status === "401" ||
    status === "403" ||
    (status === "404" && error.message.includes('"Site not found"'))
  );
}

function lookupError(
  error: unknown,
): Pick<PerceptionLookupResult, "failed" | "revoked"> {
  if (error instanceof Error && error.name === "AbortError") {
    return { failed: false, revoked: false };
  }
  return { failed: true, revoked: isExplicitAccessDenied(error) };
}

function isExactId(expected: string, actual: unknown): actual is string {
  return (
    typeof actual === "string" &&
    actual.normalize("NFKC").trim().toLocaleLowerCase() ===
      expected.normalize("NFKC").trim().toLocaleLowerCase()
  );
}

async function lookupExactEntity(
  kind: "visitor" | "session" | "event-id",
  value: string,
  scope: Required<SearchScope>,
  window: TimeWindow,
  signal: AbortSignal,
): Promise<PerceptionLookupResult> {
  try {
    if (kind === "visitor") {
      const response = await fetchVisitorDetail(
        scope.siteId,
        value,
        window.timeZone,
        window,
        { signal },
      );
      const visitor = response.data?.visitor;
      return {
        hits:
          response.ok && visitor && isExactId(value, visitor.visitorId)
            ? [{ kind, value: visitor.visitorId }]
            : [],
        failed: !response.ok,
        revoked: false,
      };
    }
    if (kind === "session") {
      const response = await fetchSessionDetail(
        scope.siteId,
        value,
        window.timeZone,
        window,
        { signal },
      );
      const sessionId = response.data?.session?.sessionId;
      return {
        hits:
          response.ok && isExactId(value, sessionId)
            ? [{ kind, value: sessionId }]
            : [],
        failed: !response.ok,
        revoked: false,
      };
    }
    const response = await fetchEventRecordDetail(scope.siteId, value, window, {
      signal,
      preserveErrors: true,
    });
    const eventId = response.data?.event?.eventId;
    return {
      hits:
        response.ok && isExactId(value, eventId)
          ? [{ kind, value: eventId }]
          : [],
      failed: !response.ok,
      revoked: false,
    };
  } catch (error) {
    return { hits: [], ...lookupError(error) };
  }
}

async function requestPerceptionHits(
  options: LookupOptions,
): Promise<PerceptionLookupResult> {
  const value = options.value.normalize("NFKC").trim();
  if (!value || options.signal.aborted)
    return { hits: [], failed: false, revoked: false };
  if (
    options.kind === "visitor" ||
    options.kind === "session" ||
    options.kind === "event-id"
  ) {
    return lookupExactEntity(
      options.kind,
      value,
      options.scope,
      options.window,
      options.signal,
    );
  }
  if (options.kind === "id") {
    // Bare UUID lookup has a fixed maximum of two exact detail requests.
    const matches = await Promise.all(
      (["visitor", "event-id"] as const).map((kind) =>
        lookupExactEntity(
          kind,
          value,
          options.scope,
          options.window,
          options.signal,
        ),
      ),
    );
    const revoked = matches.some((result) => result.revoked);
    return {
      hits: revoked ? [] : matches.flatMap((result) => result.hits),
      failed: matches.some((result) => result.failed),
      revoked,
    };
  }
  const fieldKind = options.kind as LookupFieldKind;
  const filterKey = lookupFilterKey[fieldKind];
  const exactFilter: FilterDocument = {
    version: 1,
    root: {
      kind: "condition",
      target: { kind: "field", field: filterKey as FilterFieldId },
      operator: "eq",
      value,
    },
  };
  let exactHits: PerceptionLookupHit[] = [];
  let failed = false;
  try {
    const exactValues = await fetchFilterValues(
      options.scope.siteId,
      options.window,
      filterKey,
      exactFilter,
      {
        limit: 1,
        exactMatch: true,
        preserveErrors: true,
        signal: options.signal,
      },
    );
    exactHits = exactValues.items
      .filter((item) => isExactId(value, item.value))
      .slice(0, 1)
      .map((item) => ({
        kind: fieldKind,
        value: item.value,
        ...(item.label !== item.value ? { label: item.label } : {}),
      }));
  } catch (error) {
    const status = lookupError(error);
    if (status.revoked) return { hits: [], ...status };
    failed = status.failed;
  }
  if (options.signal.aborted)
    return { hits: [], failed: false, revoked: false };
  try {
    const suggestions = await fetchFilterValues(
      options.scope.siteId,
      options.window,
      filterKey,
      undefined,
      {
        limit: 12,
        search: value,
        preserveErrors: true,
        signal: options.signal,
      },
    );
    const exactHitKeys = new Set(
      exactHits.map((hit) =>
        hit.value.normalize("NFKC").trim().toLocaleLowerCase(),
      ),
    );
    const hits = suggestions.items
      .filter((item) => item.value.trim().length > 0)
      .filter(
        (item) =>
          !exactHitKeys.has(
            item.value.normalize("NFKC").trim().toLocaleLowerCase(),
          ),
      )
      .map((item) => ({
        kind: fieldKind,
        value: item.value,
        ...(item.label !== item.value ? { label: item.label } : {}),
      }));
    return {
      hits: [...exactHits, ...hits].slice(0, 12),
      failed,
      revoked: false,
    };
  } catch (error) {
    const status = lookupError(error);
    return {
      hits: status.revoked ? [] : exactHits,
      failed: failed || status.failed,
      revoked: status.revoked,
    };
  }
}

/** Explicit, bounded, authenticated lookups. Results are returned in memory only. */
export async function lookupPerception({
  kind,
  value,
  scope,
  window: timeWindow,
  signal,
}: LookupOptions): Promise<PerceptionLookupResult> {
  if (signal.aborted) return { hits: [], failed: false, revoked: false };
  const authorizedScope = currentPerceptionScope(scope.siteId);
  if (
    !authorizedScope ||
    authorizedScope.userId !== scope.userId ||
    authorizedScope.teamId !== scope.teamId
  )
    return { hits: [], failed: false, revoked: true };
  const epoch = authorizationEpoch;
  const lookupHits = new Map<string, PerceptionLookupHit>();
  const provider: SearchProvider = {
    id: "explicit-lookup",
    modes: ["explicit-lookup"],
    cost: "remote",
    search: async () => {
      const result = await requestPerceptionHits({
        kind,
        value,
        scope,
        window: timeWindow,
        signal,
      });
      const results = result.hits.map((hit): SearchResult => {
        const key = JSON.stringify([hit.kind, hit.value, hit.label ?? null]);
        lookupHits.set(key, hit);
        return {
          kind:
            hit.kind === "page" ||
            hit.kind === "event" ||
            hit.kind === "referrer"
              ? hit.kind
              : "navigation",
          key,
          label: hit.label ?? hit.value,
          ...(hit.label && hit.label !== hit.value
            ? { keywords: [hit.value] }
            : {}),
          subtitle: hit.kind,
          scope,
          source: "explicit-lookup",
          coverage: "server-verified",
          action: { type: "explicit-search", query: hit.value },
        };
      });
      return { results, failed: result.failed, revoked: result.revoked };
    },
  };
  const result = await searchExplicit(
    {
      query: value,
      mode: "explicit-lookup",
      userInitiated: true,
      scope,
      locale: current?.locale ?? "en",
      limit: 12,
      signal,
    },
    [provider],
  );
  if (signal.aborted) return { hits: [], failed: false, revoked: false };
  const latestScope = currentPerceptionScope(scope.siteId);
  if (result.status === "revoked" || !isAuthorizedScope(scope))
    return { hits: [], failed: Boolean(result.failed), revoked: true };
  if (
    epoch !== authorizationEpoch ||
    !latestScope ||
    latestScope.userId !== scope.userId ||
    latestScope.teamId !== scope.teamId
  )
    return { hits: [], failed: Boolean(result.failed), revoked: false };
  return {
    hits:
      result.status === "ok"
        ? result.results.flatMap((item) => {
            const hit = lookupHits.get(item.key);
            return hit ? [hit] : [];
          })
        : [],
    failed: result.failed ?? result.status === "error",
    revoked: false,
  };
}
