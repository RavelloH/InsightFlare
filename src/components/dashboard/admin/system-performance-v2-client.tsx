import { useEffect, useMemo, useState } from "react";
import {
  LatencyPercentileChart,
  type LatencyPercentileChartPoint,
} from "@insightflare/product-ui/charts";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Badge } from "@insightflare/ui/badge";
import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { DataTableSwitch } from "@insightflare/ui/data-table-switch";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@insightflare/ui/drawer";
import { Input } from "@insightflare/ui/input";
import { MetricSummaryGrid } from "@insightflare/ui/metric-summary-grid";
import { PageHeading } from "@insightflare/ui/page-heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import { Spinner } from "@insightflare/ui/spinner";
import { TableCell, TableHead, TableRow } from "@insightflare/ui/table";
import {
  RiBarChartBoxLine,
  RiCpuLine,
  RiDatabase2Line,
  RiErrorWarningLine,
  RiHistoryLine,
  RiRefreshLine,
  RiSpeedUpLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { useDashboardQueryControls } from "@/components/dashboard/shell/dashboard-query-provider";
import { useLiveSearchParams } from "@/lib/dashboard/client/history";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { SystemPerformanceV2Labels } from "@/lib/system-performance-labels";
import { systemPerformanceLabels } from "@/lib/system-performance-labels";

import { DoDiagnosticV2Panel } from "./system-performance/do-diagnostic-v2";
import { PerformanceCustomRangeDialog } from "./system-performance/performance-custom-range-dialog";
import {
  type PerformanceKind,
  type PerformanceTab,
  performanceWindow,
  readPerformanceState,
  updatePerformanceUrl,
  VERSION_PATTERN,
} from "./system-performance/performance-url-state";

type View = PerformanceTab;
type HotKind = PerformanceKind;
type Metric = {
  value: number | null;
  validity?: string;
  coverage?: string;
  observed?: number | null;
  lowerBound?: boolean;
};
type Row = Record<string, unknown>;
type Result = {
  view: string;
  status: string;
  data: unknown;
  error?: {
    code?: string;
    retryable?: boolean;
    retryAfterSeconds?: number | null;
  };
  window?: {
    from: number;
    to: number;
    effectiveFrom?: number;
    effectiveTo?: number;
  };
  resultLimitsReached?: string[];
  sampling?: {
    aggregatesWeighted?: boolean;
    detailsAreRetainedSamples?: boolean;
  };
};

function isObject(input: unknown): input is Row {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
function asObject(input: unknown): Row {
  return isObject(input) ? input : {};
}
function asRows(input: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(input)) return input.filter(isObject);
  const obj = asObject(input);
  for (const key of ["rows", "items", "records", ...keys]) {
    if (Array.isArray(obj[key])) return obj[key].filter(isObject);
  }
  return [];
}
function numeric(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (
    typeof input === "string" &&
    input.trim() &&
    Number.isFinite(Number(input))
  )
    return Number(input);
  return null;
}
function metric(input: unknown): Metric {
  if (isObject(input))
    return {
      value: numeric(input.value),
      coverage: typeof input.coverage === "string" ? input.coverage : undefined,
      validity: typeof input.validity === "string" ? input.validity : undefined,
      observed: numeric(input.observed),
      lowerBound: input.lowerBound === true,
    };
  return { value: numeric(input) };
}
function readMetric(obj: Row, ...keys: string[]): Metric {
  for (const key of keys) {
    const found = key
      .split(".")
      .reduce<unknown>((value, segment) => asObject(value)[segment], obj);
    if (found !== undefined) return metric(found);
  }
  return { value: null };
}
function textValue(input: unknown, fallback = "—"): string {
  if (typeof input === "string" && input.trim().length) return input;
  const number = numeric(input);
  return number !== null ? String(number) : fallback;
}
function formatNumber(locale: Locale, input: number | null, suffix = "") {
  if (input === null) return "—";
  return (
    new Intl.NumberFormat(
      locale === "zh" ? "zh-CN" : locale === "zh-tw" ? "zh-TW" : locale,
      {
        maximumFractionDigits: suffix ? 1 : 0,
      },
    ).format(input) + suffix
  );
}
function formatMetric(locale: Locale, item: Metric, suffix = ""): string {
  return item.validity === "unavailable" ||
    item.validity === "not_applicable" ||
    item.coverage === "unavailable"
    ? "—"
    : `${item.lowerBound && item.value !== null ? "≥" : ""}${formatNumber(locale, item.value, suffix)}`;
}
function formatObservedCost(
  locale: Locale,
  value: unknown,
  coverage: unknown,
  suffix = "",
) {
  if (coverage === "unavailable") return "—";
  const observed = numeric(value);
  return observed === null
    ? "—"
    : (coverage === "partial" ? "≥" : "") +
        formatNumber(locale, observed, suffix);
}
function dataStatusLabel(
  copy: SystemPerformanceV2Labels,
  status: string,
): string {
  switch (status) {
    case "reader_not_configured":
      return copy.readerNotConfigured;
    case "writer_not_bound":
      return copy.writerNotBound;
    case "disabled":
      return copy.disabled;
    case "query_failed":
      return copy.queryFailed;
    case "no_data":
      return copy.noData;
    case "insufficient_coverage":
      return copy.partial;
    default:
      return copy.unavailable;
  }
}
function displayTime(
  locale: Locale,
  secondsOrMs: unknown,
  timeZone: string,
): string {
  const n = numeric(secondsOrMs);
  if (n === null || n <= 0) return "—";
  const millis = n > 1e12 ? n : n * 1000;
  try {
    return new Intl.DateTimeFormat(
      locale === "zh" ? "zh-CN" : locale === "zh-tw" ? "zh-TW" : locale,
      {
        timeZone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      },
    ).format(millis);
  } catch {
    return "—";
  }
}
export function SystemPerformanceV2Client({
  locale,
  messages,
}: {
  locale: Locale;
  messages: AppMessages;
}) {
  const copy = systemPerformanceLabels(locale);
  const { timeZone } = useDashboardQueryControls();
  const searchParams = useLiveSearchParams();
  const state = readPerformanceState(searchParams);
  const {
    view,
    doView,
    range,
    source,
    kind,
    routeKey,
    appVersion,
    sampleQueryId,
    sampleKind,
    sampleErrorCode,
    sampleResult,
    sampleTrigger,
  } = state;
  const [refreshId, setRefreshId] = useState(0);
  const [versionDraft, setVersionDraft] = useState(appVersion);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [drawerRow, setDrawerRow] = useState<Row | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => setVersionDraft(appVersion), [appVersion]);
  const setView = (next: View) => {
    updatePerformanceUrl({ perfTab: next });
    setDrawerOpen(false);
  };
  const setKind = (next: HotKind) =>
    updatePerformanceUrl({ hotspotKind: next });
  const setRouteKey = (next: string) =>
    updatePerformanceUrl({ routeKey: next });

  const viewParam =
    view === "do" ? "samples" : view === "hotspots" ? "hotspots" : view;
  const history = view === "do" && doView === "history";
  const shouldFetch = view !== "do" || history;
  const effectiveSource = view === "do" ? "do" : source;
  const query = useQuery({
    queryKey: [
      "admin",
      "system-performance-v2",
      viewParam,
      range,
      state.customFrom,
      state.customTo,
      effectiveSource,
      appVersion,
      sampleQueryId,
      sampleKind,
      sampleErrorCode,
      sampleResult,
      sampleTrigger,
      timeZone,
      refreshId,
      routeKey,
      kind,
    ],
    queryFn: ({ signal }) => {
      const window = performanceWindow(state);
      return requestAdminService<Result>("system-performance", {
        params: {
          view: viewParam,
          source: effectiveSource,
          ...window,
          timeZone,
          limit: view === "overview" ? 100 : 50,
          ...(routeKey && view !== "do" ? { routeKey } : {}),
          ...(appVersion ? { appVersion } : {}),
          ...(view === "hotspots" ? { kind } : {}),
          ...(view === "samples"
            ? {
                ...(sampleQueryId ? { sampleQueryId } : {}),
                ...(sampleQueryId && sampleKind ? { sampleKind } : {}),
                ...(sampleErrorCode ? { sampleErrorCode } : {}),
                ...(sampleResult ? { resultClass: sampleResult } : {}),
                ...(sampleTrigger ? { trigger: sampleTrigger } : {}),
              }
            : {}),
        },
        signal,
      });
    },
    enabled: typeof window !== "undefined" && shouldFetch,
    staleTime: 30_000,
    retry: false,
  });
  const routesQuery = useQuery({
    queryKey: [
      "admin",
      "system-performance-v2",
      "routes",
      range,
      state.customFrom,
      state.customTo,
      source,
      appVersion,
      routeKey,
      timeZone,
      refreshId,
    ],
    queryFn: ({ signal }) => {
      return requestAdminService<Result>("system-performance", {
        params: {
          view: "routes",
          source,
          ...performanceWindow(state),
          timeZone,
          limit: 50,
          ...(appVersion ? { appVersion } : {}),
          ...(routeKey ? { routeKey } : {}),
        },
        signal,
      });
    },
    enabled: typeof window !== "undefined" && view === "overview",
    staleTime: 30_000,
    retry: false,
  });
  const routes = asRows(routesQuery.data?.data, "routes");
  const result = query.data;
  const data = asObject(result?.data);
  const loading = query.isPending && shouldFetch;
  const status = result?.status ?? (query.isError ? "query_failed" : "no_data");
  const hasData = status === "ready" || status === "insufficient_coverage";
  const hasError = query.isError || status === "query_failed";

  const summary = asObject(data.summary);
  const trend = asRows(data.trend);
  const trendChart = useMemo<LatencyPercentileChartPoint[]>(
    () =>
      trend
        .map((point) => ({
          timestampMs:
            numeric(point.timestampMs) ?? (numeric(point.bucket) ?? 0) * 1000,
          p50: readMetric(point, "handlerP50Ms", "p50", "p50LatencyMs").value,
          p75: null, // v2 records P50/P95/P99, not P75.
          p95: readMetric(point, "handlerP95Ms", "p95", "p95LatencyMs").value,
        }))
        .filter((item) => item.timestampMs > 0),
    [trend],
  );

  const overviewMetrics = [
    {
      id: "estimatedInvocations",
      icon: <RiCpuLine />,
      label: copy.estimatedInvocations,
      value: formatNumber(
        locale,
        readMetric(summary, "estimatedInvocations").value,
      ),
      detail: copy.sampledNote,
      loading,
    },
    {
      id: "handlerP95",
      icon: <RiSpeedUpLine />,
      label: copy.handlerP95,
      value: formatMetric(
        locale,
        readMetric(summary, "handlerP95Ms", "p95", "p95LatencyMs"),
        " ms",
      ),
      detail: `${copy.handlerP50}: ${formatMetric(locale, readMetric(summary, "p50"), " ms")} · ${copy.handlerP99}: ${formatMetric(locale, readMetric(summary, "p99"), " ms")}`,
      loading,
    },
    {
      id: "d1Rows",
      icon: <RiDatabase2Line />,
      label: copy.d1Rows,
      value: formatMetric(
        locale,
        readMetric(summary, "weighted.d1RowsRead", "d1RowsRead"),
      ),
      detail: copy.costCoverage,
      loading,
    },
    {
      id: "retainedSamples",
      icon: <RiBarChartBoxLine />,
      label: copy.retainedSamples,
      value: formatNumber(locale, readMetric(summary, "retainedSamples").value),
      detail: copy.sampledNote,
      loading,
    },
  ];

  const rows =
    view === "hotspots"
      ? asRows(asObject(data.hotspots)[kind])
      : view === "errors"
        ? asRows(result?.data, "errors")
        : asRows(result?.data, "samples");

  const tabItems: { id: View; label: string; icon: React.ReactNode }[] = [
    {
      id: "overview",
      label: copy.overview,
      icon: <RiCpuLine className="size-4" />,
    },
    {
      id: "hotspots",
      label: copy.hotspots,
      icon: <RiSpeedUpLine className="size-4" />,
    },
    {
      id: "errors",
      label: copy.errors,
      icon: <RiErrorWarningLine className="size-4" />,
    },
    { id: "do", label: copy.do, icon: <RiHistoryLine className="size-4" /> },
    {
      id: "samples",
      label: copy.showSamples,
      icon: <RiDatabase2Line className="size-4" />,
    },
  ];

  function openDrawer(row: Row) {
    setDrawerRow(row);
    setDrawerOpen(true);
  }
  function openSamplesFrom(row: Row, origin: "routes" | "hotspots" | "errors") {
    const rowSource =
      row.source === "worker" || row.source === "do" ? row.source : source;
    const rowRoute = textValue(row.routeKey, "");
    const rowVersion = textValue(row.appVersion, "");
    updatePerformanceUrl({
      perfTab: "samples",
      perfSource: rowSource,
      routeKey: rowRoute,
      appVersion: VERSION_PATTERN.test(rowVersion) ? rowVersion : appVersion,
      sampleQueryId:
        origin === "hotspots"
          ? textValue(row.queryId || row.hotQueryId, "")
          : null,
      sampleKind: origin === "hotspots" ? kind : null,
      sampleErrorCode: origin === "errors" ? textValue(row.code, "") : null,
      sampleResult: origin === "errors" ? textValue(row.resultClass, "") : null,
      sampleTrigger: textValue(row.trigger, ""),
    });
    setDrawerOpen(false);
  }
  function showRow(row: Row) {
    if (view === "overview") {
      const candidate = textValue(row.routeKey, "");
      const version = textValue(row.appVersion, "");
      if (candidate) {
        updatePerformanceUrl({
          perfTab: "hotspots",
          routeKey: candidate,
          appVersion: VERSION_PATTERN.test(version) ? version : appVersion,
        });
        setDrawerOpen(false);
      }
    } else openDrawer(row);
  }

  return (
    <div className="space-y-5">
      <PageHeading
        title={copy.title}
        subtitle={copy.subtitle}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={range}
              onValueChange={(value) => {
                if (value === "custom") setCustomRangeOpen(true);
                else
                  updatePerformanceUrl({
                    perfRange: value,
                    perfFrom: null,
                    perfTo: null,
                  });
              }}
            >
              <SelectTrigger className="w-36" aria-label={copy.window}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">{copy.last1h}</SelectItem>
                <SelectItem value="6h">{copy.last6h}</SelectItem>
                <SelectItem value="24h">{copy.last24h}</SelectItem>
                <SelectItem value="7d">{copy.last7d}</SelectItem>
                <SelectItem value="30d">{copy.last30d}</SelectItem>
                <SelectItem value="custom">{copy.customRange}</SelectItem>
              </SelectContent>
            </Select>
            {view !== "do" ? (
              <Select
                value={source}
                onValueChange={(value) =>
                  updatePerformanceUrl({ perfSource: value })
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{copy.allSources}</SelectItem>
                  <SelectItem value="worker">{copy.worker}</SelectItem>
                  <SelectItem value="do">{copy.doSource}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            {view !== "do" ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = versionDraft.trim();
                  if (
                    value &&
                    (value.length > 61 || !VERSION_PATTERN.test(value))
                  )
                    return;
                  updatePerformanceUrl({ appVersion: value });
                }}
              >
                <Input
                  aria-label={copy.appVersion}
                  className="w-44"
                  value={versionDraft}
                  maxLength={61}
                  placeholder={copy.versionPlaceholder}
                  onChange={(event) => setVersionDraft(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    Boolean(versionDraft.trim()) &&
                    !VERSION_PATTERN.test(versionDraft.trim())
                  }
                >
                  {copy.applyVersion}
                </Button>
                {appVersion ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => updatePerformanceUrl({ appVersion: null })}
                  >
                    {copy.clearVersion}
                  </Button>
                ) : null}
              </form>
            ) : null}
            <Button
              variant="outline"
              disabled={query.isFetching && shouldFetch}
              onClick={() => setRefreshId((value) => value + 1)}
            >
              {query.isFetching && shouldFetch ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RiRefreshLine data-icon="inline-start" />
              )}
              {copy.refresh}
            </Button>
          </div>
        }
      />
      <PerformanceCustomRangeDialog
        open={customRangeOpen}
        onOpenChange={setCustomRangeOpen}
        from={state.customFrom}
        to={state.customTo}
        timeZone={timeZone}
        copy={copy}
        onApply={(from, to) =>
          updatePerformanceUrl({
            perfRange: "custom",
            perfFrom: String(from),
            perfTo: String(to),
          })
        }
      />

      <nav
        aria-label={copy.title}
        className="flex flex-wrap gap-1 border-b pb-2"
      >
        {tabItems.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={item.id === view ? "secondary" : "ghost"}
            aria-pressed={item.id === view}
            onClick={() => {
              setView(item.id);
            }}
          >
            {item.icon}
            {item.label}
          </Button>
        ))}
      </nav>
      {view === "do" ? (
        <div className="space-y-4">
          <div className="flex gap-2">
            {(["live", "history"] as const).map((id) => (
              <Button
                key={id}
                variant={doView === id ? "secondary" : "ghost"}
                onClick={() => updatePerformanceUrl({ perfDoView: id })}
                aria-pressed={doView === id}
              >
                {id === "live" ? copy.live : copy.history}
              </Button>
            ))}
          </div>
          {doView === "live" ? (
            <DoDiagnosticV2Panel
              locale={locale}
              timeZone={timeZone}
              copy={copy}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>{copy.history}</CardTitle>
                <CardDescription>{copy.globalHistory}</CardDescription>
              </CardHeader>
              <CardContent>
                <ResultNotice
                  result={result}
                  loading={loading}
                  error={hasError}
                  copy={copy}
                />
                <RowTable
                  rows={rows}
                  mode="samples"
                  loading={loading}
                  locale={locale}
                  timeZone={timeZone}
                  copy={copy}
                  onInspect={openDrawer}
                />
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        <AutoResizer initial duration={0.2}>
          <AutoTransition
            initial={false}
            transitionKey={view}
            duration={0.16}
            type="fade"
          >
            <div key={view} className="space-y-4">
              <ResultNotice
                result={result}
                loading={loading}
                error={hasError}
                copy={copy}
              />
              {view === "overview" ? (
                <>
                  <MetricSummaryGrid items={overviewMetrics} />
                  <Card>
                    <CardHeader>
                      <CardTitle>{copy.handlerP95}</CardTitle>
                      <CardDescription>{copy.sampledNote}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {trendChart.length ? (
                        <LatencyPercentileChart
                          data={trendChart}
                          locale={locale}
                          timeZone={timeZone}
                          formatValue={(value) =>
                            formatNumber(locale, value, " ms")
                          }
                          loadingLabel={messages.common.loading}
                          emptyLabel={copy.noData}
                          labels={{ p50: "P50", p75: "—", p95: "P95" }}
                        />
                      ) : (
                        <p className="py-12 text-center text-sm text-muted-foreground">
                          {copy.noData}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>{copy.route}</CardTitle>
                      <CardDescription>
                        {copy.inspectRoute} → {copy.queryId} →{" "}
                        {copy.filterShape} → {copy.value}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <RowTable
                        rows={routes}
                        mode="routes"
                        loading={routesQuery.isPending}
                        locale={locale}
                        timeZone={timeZone}
                        copy={copy}
                        onInspect={showRow}
                        onSamples={(row) => openSamplesFrom(row, "routes")}
                      />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>{copy.costCoverage}</CardTitle>
                      <CardDescription>{copy.scanDisclaimer}</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                      {(
                        [
                          [copy.d1Rows, "weighted.d1RowsRead", ""],
                          [copy.d1Engine, "weighted.d1SqlEngineMs", " ms"],
                          [copy.d1ApiWall, "weighted.d1ApiWallMs", " ms"],
                          [copy.doSqlRows, "weighted.doSqlRowsRead", ""],
                          [copy.doFetchWall, "weighted.doFetchWallMs", " ms"],
                        ] as const
                      ).map(([label, key, suffix]) => {
                        const item = readMetric(summary, key);
                        return (
                          <div key={key} className="space-y-1">
                            <p className="text-xs text-muted-foreground">
                              {label}
                            </p>
                            <p className="text-lg font-medium tabular-nums">
                              {formatMetric(locale, item, suffix)}
                            </p>
                            <Badge variant="outline">
                              {item.coverage ||
                                item.validity ||
                                copy.unavailable}
                            </Badge>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                </>
              ) : view === "hotspots" ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={kind}
                      onValueChange={(value) => setKind(value as HotKind)}
                    >
                      <SelectTrigger className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="api-hot">{copy.hotApi}</SelectItem>
                        <SelectItem value="sql-engine-fallback">
                          {copy.hotEngine}
                        </SelectItem>
                        <SelectItem value="scan">{copy.scanRows}</SelectItem>
                      </SelectContent>
                    </Select>
                    {routeKey ? (
                      <Button variant="outline" onClick={() => setRouteKey("")}>
                        {copy.route}: {routeKey} ×
                      </Button>
                    ) : null}
                  </div>
                  <Card>
                    <CardHeader>
                      <CardTitle>{copy.hotspots}</CardTitle>
                      <CardDescription>{copy.hotDisclaimer}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <RowTable
                        rows={rows}
                        mode="hotspots"
                        loading={loading}
                        locale={locale}
                        timeZone={timeZone}
                        copy={copy}
                        onInspect={showRow}
                        onSamples={(row) => openSamplesFrom(row, "hotspots")}
                      />
                      {!rows.length && (hasData || status === "no_data") ? (
                        <p className="text-sm text-muted-foreground">
                          {copy.noHotspotRank}
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                </>
              ) : view === "samples" ? (
                <Card>
                  <CardHeader>
                    <CardTitle>{copy.showSamples}</CardTitle>
                    <CardDescription>
                      {copy.sampleInvestigationNote}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {copy.sampleLimitNote}
                    </p>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {routeKey ? (
                        <Badge variant="outline">
                          {copy.route}: {routeKey}
                        </Badge>
                      ) : null}
                      {appVersion ? (
                        <Badge variant="outline">
                          {copy.appVersion}: {appVersion}
                        </Badge>
                      ) : null}
                      {sampleQueryId ? (
                        <Badge variant="outline">
                          {copy.queryId}: {sampleQueryId} (
                          {sampleKind || "selected"})
                        </Badge>
                      ) : null}
                      {sampleErrorCode ? (
                        <Badge variant="outline">
                          {copy.errorCode}: {sampleErrorCode}
                        </Badge>
                      ) : null}
                    </div>
                    <RowTable
                      rows={rows}
                      mode="samples"
                      loading={loading}
                      locale={locale}
                      timeZone={timeZone}
                      copy={copy}
                      onInspect={openDrawer}
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>{copy.errors}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <RowTable
                      rows={rows}
                      mode="errors"
                      loading={loading}
                      locale={locale}
                      timeZone={timeZone}
                      copy={copy}
                      onInspect={showRow}
                      onSamples={(row) => openSamplesFrom(row, "errors")}
                    />
                  </CardContent>
                </Card>
              )}
            </div>
          </AutoTransition>
        </AutoResizer>
      )}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} direction="right">
        <DrawerContent
          data-dashboard-floating-layer="system-performance-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
          onFocusOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{copy.queryDetails}</DrawerTitle>
            <DrawerDescription>
              {textValue(drawerRow?.queryId || drawerRow?.routeKey)}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            <p className="mb-4 text-sm text-muted-foreground">
              {copy.hotDisclaimer}
            </p>
            {drawerRow && view !== "samples" && view !== "do" ? (
              <Button
                variant="outline"
                className="mb-4"
                onClick={() =>
                  openSamplesFrom(
                    drawerRow,
                    view === "hotspots"
                      ? "hotspots"
                      : view === "errors"
                        ? "errors"
                        : "routes",
                  )
                }
              >
                {copy.showSamples}
              </Button>
            ) : null}
            {view === "samples" && drawerRow ? (
              <div className="mb-4 text-sm text-muted-foreground">
                {copy.sampleWeight}:{" "}
                {formatNumber(locale, numeric(drawerRow.sampleInterval))}.{" "}
                {copy.sampleInvestigationNote}
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {drawerRow
                ? Object.entries(drawerRow)
                    .filter(
                      ([key]) =>
                        !/details|raw|sql|stack|param|token|secret|payload/i.test(
                          key,
                        ) || /engine/i.test(key),
                    )
                    .slice(0, 30)
                    .map(([key, value]) => (
                      <div className="min-w-0 space-y-1" key={key}>
                        <p className="text-xs text-muted-foreground">{key}</p>
                        <p className="break-words text-sm font-medium">
                          {isObject(value)
                            ? textValue(value.value, copy.unavailable)
                            : textValue(value)}
                        </p>
                      </div>
                    ))
                : null}
            </div>
            {isObject(drawerRow?.details) ? (
              <div className="mt-6 space-y-4 border-t pt-4">
                <p className="text-sm text-muted-foreground">
                  {copy.dominantDisclaimer}
                </p>
                {asRows(drawerRow.details.phases).map((phase, index) => (
                  <div
                    className="flex items-center justify-between gap-4 text-sm"
                    key={index}
                  >
                    <span className="truncate font-mono">
                      {textValue(phase.id)}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatNumber(locale, numeric(phase.wallMs), " ms")}
                    </span>
                  </div>
                ))}
                {asRows(drawerRow.details.queries).map((item, index) => (
                  <div className="space-y-1 border-t pt-3 text-sm" key={index}>
                    <div className="break-all font-mono">
                      {textValue(item.id)}
                    </div>
                    <p className="text-muted-foreground">
                      {copy.queryVariant}: {textValue(item.variant)}
                    </p>
                    <p>
                      {copy.d1ApiWall}:{" "}
                      {formatObservedCost(
                        locale,
                        item.apiWallMs,
                        asObject(item.coverage).api,
                        " ms",
                      )}
                    </p>
                    <p>
                      {copy.d1Engine}:{" "}
                      {formatObservedCost(
                        locale,
                        item.sqlEngineMs,
                        asObject(item.coverage).engine,
                        " ms",
                      )}
                    </p>
                    <p>
                      {copy.d1Rows}:{" "}
                      {formatObservedCost(
                        locale,
                        item.rowsRead,
                        asObject(item.coverage).rowsRead,
                      )}
                    </p>
                    <p>
                      {copy.queryCoverage}:{" "}
                      {Object.entries(asObject(item.coverage))
                        .map(([key, value]) => key + "=" + textValue(value))
                        .join(", ") || copy.unavailable}
                    </p>
                    <p>
                      {copy.granularity}: {textValue(item.granularity)}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

function ResultNotice({
  result,
  loading,
  error,
  copy,
}: {
  result: Result | undefined;
  loading: boolean;
  error: boolean;
  copy: SystemPerformanceV2Labels;
}) {
  if (loading)
    return <p className="text-sm text-muted-foreground">{copy.refresh}…</p>;
  if (error)
    return <p className="text-sm text-destructive">{copy.queryFailed}</p>;
  if (!result) return null;
  if (result.status !== "ready" && result.status !== "insufficient_coverage") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {dataStatusLabel(copy, result.status)}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
      <Badge variant="outline">{copy.estimated}</Badge>
      {result.status === "insufficient_coverage" ? (
        <Badge variant="outline">{copy.partial}</Badge>
      ) : null}
      {!!result.resultLimitsReached?.length && (
        <Badge variant="outline">
          LIMIT {result.resultLimitsReached.join(", ")}
        </Badge>
      )}
      <span>{copy.sampledNote}</span>
    </div>
  );
}

type TableMode = "routes" | "hotspots" | "errors" | "samples";

function RowTable({
  rows,
  loading,
  copy,
  locale,
  timeZone,
  onInspect,
  onSamples,
  mode,
}: {
  rows: Row[];
  loading: boolean;
  copy: SystemPerformanceV2Labels;
  locale: Locale;
  timeZone: string;
  mode: TableMode;
  onInspect: (row: Row) => void;
  onSamples?: (row: Row) => void;
}) {
  const samples = mode === "samples";
  const errors = mode === "errors";
  const routes = mode === "routes";
  return (
    <DataTableSwitch
      loading={loading}
      hasContent={rows.length > 0}
      loadingLabel={copy.refresh}
      emptyLabel={copy.tableEmpty}
      colSpan={6}
      header={
        <TableRow>
          <TableHead>{samples ? copy.sampleAt : copy.route}</TableHead>
          <TableHead>
            {errors
              ? copy.errorCode
              : samples
                ? copy.source
                : routes
                  ? copy.trigger
                  : copy.queryId}
          </TableHead>
          <TableHead>
            {errors
              ? copy.errorGroup
              : samples
                ? copy.trigger
                : routes
                  ? copy.source
                  : copy.filterShape}
          </TableHead>
          <TableHead>
            {samples ? copy.handlerP50 : copy.estimatedInvocations}
          </TableHead>
          <TableHead>
            {errors ? copy.operation : routes ? copy.handlerP95 : copy.value}
          </TableHead>
          <TableHead />
        </TableRow>
      }
      rows={rows.map((row, index) => (
        <TableRow
          key={[
            textValue(row.queryId || row.hotQueryId),
            textValue(row.routeKey),
            index,
          ].join("-")}
        >
          <TableCell className="max-w-56 truncate font-mono text-xs">
            {samples
              ? displayTime(locale, row.timestampSeconds, timeZone)
              : textValue(row.routeKey)}
          </TableCell>
          <TableCell className="max-w-56 truncate font-mono text-xs">
            {errors
              ? textValue(row.code)
              : samples
                ? textValue(row.source)
                : routes
                  ? textValue(row.trigger)
                  : textValue(row.queryId || row.hotQueryId)}
          </TableCell>
          <TableCell className="max-w-40 truncate font-mono text-xs">
            {errors
              ? textValue(row.category)
              : samples
                ? textValue(row.trigger)
                : routes
                  ? textValue(row.source)
                  : textValue(row.filterShape)}
          </TableCell>
          <TableCell className="tabular-nums">
            {samples
              ? formatNumber(locale, numeric(row.handlerWallMs), " ms")
              : formatNumber(locale, numeric(row.estimatedInvocations))}
          </TableCell>
          <TableCell className="tabular-nums">
            {errors
              ? textValue(row.operation)
              : routes
                ? formatNumber(locale, numeric(row.p95), " ms")
                : samples
                  ? formatNumber(locale, numeric(row.invocationWallMs), " ms")
                  : formatNumber(locale, numeric(row.weightedValue))}
          </TableCell>
          <TableCell className="text-right">
            <div className="flex justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={() => onInspect(row)}>
                {copy.inspect}
              </Button>
              {onSamples ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onSamples(row)}
                >
                  {copy.showSamples}
                </Button>
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      ))}
    />
  );
}
