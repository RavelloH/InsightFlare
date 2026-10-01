import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  RealtimeTrafficTrendView,
  type RealtimeTrafficTrendViewProps,
} from "./realtime-traffic-trend-view";

const realtimeTrafficTrendData = [
  {
    label: "12:01",
    tooltipLabel: "2026-07-13 12:01",
    views: 11,
    visitors: 8,
  },
  {
    label: "12:02",
    tooltipLabel: "2026-07-13 12:02",
    views: 15,
    visitors: 10,
  },
  {
    label: "12:03",
    tooltipLabel: "2026-07-13 12:03",
    views: 9,
    visitors: 7,
  },
  {
    label: "12:04",
    tooltipLabel: "2026-07-13 12:04",
    views: 18,
    visitors: 12,
  },
] as const;

export const realtimeTrafficTrendFixtures = [
  {
    id: "realtime-traffic-trend.state.ready",
    title: "Live traffic",
    presentation: { kind: "scenario", scenario: "ready" },
    props: {
      state: "ready",
      data: realtimeTrafficTrendData,
      locale: "en-US",
      title: "Realtime traffic",
      viewsLabel: "Views",
      visitorsLabel: "Visitors",
    } satisfies RealtimeTrafficTrendViewProps,
  },
  {
    id: "realtime-traffic-trend.state.loading",
    title: "Waiting for connection",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      state: "loading",
      data: realtimeTrafficTrendData,
      locale: "en-US",
      title: "Realtime traffic",
      viewsLabel: "Views",
      visitorsLabel: "Visitors",
    } satisfies RealtimeTrafficTrendViewProps,
  },
] as const satisfies readonly ComponentFixture<RealtimeTrafficTrendViewProps>[];

export const realtimeTrafficTrendContract =
  defineComponentContract<RealtimeTrafficTrendViewProps>({
    id: "realtime-traffic-trend",
    title: "Realtime traffic trend",
    category: "Product UI / Realtime",
    categoryId: "product-realtime",
    description:
      "A props-only live traffic visualization with deterministic ready and loading states.",
    fixtures: realtimeTrafficTrendFixtures,
    render: (props) => <RealtimeTrafficTrendView {...props} />,
  });
