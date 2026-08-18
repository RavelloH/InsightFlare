import { type MouseEvent, useMemo } from "react";
import {
  RiArrowRightUpLine,
  RiSearchLine,
  RiShareForwardLine,
} from "@remixicon/react";

import {
  LabelWithOptionalIcon,
  REFERRER_FILTER_CONTROL_BY_TAB,
  type ReferrerBreakdownRow,
  type ReferrerRowsByTab,
  type ReferrerTab,
} from "@/components/dashboard/referrer-utils";
import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableTab,
} from "@/components/dashboard/tabbed-data-table-card";
import { Clickable } from "@/components/ui/clickable";
import {
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import {
  dashboardFilterValue,
  serializeDashboardSearchParams,
  setDashboardFilterValue,
  withDashboardFilterSearchParams,
} from "@/lib/dashboard/filter-state";
import { numberFormat } from "@/lib/dashboard/format";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { usePathname } from "@/lib/router";
import { cn } from "@/lib/utils";

type ReferrerSortKey = "views" | "visitors";

interface ReferrerBreakdownCardProps {
  locale: Locale;
  messages: AppMessages;
  pathname: string;
  filters: FilterDocument;
  rowsByTab: ReferrerRowsByTab;
  loading: boolean;
}

const REFERRER_TABS = ["domain", "link"] as const satisfies ReferrerTab[];

export function ReferrerBreakdownCard({
  locale,
  messages,
  pathname,
  filters,
  rowsByTab,
  loading,
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
    }),
    [
      messages.overview.sourceDomainColumn,
      messages.overview.sourceLinkColumn,
      messages.overview.sourceLinkTab,
      messages.overview.sourceTab,
    ],
  );
  const columns = useMemo<
    readonly TabbedDataTableColumn<
      ReferrerBreakdownRow,
      ReferrerSortKey,
      ReferrerTab
    >[]
  >(
    () => [
      {
        key: "views",
        label: messages.common.views,
        getValue: (row) => row.views,
        format: (value) => numberFormat(locale, value),
      },
      {
        key: "visitors",
        label: messages.common.visitors,
        getValue: (row) => row.visitors,
        format: (value) => numberFormat(locale, value),
      },
    ],
    [locale, messages.common.views, messages.common.visitors],
  );
  const loadingByTab = useMemo(
    () => ({
      domain: loading,
      link: loading,
    }),
    [loading],
  );
  const activeFilterValueByTab = useMemo(
    () => ({
      domain:
        dashboardFilterValue(filters, REFERRER_FILTER_CONTROL_BY_TAB.domain) ??
        null,
      link:
        dashboardFilterValue(filters, REFERRER_FILTER_CONTROL_BY_TAB.link) ??
        null,
    }),
    [filters],
  );

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

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium tracking-tight">
          <RiShareForwardLine className="size-4 shrink-0" />
          {messages.referrers.breakdownTitle}
        </h2>
      </div>

      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        {REFERRER_TABS.map((tab) => (
          <div key={tab} className="h-full min-w-0">
            <TabbedDataTableCard<
              ReferrerTab,
              ReferrerBreakdownRow,
              ReferrerSortKey
            >
              tabs={[tabMeta[tab]]}
              rowsByTab={rowsByTab}
              loadingByTab={loadingByTab}
              columns={columns}
              rowAdapter={{
                renderLabel: (row, { tab: activeTab }) => {
                  const displayLabel = row.displayLabel ?? row.label;
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
                        showIcon
                        unknownLabel={messages.overview.direct}
                      />
                      {row.targetUrl ? (
                        <Clickable
                          className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                          onClick={(event) => openTarget(row.targetUrl!, event)}
                          aria-label={displayLabel}
                          title={displayLabel}
                        >
                          {activeTab === "link" ? (
                            <RiArrowRightUpLine size="1.4em" />
                          ) : (
                            <RiSearchLine size="1.2em" />
                          )}
                        </Clickable>
                      ) : null}
                    </span>
                  );
                },
                getSearchText: (row) => row.label,
                getExportLabel: (row) => row.label,
                getActive: (row, activeTab) =>
                  activeFilterValueByTab[activeTab] === row.filterValue,
                getInteractive: () => true,
                onClick: (row, { tab: activeTab }) =>
                  toggleRowFilter(activeTab, row.filterValue),
              }}
              filterRows={(rows, activeTab) => {
                const activeValue = activeFilterValueByTab[activeTab];
                return activeValue
                  ? rows.filter((row) => row.filterValue === activeValue)
                  : [...rows];
              }}
              compareRows={(left, right, { sort }) => {
                const primary =
                  (left[sort.key] - right[sort.key]) *
                  (sort.direction === "asc" ? 1 : -1);
                if (primary !== 0) return primary;
                if (right.views !== left.views) return right.views - left.views;
                if (right.visitors !== left.visitors) {
                  return right.visitors - left.visitors;
                }
                return (left.displayLabel ?? left.label).localeCompare(
                  right.displayLabel ?? right.label,
                );
              }}
              loadingLabel={messages.common.loading}
              emptyLabel={messages.common.noData}
              className="h-full min-h-[420px]"
              search={{
                actionLabel: messages.common.search,
                placeholder: (activeTab) =>
                  formatI18nTemplate(messages.overview.searchInTab, {
                    tab: activeTab.label,
                  }),
              }}
              export={{
                labels: messages.common.tableExport,
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
