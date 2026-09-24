import { DEMO_SITE_PROFILES } from "@/lib/demo/data/site-profiles";
import { fnv1a, mulberry32 } from "@/lib/demo/generators/utils";
import type {
  DoDiagnosticAggregate,
  DoDiagnosticSiteEntry,
} from "@/lib/system-performance";

import {
  DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
  DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
} from "./system-performance";
const DEMO_DO_HARD_AGED_MS = 36 * 60 * 60 * 1000;
const DEMO_DO_STUCK_FLUSH_ATTEMPTS = 5;
export function generateDemoDoDiagnostic(): DoDiagnosticAggregate {
  const generatedAt = Date.now();
  const sites: DoDiagnosticSiteEntry[] = DEMO_SITE_PROFILES.slice(0, 12).map(
    (site, index) => {
      const rng = mulberry32(fnv1a(`do-diag:${site.id}:${index}`));
      const openTotal = Math.floor(rng() * 30);
      const stale = Math.min(openTotal, Math.floor(rng() * 12));
      const timedOut = Math.min(stale, Math.floor(rng() * 4));
      const hardAged = index === 0 ? Math.floor(rng() * 3) : 0;
      const futureSkewed = index === 1 ? Math.floor(rng() * 2) : 0;
      const dirty = Math.floor(rng() * 8);
      const stuck = index < 2 ? Math.floor(rng() * 2) : 0;
      const customEventsTotal = Math.floor(rng() * 40);
      const customEventsDirty = Math.floor(rng() * 6);
      return {
        siteId: site.id,
        siteName: site.name,
        siteDomain: site.domain,
        ok: true,
        durationMs: Math.round(40 + rng() * 80),
        diagnostic: {
          ok: true,
          snapshotAt: generatedAt,
          thresholds: {
            staleMs: DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
            timeoutMs: DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
            hardAgedMs: DEMO_DO_HARD_AGED_MS,
            stuckFlushAttempts: DEMO_DO_STUCK_FLUSH_ATTEMPTS,
          },
          visits: {
            total: openTotal + Math.floor(rng() * 60),
            byStatus: { open: openTotal },
            open: {
              total: openTotal,
              stale,
              timedOut,
              hardAged,
              futureSkewed,
              oldestStartedAt:
                openTotal > 0
                  ? generatedAt - Math.floor(rng() * 12 * 60 * 60 * 1000)
                  : null,
              newestActivityAt:
                openTotal > 0
                  ? generatedAt - Math.floor(rng() * 60 * 1000)
                  : null,
              futureMaxActivityAt:
                futureSkewed > 0
                  ? generatedAt + Math.floor(rng() * 24 * 60 * 60 * 1000)
                  : null,
            },
            dirty: {
              total: dirty,
              stuck,
              maxFlushAttempts:
                stuck > 0 ? Math.floor(5 + rng() * 20) : Math.floor(rng() * 3),
            },
          },
          customEvents: {
            total: customEventsTotal,
            dirty: customEventsDirty,
            stuck: 0,
            maxFlushAttempts: Math.floor(rng() * 3),
            oldestOccurredAt:
              customEventsDirty > 0
                ? generatedAt - Math.floor(rng() * 30 * 60 * 1000)
                : null,
          },
          alarm: {
            scheduledAt:
              openTotal > 0
                ? generatedAt + Math.floor(rng() * 60 * 1000)
                : null,
            nextDueAt:
              openTotal > 0
                ? generatedAt + Math.floor(rng() * 60 * 1000)
                : null,
            nextDueKind: openTotal > 0 ? "visit_timeout" : null,
            nextDueEntity: openTotal > 0 ? "visit" : null,
          },
        },
      };
    },
  );

  const totals = sites.reduce(
    (acc, entry) => {
      const d = entry.diagnostic;
      if (!d) return acc;
      acc.bufferedVisits += d.visits.total;
      acc.openVisits += d.visits.open.total;
      acc.openStale += d.visits.open.stale;
      acc.openTimedOut += d.visits.open.timedOut;
      acc.openHardAged += d.visits.open.hardAged;
      acc.openFutureSkewed += d.visits.open.futureSkewed;
      acc.dirtyVisits += d.visits.dirty.total;
      acc.stuckDirtyVisits += d.visits.dirty.stuck;
      acc.bufferedCustomEvents += d.customEvents.total;
      acc.dirtyCustomEvents += d.customEvents.dirty;
      acc.stuckDirtyCustomEvents += d.customEvents.stuck;
      if (d.alarm.scheduledAt !== null) acc.activeAlarms += 1;
      acc.maxVisitFlushAttempts = Math.max(
        acc.maxVisitFlushAttempts,
        d.visits.dirty.maxFlushAttempts,
      );
      acc.maxCustomEventFlushAttempts = Math.max(
        acc.maxCustomEventFlushAttempts,
        d.customEvents.maxFlushAttempts,
      );
      return acc;
    },
    {
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
    },
  );

  const oldestOpenStartedAt = sites.reduce<number | null>((acc, entry) => {
    const value = entry.diagnostic?.visits.open.oldestStartedAt ?? null;
    if (value === null) return acc;
    if (acc === null) return value;
    return value < acc ? value : acc;
  }, null);
  const futureMaxActivityAt = sites.reduce<number | null>((acc, entry) => {
    const value = entry.diagnostic?.visits.open.futureMaxActivityAt ?? null;
    if (value === null) return acc;
    if (acc === null) return value;
    return value > acc ? value : acc;
  }, null);

  return {
    ok: true,
    generatedAt,
    totalSites: sites.length,
    reachableSites: sites.length,
    unreachableSites: 0,
    thresholds: {
      staleMs: DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
      timeoutMs: DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
      hardAgedMs: DEMO_DO_HARD_AGED_MS,
      stuckFlushAttempts: DEMO_DO_STUCK_FLUSH_ATTEMPTS,
    },
    totals,
    oldestOpenStartedAt,
    futureMaxActivityAt,
    sites,
  };
}
