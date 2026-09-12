import { memo, useCallback, useMemo } from "react";
import { RiPriceTag3Line } from "@remixicon/react";

import {
  type CampaignBreakdownRow,
  type CampaignSortKey,
  type CampaignTab,
} from "@/components/dashboard/campaign-utils";
import {
  ComparisonMetricToggle,
  type ComparisonTableMetric,
  createComparisonTableColumns,
} from "@/components/dashboard/comparison-table";
import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableLoader,
  type TabbedDataTableRowAdapter,
  type TabbedDataTableTab,
} from "@/components/dashboard/tabbed-data-table-card";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

export type CampaignBreakdownGroupKey = "acquisition" | "signals";

interface CampaignBreakdownCardProps {
  locale: Locale;
  messages: AppMessages;
  loader: TabbedDataTableLoader<
    CampaignTab,
    CampaignBreakdownRow,
    CampaignSortKey
  >;
  comparisonQuery: DashboardComparisonQuery | null;
  comparisonLabel: string;
  comparisonMetricByGroup: Readonly<
    Record<CampaignBreakdownGroupKey, ComparisonTableMetric>
  >;
  onComparisonMetricChange: (
    group: CampaignBreakdownGroupKey,
    metric: ComparisonTableMetric,
  ) => void;
  requestKey: string;
}

const CAMPAIGN_BREAKDOWN_GROUPS: Array<{
  key: CampaignBreakdownGroupKey;
  tabs: CampaignTab[];
}> = [
  {
    key: "acquisition",
    tabs: ["source", "medium", "campaign"],
  },
  {
    key: "signals",
    tabs: ["term", "content"],
  },
];

export const CampaignBreakdownCard = memo(function CampaignBreakdownCard({
  locale,
  messages,
  loader,
  comparisonQuery,
  comparisonLabel,
  comparisonMetricByGroup,
  onComparisonMetricChange,
  requestKey,
}: CampaignBreakdownCardProps) {
  const tabMeta = useMemo<Record<CampaignTab, TabbedDataTableTab<CampaignTab>>>(
    () => ({
      source: {
        value: "source",
        label: messages.campaigns.tabSource,
        columnLabel: messages.campaigns.tabSource,
      },
      medium: {
        value: "medium",
        label: messages.campaigns.tabMedium,
        columnLabel: messages.campaigns.tabMedium,
      },
      campaign: {
        value: "campaign",
        label: messages.campaigns.tabCampaign,
        columnLabel: messages.campaigns.tabCampaign,
      },
      term: {
        value: "term",
        label: messages.campaigns.tabTerm,
        columnLabel: messages.campaigns.tabTerm,
      },
      content: {
        value: "content",
        label: messages.campaigns.tabContent,
        columnLabel: messages.campaigns.tabContent,
      },
    }),
    [
      messages.campaigns.tabCampaign,
      messages.campaigns.tabContent,
      messages.campaigns.tabMedium,
      messages.campaigns.tabSource,
      messages.campaigns.tabTerm,
    ],
  );
  const comparisonColumnsByGroup = useMemo(
    () =>
      Object.fromEntries(
        (
          Object.keys(comparisonMetricByGroup) as CampaignBreakdownGroupKey[]
        ).map((group) => {
          const metric = comparisonMetricByGroup[group];
          return [
            group,
            createComparisonTableColumns<CampaignBreakdownRow, CampaignTab>({
              metric,
              comparisonLabel,
              locale,
              messages,
              getCurrent: (row) => row[metric] ?? 0,
              getReference: (row) => row.reference?.[metric],
              getChange: (row) => row.change?.[metric],
            }),
          ];
        }),
      ) as Record<
        CampaignBreakdownGroupKey,
        readonly TabbedDataTableColumn<
          CampaignBreakdownRow,
          CampaignSortKey,
          CampaignTab
        >[]
      >,
    [
      comparisonLabel,
      comparisonMetricByGroup.acquisition,
      comparisonMetricByGroup.signals,
      locale,
      messages,
    ],
  );
  const currentColumns = useMemo<
    readonly TabbedDataTableColumn<
      CampaignBreakdownRow,
      CampaignSortKey,
      CampaignTab
    >[]
  >(
    () => [
      {
        key: "views" as const,
        label: messages.common.views,
        getValue: (row: CampaignBreakdownRow) => row.views,
        format: (value: number) => numberFormat(locale, value),
      },
      {
        key: "sessions" as const,
        label: messages.common.sessions,
        getValue: (row: CampaignBreakdownRow) => row.sessions,
        format: (value: number) => numberFormat(locale, value),
      },
    ],
    [locale, messages.common.sessions, messages.common.views],
  );
  const groupTabsByKey = useMemo(
    () =>
      Object.fromEntries(
        CAMPAIGN_BREAKDOWN_GROUPS.map((group) => [
          group.key,
          group.tabs.map((tab) => tabMeta[tab]) as [
            TabbedDataTableTab<CampaignTab>,
            ...TabbedDataTableTab<CampaignTab>[],
          ],
        ]),
      ) as Record<
        CampaignBreakdownGroupKey,
        [TabbedDataTableTab<CampaignTab>, ...TabbedDataTableTab<CampaignTab>[]]
      >,
    [tabMeta],
  );
  const rowAdapter = useMemo<
    TabbedDataTableRowAdapter<
      CampaignBreakdownRow,
      CampaignTab,
      CampaignSortKey
    >
  >(
    () => ({
      renderLabel: (row) => (
        <span className={cn("break-words", row.mono && "font-mono")}>
          {row.label}
        </span>
      ),
      getSearchText: (row) => row.label,
      getExportLabel: (row) => row.label,
      getClassName: () => "hover:brightness-95",
    }),
    [],
  );
  const labelColumnLabel = useCallback(
    (tab: TabbedDataTableTab<CampaignTab>) => tab.columnLabel ?? tab.label,
    [],
  );
  const search = useMemo(
    () => ({
      actionLabel: messages.common.search,
      placeholder: (tab: TabbedDataTableTab<CampaignTab>) =>
        formatI18nTemplate(messages.overview.searchInTab, {
          tab: tab.label,
        }),
    }),
    [messages.common.search, messages.overview.searchInTab],
  );
  const exportConfig = useMemo(
    () => ({
      labels: messages.common.tableExport,
    }),
    [messages.common.tableExport],
  );
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium tracking-tight">
          <RiPriceTag3Line className="size-4 shrink-0" />
          {messages.campaigns.breakdownTitle}
        </h2>
      </div>

      <div className="grid items-stretch gap-6 lg:grid-cols-2">
        {CAMPAIGN_BREAKDOWN_GROUPS.map((group) => {
          const comparisonMetric = comparisonMetricByGroup[group.key];
          return (
            <div key={group.key} className="h-full min-w-0">
              <TabbedDataTableCard<
                CampaignTab,
                CampaignBreakdownRow,
                CampaignSortKey
              >
                tabs={groupTabsByKey[group.key]}
                loader={loader}
                requestKey={`${requestKey}:${group.key}:${comparisonMetric}`}
                defaultSort={
                  comparisonQuery
                    ? { key: "current", direction: "desc" }
                    : undefined
                }
                columns={
                  comparisonQuery
                    ? comparisonColumnsByGroup[group.key]
                    : currentColumns
                }
                rowAdapter={rowAdapter}
                labelColumnLabel={labelColumnLabel}
                sortActionLabel={(label) =>
                  formatI18nTemplate(messages.common.sortBy, { label })
                }
                loadingLabel={messages.common.loading}
                emptyLabel={messages.campaigns.noTaggedTraffic}
                className="h-full min-h-[420px]"
                search={search}
                export={exportConfig}
                headerRight={
                  comparisonQuery ? (
                    <ComparisonMetricToggle
                      metric={comparisonMetric}
                      metrics={["views", "sessions"]}
                      messages={messages}
                      onMetricChange={(metric) =>
                        onComparisonMetricChange(group.key, metric)
                      }
                    />
                  ) : null
                }
              />
            </div>
          );
        })}
      </div>
    </section>
  );
});
