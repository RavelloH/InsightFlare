import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  currentTotals,
  previousTotals,
  SHOWCASE_SOURCES,
  splitTotal,
} from "../showcase/site-profile";
import {
  ShareBreakdownView,
  type ShareBreakdownViewProps,
} from "./share-breakdown-view";

export type ShareBreakdownFixture = ComponentFixture<ShareBreakdownViewProps>;
export type ShareBreakdownContract = ReturnType<
  typeof defineComponentContract<ShareBreakdownViewProps>
>;

function sourceItems(total: number, drift: readonly number[]) {
  const values = splitTotal(
    total,
    SHOWCASE_SOURCES.map(
      (source, index) => source.weight * (drift[index] ?? 1),
    ),
  );
  return SHOWCASE_SOURCES.map((source, index) => ({
    key: source.key,
    label: source.label,
    value: values[index] ?? 0,
    ...(source.key === "other" ? { isOther: true } : {}),
  }));
}

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
    id: "sharing.share-breakdown.showcase",
    title: "Showcase",
    description: "Traffic sources of a developer-tools site, with comparison.",
    presentation: { kind: "scenario", scenario: "showcase" },
    props: {
      title: "Traffic sources",
      items: sourceItems(
        currentTotals.visitors,
        [1, 1, 1.05, 1.8, 1, 1.1, 1, 1],
      ),
      comparisonItems: sourceItems(
        previousTotals.visitors,
        [1, 1.08, 0.96, 0.7, 1.15, 0.92, 1, 1],
      ),
      comparisonLabel: "Previous period",
      maxItems: 6,
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
