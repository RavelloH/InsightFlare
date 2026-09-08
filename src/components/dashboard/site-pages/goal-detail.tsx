import { RiDeleteBinLine, RiEditLine, RiLineChartLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchGoalSummary,
  fetchGoalTimeseries,
} from "@/lib/dashboard/client-data";
import {
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { GoalDefinition, GoalSummary } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
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

function GoalMetric({
  label,
  value,
  detail,
  loading = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly loading?: boolean;
}) {
  return (
    <div className="min-w-0 bg-card p-4">
      <p className="truncate text-[11px] uppercase text-muted-foreground">
        {label}
      </p>
      <AutoTransition
        className="mt-3 h-7"
        initial={false}
        transitionKey={loading ? "loading" : value}
        duration={0.18}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <Skeleton key="loading" className="h-7 w-28" />
        ) : (
          <p
            key="value"
            className="truncate font-mono text-xl font-semibold leading-7"
          >
            {value}
          </p>
        )}
      </AutoTransition>
      <AutoTransition
        className="mt-3 h-4"
        initial={false}
        transitionKey={loading ? "loading" : (detail ?? "")}
        duration={0.18}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <Skeleton key="loading" className="h-3 w-32" />
        ) : (
          <p
            key="detail"
            className="truncate text-[11px] text-muted-foreground"
          >
            {detail}
          </p>
        )}
      </AutoTransition>
    </div>
  );
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

function GoalDetailSkeleton({ canManage }: { readonly canManage: boolean }) {
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
      <Card className="min-w-0 py-0">
        <CardContent className="p-0">
          <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((item) => (
              <div key={item} className="min-w-0 bg-card p-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-3 h-7 w-28" />
                <Skeleton className="mt-3 h-3 w-32" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
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
  locale,
  labels,
  messages,
  window,
  filters,
  filterKey,
  canManage,
  onEdit,
  onDelete,
  loading = false,
  loadError = false,
}: {
  readonly goal?: GoalDefinition;
  readonly siteId: string;
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly messages?: Pick<
    AppMessages,
    "conditionDescription" | "filterBuilder"
  >;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
  readonly filterKey: string;
  readonly canManage: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly loading?: boolean;
  readonly loadError?: boolean;
}) {
  const goalId = goal?.id ?? "";
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

  if (!goal) {
    if (loading && !loadError) {
      return <GoalDetailSkeleton canManage={canManage} />;
    }
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {labels.detailLoadError}
      </div>
    );
  }

  const analysisLoading = summary.isPending || timeseries.isPending;
  const goalSummary = summary.data?.data.summary;
  const filterDescriptionMessages = messages ?? getMessages(locale);

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
              disabled={analysisLoading}
              onClick={onEdit}
            >
              <RiEditLine />
              {labels.edit}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={analysisLoading}
              onClick={onDelete}
            >
              <RiDeleteBinLine />
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
        <Card className="min-w-0 py-0">
          <CardContent className="p-0">
            <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 lg:grid-cols-4">
              <GoalMetric
                label={labels.visitors}
                value={goalMetricValue(goalSummary, "visitors", locale)}
                detail={`${labels.converted} / ${labels.total}`}
                loading={summary.isFetching || !summary.data}
              />
              <GoalMetric
                label={labels.sessions}
                value={goalMetricValue(goalSummary, "sessions", locale)}
                detail={`${labels.converted} / ${labels.total}`}
                loading={summary.isFetching || !summary.data}
              />
              <GoalMetric
                label={`${labels.visitors} ${labels.conversion}`}
                value={goalMetricRate(goalSummary, "visitors", locale)}
                detail={goalMetricValue(goalSummary, "visitors", locale)}
                loading={summary.isFetching || !summary.data}
              />
              <GoalMetric
                label={`${labels.sessions} ${labels.conversion}`}
                value={goalMetricRate(goalSummary, "sessions", locale)}
                detail={goalMetricValue(goalSummary, "sessions", locale)}
                loading={summary.isFetching || !summary.data}
              />
            </div>
          </CardContent>
        </Card>
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
              locale={locale}
              labels={labels}
              from={window.from}
              to={window.to}
              timeZone={window.timeZone}
              interval={window.interval}
              loading={timeseries.isFetching || !timeseries.data}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
