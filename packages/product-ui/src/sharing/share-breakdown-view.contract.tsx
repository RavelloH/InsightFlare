import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  ShareBreakdownView,
  type ShareBreakdownViewProps,
} from "./share-breakdown-view";

export type ShareBreakdownFixture = ComponentFixture<ShareBreakdownViewProps>;
export type ShareBreakdownContract = ReturnType<
  typeof defineComponentContract<ShareBreakdownViewProps>
>;

export const shareBreakdownFixtures = [
  {
    id: "sharing.share-breakdown.with-comparison",
    title: "Share and comparison",
    presentation: { kind: "scenario", scenario: "with-comparison" },
    props: {
      title: "Traffic sources",
      items: [
        { key: "search", label: "Search", value: 1284 },
        { key: "direct", label: "Direct", value: 742 },
        { key: "social", label: "Social", value: 318 },
      ],
      comparisonItems: [
        { key: "search", label: "Search", value: 1014 },
        { key: "direct", label: "Direct", value: 814 },
        { key: "social", label: "Social", value: 270 },
      ],
      comparisonLabel: "Previous period",
      maxItems: 4,
      locale: "en-US",
      valueLabel: "visitors",
      emptyLabel: "No traffic sources",
    } satisfies ShareBreakdownViewProps,
  },
  {
    id: "sharing.share-breakdown.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: {
      title: "Traffic sources",
      items: [],
      maxItems: 4,
      locale: "en-US",
      valueLabel: "visitors",
      emptyLabel: "No traffic sources",
      loading: true,
    } satisfies ShareBreakdownViewProps,
  },
] as const satisfies readonly ShareBreakdownFixture[];

export const shareBreakdownContract: ShareBreakdownContract =
  defineComponentContract<ShareBreakdownViewProps>({
    id: "sharing.share-breakdown",
    title: "Traffic share breakdown",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    description:
      "A props-only traffic share view with optional period comparison.",
    fixtures: shareBreakdownFixtures,
    render: (props) => <ShareBreakdownView {...props} />,
  });
