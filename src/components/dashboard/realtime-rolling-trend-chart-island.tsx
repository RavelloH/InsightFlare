import dynamic from "@/lib/dynamic";
import type { Locale } from "@/lib/i18n/config";

import type { RealtimeRollingTrendPoint } from "./charts/realtime-rolling-trend-chart";

export type { RealtimeRollingTrendPoint } from "./charts/realtime-rolling-trend-chart";

interface RealtimeRollingTrendChartIslandProps {
  locale: Locale;
  data: RealtimeRollingTrendPoint[];
  viewsLabel: string;
  sessionsLabel: string;
  timeZone: string;
  className?: string;
}

const RealtimeRollingTrendChart = dynamic<RealtimeRollingTrendChartIslandProps>(
  () =>
    import("@/components/dashboard/charts/realtime-rolling-trend-chart").then(
      (module) => module.RealtimeRollingTrendChart,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[280px] w-full animate-pulse rounded-md bg-muted/25" />
    ),
  },
);

export function RealtimeRollingTrendChartIsland(
  props: RealtimeRollingTrendChartIslandProps,
) {
  return <RealtimeRollingTrendChart {...props} />;
}
