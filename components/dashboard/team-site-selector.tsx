"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TeamData, SiteData } from "@/lib/edge-client";

interface TeamSiteSelectorProps {
  teams: TeamData[];
  sites: SiteData[];
  currentTeamId: string;
  currentSiteId: string;
}

export function TeamSiteSelector({
  teams,
  sites,
  currentTeamId,
  currentSiteId,
}: TeamSiteSelectorProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function updateParams(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    if (key === "teamId") {
      params.delete("siteId");
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={currentTeamId} onValueChange={(v) => updateParams("teamId", v)}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder="Select team" />
        </SelectTrigger>
        <SelectContent>
          {teams.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              {team.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={currentSiteId} onValueChange={(v) => updateParams("siteId", v)}>
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Select site" />
        </SelectTrigger>
        <SelectContent>
          {sites.map((site) => (
            <SelectItem key={site.id} value={site.id}>
              {site.name} ({site.domain})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
