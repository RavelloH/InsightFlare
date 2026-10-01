import type { RealtimeTrafficTrendViewProps } from "@insightflare/product-ui/realtime";

import dynamic from "@/lib/dynamic";

const RealtimeRollingTrendChart = dynamic<RealtimeTrafficTrendViewProps>(
  () =>
    import("@insightflare/product-ui/realtime").then(
      (module) => module.RealtimeTrafficTrendView,
    ),
  {
    ssr: false,
    loading: () => <div className="h-[280px] w-full" aria-hidden="true" />,
  },
);

export function RealtimeRollingTrendChartIsland(
  props: RealtimeTrafficTrendViewProps,
) {
  return <RealtimeRollingTrendChart {...props} />;
}
