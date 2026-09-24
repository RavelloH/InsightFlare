import { useMemo } from "react";
import { RiPulseLine, RiRepeat2Line } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { PageHeading } from "@/components/dashboard/common/page-heading";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/comparison/use-dashboard-comparison-query";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import { AutoTransition } from "@/components/ui/auto-transition";
import { fetchRetention } from "@/lib/dashboard/client/data/index";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { RetentionData } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import {
  RetentionMatrix,
  RetentionStateCard,
  RetentionSummaryGrid,
} from "./components";
import {
  buildRetentionComparisonViewModel,
  buildRetentionViewModel,
  retentionLoadingShape,
} from "./model";
interface RetentionClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}
interface RetentionQueryData {
  current: RetentionData;
  comparison: RetentionData | null;
}
export function RetentionClientPage({
  locale,
  messages,
  siteId,
}: RetentionClientPageProps) {
  const labels = messages.retention;
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonQuery = useDashboardComparisonQuery(timeWindow, filters);
  const comparisonLabel = dashboardComparisonLabel(messages, comparisonQuery);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const granularity = timeWindow.interval;
  const loadingShape = useMemo(
    () => retentionLoadingShape(timeWindow, granularity, filters),
    [
      filters,
      filtersKey,
      granularity,
      timeWindow.from,
      timeWindow.timeZone,
      timeWindow.to,
    ],
  );

  const {
    data: queryData,
    isError: error,
    isFetching: loading,
    isPending,
  } = useQuery<RetentionQueryData>({
    queryKey: [
      "dashboard",
      "retention",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      granularity,
      filtersKey,
      comparisonQuery?.mode ?? "none",
      comparisonQuery?.window.from ?? null,
      comparisonQuery?.window.to ?? null,
      comparisonQuery?.window.timeZone ?? null,
      comparisonFiltersKey,
    ],
    queryFn: async ({ signal }) => {
      const currentRequest = fetchRetention(siteId, timeWindow, filters, {
        granularity,
        signal,
      });
      if (!comparisonQuery) {
        return {
          current: await currentRequest,
          comparison: null,
        };
      }

      const [current, comparison] = await Promise.all([
        currentRequest,
        fetchRetention(
          siteId,
          comparisonQuery.window,
          comparisonQuery.filters,
          { granularity, signal },
        ),
      ]);
      return { current, comparison };
    },
    enabled: typeof window !== "undefined",
  });
  const initialLoading = isPending && queryData === undefined;
  const resolvedLoading = loading || initialLoading;

  const viewModel = useMemo(
    () =>
      buildRetentionViewModel(
        queryData?.current ?? null,
        locale,
        messages,
        labels,
        granularity,
        timeWindow,
      ),
    [queryData?.current, locale, messages, labels, granularity, timeWindow],
  );
  const comparisonViewModel = useMemo(() => {
    if (!comparisonQuery || !queryData?.comparison) return null;
    const comparison = buildRetentionViewModel(
      queryData.comparison,
      locale,
      messages,
      labels,
      granularity,
      comparisonQuery.window,
    );
    return buildRetentionComparisonViewModel(
      viewModel,
      comparison,
      timeWindow,
      comparisonQuery.window,
      granularity,
    );
  }, [
    comparisonQuery,
    granularity,
    labels,
    locale,
    messages,
    queryData?.comparison,
    timeWindow,
    viewModel,
  ]);
  const isEmpty = !resolvedLoading && !error && viewModel.cohorts.length === 0;
  const bodyState = resolvedLoading
    ? "loading"
    : error
      ? "error"
      : isEmpty
        ? "empty"
        : "ready";

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.retention.title}
        subtitle={messages.retention.subtitle}
      />

      {resolvedLoading || (!error && !isEmpty) ? (
        <RetentionSummaryGrid
          locale={locale}
          labels={labels}
          viewModel={viewModel}
          comparisonViewModel={comparisonViewModel?.comparison ?? null}
          comparisonLabel={comparisonLabel}
          loading={resolvedLoading}
        />
      ) : null}

      {resolvedLoading || (!error && !isEmpty) ? (
        <div className="space-y-4">
          <RetentionMatrix
            locale={locale}
            messages={messages}
            labels={labels}
            viewModel={viewModel}
            comparisonViewModel={comparisonViewModel}
            comparisonLabel={comparisonLabel}
            loading={resolvedLoading}
            loadingShape={loadingShape}
          />
        </div>
      ) : (
        <AutoTransition
          transitionKey={bodyState}
          duration={0.18}
          type="fade"
          presenceMode="wait"
        >
          {error ? (
            <RetentionStateCard
              title={labels.loadError}
              subtitle={messages.retention.subtitle}
              icon={RiPulseLine}
            />
          ) : (
            <RetentionStateCard
              title={labels.empty}
              subtitle={labels.emptyHint}
              icon={RiRepeat2Line}
            />
          )}
        </AutoTransition>
      )}
    </div>
  );
}
