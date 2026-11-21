import { createDatabaseRuntime } from "@/lib/db";
import type { Env } from "@/lib/edge/types";
import { bad, forb, jsonResponseFor, na, nf } from "@/lib/response";
import type {
  DoDiagnosticAggregate,
  DoDiagnosticPayload,
  DoDiagnosticScanResponse,
  DoDiagnosticSiteEntry,
  DoDiagnosticSiteResponse,
} from "@/lib/system-performance";

type AdminActor = { isAdmin: boolean };
type RequireActor = (env: Env, req: Request) => Promise<AdminActor | Response>;
type Site = { id: string; name: string; domain: string };

const FETCH_TIMEOUT_MS = 4_000;
const MAX_CONCURRENCY = 8;
const DEFAULT_SCAN_LIMIT = 20;
const MAX_SCAN_LIMIT = 50;
const SITE_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const THRESHOLDS = {
  staleMs: 30 * 60 * 1000,
  timeoutMs: 12 * 60 * 60 * 1000,
  hardAgedMs: 36 * 60 * 60 * 1000,
  stuckFlushAttempts: 5,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isDiagnostic(value: unknown): value is DoDiagnosticPayload {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.snapshotAt !== "number" ||
    !Number.isFinite(value.snapshotAt) ||
    !isRecord(value.visits) ||
    !isRecord(value.customEvents) ||
    !isRecord(value.alarm) ||
    !isRecord(value.thresholds)
  )
    return false;
  const visits = value.visits;
  return (
    typeof visits.total === "number" &&
    isRecord(visits.open) &&
    isRecord(visits.dirty) &&
    typeof visits.open.total === "number" &&
    typeof visits.open.stale === "number" &&
    typeof visits.open.timedOut === "number" &&
    typeof visits.open.hardAged === "number" &&
    typeof visits.open.futureSkewed === "number" &&
    typeof visits.dirty.total === "number" &&
    typeof visits.dirty.stuck === "number" &&
    typeof visits.dirty.maxFlushAttempts === "number" &&
    typeof value.customEvents.total === "number" &&
    typeof value.customEvents.dirty === "number" &&
    typeof value.customEvents.stuck === "number" &&
    typeof value.customEvents.maxFlushAttempts === "number"
  );
}

/** Only contacts this site's DO. No global scan and no mutations or alarm scheduling. */
async function fetchSiteDiagnostic(
  env: Env,
  site: Site,
): Promise<DoDiagnosticSiteEntry> {
  const started = Date.now();
  const base = {
    siteId: site.id,
    siteName: site.name || site.id,
    siteDomain: site.domain || "",
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = (async (): Promise<DoDiagnosticSiteEntry> => {
    try {
      const stub = env.INGEST_DO.get(env.INGEST_DO.idFromName(site.id));
      const response = await stub.fetch("https://ingest.internal/diagnostic", {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ...base,
          ok: false,
          durationMs: Date.now() - started,
          error: "http_status",
        };
      }
      const payload: unknown = await response.json();
      if (!isDiagnostic(payload)) {
        return {
          ...base,
          ok: false,
          error: "invalid_response",
          durationMs: Date.now() - started,
        };
      }
      return {
        ...base,
        ok: true,
        durationMs: Date.now() - started,
        diagnostic: payload,
      };
    } catch {
      return {
        ...base,
        ok: false,
        durationMs: Date.now() - started,
        error: "unavailable",
      };
    }
  })();
  const timeout = new Promise<DoDiagnosticSiteEntry>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ...base,
        ok: false,
        durationMs: Date.now() - started,
        error: "timeout",
      });
    }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function scanSites(
  env: Env,
  sites: Site[],
): Promise<DoDiagnosticSiteEntry[]> {
  const result: DoDiagnosticSiteEntry[] = new Array(sites.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENCY, sites.length) },
      async () => {
        while (next < sites.length) {
          const index = next++;
          result[index] = await fetchSiteDiagnostic(env, sites[index]);
        }
      },
    ),
  );
  return result;
}

function aggregateScan(
  entries: DoDiagnosticSiteEntry[],
  totalSites: number,
  nextCursor: string | null,
): DoDiagnosticScanResponse {
  const generatedAt = Date.now();
  const successful = entries.filter((entry) => entry.ok && entry.diagnostic);
  const totals: DoDiagnosticAggregate["totals"] = {
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
  let oldestOpenStartedAt: number | null = null;
  let futureMaxActivityAt: number | null = null;
  let thresholds: DoDiagnosticPayload["thresholds"] | null = null;
  for (const entry of successful) {
    const d = entry.diagnostic!;
    thresholds ??= d.thresholds;
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
    if (d.alarm.scheduledAt != null) totals.activeAlarms++;
    totals.maxVisitFlushAttempts = Math.max(
      totals.maxVisitFlushAttempts,
      d.visits.dirty.maxFlushAttempts,
    );
    totals.maxCustomEventFlushAttempts = Math.max(
      totals.maxCustomEventFlushAttempts,
      d.customEvents.maxFlushAttempts,
    );
    if (d.visits.open.oldestStartedAt != null) {
      oldestOpenStartedAt =
        oldestOpenStartedAt === null
          ? d.visits.open.oldestStartedAt
          : Math.min(oldestOpenStartedAt, d.visits.open.oldestStartedAt);
    }
    if (d.visits.open.futureMaxActivityAt != null) {
      futureMaxActivityAt =
        futureMaxActivityAt === null
          ? d.visits.open.futureMaxActivityAt
          : Math.max(futureMaxActivityAt, d.visits.open.futureMaxActivityAt);
    }
  }
  return {
    ok: true,
    scope: "scan",
    generatedAt,
    scanAt: generatedAt,
    requestedSites: entries.length,
    processedSites: entries.length,
    totalSites,
    reachableSites: successful.length,
    unreachableSites: entries.length - successful.length,
    partial: nextCursor !== null || successful.length !== entries.length,
    nextCursor,
    hasMore: nextCursor !== null,
    thresholds: thresholds ?? THRESHOLDS,
    totals,
    oldestOpenStartedAt,
    futureMaxActivityAt,
    sites: entries,
  };
}

/** Explicit scope is mandatory: a page load must never implicitly wake all DOs. */
export async function handleDoDiagnosticScopedAdmin(
  req: Request,
  env: Env,
  url: URL,
  requireActor: RequireActor,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin)
    return forb("Only system admin can view DO diagnostics", undefined, req);
  if (req.method !== "GET") return na(req);

  const scope = url.searchParams.get("scope");
  const database = createDatabaseRuntime(env.DB);
  if (scope === "site") {
    const siteId = url.searchParams.get("siteId") || "";
    if (!SITE_ID.test(siteId) || url.searchParams.getAll("siteId").length !== 1)
      return bad("Valid siteId is required", "invalid_site_id", req);
    const row = await database.first<Site>({
      sql: "SELECT id, name, domain FROM sites WHERE id = ? LIMIT 1",
      bindings: [siteId],
      tag: "admin.sites.first",
    });
    if (!row) return nf("Site not found", undefined, req);
    const site = await fetchSiteDiagnostic(env, row);
    return jsonResponseFor(req, {
      ok: true,
      scope: "site",
      generatedAt: Date.now(),
      site,
    } satisfies DoDiagnosticSiteResponse);
  }
  if (scope !== "scan") {
    return bad(
      "DO diagnostic requires scope=site or scope=scan",
      "invalid_scope",
      req,
    );
  }

  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_SCAN_LIMIT : Number(rawLimit);
  const cursor = url.searchParams.get("cursor") || "";
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_SCAN_LIMIT ||
    (cursor !== "" && !SITE_ID.test(cursor)) ||
    url.searchParams.getAll("cursor").length > 1 ||
    url.searchParams.getAll("limit").length > 1
  ) {
    return bad("Invalid DO scan page", "invalid_scan_page", req);
  }
  const [rows, countRow] = await Promise.all([
    database.all<Site>({
      sql: "SELECT id, name, domain FROM sites WHERE id > ? ORDER BY id ASC LIMIT ?",
      bindings: [cursor, limit + 1],
      tag: "admin.sites.all",
    }),
    database.first<{ count: number }>({
      sql: "SELECT COUNT(*) AS count FROM sites",
      tag: "admin.sites.first",
    }),
  ]);
  const hasMore = rows.results.length > limit;
  const batch = rows.results.slice(0, limit);
  const entries = await scanSites(env, batch);
  const nextCursor =
    hasMore && batch.length ? batch[batch.length - 1].id : null;
  return jsonResponseFor(
    req,
    aggregateScan(entries, Number(countRow?.count ?? 0), nextCursor),
  );
}
