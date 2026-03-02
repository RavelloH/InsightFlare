"use client";

import type { TeamData, SiteData } from "@/lib/edge-client";
import { TeamSiteSelector } from "@/components/dashboard/team-site-selector";
import { DateRangePicker } from "@/components/dashboard/date-range-picker";
import { LiveCounter } from "@/components/shared/live-counter";

interface StickyDashboardHeaderProps {
  teams: TeamData[];
  sites: SiteData[];
  currentTeamId: string;
  currentSiteId: string;
  locale: string;
  from: number;
  to: number;
  wsBaseUrl?: string;
  wsToken?: string;
}

export function StickyDashboardHeader({
  teams,
  sites,
  currentTeamId,
  currentSiteId,
  locale,
  from,
  to,
  wsBaseUrl,
  wsToken,
}: StickyDashboardHeaderProps) {
  return (
    <div className="sticky top-12 z-[9] -mx-4 mb-4 border-b bg-background/80 px-4 py-2.5 backdrop-blur-sm md:-mx-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TeamSiteSelector
          teams={teams}
          sites={sites}
          currentTeamId={currentTeamId}
          currentSiteId={currentSiteId}
        />
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker locale={locale} from={from} to={to} />
          {wsBaseUrl && (
            <LiveCounter siteId={currentSiteId} wsBaseUrl={wsBaseUrl} wsToken={wsToken} />
          )}
        </div>
      </div>
    </div>
  );
}
