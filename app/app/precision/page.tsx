import { Beaker, Clock4 } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
import { PrecisionQuery } from "@/components/precision-query";
import { TeamSiteSwitcher } from "@/components/team-site-switcher";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchAdminSites, fetchAdminTeams } from "@/lib/edge-client";

interface PrecisionSearchParams {
  teamId?: string;
  siteId?: string;
  from?: string;
  to?: string;
}

function parseNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

export default async function PrecisionPage({
  searchParams,
}: {
  searchParams: Promise<PrecisionSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const now = Date.now();
  const defaultFrom = now - 3 * 365 * 24 * 60 * 60 * 1000;
  const from = parseNumber(params.from, defaultFrom);
  const to = parseNumber(params.to, now);

  const teams = await fetchAdminTeams();
  const selectedTeamId =
    (params.teamId && teams.some((team) => team.id === params.teamId) ? params.teamId : undefined) || teams[0]?.id || "";
  const sites = selectedTeamId ? await fetchAdminSites(selectedTeamId) : [];
  const selectedSiteId =
    (params.siteId && sites.some((site) => site.id === params.siteId) ? params.siteId : undefined) || sites[0]?.id || "";

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      <TopNav active="precision" teamId={selectedTeamId} siteId={selectedSiteId} />

      <header className="rounded-[1.75rem] border border-slate-200 bg-white/90 p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge>Precision Mode</Badge>
            <h1 className="mt-2 font-[var(--font-display)] text-4xl text-ink">DuckDB Local Query Lab</h1>
            <p className="mt-2 text-sm text-slate-600">
              Query long-term archive slices in-browser using `duckdb-wasm` without rehydrating full detail into D1.
            </p>
          </div>
          <LogoutButton />
        </div>
        {teams.length > 0 && sites.length > 0 ? (
          <div className="mt-4">
            <TeamSiteSwitcher
              actionPath="/app/precision"
              teams={teams}
              sites={sites}
              currentTeamId={selectedTeamId}
              currentSiteId={selectedSiteId}
              from={from}
              to={to}
            />
          </div>
        ) : null}
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-[var(--font-display)]">
              <Clock4 className="h-5 w-5 text-accent" />
              Time Range
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <p>From: {new Date(from).toLocaleString()}</p>
            <p>To: {new Date(to).toLocaleString()}</p>
            <p>Tip: pass `from`/`to` in epoch milliseconds on URL to narrow scan scope.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-[var(--font-display)]">
              <Beaker className="h-5 w-5 text-signal" />
              Input Dataset
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <p>Site: {selectedSiteId || "N/A"}</p>
            <p>Archive source: R2 to private archive endpoints to dashboard archive proxy.</p>
            <p>Format: Parquet archive shards tracked by `archive_objects` in D1.</p>
          </CardContent>
        </Card>
      </section>

      {selectedSiteId ? (
        <PrecisionQuery siteId={selectedSiteId} from={from} to={to} />
      ) : (
        <Card>
          <CardContent className="py-6 text-sm text-slate-600">
            No site selected. Create one in <a className="font-semibold text-accent underline" href="/app/teams">Teams</a>.
          </CardContent>
        </Card>
      )}
    </main>
  );
}
