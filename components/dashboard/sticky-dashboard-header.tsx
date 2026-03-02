"use client";

import { DateRangePicker } from "@/components/dashboard/date-range-picker";
import { LiveCounter } from "@/components/shared/live-counter";

interface StickyDashboardHeaderProps {
  locale: string;
  from: number;
  to: number;
  siteId: string;
  wsBaseUrl?: string;
  wsToken?: string;
}

export function StickyDashboardHeader({
  locale,
  from,
  to,
  siteId,
  wsBaseUrl,
  wsToken,
}: StickyDashboardHeaderProps) {
  return (
    <div className="sticky top-0 z-[9] -mx-4 mb-4 border-b bg-background/80 px-4 py-1.5 backdrop-blur-sm md:-mx-6 md:px-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <DateRangePicker locale={locale} from={from} to={to} />
        {wsBaseUrl && (
          <LiveCounter
            siteId={siteId}
            wsBaseUrl={wsBaseUrl}
            wsToken={wsToken}
          />
        )}
      </div>
    </div>
  );
}
