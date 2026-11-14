import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { createShowcaseRng, gaussian, poisson } from "../showcase/site-profile";
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

function showcaseMinute(index: number) {
  const minutes = 12 * 60 + index;
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mins = String(minutes % 60).padStart(2, "0");
  return `${hours}:${mins}`;
}

function showcaseRealtimeData() {
  // A slowly drifting arrival rate, sampled as Poisson counts per minute.
  const rng = createShowcaseRng(130712);
  let rate = 11;
  return Array.from({ length: 30 }, (_, index) => {
    rate = Math.max(4, rate + gaussian(rng) * 1.1 + (13 - rate) * 0.12);
    const visitors = Math.max(1, poisson(rng, rate));
    const views = visitors + poisson(rng, visitors * 0.85);
    const time = showcaseMinute(index);
    return {
      label: time,
      tooltipLabel: `2026-07-13 ${time}`,
      views,
      visitors,
    };
  });
}

const realtimeTrafficTrendShowcaseData = showcaseRealtimeData();

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
  {
    id: "realtime-traffic-trend.showcase",
    title: "Showcase",
    description:
      "Thirty minutes of realistic live traffic for marketing and documentation pages.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      state: "ready",
      data: realtimeTrafficTrendShowcaseData,
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
