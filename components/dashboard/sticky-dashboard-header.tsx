"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { DateRangePicker } from "@/components/dashboard/date-range-picker";
import { IntervalSelector } from "@/components/dashboard/interval-selector";
import { LiveCounter } from "@/components/shared/live-counter";

interface StickyDashboardHeaderProps {
  locale: string;
  from: number;
  to: number;
  interval: "hour" | "day";
  siteId: string;
  wsBaseUrl?: string;
  wsToken?: string;
}

export function StickyDashboardHeader({
  locale,
  from,
  to,
  interval,
  siteId,
  wsBaseUrl,
  wsToken,
}: StickyDashboardHeaderProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function onIntervalChange(nextInterval: "hour" | "day") {
    const params = new URLSearchParams(searchParams.toString());
    params.set("interval", nextInterval);
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="sticky-header top-16 -mx-4 mb-4 px-4 py-2 md:-mx-6 md:px-6 lg:top-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker locale={locale} from={from} to={to} />
          <IntervalSelector
            value={interval}
            onChange={onIntervalChange}
            labels={locale === "zh" ? { hour: "小时", day: "天" } : { hour: "Hourly", day: "Daily" }}
          />
        </div>
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
