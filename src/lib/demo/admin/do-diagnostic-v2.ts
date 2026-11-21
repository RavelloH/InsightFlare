import { DEMO_SITE_PROFILES } from "@/lib/demo/data/site-profiles";
import type {
  DoDiagnosticScanResponse,
  DoDiagnosticSiteEntry,
  DoDiagnosticSiteResponse,
} from "@/lib/system-performance";

import { generateDemoDoDiagnostic } from "./durable-objects";

type Params = Record<string, string | number>;

export function generateDemoDoDiagnosticScoped(params: Params):
  | DoDiagnosticSiteResponse
  | DoDiagnosticScanResponse
  | {
      ok: false;
      code: string;
    } {
  const scope = String(params.scope || "");
  if (scope !== "site" && scope !== "scan")
    return { ok: false, code: "invalid_scope" };
  const previous = generateDemoDoDiagnostic();
  const siteEntries: DoDiagnosticSiteEntry[] = previous.sites.map(
    (entry, index) =>
      index === 3
        ? { ...entry, ok: false, diagnostic: undefined, error: "timeout" }
        : entry,
  );
  const all = DEMO_SITE_PROFILES.map(
    (site) =>
      siteEntries.find((entry) => entry.siteId === site.id) ?? {
        siteId: site.id,
        siteName: site.name,
        siteDomain: site.domain,
        ok: false,
        error: "unavailable",
        durationMs: 4000,
      },
  ).sort((a, b) => a.siteId.localeCompare(b.siteId)) as DoDiagnosticSiteEntry[];
  const now = Date.now();
  if (scope === "site") {
    const siteId = String(params.siteId || "");
    const site = all.find((item) => item.siteId === siteId);
    if (!site) return { ok: false, code: "site_not_found" };
    return { ok: true, scope: "site", generatedAt: now, site };
  }
  const limit = Math.max(1, Math.min(50, Number(params.limit) || 20));
  const cursor = String(params.cursor || "");
  const matching = all.filter((site) => site.siteId > cursor);
  const selected = matching.slice(0, limit);
  const hasMore = matching.length > limit;
  const nextCursor =
    hasMore && selected.length ? selected[selected.length - 1].siteId : null;
  const reachable = selected.filter((item) => item.ok && item.diagnostic);
  const totals = {
    bufferedVisits: 0,
    openVisits: 0,
    openStale: 0,
    openTimedOut: 0,
    openHardAged: 0,
    openFutureSkewed: 0,
    dirtyVisits: 0,
    stuckDirtyVisits: 0,
    bufferedCustomEvents: 0,
    dirtyCustomEvents: 0,
    stuckDirtyCustomEvents: 0,
    activeAlarms: 0,
    maxVisitFlushAttempts: 0,
    maxCustomEventFlushAttempts: 0,
  };
  for (const entry of reachable) {
    const d = entry.diagnostic!;
    totals.bufferedVisits += d.visits.total;
    totals.openVisits += d.visits.open.total;
    totals.openStale += d.visits.open.stale;
    totals.openTimedOut += d.visits.open.timedOut;
    totals.openHardAged += d.visits.open.hardAged;
    totals.openFutureSkewed += d.visits.open.futureSkewed;
    totals.dirtyVisits += d.visits.dirty.total;
    totals.stuckDirtyVisits += d.visits.dirty.stuck;
    totals.bufferedCustomEvents += d.customEvents.total;
    totals.dirtyCustomEvents += d.customEvents.dirty;
    totals.stuckDirtyCustomEvents += d.customEvents.stuck;
    if (d.alarm.scheduledAt !== null) totals.activeAlarms++;
    totals.maxVisitFlushAttempts = Math.max(
      totals.maxVisitFlushAttempts,
      d.visits.dirty.maxFlushAttempts,
    );
    totals.maxCustomEventFlushAttempts = Math.max(
      totals.maxCustomEventFlushAttempts,
      d.customEvents.maxFlushAttempts,
    );
  }
  return {
    ok: true,
    scope: "scan",
    scanAt: now,
    generatedAt: now,
    totalSites: all.length,
    requestedSites: selected.length,
    processedSites: selected.length,
    reachableSites: reachable.length,
    unreachableSites: selected.length - reachable.length,
    partial: hasMore || reachable.length !== selected.length,
    hasMore,
    nextCursor,
    thresholds: previous.thresholds,
    totals,
    oldestOpenStartedAt: reachable.reduce<number | null>((earliest, entry) => {
      const value = entry.diagnostic?.visits.open.oldestStartedAt ?? null;
      return value === null
        ? earliest
        : earliest === null
          ? value
          : Math.min(value, earliest);
    }, null),
    futureMaxActivityAt: reachable.reduce<number | null>((latest, entry) => {
      const value = entry.diagnostic?.visits.open.futureMaxActivityAt ?? null;
      return value === null
        ? latest
        : latest === null
          ? value
          : Math.max(value, latest);
    }, null),
    sites: selected,
  };
}
