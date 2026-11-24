import { useRef, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Badge } from "@insightflare/ui/badge";
import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { DataTableSwitch } from "@insightflare/ui/data-table-switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import { Spinner } from "@insightflare/ui/spinner";
import { TableCell, TableHead, TableRow } from "@insightflare/ui/table";
import { RiArrowRightLine, RiRadarLine, RiScanLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  durationFormat,
  shortDateTimeWithSeconds,
} from "@/lib/dashboard/format";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import type { SiteData, TeamData } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type {
  DoDiagnosticPayload,
  DoDiagnosticScanResponse,
  DoDiagnosticSiteEntry,
  DoDiagnosticSiteResponse,
} from "@/lib/system-performance";
import { cn } from "@/lib/utils";

import { formatCount, formatMs, type PerformanceCopy, template } from "./model";
import { InlineNote, rowActivation, StatGrid, StatusPanel } from "./parts";

const SCAN_BATCH = 20;

function pendingWrites(diagnostic: DoDiagnosticPayload) {
  return diagnostic.visits.dirty.total + diagnostic.customEvents.dirty;
}

function issueCounts(diagnostic: DoDiagnosticPayload) {
  const open = diagnostic.visits.open;
  return {
    stale: open.stale,
    timedOut: open.timedOut,
    hardAged: open.hardAged,
    futureSkew: open.futureSkewed,
    stuck: diagnostic.visits.dirty.stuck + diagnostic.customEvents.stuck,
  };
}

function hasIssues(diagnostic: DoDiagnosticPayload) {
  return Object.values(issueCounts(diagnostic)).some((value) => value > 0);
}

function Snapshot({
  locale,
  timeZone,
  copy,
  entry,
}: {
  locale: Locale;
  timeZone: string;
  copy: PerformanceCopy;
  entry: DoDiagnosticSiteEntry;
}) {
  if (!entry.ok || !entry.diagnostic) {
    return (
      <StatusPanel
        tone="error"
        message={template(copy.durableObjects.failed, {
          reason: entry.error || copy.durableObjects.unreachable,
        })}
      />
    );
  }
  const diagnostic = entry.diagnostic;
  const issues = issueCounts(diagnostic);
  const thresholds = diagnostic.thresholds;
  const issueItems = [
    {
      id: "stale",
      label: template(copy.durableObjects.stale, {
        duration: durationFormat(locale, thresholds.staleMs),
      }),
      value: issues.stale,
    },
    {
      id: "timedOut",
      label: template(copy.durableObjects.timedOut, {
        duration: durationFormat(locale, thresholds.timeoutMs),
      }),
      value: issues.timedOut,
    },
    {
      id: "hardAged",
      label: template(copy.durableObjects.hardAged, {
        duration: durationFormat(locale, thresholds.hardAgedMs),
      }),
      value: issues.hardAged,
    },
    {
      id: "futureSkew",
      label: copy.durableObjects.futureSkew,
      value: issues.futureSkew,
    },
    { id: "stuck", label: copy.durableObjects.stuck, value: issues.stuck },
  ];
  const flagged = issueItems.filter((item) => item.value > 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{entry.siteName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {entry.siteDomain}
          </p>
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {copy.durableObjects.snapshotAt}{" "}
          {shortDateTimeWithSeconds(locale, diagnostic.snapshotAt, timeZone)} ·{" "}
          {copy.durableObjects.responseTime}{" "}
          {formatMs(locale, entry.durationMs)}
        </p>
      </div>
      <StatGrid
        items={[
          {
            id: "buffered",
            label: copy.durableObjects.bufferedVisits,
            value: formatCount(locale, diagnostic.visits.total),
          },
          {
            id: "open",
            label: copy.durableObjects.openVisits,
            value: formatCount(locale, diagnostic.visits.open.total),
          },
          {
            id: "pending",
            label: copy.durableObjects.pendingWrites,
            value: formatCount(locale, pendingWrites(diagnostic)),
          },
          {
            id: "custom",
            label: copy.durableObjects.customEvents,
            value: formatCount(locale, diagnostic.customEvents.total),
          },
          {
            id: "attempts",
            label: copy.durableObjects.maxAttempts,
            value: formatCount(
              locale,
              Math.max(
                diagnostic.visits.dirty.maxFlushAttempts,
                diagnostic.customEvents.maxFlushAttempts,
              ),
            ),
          },
          {
            id: "alarm",
            label: copy.durableObjects.nextAlarm,
            value:
              diagnostic.alarm.scheduledAt === null
                ? copy.durableObjects.none
                : shortDateTimeWithSeconds(
                    locale,
                    diagnostic.alarm.scheduledAt,
                    timeZone,
                  ),
          },
        ]}
      />
      {flagged.length ? (
        <div className="border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {copy.durableObjects.attention}
          </p>
          <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {flagged.map((item) => (
              <li key={item.id} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{item.label}</span>
                <span className="tabular-nums">
                  {formatCount(locale, item.value)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          {copy.durableObjects.healthy}
        </p>
      )}
    </div>
  );
}

function EntryState({
  copy,
  entry,
}: {
  copy: PerformanceCopy;
  entry: DoDiagnosticSiteEntry;
}) {
  if (!entry.ok || !entry.diagnostic)
    return (
      <Badge variant="destructive">{copy.durableObjects.unreachable}</Badge>
    );
  if (hasIssues(entry.diagnostic))
    return (
      <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
        {copy.durableObjects.attention}
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">
      {copy.durableObjects.reachable}
    </Badge>
  );
}

export function DoDiagnosticPanel({
  locale,
  timeZone,
  copy,
  onViewSamples,
}: {
  locale: Locale;
  timeZone: string;
  copy: PerformanceCopy;
  onViewSamples: () => void;
}) {
  const [teamId, setTeamId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [snapshot, setSnapshot] = useState<DoDiagnosticSiteEntry | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [scan, setScan] = useState<DoDiagnosticScanResponse | null>(null);
  const [scanError, setScanError] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [scannedSites, setScannedSites] = useState<DoDiagnosticSiteEntry[]>([]);

  // Team and site lists come from the admin CRUD endpoints and never wake a Durable Object.
  const teams = useQuery({
    queryKey: ["system-performance", "do", "teams"],
    queryFn: ({ signal }) =>
      requestAdminService<TeamData[]>("teams", { signal }),
    enabled: typeof window !== "undefined",
    staleTime: 60_000,
  });
  const sites = useQuery({
    queryKey: ["system-performance", "do", "sites", teamId],
    queryFn: ({ signal }) =>
      requestAdminService<SiteData[]>("sites", { params: { teamId }, signal }),
    enabled: typeof window !== "undefined" && Boolean(teamId),
    staleTime: 60_000,
  });

  async function inspectSite() {
    if (!siteId) return;
    setSnapshotLoading(true);
    setSnapshotError("");
    try {
      const result = await requestAdminService<DoDiagnosticSiteResponse>(
        "do-diagnostic",
        { params: { scope: "site", siteId } },
      );
      setSnapshot(result.site);
    } catch (error) {
      setSnapshot(null);
      setSnapshotError(
        template(copy.durableObjects.failed, {
          reason:
            error instanceof Error
              ? error.message
              : copy.durableObjects.unreachable,
        }),
      );
    } finally {
      setSnapshotLoading(false);
    }
  }

  async function runScan(cursor?: string) {
    if (scanLoading) return;
    setScanLoading(true);
    setScanError("");
    if (!cursor) setScannedSites([]);
    try {
      const page = await requestAdminService<DoDiagnosticScanResponse>(
        "do-diagnostic",
        {
          params: {
            scope: "scan",
            limit: SCAN_BATCH,
            ...(cursor ? { cursor } : {}),
          },
        },
      );
      setScan(page);
      setScannedSites((before) =>
        cursor ? [...before, ...page.sites] : page.sites,
      );
    } catch {
      setScanError(copy.status.queryFailed);
    } finally {
      setScanLoading(false);
    }
  }

  const snapshotCardRef = useRef<HTMLDivElement | null>(null);
  const showEntry = (entry: DoDiagnosticSiteEntry) => {
    setSnapshotError("");
    setSnapshot(entry);
    snapshotCardRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  };

  const unreachable = scannedSites.filter((entry) => !entry.ok).length;
  const snapshotKey = snapshotLoading
    ? "loading"
    : snapshotError
      ? "error"
      : (snapshot?.siteId ?? "idle");

  return (
    <div className="space-y-6">
      <Card ref={snapshotCardRef}>
        <CardHeader>
          <CardTitle>{copy.durableObjects.snapshotTitle}</CardTitle>
          <CardDescription>
            {copy.durableObjects.snapshotDescription}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Select
              value={teamId || undefined}
              onValueChange={(value) => {
                setTeamId(value);
                setSiteId("");
              }}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue placeholder={copy.durableObjects.chooseTeam} />
              </SelectTrigger>
              <SelectContent>
                {(teams.data ?? []).map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={siteId || undefined}
              onValueChange={setSiteId}
              disabled={!teamId || sites.isPending}
            >
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue placeholder={copy.durableObjects.chooseSite} />
              </SelectTrigger>
              <SelectContent>
                {(sites.data ?? []).map((site) => (
                  <SelectItem key={site.id} value={site.id}>
                    {site.name}
                    <span className="text-muted-foreground">
                      {" "}
                      · {site.domain}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              disabled={!siteId || snapshotLoading}
              onClick={() => void inspectSite()}
            >
              {snapshotLoading ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RiRadarLine data-icon="inline-start" />
              )}
              {copy.durableObjects.inspect}
            </Button>
          </div>
          <AutoResizer initial duration={0.22}>
            <AutoTransition
              initial={false}
              type="fade"
              duration={0.16}
              transitionKey={snapshotKey}
            >
              {snapshotLoading ? (
                <div
                  key="loading"
                  className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
                >
                  <Spinner className="size-4" />
                  {copy.loading}
                </div>
              ) : snapshotError ? (
                <StatusPanel key="error" tone="error" message={snapshotError} />
              ) : snapshot ? (
                <Snapshot
                  key={snapshot.siteId}
                  locale={locale}
                  timeZone={timeZone}
                  copy={copy}
                  entry={snapshot}
                />
              ) : (
                <StatusPanel key="idle" message={copy.durableObjects.idle} />
              )}
            </AutoTransition>
          </AutoResizer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{copy.durableObjects.scanTitle}</CardTitle>
          <CardDescription>
            {template(copy.durableObjects.scanDescription, {
              count: SCAN_BATCH,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={scanLoading}
              onClick={() => void runScan()}
            >
              {scanLoading && !scan ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RiScanLine data-icon="inline-start" />
              )}
              {scan ? copy.durableObjects.rescan : copy.durableObjects.scan}
            </Button>
            {scan ? (
              <span
                className="text-sm text-muted-foreground tabular-nums"
                aria-live="polite"
              >
                {template(copy.durableObjects.scanProgress, {
                  done: scannedSites.length,
                  total: scan.totalSites,
                })}
                {unreachable > 0 ? (
                  <span className="text-destructive">
                    {" · "}
                    {template(copy.durableObjects.scanUnreachable, {
                      count: unreachable,
                    })}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          {scanError ? (
            <p className="text-sm text-destructive">{scanError}</p>
          ) : null}
          {scan || scanLoading ? (
            <DataTableSwitch
              loading={scanLoading && scannedSites.length === 0}
              hasContent={scannedSites.length > 0}
              loadingLabel={copy.loading}
              emptyLabel={copy.durableObjects.scanEmpty}
              colSpan={6}
              loadingRowCount={5}
              header={
                <TableRow>
                  <TableHead>{copy.durableObjects.site}</TableHead>
                  <TableHead>{copy.durableObjects.state}</TableHead>
                  <TableHead className="text-right">
                    {copy.durableObjects.bufferedVisits}
                  </TableHead>
                  <TableHead className="text-right">
                    {copy.durableObjects.openVisits}
                  </TableHead>
                  <TableHead className="text-right">
                    {copy.durableObjects.pendingWrites}
                  </TableHead>
                  <TableHead className="text-right">
                    {copy.durableObjects.responseTime}
                  </TableHead>
                </TableRow>
              }
              rows={scannedSites.map((entry) => (
                <TableRow
                  key={entry.siteId}
                  {...rowActivation(() => showEntry(entry))}
                >
                  <TableCell className="max-w-72">
                    <div className="truncate font-medium">
                      {entry.siteName || entry.siteId}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {entry.siteDomain}
                    </div>
                  </TableCell>
                  <TableCell>
                    <EntryState copy={copy} entry={entry} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entry.diagnostic
                      ? formatCount(locale, entry.diagnostic.visits.total)
                      : copy.emptyValue}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entry.diagnostic
                      ? formatCount(locale, entry.diagnostic.visits.open.total)
                      : copy.emptyValue}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {entry.diagnostic
                      ? formatCount(locale, pendingWrites(entry.diagnostic))
                      : copy.emptyValue}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      !entry.ok && "text-muted-foreground",
                    )}
                  >
                    {formatMs(locale, entry.durationMs)}
                  </TableCell>
                </TableRow>
              ))}
            />
          ) : null}
          {scan?.hasMore && scan.nextCursor ? (
            <Button
              variant="outline"
              disabled={scanLoading}
              onClick={() => void runScan(scan.nextCursor ?? undefined)}
            >
              {scanLoading ? <Spinner data-icon="inline-start" /> : null}
              {copy.durableObjects.continue}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <InlineNote>{copy.durableObjects.invocationsHint}</InlineNote>
        <Button variant="ghost" size="sm" onClick={onViewSamples}>
          {copy.durableObjects.viewSamples}
          <RiArrowRightLine data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}
