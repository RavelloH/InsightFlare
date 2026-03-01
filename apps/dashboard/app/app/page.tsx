import { AlertTriangle, Gauge, Globe, Route, Users2 } from "lucide-react";
import { QueryForm } from "@/components/query-form";
import { TrendChart } from "@/components/charts/trend-chart";
import { LogoutButton } from "@/components/logout-button";
import { MetricCard } from "@/components/metric-card";
import { RealtimePanel } from "@/components/realtime-panel";
import { TeamSiteSwitcher } from "@/components/team-site-switcher";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  fetchAdminSites,
  fetchAdminTeams,
  fetchPrivateOverview,
  fetchPrivatePages,
  fetchPrivateReferrers,
  fetchPrivateSessions,
  fetchPrivateTrend,
} from "@/lib/edge-client";
import { compactNumber, formatDateTime, formatDuration, formatPercent } from "@/lib/utils";

interface DashboardSearchParams {
  teamId?: string;
  siteId?: string;
  from?: string;
  to?: string;
  fromIso?: string;
  toIso?: string;
}

function parseDateInput(value: string | undefined): number | null {
  if (!value) return null;
  const fromDate = Date.parse(value);
  if (Number.isFinite(fromDate)) return fromDate;
  const fromNum = Number(value);
  if (Number.isFinite(fromNum)) return Math.floor(fromNum);
  return null;
}

function resolveRange(searchParams: DashboardSearchParams): { siteId: string; from: number; to: number } {
  const now = Date.now();
  const defaultFrom = now - 7 * 24 * 60 * 60 * 1000;
  const fromIso = parseDateInput(searchParams.fromIso);
  const toIso = parseDateInput(searchParams.toIso);
  const fromRaw = parseDateInput(searchParams.from);
  const toRaw = parseDateInput(searchParams.to);

  const from = fromIso ?? fromRaw ?? defaultFrom;
  const to = toIso ?? toRaw ?? now;

  return {
    siteId: searchParams.siteId || process.env.INSIGHTFLARE_DEFAULT_SITE_ID || "default",
    from: Math.min(from, to),
    to: Math.max(from, to),
  };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const baseRange = resolveRange(params);

  const teams = await fetchAdminTeams();
  if (teams.length === 0) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
        <TopNav active="dashboard" />
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-[var(--font-display)]">No Team Yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <p>Create your first team and site in the Teams tab to start collecting analytics.</p>
            <a className="inline-block rounded-xl2 bg-accent px-4 py-2 font-semibold text-white" href="/app/teams">
              Go to Team Setup
            </a>
          </CardContent>
        </Card>
      </main>
    );
  }

  const selectedTeamId =
    (params.teamId && teams.some((team) => team.id === params.teamId) ? params.teamId : undefined) || teams[0].id;

  const sites = await fetchAdminSites(selectedTeamId);
  if (sites.length === 0) {
    return (
      <main className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
        <TopNav active="dashboard" teamId={selectedTeamId} />
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-[var(--font-display)]">No Site Yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <p>Create a site under the selected team, then install `/script.js` on your target website.</p>
            <a className="inline-block rounded-xl2 bg-accent px-4 py-2 font-semibold text-white" href={`/app/teams?teamId=${selectedTeamId}`}>
              Create Site
            </a>
          </CardContent>
        </Card>
      </main>
    );
  }

  const selectedSiteId =
    (params.siteId && sites.some((site) => site.id === params.siteId) ? params.siteId : undefined) || sites[0].id;

  const range = {
    ...baseRange,
    siteId: selectedSiteId,
  };

  const [overview, trend, pages, referrers, sessions] = await Promise.all([
    fetchPrivateOverview(range),
    fetchPrivateTrend({ ...range, interval: "day" }),
    fetchPrivatePages(range),
    fetchPrivateReferrers(range),
    fetchPrivateSessions(range),
  ]);
  const wsBaseUrl = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_URL || process.env.INSIGHTFLARE_EDGE_URL || "";
  const wsToken = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_TOKEN || "";

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      <TopNav active="dashboard" teamId={selectedTeamId} siteId={selectedSiteId} />

      <header className="relative overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white/90 p-6 shadow-card">
        <div className="absolute -right-14 -top-14 h-48 w-48 rounded-full bg-accent/15 blur-2xl" />
        <div className="absolute -left-20 bottom-0 h-44 w-44 rounded-full bg-signal/20 blur-2xl" />
        <div className="relative z-10 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <Badge>InsightFlare Dashboard</Badge>
            <h1 className="font-[var(--font-display)] text-4xl leading-tight text-ink">Team Analytics Command</h1>
            <p className="max-w-2xl text-sm text-slate-600">
              Real-time ingestion with private deep analysis and privacy-preserving public reporting in one surface.
            </p>
          </div>
          <LogoutButton />
        </div>
        <div className="relative z-10 mt-5">
          <div className="mb-3">
            <TeamSiteSwitcher
              actionPath="/app"
              teams={teams}
              sites={sites}
              currentTeamId={selectedTeamId}
              currentSiteId={selectedSiteId}
              from={range.from}
              to={range.to}
            />
          </div>
          <QueryForm siteId={range.siteId} teamId={selectedTeamId} from={range.from} to={range.to} actionPath="/app" />
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Views" value={compactNumber(overview.data.views)} hint="Total page events in range" />
        <MetricCard label="Sessions" value={compactNumber(overview.data.sessions)} hint="Unique session IDs" />
        <MetricCard
          label="Visitors"
          value={compactNumber(overview.data.visitors)}
          hint={overview.data.approximateVisitors ? "Includes archive approximations" : "Exact for detailed range"}
        />
        <MetricCard label="Bounce Rate" value={formatPercent(overview.data.bounceRate)} hint="Duration <= 0ms events" />
        <MetricCard label="Avg Duration" value={formatDuration(overview.data.avgDurationMs)} hint="Per event" />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <Gauge className="h-5 w-5 text-accent" />
              Traffic Trend
            </CardTitle>
            <Badge variant="outline">Daily</Badge>
          </CardHeader>
          <CardContent>
            <TrendChart data={trend.data} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <AlertTriangle className="h-5 w-5 text-signal" />
              Session Snapshot
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sessions.data.length === 0 ? (
              <p className="text-sm text-slate-500">No sessions in current range.</p>
            ) : (
              sessions.data.map((session) => (
                <div key={session.sessionId} className="rounded-xl2 border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-xs text-slate-500">{session.sessionId.slice(0, 16)}...</p>
                    <Badge variant="outline">{session.views} views</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-700">
                    {session.entryPath || "/"} → {session.exitPath || "/"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{formatDateTime(session.startedAt)}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <RealtimePanel siteId={range.siteId} wsBaseUrl={wsBaseUrl} wsToken={wsToken} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <Route className="h-5 w-5 text-accent" />
              Top Pages
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>Query/Hash</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.data.map((row) => (
                  <TableRow key={`${row.pathname}|${row.query || ""}|${row.hash || ""}`}>
                    <TableCell className="font-medium text-ink">{row.pathname}</TableCell>
                    <TableCell className="font-mono text-xs text-slate-500">
                      {row.query || row.hash ? `${row.query || ""}${row.hash || ""}` : "-"}
                    </TableCell>
                    <TableCell className="text-right">{compactNumber(row.views)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <Globe className="h-5 w-5 text-accent" />
              Top Referrers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Referrer</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {referrers.data.map((row) => (
                  <TableRow key={row.referrer}>
                    <TableCell className="max-w-[280px] truncate font-medium text-ink">{row.referrer || "direct"}</TableCell>
                    <TableCell className="text-right">{compactNumber(row.views)}</TableCell>
                    <TableCell className="text-right">{compactNumber(row.sessions)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <footer className="flex items-center gap-2 text-xs text-slate-500">
        <Users2 className="h-4 w-4" />
        <span>Site: {range.siteId}</span>
      </footer>
    </main>
  );
}
