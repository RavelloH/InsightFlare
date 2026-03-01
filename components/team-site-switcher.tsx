import { Button } from "@/components/ui/button";
import { SiteData, TeamData } from "@/lib/edge-client";

interface TeamSiteSwitcherProps {
  actionPath: string;
  teams: TeamData[];
  sites: SiteData[];
  currentTeamId: string;
  currentSiteId: string;
  from?: number;
  to?: number;
}

export function TeamSiteSwitcher({
  actionPath,
  teams,
  sites,
  currentTeamId,
  currentSiteId,
  from,
  to,
}: TeamSiteSwitcherProps): React.JSX.Element {
  return (
    <form action={actionPath} method="GET" className="grid gap-2 md:grid-cols-[1fr_1fr_auto] md:items-end">
      {from ? <input type="hidden" name="from" value={String(from)} /> : null}
      {to ? <input type="hidden" name="to" value={String(to)} /> : null}

      <label className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Team</span>
        <select
          name="teamId"
          defaultValue={currentTeamId}
          className="h-10 w-full rounded-xl2 border border-slate-300 bg-white px-3 text-sm text-slate-700"
        >
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>

      <label className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Site</span>
        <select
          name="siteId"
          defaultValue={currentSiteId}
          className="h-10 w-full rounded-xl2 border border-slate-300 bg-white px-3 text-sm text-slate-700"
        >
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name} ({site.domain})
            </option>
          ))}
        </select>
      </label>

      <Button type="submit">Switch</Button>
    </form>
  );
}

