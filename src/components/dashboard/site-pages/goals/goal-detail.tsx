import { useState } from "react";
import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { MetricSummaryGrid } from "@insightflare/ui/metric-summary-grid";
import { Skeleton } from "@insightflare/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@insightflare/ui/tabs";
import {
  RiDeleteBinLine,
  RiEditLine,
  RiFileList3Line,
  RiLineChartLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { AnalysisJourneyTable } from "@/components/dashboard/site-pages/journeys/analysis-journey-table";
import {
  fetchGoalSummary,
  fetchGoalTimeseries,
} from "@/lib/dashboard/client/data/index";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import {
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  GoalDefinition,
  GoalSummary,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import { type AppMessages, getMessages } from "@/lib/i18n/messages";

import { goalFilterSummary, goalSummaryQueryKey } from "./goal-card";
import { GoalTimeseriesChart } from "./goal-timeseries-chart";
export function goalTimeseriesQueryKey(
  siteId: string,
  goal: Pick<GoalDefinition, "id" | "semanticFingerprint">,
  window: TimeWindow,
  filterKey: string,
  scope: string,
) {
  return [
    "dashboard",
    "goal-timeseries",
    siteId,
    goal.id,
    goal.semanticFingerprint,
    window.from,
    window.to,
    window.timeZone,
    window.interval,
    filterKey,
    scope,
  ] as const;
}
function updatedLabel(
  locale: Locale,
  labels: AppMessages["goals"],
  timestampSeconds: number,
): string {
  const date = new Date(timestampSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return labels.updated;
  return `${labels.updated} ${new Intl.DateTimeFormat(intlLocale(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)}`;
}
function conversionRateChange(
  current?: GoalSummary["sessions"],
  comparison?: GoalSummary["sessions"],
): number | null {
  const currentRate = Number(current?.conversionRate);
  const comparisonRate = Number(comparison?.conversionRate);
  if (
    !Number.isFinite(currentRate) ||
    !Number.isFinite(comparisonRate) ||
    comparisonRate === 0
  ) {
    return null;
  }
  return ((currentRate - comparisonRate) / comparisonRate) * 100;
}
function goalMetricValue(
  summary: GoalSummary | undefined,
  audience: "visitors" | "sessions",
  locale: Locale,
): string {
  const metric = summary?.[audience];
  return `${numberFormat(locale, metric?.converted ?? 0)} / ${numberFormat(locale, metric?.total ?? 0)}`;
}
function goalMetricRate(
  summary: GoalSummary | undefined,
  audience: "visitors" | "sessions",
  locale: Locale,
): string {
  return percentFormat(locale, summary?.[audience].conversionRate ?? 0);
}
function GoalDetailSkeleton({
  canManage,
  labels,
}: {
  readonly canManage: boolean;
  readonly labels: AppMessages["goals"];
}) {
  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-7 w-56 max-w-full" />
          <Skeleton className="h-4 w-44" />
        </div>
        {canManage ? (
          <div className="flex items-center justify-end gap-2 self-start">
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-20" />
          </div>
        ) : null}
      </div>
      <MetricSummaryGrid
        items={[
          {
            id: "visitors",
            label: labels.visitors,
            value: "",
            detail: "",
            loading: true,
          },
          {
            id: "sessions",
            label: labels.sessions,
            value: "",
            detail: "",
            loading: true,
          },
          {
            id: "visitor-conversion",
            label: `${labels.visitors} ${labels.conversion}`,
            value: "",
            detail: "",
            loading: true,
          },
          {
            id: "session-conversion",
            label: `${labels.sessions} ${labels.conversion}`,
            value: "",
            detail: "",
            loading: true,
          },
        ]}
      />
      <Card className="min-w-0">
        <CardHeader>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[280px] w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
export function GoalDetail({
  goal,
  siteId,
  pathname = "",
  locale,
  labels,
  messages,
  window,
  filters,
  filterKey,
  comparisonQuery,
  comparisonLabel,
  canManage,
  actionPending,
  onEdit,
  onDelete,
  loading = false,
  loadError = false,
}: {
  readonly goal?: GoalDefinition;
  readonly siteId: string;
  readonly pathname?: string;
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly messages?: Pick<
    AppMessages,
    "conditionDescription" | "filterBuilder"
  >;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
  readonly filterKey: string;
  readonly comparisonQuery?: DashboardComparisonQuery | null;
  readonly comparisonLabel?: string;
  readonly canManage: boolean;
  readonly actionPending: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly loading?: boolean;
  readonly loadError?: boolean;
}) {
  const goalId = goal?.id ?? "";
  const [journeyEntity, setJourneyEntity] = useState<"visitors" | "sessions">(
    "visitors",
  );
  const comparisonFilterKey = comparisonQuery
    ? filterQueryKey(comparisonQuery.filters)
    : "none";
  const summary = useQuery({
    queryKey: goal
      ? goalSummaryQueryKey(siteId, goal, window, filterKey, "auto")
      : [
          "dashboard",
          "goal-summary",
          siteId,
          goalId,
          window.from,
          window.to,
          window.timeZone,
          filterKey,
        ],
    queryFn: ({ signal }) =>
      fetchGoalSummary(siteId, goalId, window, filters, {
        signal,
        ...(goal ? { goalSemanticFingerprint: goal.semanticFingerprint } : {}),
      }),
    enabled: Boolean(goalId),
  });
  const comparisonSummary = useQuery({
    queryKey:
      goal && comparisonQuery
        ? goalSummaryQueryKey(
            siteId,
            goal,
            comparisonQuery.window,
            comparisonFilterKey,
            "auto",
          )
        : ["dashboard", "goal-summary-comparison-disabled", siteId, goalId],
    queryFn: ({ signal }) => {
      if (!goal || !comparisonQuery) {
        throw new Error("Comparison query is not enabled");
      }
      return fetchGoalSummary(
        siteId,
        goalId,
        comparisonQuery.window,
        comparisonQuery.filters,
        {
          signal,
          goalSemanticFingerprint: goal.semanticFingerprint,
        },
      );
    },
    enabled: Boolean(goalId && goal && comparisonQuery),
  });
  const timeseries = useQuery({
    queryKey: goal
      ? goalTimeseriesQueryKey(siteId, goal, window, filterKey, "auto")
      : [
          "dashboard",
          "goal-timeseries",
          siteId,
          goalId,
          window.from,
          window.to,
          window.timeZone,
          window.interval,
          filterKey,
        ],
    queryFn: ({ signal }) =>
      fetchGoalTimeseries(siteId, goalId, window, filters, {
        signal,
        ...(goal ? { goalSemanticFingerprint: goal.semanticFingerprint } : {}),
      }),
    enabled: Boolean(goalId),
  });
  const comparisonTimeseries = useQuery({
    queryKey:
      goal && comparisonQuery
        ? goalTimeseriesQueryKey(
            siteId,
            goal,
            comparisonQuery.window,
            comparisonFilterKey,
            "auto",
          )
        : ["dashboard", "goal-timeseries-comparison-disabled", siteId, goalId],
    queryFn: ({ signal }) => {
      if (!goal || !comparisonQuery) {
        throw new Error("Comparison query is not enabled");
      }
      return fetchGoalTimeseries(
        siteId,
        goalId,
        comparisonQuery.window,
        comparisonQuery.filters,
        {
          signal,
          goalSemanticFingerprint: goal.semanticFingerprint,
        },
      );
    },
    enabled: Boolean(goalId && goal && comparisonQuery),
  });

  if (!goal) {
    if (loading && !loadError) {
      return <GoalDetailSkeleton canManage={canManage} labels={labels} />;
    }
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {labels.detailLoadError}
      </div>
    );
  }

  const goalSummary = summary.data?.data.summary;
  const comparisonGoalSummary = comparisonSummary.data?.data.summary;
  const comparisonLoading =
    Boolean(comparisonQuery) &&
    (comparisonSummary.isFetching || !comparisonSummary.data);
  const filterDescriptionMessages = messages ?? getMessages(locale);
  const fullMessages = getMessages(locale);
  const metricLoading = summary.isFetching || !summary.data;
  const comparisonDetail = (value: string) =>
    comparisonGoalSummary && comparisonLabel
      ? `${comparisonLabel}: ${value}`
      : undefined;
  const conversionChange = (audience: "visitors" | "sessions") => {
    if (!comparisonGoalSummary || !comparisonLabel) return undefined;
    const value = conversionRateChange(
      goalSummary?.[audience],
      comparisonGoalSummary[audience],
    );
    if (value === null) return undefined;
    return {
      value: `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`,
      direction: value >= 0 ? ("up" as const) : ("down" as const),
      tone: value >= 0 ? ("positive" as const) : ("negative" as const),
    };
  };
  const goalMetricItems = [
    {
      id: "visitors",
      label: labels.visitors,
      value: goalMetricValue(goalSummary, "visitors", locale),
      detail:
        comparisonDetail(
          goalMetricValue(comparisonGoalSummary, "visitors", locale),
        ) ?? `${labels.converted} / ${labels.total}`,
      detailLoading: comparisonLoading && Boolean(comparisonLabel),
      loading: metricLoading,
    },
    {
      id: "sessions",
      label: labels.sessions,
      value: goalMetricValue(goalSummary, "sessions", locale),
      detail:
        comparisonDetail(
          goalMetricValue(comparisonGoalSummary, "sessions", locale),
        ) ?? `${labels.converted} / ${labels.total}`,
      detailLoading: comparisonLoading && Boolean(comparisonLabel),
      loading: metricLoading,
    },
    {
      id: "visitor-conversion",
      label: `${labels.visitors} ${labels.conversion}`,
      value: goalMetricRate(goalSummary, "visitors", locale),
      detail:
        comparisonDetail(
          goalMetricRate(comparisonGoalSummary, "visitors", locale),
        ) ?? goalMetricValue(goalSummary, "visitors", locale),
      change: conversionChange("visitors"),
      detailLoading: comparisonLoading && Boolean(comparisonLabel),
      loading: metricLoading,
    },
    {
      id: "session-conversion",
      label: `${labels.sessions} ${labels.conversion}`,
      value: goalMetricRate(goalSummary, "sessions", locale),
      detail:
        comparisonDetail(
          goalMetricRate(comparisonGoalSummary, "sessions", locale),
        ) ?? goalMetricValue(goalSummary, "sessions", locale),
      change: conversionChange("sessions"),
      detailLoading: comparisonLoading && Boolean(comparisonLabel),
      loading: metricLoading,
    },
  ];

  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-2">
          <h2 className="truncate text-xl font-semibold">{goal.name}</h2>
          <p className="text-sm text-muted-foreground">
            {updatedLabel(locale, labels, goal.updatedAt)}
          </p>
          <p className="min-w-0 break-words text-xs text-muted-foreground">
            {goalFilterSummary(goal, filterDescriptionMessages)}
          </p>
        </div>
        {canManage ? (
          <div className="flex items-center justify-end gap-2 self-start">
            <Button
              type="button"
              variant="outline"
              disabled={actionPending}
              onClick={onEdit}
            >
              <RiEditLine data-icon="inline-start" />
              {labels.edit}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={actionPending}
              onClick={onDelete}
            >
              <RiDeleteBinLine data-icon="inline-start" />
              {labels.delete}
            </Button>
          </div>
        ) : null}
      </div>

      {summary.isError ? (
        <Card className="min-w-0">
          <CardContent className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
            {labels.detailLoadError}
          </CardContent>
        </Card>
      ) : (
        <MetricSummaryGrid items={goalMetricItems} />
      )}

      <Card className="min-w-0 overflow-visible">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiLineChartLine className="size-4" />
            {labels.timeseries}
          </CardTitle>
          <CardDescription>{labels.listSubtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          {timeseries.isError ? (
            <p className="text-sm text-muted-foreground">
              {labels.detailLoadError}
            </p>
          ) : (
            <GoalTimeseriesChart
              points={timeseries.data?.data.timeseries ?? []}
              comparisonPoints={comparisonTimeseries.data?.data.timeseries}
              locale={locale}
              labels={labels}
              from={window.from}
              to={window.to}
              timeZone={window.timeZone}
              interval={window.interval}
              comparisonFrom={comparisonQuery?.window.from}
              comparisonTo={comparisonQuery?.window.to}
              comparisonLabel={comparisonLabel}
              loading={timeseries.isFetching || !timeseries.data}
            />
          )}
        </CardContent>
      </Card>

      <section className="min-w-0 space-y-3">
        <div className="space-y-1">
          <h3 className="inline-flex items-center gap-2 text-sm font-medium">
            <RiFileList3Line className="size-4 shrink-0" />
            {labels.conversionRecords}
          </h3>
        </div>
        <Tabs
          value={journeyEntity}
          onValueChange={(value) => {
            if (value === "visitors" || value === "sessions") {
              setJourneyEntity(value);
            }
          }}
        >
          <AnalysisJourneyTable
            entity={journeyEntity === "visitors" ? "visitor" : "session"}
            siteId={siteId}
            pathname={pathname}
            locale={locale}
            messages={fullMessages}
            window={window}
            filters={filters}
            analysisContext={{ type: "goal", goalId: goal.id }}
            toolbarLeading={
              <TabsList aria-label={`${labels.visitors} / ${labels.sessions}`}>
                <TabsTrigger value="visitors">{labels.visitors}</TabsTrigger>
                <TabsTrigger value="sessions">{labels.sessions}</TabsTrigger>
              </TabsList>
            }
          />
        </Tabs>
      </section>
    </div>
  );
}
