import { useMemo } from "react";
import {
  LatencyPercentileChart,
  type LatencyPercentileChartPoint,
} from "@insightflare/product-ui/charts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { DataTableSwitch } from "@insightflare/ui/data-table-switch";
import { MetricSummaryGrid } from "@insightflare/ui/metric-summary-grid";
import { TableCell, TableHead, TableRow } from "@insightflare/ui/table";
import {
  RiDatabase2Line,
  RiErrorWarningLine,
  RiPulseLine,
  RiTimerLine,
} from "@remixicon/react";

import type { Locale } from "@/lib/i18n/config";

import {
  averageMs,
  COST_METRICS,
  type ErrorsData,
  failureCount,
  formatCount,
  formatMs,
  formatRate,
  formatWeighted,
  type InvocationRouteAggregate,
  type OverviewData,
  type PerformanceCopy,
  type PerformanceResponse,
  type RoutesData,
  shortVersion,
  sourceLabel,
  template,
  triggerLabel,
} from "./model";
import { InlineNote, rowActivation, StatGrid } from "./parts";

export function OverviewView({
  locale,
  timeZone,
  copy,
  overview,
  routes,
  errors,
  loading,
  routesLoading,
  onRouteSelect,
}: {
  locale: Locale;
  timeZone: string;
  copy: PerformanceCopy;
  overview: PerformanceResponse<OverviewData> | undefined;
  routes: PerformanceResponse<RoutesData> | undefined;
  errors: PerformanceResponse<ErrorsData> | undefined;
  loading: boolean;
  routesLoading: boolean;
  onRouteSelect: (route: InvocationRouteAggregate) => void;
}) {
  const summary = overview?.data?.summary ?? null;
  const trend = overview?.data?.trend;
  const routeRows = routes?.data?.routes ?? [];
  const failures = failureCount(errors?.data?.errors ?? []);
  const invocations = summary?.estimatedInvocations ?? 0;
  const failureRate = invocations > 0 ? failures / invocations : null;
  const partial = overview?.status === "insufficient_coverage";

  const chartData = useMemo<LatencyPercentileChartPoint[]>(
    () =>
      (trend ?? [])
        .map((point) => ({
          timestampMs: point.bucket * 1000,
          p50: point.p50,
          p95: point.p95,
          p99: point.p99,
        }))
        .sort((a, b) => a.timestampMs - b.timestampMs),
    [trend],
  );

  const metrics = [
    {
      id: "invocations",
      icon: <RiPulseLine />,
      label: copy.metrics.invocations,
      value: formatCount(locale, summary?.estimatedInvocations),
      detail: template(copy.metrics.invocationsDetail, {
        samples: formatCount(locale, summary?.retainedSamples ?? 0),
      }),
      loading,
    },
    {
      id: "handler-p95",
      icon: <RiTimerLine />,
      label: copy.metrics.handlerP95,
      value: formatMs(locale, summary?.p95),
      detail: template(copy.metrics.handlerP95Detail, {
        p50: formatMs(locale, summary?.p50),
        p99: formatMs(locale, summary?.p99),
      }),
      loading,
    },
    {
      id: "d1-rows",
      icon: <RiDatabase2Line />,
      label: copy.metrics.d1Rows,
      value: formatWeighted(locale, summary?.weighted.d1RowsRead, "count"),
      detail: template(copy.metrics.d1RowsDetail, {
        statements: formatCount(locale, summary?.workerD1Statements ?? 0),
      }),
      loading,
    },
    {
      id: "failure-rate",
      icon: <RiErrorWarningLine />,
      label: copy.metrics.failureRate,
      value: formatRate(locale, failureRate),
      detail: template(copy.metrics.failureRateDetail, {
        count: formatCount(locale, failures),
      }),
      tone:
        failureRate === null
          ? ("default" as const)
          : failureRate >= 0.01
            ? ("critical" as const)
            : failureRate > 0
              ? ("warning" as const)
              : ("default" as const),
      loading: loading || !errors,
    },
  ];

  return (
    <div className="space-y-6">
      <MetricSummaryGrid items={metrics} />
      {partial ? <InlineNote>{copy.status.partial}</InlineNote> : null}

      <Card>
        <CardHeader>
          <CardTitle>{copy.trend.title}</CardTitle>
          <CardDescription>{copy.trend.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <LatencyPercentileChart
            data={chartData}
            labels={{
              p50: copy.trend.p50,
              p95: copy.trend.p95,
              p99: copy.trend.p99,
            }}
            locale={locale}
            timeZone={timeZone}
            formatValue={(value) => formatMs(locale, value)}
            loading={loading}
            loadingLabel={copy.loading}
            emptyLabel={copy.trend.empty}
            className="h-[280px]"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{copy.cost.title}</CardTitle>
          <CardDescription>{copy.cost.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <StatGrid
            className="xl:grid-cols-5"
            items={COST_METRICS.map((metric) => {
              const value = summary?.weighted[metric.key];
              return {
                id: metric.key,
                label: copy.cost[metric.label],
                value: loading
                  ? copy.emptyValue
                  : formatWeighted(locale, value, metric.unit),
                note:
                  !loading && value?.coverage === "unavailable"
                    ? copy.cost.notRecorded
                    : undefined,
              };
            })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{copy.routes.title}</CardTitle>
          <CardDescription>{copy.routes.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={routesLoading}
            hasContent={routeRows.length > 0}
            loadingLabel={copy.loading}
            emptyLabel={copy.routes.empty}
            colSpan={7}
            loadingRowCount={6}
            header={
              <TableRow>
                <TableHead>{copy.columns.route}</TableHead>
                <TableHead>{copy.columns.source}</TableHead>
                <TableHead>{copy.columns.version}</TableHead>
                <TableHead className="text-right">
                  {copy.columns.invocations}
                </TableHead>
                <TableHead className="text-right">
                  {copy.columns.average}
                </TableHead>
                <TableHead className="text-right">{copy.columns.p95}</TableHead>
                <TableHead className="text-right">
                  {copy.columns.d1Rows}
                </TableHead>
              </TableRow>
            }
            rows={routeRows.map((route) => (
              <TableRow
                key={`${route.source}:${route.trigger}:${route.routeKey}:${route.appVersion ?? ""}`}
                {...rowActivation(() => onRouteSelect(route))}
              >
                <TableCell className="max-w-72 truncate font-mono text-xs">
                  {route.routeKey}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {sourceLabel(copy, route.source)}
                  {route.trigger !== "request"
                    ? ` · ${triggerLabel(copy, route.trigger)}`
                    : ""}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {shortVersion(route.appVersion)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(locale, route.estimatedInvocations)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMs(locale, averageMs(route))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMs(locale, route.p95)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatWeighted(locale, route.weighted.d1RowsRead, "count")}
                </TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
