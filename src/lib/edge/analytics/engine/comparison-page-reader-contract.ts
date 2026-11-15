import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";

export interface ComparisonPageReaderContract {
  readonly selection: PageDimensionSelection;
  readonly route: "existing-qualified" | "membership-recipe";
  readonly readerProfile: "comparison-page-dimension-v1";
  readonly sourceRole: "page";
  readonly maxPlans: 1;
  readonly maxSources: 1;
}
/** Exact reader declarations only. No audience, subject or authorization grant. */
const COMPARISON_PAGE_READERS = {
  "page.path": {
    selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
    route: "existing-qualified",
  },
  "page.query": {
    selection: PAGE_DIMENSION_SELECTIONS.pageQueryTrimmed,
    route: "existing-qualified",
  },
  "page.title": {
    selection: PAGE_DIMENSION_SELECTIONS.pageTitleTrimmed,
    route: "existing-qualified",
  },
  "page.hostname": {
    selection: PAGE_DIMENSION_SELECTIONS.pageHostnameTrimmed,
    route: "existing-qualified",
  },
  "source.domain": {
    selection: PAGE_DIMENSION_SELECTIONS.referrerDomain,
    route: "membership-recipe",
  },
  "source.link": {
    selection: PAGE_DIMENSION_SELECTIONS.referrerUrl,
    route: "membership-recipe",
  },
  "source.channel": {
    selection: PAGE_DIMENSION_SELECTIONS.trafficChannel,
    route: "membership-recipe",
  },
  "client.browser": {
    selection: PAGE_DIMENSION_SELECTIONS.browser,
    route: "membership-recipe",
  },
  "client.osVersion": {
    selection: PAGE_DIMENSION_SELECTIONS.osVersion,
    route: "membership-recipe",
  },
  "client.deviceType": {
    selection: PAGE_DIMENSION_SELECTIONS.deviceType,
    route: "membership-recipe",
  },
  "client.language": {
    selection: PAGE_DIMENSION_SELECTIONS.language,
    route: "membership-recipe",
  },
  "client.screenSize": {
    selection: PAGE_DIMENSION_SELECTIONS.screenSize,
    route: "membership-recipe",
  },
  "utm.source": {
    selection: PAGE_DIMENSION_SELECTIONS.utmSource,
    route: "membership-recipe",
  },
  "utm.medium": {
    selection: PAGE_DIMENSION_SELECTIONS.utmMedium,
    route: "membership-recipe",
  },
  "utm.campaign": {
    selection: PAGE_DIMENSION_SELECTIONS.utmCampaign,
    route: "membership-recipe",
  },
  "utm.term": {
    selection: PAGE_DIMENSION_SELECTIONS.utmTerm,
    route: "membership-recipe",
  },
  "utm.content": {
    selection: PAGE_DIMENSION_SELECTIONS.utmContent,
    route: "membership-recipe",
  },
  "geo.country": {
    selection: PAGE_DIMENSION_SELECTIONS.countryTrimmed,
    route: "membership-recipe",
  },
  "geo.region": {
    selection: PAGE_DIMENSION_SELECTIONS.region,
    route: "membership-recipe",
  },
  "geo.city": {
    selection: PAGE_DIMENSION_SELECTIONS.city,
    route: "membership-recipe",
  },
  "geo.continent": {
    selection: PAGE_DIMENSION_SELECTIONS.continentTrimmed,
    route: "membership-recipe",
  },
  "geo.timezone": {
    selection: PAGE_DIMENSION_SELECTIONS.timezoneTrimmed,
    route: "existing-qualified",
  },
  "geo.organization": {
    selection: PAGE_DIMENSION_SELECTIONS.organizationTrimmed,
    route: "existing-qualified",
  },
} as const;
export type ComparisonPageReaderTab = keyof typeof COMPARISON_PAGE_READERS;
const contracts = Object.fromEntries(
  Object.entries(COMPARISON_PAGE_READERS).map(([tab, reader]) => [
    tab,
    Object.freeze({
      ...reader,
      readerProfile: "comparison-page-dimension-v1" as const,
      sourceRole: "page" as const,
      maxPlans: 1 as const,
      maxSources: 1 as const,
    }),
  ]),
) as Readonly<Record<ComparisonPageReaderTab, ComparisonPageReaderContract>>;
Object.freeze(contracts);
export const COMPARISON_PAGE_READER_TABS = Object.freeze(
  Object.keys(COMPARISON_PAGE_READERS) as ComparisonPageReaderTab[],
);
export function comparisonPageReaderContract(
  tab: string,
): ComparisonPageReaderContract | undefined {
  return Object.hasOwn(contracts, tab)
    ? contracts[tab as ComparisonPageReaderTab]
    : undefined;
}
