import type { ComparisonReportFamily } from "./comparison-report-plan";
import type { PageDimensionSelection } from "./dimension-report-plan";
import { PAGE_DIMENSION_SELECTIONS } from "./dimension-report-plan";

export interface ComparisonPageTab {
  readonly selection: PageDimensionSelection;
}

const COMPARISON_PAGE_TABS: Readonly<Record<string, ComparisonPageTab>> = {
  "page.path": {
    selection: PAGE_DIMENSION_SELECTIONS.pagePathTrimmed,
  },
  "page.query": {
    selection: PAGE_DIMENSION_SELECTIONS.pageQueryTrimmed,
  },
  "page.title": {
    selection: PAGE_DIMENSION_SELECTIONS.pageTitleTrimmed,
  },
  "page.hostname": {
    selection: PAGE_DIMENSION_SELECTIONS.pageHostnameTrimmed,
  },
  "geo.timezone": {
    selection: PAGE_DIMENSION_SELECTIONS.timezoneTrimmed,
  },
  "geo.organization": {
    selection: PAGE_DIMENSION_SELECTIONS.organizationTrimmed,
  },
};

export function comparisonPageTab(tab: string): ComparisonPageTab | undefined {
  return Object.hasOwn(COMPARISON_PAGE_TABS, tab)
    ? COMPARISON_PAGE_TABS[tab]
    : undefined;
}

/** Resolves the logical comparison report family without storage expressions. */
export function normalizeComparisonReportFamily(
  tab: string,
): ComparisonReportFamily | undefined {
  if (tab === "page.entry" || tab === "page.exit")
    return {
      kind: "session-boundary",
      pathKind: tab === "page.entry" ? "entry" : "exit",
    };
  const pageTab = comparisonPageTab(tab);
  return pageTab
    ? { kind: "page-dimension", selection: pageTab.selection }
    : undefined;
}
