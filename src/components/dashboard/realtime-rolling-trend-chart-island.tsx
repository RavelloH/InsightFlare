import dynamic from "@/lib/dynamic";

import type { TrafficPairAreaChartProps } from "./charts/traffic-pair-area-chart";

export type { TrafficPairDataPoint } from "./charts/traffic-pair-chart";

type RealtimeRollingTrendChartIslandProps = TrafficPairAreaChartProps;

const RealtimeRollingTrendChart = dynamic<RealtimeRollingTrendChartIslandProps>(
  () =>
    import("@/components/dashboard/charts/traffic-pair-area-chart").then(
      (module) => module.TrafficPairAreaChart,
    ),
  {
    ssr: false,
    loading: () => <div className="h-[280px] w-full" aria-hidden="true" />,
  },
);

export function RealtimeRollingTrendChartIsland(
  props: RealtimeRollingTrendChartIslandProps,
) {
  return <RealtimeRollingTrendChart {...props} />;
}
