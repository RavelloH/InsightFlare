import { useState } from "react";
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
import { RiCpuLine, RiRefreshLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import type { SiteData, TeamData } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type {
  DoDiagnosticScanResponse,
  DoDiagnosticSiteEntry,
  DoDiagnosticSiteResponse,
} from "@/lib/system-performance";
import type { SystemPerformanceV2Labels } from "@/lib/system-performance-labels";

function datetime(
  locale: Locale,
  milliseconds: number | null | undefined,
  timeZone: string,
): string {
  if (
    typeof milliseconds !== "number" ||
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0
  )
    return "—";
  try {
    return new Intl.DateTimeFormat(
      locale === "zh" ? "zh-CN" : locale === "zh-tw" ? "zh-TW" : locale,
      {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      },
    ).format(milliseconds);
  } catch {
    return "—";
  }
}

function statusLabel(
  entry: DoDiagnosticSiteEntry,
  copy: SystemPerformanceV2Labels,
): string {
  return entry.ok
    ? copy.reachable
    : `${copy.unreachable} (${entry.error || copy.unavailable})`;
}

function LiveSnapshot({
  entry,
  locale,
  timeZone,
  copy,
}: {
  entry: DoDiagnosticSiteEntry;
  locale: Locale;
  timeZone: string;
  copy: SystemPerformanceV2Labels;
}) {
  if (!entry.ok || !entry.diagnostic) {
    return (
      <p className="text-sm text-destructive">{statusLabel(entry, copy)}</p>
    );
  }
  const diagnostic = entry.diagnostic;
  const stats = [
    [copy.bufferedVisits, diagnostic.visits.total],
    [
      copy.dirtyEvents,
      diagnostic.visits.dirty.total + diagnostic.customEvents.dirty,
    ],
    [
      copy.pendingAlarm,
      diagnostic.alarm.scheduledAt === null
        ? "—"
        : datetime(locale, diagnostic.alarm.scheduledAt, timeZone),
    ],
    [
      copy.flushAttempts,
      Math.max(
        diagnostic.visits.dirty.maxFlushAttempts,
        diagnostic.customEvents.maxFlushAttempts,
      ),
    ],
  ] as const;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {copy.age}: {datetime(locale, diagnostic.snapshotAt, timeZone)}
      </p>
      <div className="grid gap-px overflow-hidden border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="min-w-0 bg-background p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-2 break-words text-xl font-semibold tabular-nums">
              {value}
            </p>
          </div>
        ))}
      </div>
      <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        <p>
          {copy.reachable}: {entry.siteName} ({entry.siteDomain})
        </p>
        <p>
          {copy.age}: {datetime(locale, entry.diagnostic.snapshotAt, timeZone)}
        </p>
        <p>
          Open: {diagnostic.visits.open.total} · Stale:{" "}
          {diagnostic.visits.open.stale}
        </p>
        <p>
          Timeout: {diagnostic.visits.open.timedOut} · Hard aged:{" "}
          {diagnostic.visits.open.hardAged}
        </p>
        <p>
          Future skew: {diagnostic.visits.open.futureSkewed} · Stuck:{" "}
          {diagnostic.visits.dirty.stuck + diagnostic.customEvents.stuck}
        </p>
        <p>
          {copy.flushAttempts}: {diagnostic.visits.dirty.maxFlushAttempts} /{" "}
          {diagnostic.customEvents.maxFlushAttempts}
        </p>
      </div>
    </div>
  );
}

export function DoDiagnosticV2Panel({
  locale,
  timeZone,
  copy,
}: {
  locale: Locale;
  timeZone: string;
  copy: SystemPerformanceV2Labels;
}) {
  const [teamId, setTeamId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [snapshot, setSnapshot] = useState<DoDiagnosticSiteResponse | null>(
    null,
  );
  const [snapshotError, setSnapshotError] = useState("");
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [scan, setScan] = useState<DoDiagnosticScanResponse | null>(null);
  const [scanError, setScanError] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [scannedSites, setScannedSites] = useState<DoDiagnosticSiteEntry[]>([]);

  // Site/team metadata comes from existing admin CRUD endpoints; this NEVER contacts any DO.
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

  async function inspectSite(selected = siteId) {
    if (!selected) return;
    setSnapshotLoading(true);
    setSnapshotError("");
    try {
      const result = await requestAdminService<DoDiagnosticSiteResponse>(
        "do-diagnostic",
        {
          params: { scope: "site", siteId: selected },
        },
      );
      setSnapshot(result);
    } catch {
      setSnapshotError(copy.unreachable);
    } finally {
      setSnapshotLoading(false);
    }
  }

  async function runScan(cursor?: string) {
    if (scanLoading) return;
    setScanLoading(true);
    setScanError("");
    if (!cursor) {
      setScannedSites([]);
      setScan(null);
    }
    try {
      const page = await requestAdminService<DoDiagnosticScanResponse>(
        "do-diagnostic",
        {
          params: { scope: "scan", limit: 20, ...(cursor ? { cursor } : {}) },
        },
      );
      setScan(page);
      setScannedSites((before) =>
        cursor ? [...before, ...page.sites] : page.sites,
      );
    } catch {
      setScanError(copy.queryFailed);
    } finally {
      setScanLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiCpuLine className="size-4" />
            {copy.live}
          </CardTitle>
          <CardDescription>{copy.unknownSite}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Select
              value={teamId || undefined}
              onValueChange={(value) => {
                setTeamId(value);
                setSiteId("");
                setSnapshot(null);
              }}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue placeholder={copy.chooseTeam} />
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
              onValueChange={(value) => {
                setSiteId(value);
                setSnapshot(null);
              }}
              disabled={!teamId || sites.isPending}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder={copy.chooseSite} />
              </SelectTrigger>
              <SelectContent>
                {(sites.data ?? []).map((site) => (
                  <SelectItem key={site.id} value={site.id}>
                    {site.name} · {site.domain}
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
                <RiRefreshLine data-icon="inline-start" />
              )}
              {copy.inspectSite}
            </Button>
          </div>
          <AutoResizer initial duration={0.25}>
            <AutoTransition
              initial={false}
              type="fade"
              duration={0.18}
              transitionKey={
                snapshotLoading
                  ? "loading"
                  : snapshotError
                    ? "error"
                    : snapshot?.site.siteId || "idle"
              }
            >
              {snapshotLoading ? (
                <div className="flex min-h-24 items-center justify-center gap-2 text-muted-foreground">
                  <Spinner className="size-4" />
                  {copy.pendingScan}
                </div>
              ) : snapshotError ? (
                <p className="text-sm text-destructive">{snapshotError}</p>
              ) : snapshot ? (
                <LiveSnapshot
                  entry={snapshot.site}
                  locale={locale}
                  timeZone={timeZone}
                  copy={copy}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {copy.unknownSite}
                </p>
              )}
            </AutoTransition>
          </AutoResizer>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{copy.scanAll}</CardTitle>
          <CardDescription>{copy.scanWarning}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={scanLoading}
              onClick={() => void runScan()}
            >
              {scanLoading ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RiRefreshLine data-icon="inline-start" />
              )}
              {copy.scanAll}
            </Button>
            {scan ? (
              <span
                className="text-sm text-muted-foreground"
                aria-live="polite"
              >
                {copy.scanned}: {scannedSites.length} / {scan.totalSites} ·{" "}
                {copy.reachable}:{" "}
                {scannedSites.filter((entry) => entry.ok).length}
              </span>
            ) : null}
          </div>
          {scanError ? (
            <p className="text-sm text-destructive">{scanError}</p>
          ) : null}
          {scan?.partial ? (
            <Badge variant="outline">{copy.scanPartial}</Badge>
          ) : null}
          <DataTableSwitch
            loading={scanLoading && !scan}
            hasContent={scannedSites.length > 0}
            loadingLabel={copy.pendingScan}
            emptyLabel={copy.scanWarning}
            colSpan={4}
            header={
              <TableRow>
                <TableHead>{copy.chooseSite}</TableHead>
                <TableHead>{copy.reachable}</TableHead>
                <TableHead>{copy.age}</TableHead>
                <TableHead>{copy.bufferedVisits}</TableHead>
              </TableRow>
            }
            rows={scannedSites.map((entry) => (
              <TableRow key={entry.siteId}>
                <TableCell className="font-medium">
                  {entry.siteName || entry.siteId}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{statusLabel(entry, copy)}</Badge>
                </TableCell>
                <TableCell>
                  {datetime(locale, entry.diagnostic?.snapshotAt, timeZone)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {entry.diagnostic?.visits.total ?? copy.unavailable}
                </TableCell>
              </TableRow>
            ))}
          />
          {scan?.hasMore && scan.nextCursor ? (
            <Button
              variant="outline"
              disabled={scanLoading}
              onClick={() => void runScan(scan.nextCursor || undefined)}
            >
              {scanLoading ? <Spinner data-icon="inline-start" /> : null}
              {copy.continueScan}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
