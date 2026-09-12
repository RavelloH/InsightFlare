import { memo, type MouseEvent, useMemo } from "react";
import {
  RiArrowRightUpLine,
  RiSearchLine,
  RiShareForwardLine,
} from "@remixicon/react";

import {
  ComparisonMetricToggle,
  type ComparisonTableMetric,
  createComparisonTableColumns,
} from "@/components/dashboard/comparison-table";
import { InlineMeta } from "@/components/dashboard/journey-display";
import {
  LabelWithOptionalIcon,
  REFERRER_FILTER_CONTROL_BY_TAB,
  type ReferrerBreakdownRow,
  type ReferrerSortKey,
  type ReferrerTab,
} from "@/components/dashboard/referrer-utils";
import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableLoader,
  type TabbedDataTableTab,
} from "@/components/dashboard/tabbed-data-table-card";
import { TrafficChannelIcon } from "@/components/dashboard/traffic-channel-icon";
import { Clickable } from "@/components/ui/clickable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import {
  dashboardFilterValue,
  serializeDashboardSearchParams,
  setDashboardFilterValue,
  withDashboardFilterSearchParams,
} from "@/lib/dashboard/filter-state";
import { numberFormat } from "@/lib/dashboard/format";
import {
  type FilterDocument,
  filterScopePreferenceFromDocument,
} from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { usePathname } from "@/lib/router";
import { cn } from "@/lib/utils";

export type ReferrerBreakdownGroupKey = "source" | "channel";

interface ReferrerBreakdownCardProps {
  locale: Locale;
  messages: AppMessages;
  pathname: string;
  filters: FilterDocument;
  comparisonQuery: DashboardComparisonQuery | null;
  comparisonLabel: string;
  comparisonMetricByGroup: Readonly<
    Record<ReferrerBreakdownGroupKey, ComparisonTableMetric>
  >;
  onComparisonMetricChange: (
    group: ReferrerBreakdownGroupKey,
    metric: ComparisonTableMetric,
  ) => void;
  requestKey: string;
  loader: TabbedDataTableLoader<
    ReferrerTab,
    ReferrerBreakdownRow,
    ReferrerSortKey
  >;
  showSourceLinkTab?: boolean;
}

export const ReferrerBreakdownCard = memo(function ReferrerBreakdownCard({
  locale,
  messages,
  pathname,
  filters,
  comparisonQuery,
  comparisonLabel,
  comparisonMetricByGroup,
  onComparisonMetricChange,
  requestKey,
  loader,
  showSourceLinkTab = true,
}: ReferrerBreakdownCardProps) {
  const searchParams = useLiveSearchParams();
  const livePathname = usePathname() || pathname;
  const tabMeta = useMemo<Record<ReferrerTab, TabbedDataTableTab<ReferrerTab>>>(
    () => ({
      domain: {
        value: "domain",
        label: messages.overview.sourceTab,
        columnLabel: messages.overview.sourceDomainColumn,
      },
      link: {
        value: "link",
        label: messages.overview.sourceLinkTab,
        columnLabel: messages.overview.sourceLinkColumn,
      },
      channel: {
        value: "channel",
        label: messages.overview.channelTab,
        columnLabel: messages.overview.channelColumn,
      },
    }),
    [
      messages.overview.channelColumn,
      messages.overview.channelTab,
      messages.overview.sourceDomainColumn,
      messages.overview.sourceLinkColumn,
      messages.overview.sourceLinkTab,
      messages.overview.sourceTab,
    ],
  );
  const comparisonColumnsByGroup = useMemo(
    () =>
      Object.fromEntries(
        (
          Object.keys(comparisonMetricByGroup) as ReferrerBreakdownGroupKey[]
        ).map((group) => {
          const metric = comparisonMetricByGroup[group];
          return [
            group,
            createComparisonTableColumns<ReferrerBreakdownRow, ReferrerTab>({
              metric,
              comparisonLabel,
              locale,
              messages,
              getCurrent: (row) => row[metric],
              getReference: (row) => row.reference?.[metric],
              getChange: (row) => row.change?.[metric],
            }),
          ];
        }),
      ) as Record<
        ReferrerBreakdownGroupKey,
        readonly TabbedDataTableColumn<
          ReferrerBreakdownRow,
          ReferrerSortKey,
          ReferrerTab
        >[]
      >,
    [
      comparisonLabel,
      comparisonMetricByGroup.channel,
      comparisonMetricByGroup.source,
      locale,
      messages,
    ],
  );
  const currentColumns = useMemo<
    readonly TabbedDataTableColumn<
      ReferrerBreakdownRow,
      ReferrerSortKey,
      ReferrerTab
    >[]
  >(
    () => [
      {
        key: "views" as const,
        label: messages.common.views,
        getValue: (row: ReferrerBreakdownRow) => row.views,
        format: (value: number) => numberFormat(locale, value),
      },
      {
        key: "visitors" as const,
        label: messages.common.visitors,
        getValue: (row: ReferrerBreakdownRow) => row.visitors,
        format: (value: number) => numberFormat(locale, value),
      },
    ],
    [locale, messages.common.views, messages.common.visitors],
  );
  const activeFilterValueByTab = useMemo(
    () => ({
      domain:
        dashboardFilterValue(filters, REFERRER_FILTER_CONTROL_BY_TAB.domain) ??
        null,
      link:
        dashboardFilterValue(filters, REFERRER_FILTER_CONTROL_BY_TAB.link) ??
        null,
      channel:
        dashboardFilterValue(filters, REFERRER_FILTER_CONTROL_BY_TAB.channel) ??
        null,
    }),
    [filters],
  );
  // Session/Visitor scope first selects matching entities, then expands back
  // to all of their observations. Do not apply the selected referrer again
  // to the already-expanded result rows.
  const entityScopedOutput =
    filterScopePreferenceFromDocument(filters) === "session" ||
    filterScopePreferenceFromDocument(filters) === "visitor";

  function setFilter(next: { tab: ReferrerTab; value: string } | null) {
    const activeTab = next?.tab ?? "domain";
    const nextFilters = setDashboardFilterValue(
      filters,
      REFERRER_FILTER_CONTROL_BY_TAB[activeTab],
      next?.value,
    );
    const updatedParams = withDashboardFilterSearchParams(
      searchParams,
      nextFilters,
    );

    const updated = serializeDashboardSearchParams(updatedParams);
    const current = serializeDashboardSearchParams(searchParams);
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    replaceUrlWithoutNavigation(target);
  }

  function toggleRowFilter(tab: ReferrerTab, value: string) {
    const normalized = value.trim();
    const isActive = activeFilterValueByTab[tab] === normalized;
    setFilter(isActive ? null : { tab, value: normalized });
  }

  function openTarget(url: string, event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    globalThis.window.open(url, "_blank", "noopener,noreferrer");
  }

  const sourceTabs = (
    showSourceLinkTab ? [tabMeta.domain, tabMeta.link] : [tabMeta.domain]
  ) as [TabbedDataTableTab<ReferrerTab>, ...TabbedDataTableTab<ReferrerTab>[]];
  const channelTabs = [tabMeta.channel] as [
    TabbedDataTableTab<ReferrerTab>,
    ...TabbedDataTableTab<ReferrerTab>[],
  ];
  const rowAdapter = {
    renderLabel: (
      row: ReferrerBreakdownRow,
      { tab: activeTab }: { tab: ReferrerTab },
    ) => {
      const displayLabel = row.displayLabel ?? row.label;
      if (activeTab === "channel" && row.channelId) {
        return (
          <InlineMeta
            icon={<TrafficChannelIcon channel={row.channelId} />}
            label={displayLabel}
          />
        );
      }
      return (
        <span
          className={cn(
            "inline-flex items-center gap-2 break-words",
            row.mono && "font-mono",
          )}
        >
          <LabelWithOptionalIcon
            label={displayLabel}
            iconLabel={row.label}
            showIcon={activeTab !== "channel"}
            unknownLabel={messages.overview.direct}
          />
          {row.targetUrl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Clickable
                  className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                  onClick={(event) => openTarget(row.targetUrl!, event)}
                  aria-label={`${messages.common.open}: ${displayLabel}`}
                >
                  {activeTab === "link" ? (
                    <RiArrowRightUpLine size="1.4em" />
                  ) : (
                    <RiSearchLine size="1.2em" />
                  )}
                </Clickable>
              </TooltipTrigger>
              <TooltipContent>
                {`${messages.common.open}: ${displayLabel}`}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      );
    },
    getSearchText: (row: ReferrerBreakdownRow) => row.label,
    getExportLabel: (row: ReferrerBreakdownRow) => row.label,
    getActive: (row: ReferrerBreakdownRow, activeTab: ReferrerTab) =>
      activeFilterValueByTab[activeTab] === row.filterValue,
    getInteractive: () => true,
    onClick: (
      row: ReferrerBreakdownRow,
      { tab: activeTab }: { tab: ReferrerTab },
    ) => toggleRowFilter(activeTab, row.filterValue),
  };
  const filterRows = (
    rows: readonly ReferrerBreakdownRow[],
    activeTab: ReferrerTab,
  ) => {
    const activeValue = activeFilterValueByTab[activeTab];
    return !entityScopedOutput && activeValue
      ? rows.filter((row) => row.filterValue === activeValue)
      : [...rows];
  };
  const search = {
    actionLabel: messages.common.search,
    placeholder: (activeTab: TabbedDataTableTab<ReferrerTab>) =>
      formatI18nTemplate(messages.overview.searchInTab, {
        tab: activeTab.label,
      }),
  };
  const renderTable = (
    group: ReferrerBreakdownGroupKey,
    tabs: [
      TabbedDataTableTab<ReferrerTab>,
      ...TabbedDataTableTab<ReferrerTab>[],
    ],
  ) => (
    <TabbedDataTableCard<ReferrerTab, ReferrerBreakdownRow, ReferrerSortKey>
      tabs={tabs}
      loader={loader}
      requestKey={`${requestKey}:${group}:${comparisonMetricByGroup[group]}`}
      defaultSort={
        comparisonQuery ? { key: "current", direction: "desc" } : undefined
      }
      columns={
        comparisonQuery ? comparisonColumnsByGroup[group] : currentColumns
      }
      rowAdapter={rowAdapter}
      filterRows={filterRows}
      sortActionLabel={(label) =>
        formatI18nTemplate(messages.common.sortBy, { label })
      }
      loadingLabel={messages.common.loading}
      emptyLabel={messages.common.noData}
      className="h-full min-h-[420px]"
      search={search}
      export={{
        labels: messages.common.tableExport,
      }}
      headerRight={
        comparisonQuery ? (
          <ComparisonMetricToggle
            metric={comparisonMetricByGroup[group]}
            metrics={["views", "visitors"]}
            messages={messages}
            onMetricChange={(metric) => onComparisonMetricChange(group, metric)}
          />
        ) : null
      }
    />
  );

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium tracking-tight">
          <RiShareForwardLine className="size-4 shrink-0" />
          {messages.referrers.breakdownTitle}
        </h2>
      </div>

      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        <div className="h-full min-w-0">
          {renderTable("source", sourceTabs)}
        </div>
        <div className="h-full min-w-0">
          {renderTable("channel", channelTabs)}
        </div>
      </div>
    </section>
  );
});
