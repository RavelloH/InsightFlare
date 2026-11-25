import { useCallback, useMemo, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import { PageHeading } from "@insightflare/ui/page-heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import { Spinner } from "@insightflare/ui/spinner";
import { RiRefreshLine } from "@remixicon/react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";

import { useDashboardTimeWindow } from "@/components/dashboard/shell/dashboard-query-provider";
import { useLiveSearchParams } from "@/lib/dashboard/client/history";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import {
  PERFORMANCE_QUERY_ROOT,
  useBaseParams,
  usePerformanceView,
} from "./data";
import {
  type DetailActions,
  type DetailTarget,
  PerformanceDetailDrawer,
} from "./detail-drawer";
import { DoDiagnosticPanel } from "./do-diagnostic-panel";
import { ErrorsView } from "./errors-view";
import { HotspotsView } from "./hotspots-view";
import type {
  ErrorsData,
  HotspotsData,
  OverviewData,
  RoutesData,
  SamplesData,
} from "./model";
import { resultLabel, statusMessage, triggerLabel } from "./model";
import { OverviewView } from "./overview-view";
import { type ActiveFilter, ActiveFilters, StatusPanel } from "./parts";
import {
  type PerformanceSource,
  readPerformanceState,
  updatePerformanceUrl,
} from "./performance-url-state";
import { SamplesView } from "./samples-view";

const SAMPLE_FILTERS_CLEARED = {
  sampleQueryId: null,
  sampleKind: null,
  sampleErrorCode: null,
  sampleResult: null,
  sampleTrigger: null,
} as const;

export function SystemPerformanceClient({
  locale,
  messages,
}: {
  locale: Locale;
  messages: AppMessages;
}) {
  const copy = messages.systemPerformance;
  const queryClient = useQueryClient();
  const timeWindow = useDashboardTimeWindow();
  const searchParams = useLiveSearchParams();
  const state = readPerformanceState(searchParams);
  const { tab } = state;
  const base = useBaseParams(timeWindow, state);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const overview = usePerformanceView<OverviewData>(
    "overview",
    useMemo(() => ({ ...base, limit: 100 }), [base]),
    tab === "overview",
  );
  const routes = usePerformanceView<RoutesData>(
    "routes",
    useMemo(() => ({ ...base, limit: 50 }), [base]),
    tab === "overview",
  );
  const errors = usePerformanceView<ErrorsData>(
    "errors",
    useMemo(() => ({ ...base, limit: 100 }), [base]),
    tab === "overview" || tab === "errors",
  );
  const hotspots = usePerformanceView<HotspotsData>(
    "hotspots",
    useMemo(
      () => ({ ...base, kind: state.kind, limit: 50 }),
      [base, state.kind],
    ),
    tab === "hotspots",
  );
  const samples = usePerformanceView<SamplesData>(
    "samples",
    useMemo(
      () => ({
        ...base,
        limit: 50,
        ...(state.sampleQueryId ? { sampleQueryId: state.sampleQueryId } : {}),
        ...(state.sampleQueryId && state.sampleKind
          ? { sampleKind: state.sampleKind }
          : {}),
        ...(state.sampleErrorCode
          ? { sampleErrorCode: state.sampleErrorCode }
          : {}),
        ...(state.sampleResult ? { resultClass: state.sampleResult } : {}),
        ...(state.sampleTrigger ? { trigger: state.sampleTrigger } : {}),
      }),
      [
        base,
        state.sampleQueryId,
        state.sampleKind,
        state.sampleErrorCode,
        state.sampleResult,
        state.sampleTrigger,
      ],
    ),
    tab === "samples",
  );

  const fetching = useIsFetching({ queryKey: PERFORMANCE_QUERY_ROOT }) > 0;
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: PERFORMANCE_QUERY_ROOT });
  }, [queryClient]);

  const openDetail = useCallback((target: DetailTarget) => {
    setDetail(target);
    setDrawerOpen(true);
  }, []);
  const navigate = useCallback(
    (patch: Parameters<typeof updatePerformanceUrl>[0]) => {
      setDrawerOpen(false);
      updatePerformanceUrl(patch);
    },
    [],
  );

  const actions = useMemo<DetailActions>(
    () => ({
      filterRoute: (routeKey) => navigate({ routeKey }),
      filterVersion: (appVersion) => navigate({ appVersion }),
      viewHotspots: (routeKey) => navigate({ perfTab: "hotspots", routeKey }),
      viewSamples: (target) => {
        const row = target.row;
        navigate({
          ...SAMPLE_FILTERS_CLEARED,
          perfTab: "samples",
          perfSource: row.source,
          routeKey: row.routeKey,
          sampleTrigger: row.trigger,
          ...(target.type === "hotspot"
            ? { sampleQueryId: target.row.queryId, sampleKind: target.kind }
            : {}),
          ...(target.type === "error"
            ? {
                sampleErrorCode: target.row.code,
                sampleResult: target.row.resultClass,
              }
            : {}),
        });
      },
    }),
    [navigate],
  );

  const activeFilters: ActiveFilter[] = [];
  if (tab !== "do") {
    if (state.routeKey)
      activeFilters.push({
        id: "route",
        label: copy.filters.route,
        value: state.routeKey,
        onRemove: () => navigate({ routeKey: null }),
      });
    if (state.appVersion)
      activeFilters.push({
        id: "version",
        label: copy.filters.version,
        value: state.appVersion,
        onRemove: () => navigate({ appVersion: null }),
      });
  }
  if (tab === "samples") {
    if (state.sampleQueryId)
      activeFilters.push({
        id: "query",
        label: copy.filters.query,
        value: state.sampleQueryId,
        onRemove: () => navigate({ sampleQueryId: null, sampleKind: null }),
      });
    if (state.sampleErrorCode)
      activeFilters.push({
        id: "error",
        label: copy.filters.errorCode,
        value: state.sampleErrorCode,
        onRemove: () => navigate({ sampleErrorCode: null }),
      });
    if (state.sampleResult)
      activeFilters.push({
        id: "result",
        label: copy.filters.result,
        value: resultLabel(copy, state.sampleResult),
        onRemove: () => navigate({ sampleResult: null }),
      });
    if (state.sampleTrigger)
      activeFilters.push({
        id: "trigger",
        label: copy.filters.trigger,
        value: triggerLabel(copy, state.sampleTrigger),
        onRemove: () => navigate({ sampleTrigger: null }),
      });
  }

  const current =
    tab === "overview"
      ? overview
      : tab === "hotspots"
        ? hotspots
        : tab === "errors"
          ? errors
          : tab === "samples"
            ? samples
            : null;
  const blocking = current
    ? (statusMessage(copy, current.data?.status, current.isError) ??
      (tab === "overview" && current.data?.status === "no_data"
        ? copy.status.noData
        : null))
    : null;
  const limited = Boolean(current?.data?.resultLimitsReached?.length);

  function renderView() {
    if (tab === "do")
      return (
        <DoDiagnosticPanel
          locale={locale}
          timeZone={timeWindow.timeZone}
          copy={copy}
          onViewSamples={() =>
            navigate({
              ...SAMPLE_FILTERS_CLEARED,
              perfTab: "samples",
              perfSource: "do",
            })
          }
        />
      );
    if (blocking)
      return (
        <StatusPanel
          tone={current?.isError ? "error" : "muted"}
          message={blocking}
          action={
            current?.isError ? (
              <Button variant="outline" size="sm" onClick={refresh}>
                {copy.refresh}
              </Button>
            ) : undefined
          }
        />
      );
    if (tab === "overview")
      return (
        <OverviewView
          locale={locale}
          timeZone={timeWindow.timeZone}
          copy={copy}
          overview={overview.data}
          routes={routes.data}
          errors={errors.data}
          loading={overview.isPending}
          routesLoading={routes.isPending}
          onRouteSelect={(row) => openDetail({ type: "route", row })}
        />
      );
    if (tab === "hotspots")
      return (
        <HotspotsView
          locale={locale}
          copy={copy}
          kind={state.kind}
          onKindChange={(kind) => updatePerformanceUrl({ hotspotKind: kind })}
          response={hotspots.data}
          loading={hotspots.isPending}
          onSelect={(row) =>
            openDetail({ type: "hotspot", row, kind: state.kind })
          }
        />
      );
    if (tab === "errors")
      return (
        <ErrorsView
          locale={locale}
          copy={copy}
          response={errors.data}
          loading={errors.isPending}
          onSelect={(row) => openDetail({ type: "error", row })}
        />
      );
    return (
      <SamplesView
        locale={locale}
        timeZone={timeWindow.timeZone}
        copy={copy}
        response={samples.data}
        loading={samples.isPending}
        onSelect={(row) => openDetail({ type: "sample", row })}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeading
        title={copy.title}
        subtitle={[copy.subtitle, copy.sampledHint].join(
          locale === "en" ? " " : "",
        )}
        actions={
          <>
            {tab !== "do" ? (
              <Select
                value={state.source}
                onValueChange={(value) =>
                  navigate({
                    perfSource:
                      value === "all" ? null : (value as PerformanceSource),
                  })
                }
              >
                <SelectTrigger
                  className="w-40"
                  aria-label={copy.filters.source}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{copy.sources.all}</SelectItem>
                  <SelectItem value="worker">{copy.sources.worker}</SelectItem>
                  <SelectItem value="do">{copy.sources.do}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            {tab !== "do" ? (
              <Button variant="outline" disabled={fetching} onClick={refresh}>
                {fetching ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RiRefreshLine data-icon="inline-start" />
                )}
                {copy.refresh}
              </Button>
            ) : null}
          </>
        }
      />
      <ActiveFilters
        copy={copy}
        filters={activeFilters}
        onClear={() =>
          navigate({
            ...SAMPLE_FILTERS_CLEARED,
            routeKey: null,
            appVersion: null,
          })
        }
      />
      {limited && !blocking ? (
        <p className="text-xs text-muted-foreground">{copy.status.limited}</p>
      ) : null}
      <AutoResizer initial={false} duration={0.2}>
        <AutoTransition
          initial={false}
          transitionKey={tab}
          duration={0.16}
          type="fade"
        >
          <div key={tab}>{renderView()}</div>
        </AutoTransition>
      </AutoResizer>
      <PerformanceDetailDrawer
        locale={locale}
        timeZone={timeWindow.timeZone}
        copy={copy}
        target={detail}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        actions={actions}
      />
    </div>
  );
}
