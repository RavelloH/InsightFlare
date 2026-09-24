import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { RiMapPin2Line } from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";

import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableLoader,
  type TabbedDataTableRowAdapter,
  type TabbedDataTableSortState,
} from "@/components/dashboard/common/tabbed-data-table-card";
import {
  COUNTRY_TABLE_SKELETON_ROWS,
  type CountryHealthRow,
  type CountryMapHover,
  formatMetricValue,
  formatPanelValue,
  METRIC_THRESHOLDS,
  panelLabel,
  type PathSortKey,
  type PerformanceMapFeature,
  type PerformancePanelKey,
  type PerformanceStatus,
  roundedScore,
  type SortDirection,
  STATUS_STYLE,
  statusColor,
  statusLabel,
} from "@/components/dashboard/site-pages/performance/model";
import {
  type CountriesFeatureCollection,
  type CountryFeature,
  countryFillOpacity,
  geometryToPath,
  normalizeCountryCode,
  resolveCountryCodeFromFeature,
  resolveCountryLabelFromFeature,
  WORLD_MAP_HEIGHT,
  WORLD_MAP_WIDTH,
} from "@/components/dashboard/site-pages/performance/performance-map-utils";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat } from "@/lib/dashboard/format";
import { loadLocalTablePage } from "@/lib/dashboard/table-loader";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import { PerformanceDynamicValue, PerformancePanelText } from "./shared";
export function CountryLabelWithFlag({
  label,
  iconName,
}: {
  label: string;
  iconName: string | null;
}) {
  if (!iconName) {
    return <span className="truncate">{label}</span>;
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Icon
        icon={iconName}
        style={{ width: 16, height: 12 }}
        className="block shrink-0"
      />
      <span className="truncate">{label}</span>
    </span>
  );
}
export function pathStatusRangeLabel(
  locale: Locale,
  messages: AppMessages,
  activePanel: PerformancePanelKey,
  status: Exclude<PerformanceStatus, "none">,
): string {
  if (activePanel === "score") {
    if (status === "poor") return "<50";
    if (status === "needs-improvement") return "50 - 90";
    return ">90";
  }

  const thresholds = METRIC_THRESHOLDS[activePanel];
  if (status === "poor") {
    return `>${formatMetricValue(locale, messages, activePanel, thresholds.poor)}`;
  }
  if (status === "needs-improvement") {
    return `${formatMetricValue(
      locale,
      messages,
      activePanel,
      thresholds.good,
    )} - ${formatMetricValue(locale, messages, activePanel, thresholds.poor)}`;
  }
  return `<=${formatMetricValue(locale, messages, activePanel, thresholds.good)}`;
}
const CountryStatusColumn = memo(function CountryStatusColumn({
  locale,
  messages,
  activePanel,
  status,
  rows,
  sort,
  onSort,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  status: Exclude<PerformanceStatus, "none">;
  rows: CountryHealthRow[];
  sort: { key: PathSortKey; direction: SortDirection };
  onSort: (key: PathSortKey) => void;
  comparisonLabel?: string;
  loading?: boolean;
}) {
  const statusStyle = STATUS_STYLE[status];
  const StatusIcon = statusStyle.icon;
  const displayRows = loading ? COUNTRY_TABLE_SKELETON_ROWS : rows;
  const rangeLabel = pathStatusRangeLabel(
    locale,
    messages,
    activePanel,
    status,
  );
  const columns = useMemo<
    readonly TabbedDataTableColumn<
      CountryHealthRow,
      PathSortKey,
      typeof status
    >[]
  >(() => {
    const metricLabel =
      activePanel === "score"
        ? messages.performance.score
        : messages.performance.metricValueColumn;

    if (comparisonLabel) {
      return [
        {
          key: "samples",
          label: comparisonLabel,
          getValue: (row) => row.comparisonValue ?? row.comparisonScore ?? 0,
          format: (_value, row) =>
            loading ? (
              <Skeleton className="ml-auto h-4 w-14" />
            ) : (
              <span className="text-muted-foreground">
                {formatPanelValue(
                  locale,
                  messages,
                  activePanel,
                  row.comparisonValue ?? row.comparisonScore,
                )}
              </span>
            ),
          className: "font-mono tabular-nums",
        },
        {
          key: "value",
          label: metricLabel,
          getValue: (row) => row.value ?? row.score ?? 0,
          format: (_value, row) =>
            loading ? (
              <Skeleton className="ml-auto h-4 w-14" />
            ) : (
              <span>
                {formatPanelValue(
                  locale,
                  messages,
                  activePanel,
                  row.value ?? row.score,
                )}
              </span>
            ),
          className: "font-mono tabular-nums",
        },
      ];
    }

    return [
      {
        key: "samples",
        label: messages.performance.samplesLabel,
        getValue: (row) => row.samples,
        format: (value) =>
          loading ? (
            <Skeleton className="ml-auto h-4 w-12" />
          ) : (
            <span>{numberFormat(locale, value)}</span>
          ),
        className: "font-mono tabular-nums",
      },
      {
        key: "value",
        label: metricLabel,
        getValue: (row) => row.value ?? row.score ?? 0,
        format: (_value, row) =>
          loading ? (
            <Skeleton className="ml-auto h-4 w-14" />
          ) : (
            <span>
              {formatPanelValue(
                locale,
                messages,
                activePanel,
                row.value ?? row.score,
              )}
            </span>
          ),
        className: "font-mono tabular-nums",
      },
    ];
  }, [
    activePanel,
    comparisonLabel,
    loading,
    locale,
    messages,
    messages.performance.metricValueColumn,
    messages.performance.samplesLabel,
    messages.performance.score,
  ]);
  const tabs = useMemo(
    () =>
      [
        {
          value: status,
          label: statusLabel(messages, status),
          columnLabel: messages.common.country,
          defaultSort: sort,
        },
      ] as const,
    [messages, sort, status],
  );
  const sortByTab = useMemo(
    () => ({ [status]: sort }) as Record<typeof status, typeof sort>,
    [sort, status],
  );
  const handleSortChange = useCallback(
    (_tab: typeof status, next: TabbedDataTableSortState<PathSortKey>) =>
      onSort(next.key),
    [onSort],
  );
  const loader = useCallback<
    TabbedDataTableLoader<typeof status, CountryHealthRow, PathSortKey>
  >(
    async ({ cursor, limit, search, sort }) =>
      loadLocalTablePage({
        rows: displayRows,
        sort,
        columns,
        tab: status,
        limit,
        cursor,
        search,
        getText: (row) => row.label,
        tieBreakText: false,
      }),
    [columns, displayRows, status],
  );
  const tableRequestKey = useMemo(
    () => `${activePanel}:${locale}:${JSON.stringify(displayRows)}`,
    [activePanel, displayRows, locale],
  );
  const rowAdapter = useMemo<
    TabbedDataTableRowAdapter<CountryHealthRow, typeof status, PathSortKey>
  >(
    () => ({
      renderLabel: (row) =>
        loading ? (
          <Skeleton className="h-4 w-[min(12rem,78%)]" />
        ) : (
          <span className="max-w-[18rem]">
            <CountryLabelWithFlag label={row.label} iconName={row.iconName} />
          </span>
        ),
      getSearchText: (row) => row.label,
      getExportLabel: (row) => row.label,
      getClassName: () => "hover:brightness-[0.98] dark:hover:brightness-125",
    }),
    [loading],
  );

  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-3 px-4 py-4">
        <div className="min-w-0 space-y-1">
          <div
            className={cn(
              "flex items-center gap-2 font-medium",
              statusStyle.labelClassName,
            )}
          >
            <StatusIcon className="size-4" />
            {statusLabel(messages, status)}
          </div>
          <PerformancePanelText
            transitionKey={rangeLabel}
            className="text-xs text-muted-foreground"
          >
            {rangeLabel}
          </PerformancePanelText>
        </div>
        <PerformanceDynamicValue
          loading={loading}
          skeletonClassName="h-4 w-8"
          className="shrink-0"
          transitionKey={rows.length}
        >
          <div className="font-mono text-sm text-muted-foreground tabular-nums">
            {numberFormat(locale, rows.length)}
          </div>
        </PerformanceDynamicValue>
      </div>
      <div className="pb-4">
        <TabbedDataTableCard<typeof status, CountryHealthRow, PathSortKey>
          tabs={tabs}
          loader={loader}
          columns={columns}
          value={status}
          sortByTab={sortByTab}
          onSortChange={handleSortChange}
          rowAdapter={rowAdapter}
          requestKey={tableRequestKey}
          sortActionLabel={(label) =>
            formatI18nTemplate(messages.common.sortBy, { label })
          }
          loadingLabel={messages.common.loading}
          emptyLabel={messages.common.noData}
          headerHidden
          search={false}
          progress={comparisonLabel ? "value" : "samples"}
        />
      </div>
    </div>
  );
});
const PerformanceHealthMapVisual = memo(function PerformanceHealthMapVisual({
  locale,
  messages,
  activePanel,
  featureCollection,
  mapFeatures,
  countryMap,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  featureCollection: CountriesFeatureCollection | null;
  mapFeatures: PerformanceMapFeature[];
  countryMap: Map<string, CountryHealthRow>;
  loading?: boolean;
}) {
  const [hoveredCountry, setHoveredCountry] = useState<CountryMapHover | null>(
    null,
  );

  useEffect(() => {
    setHoveredCountry(null);
  }, [activePanel]);

  const updateCountryHover = (
    hoverKey: string,
    feature: CountryFeature,
    code: string | null,
    country: CountryHealthRow | null,
    status: PerformanceStatus,
  ) => {
    const label =
      country?.label ??
      resolveCountryLabelFromFeature(
        feature,
        code,
        locale,
        messages.common.unknown,
      );
    const samples = country?.samples ?? 0;
    const score = country?.score ?? null;
    setHoveredCountry((current) => {
      if (
        current?.key === hoverKey &&
        current.label === label &&
        current.samples === samples &&
        current.score === score &&
        current.status === status
      ) {
        return current;
      }

      return {
        key: hoverKey,
        label,
        samples,
        score,
        status,
      };
    });
  };
  const hoverScore = roundedScore(hoveredCountry?.score);
  const hoveredSamplesText = numberFormat(locale, hoveredCountry?.samples ?? 0);
  const hoveredScoreText =
    hoverScore == null ? "-" : numberFormat(locale, hoverScore);
  const mapTransitionKey = loading
    ? "loading"
    : featureCollection
      ? activePanel
      : "resource-loading";

  return (
    <div className="relative overflow-hidden border-t border-border/70 bg-muted/20 p-3">
      <AutoResizer className="w-full" duration={0.24}>
        <AutoTransition
          initial={false}
          transitionKey={mapTransitionKey}
          duration={0.22}
          type="fade"
          presenceMode="wait"
          className="w-full"
        >
          {featureCollection && !loading ? (
            <div
              key={`map-${activePanel}`}
              className="relative mx-auto aspect-[960/500] w-full"
              onMouseLeave={() => setHoveredCountry(null)}
            >
              <svg
                role="img"
                aria-label={messages.performance.countryHealthTitle}
                className="block h-full w-full"
                viewBox={`0 0 ${WORLD_MAP_WIDTH} ${WORLD_MAP_HEIGHT}`}
                preserveAspectRatio="xMidYMid meet"
              >
                <rect
                  width={WORLD_MAP_WIDTH}
                  height={WORLD_MAP_HEIGHT}
                  fill="transparent"
                />
                {mapFeatures.map(({ code, feature, hoverKey, path }) => {
                  const country = code ? countryMap.get(code) : null;
                  const status = country?.status ?? "none";
                  const isHovered = hoveredCountry?.key === hoverKey;
                  return (
                    <path
                      key={hoverKey}
                      d={path}
                      fill={statusColor(status)}
                      fillRule="evenodd"
                      fillOpacity={
                        isHovered
                          ? Math.min(
                              0.82,
                              countryFillOpacity(
                                status,
                                country?.samples ?? 0,
                              ) + 0.22,
                            )
                          : countryFillOpacity(status, country?.samples ?? 0)
                      }
                      stroke={isHovered ? "var(--foreground)" : "var(--border)"}
                      strokeOpacity={isHovered ? 0.96 : 0.86}
                      strokeWidth={isHovered ? 1 : 0.65}
                      vectorEffect="non-scaling-stroke"
                      className="cursor-default transition-[fill-opacity,stroke,stroke-opacity] duration-150"
                      onMouseEnter={() =>
                        updateCountryHover(
                          hoverKey,
                          feature,
                          code,
                          country ?? null,
                          status,
                        )
                      }
                      onMouseMove={() =>
                        updateCountryHover(
                          hoverKey,
                          feature,
                          code,
                          country ?? null,
                          status,
                        )
                      }
                    />
                  );
                })}
              </svg>
              <AnimatePresence>
                {hoveredCountry ? (
                  <motion.div
                    key="performance-country-toolbar"
                    className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 12 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                  >
                    <div className="inline-flex max-w-full items-center gap-4 rounded-md border border-border/70 bg-background/92 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
                      <AutoResizer
                        initial
                        animateWidth
                        animateHeight={false}
                        className="inline-flex min-w-0 shrink items-center"
                      >
                        <AutoTransition
                          className="inline-block"
                          duration={0.2}
                          type="fade"
                          initial={false}
                          presenceMode="wait"
                          customVariants={{
                            initial: { opacity: 0 },
                            animate: { opacity: 1 },
                            exit: { opacity: 0 },
                          }}
                        >
                          <span
                            key={`country-${hoveredCountry.key}-${hoveredCountry.label}`}
                            className="inline-flex items-center gap-2 whitespace-nowrap font-medium"
                          >
                            <span
                              className="size-2 rounded-full"
                              style={{
                                backgroundColor: statusColor(
                                  hoveredCountry.status,
                                ),
                              }}
                            />
                            {hoveredCountry.label}
                          </span>
                        </AutoTransition>
                      </AutoResizer>
                      <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                        <span>{messages.performance.samplesLabel}:</span>
                        <AutoResizer
                          initial
                          animateWidth
                          animateHeight={false}
                          className="inline-flex shrink-0 items-center"
                        >
                          <AutoTransition
                            className="inline-block whitespace-nowrap font-mono text-foreground tabular-nums"
                            duration={0.2}
                            type="fade"
                            initial={false}
                            presenceMode="wait"
                            customVariants={{
                              initial: { opacity: 0 },
                              animate: { opacity: 1 },
                              exit: { opacity: 0 },
                            }}
                          >
                            <span key={`samples-${hoveredSamplesText}`}>
                              {hoveredSamplesText}
                            </span>
                          </AutoTransition>
                        </AutoResizer>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                        <span>{messages.performance.score}:</span>
                        <AutoResizer
                          initial
                          animateWidth
                          animateHeight={false}
                          className="inline-flex shrink-0 items-center"
                        >
                          <AutoTransition
                            className="inline-block whitespace-nowrap font-mono text-foreground tabular-nums"
                            duration={0.2}
                            type="fade"
                            initial={false}
                            presenceMode="wait"
                            customVariants={{
                              initial: { opacity: 0 },
                              animate: { opacity: 1 },
                              exit: { opacity: 0 },
                            }}
                          >
                            <span key={`score-${hoveredScoreText}`}>
                              {hoveredScoreText}
                            </span>
                          </AutoTransition>
                        </AutoResizer>
                      </span>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          ) : (
            <Skeleton
              key={loading ? "loading" : "resource-loading"}
              className="mx-auto aspect-[2/1] w-full rounded-none"
            />
          )}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
});
export const PerformanceHealthMapCard = memo(function PerformanceHealthMapCard({
  locale,
  messages,
  activePanel,
  countries,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  countries: CountryHealthRow[];
  comparisonLabel?: string;
  loading?: boolean;
}) {
  const [featureCollection, setFeatureCollection] =
    useState<CountriesFeatureCollection | null>(null);

  useEffect(() => {
    let active = true;

    fetch("/api/public/resources/world-countries", { cache: "force-cache" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!active) return;
        const next =
          payload &&
          typeof payload === "object" &&
          (payload as { type?: unknown }).type === "FeatureCollection" &&
          Array.isArray((payload as { features?: unknown }).features)
            ? (payload as CountriesFeatureCollection)
            : null;
        setFeatureCollection(next);
      })
      .catch(() => {
        if (!active) return;
        setFeatureCollection(null);
      });

    return () => {
      active = false;
    };
  }, []);

  const countryMap = useMemo(() => {
    const map = new Map<string, CountryHealthRow>();
    for (const country of countries) {
      const code = normalizeCountryCode(country.country);
      if (!code) continue;
      map.set(code, country);
    }
    return map;
  }, [countries]);
  const mapFeatures = useMemo(() => {
    if (!featureCollection) return [];

    return featureCollection.features
      .map((feature, index) => {
        const code = resolveCountryCodeFromFeature(feature);
        return {
          code,
          feature,
          hoverKey: `${code ?? "country"}-${index}`,
          path: geometryToPath(feature.geometry),
        };
      })
      .filter((entry) => entry.path.length > 0);
  }, [featureCollection]);
  const [sort, setSort] = useState<{
    key: PathSortKey;
    direction: SortDirection;
  }>({
    key: "samples",
    direction: "desc",
  });
  const sortedCountries = useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...countries].sort((a, b) => {
      if (sort.key === "samples") {
        if (comparisonLabel) {
          return (
            ((a.comparisonValue ?? a.comparisonScore ?? -1) -
              (b.comparisonValue ?? b.comparisonScore ?? -1)) *
            direction
          );
        }
        return (a.samples - b.samples) * direction;
      }
      if (sort.key === "score") {
        return ((a.score ?? -1) - (b.score ?? -1)) * direction;
      }
      return ((a.value ?? -1) - (b.value ?? -1)) * direction;
    });
  }, [comparisonLabel, countries, sort.direction, sort.key]);
  const groupedRows = useMemo(
    () => ({
      poor: sortedCountries.filter((row) => row.status === "poor"),
      "needs-improvement": sortedCountries.filter(
        (row) => row.status === "needs-improvement",
      ),
      great: sortedCountries.filter((row) => row.status === "great"),
    }),
    [sortedCountries],
  );
  const countryHealthSubtitle = formatI18nTemplate(
    messages.performance.countryHealthSubtitle,
    { metric: panelLabel(messages, activePanel) },
  );

  const updateSort = useCallback((key: PathSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : { key, direction: "desc" },
    );
  }, []);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="inline-flex items-center gap-2">
              <RiMapPin2Line className="size-4" />
              {messages.performance.countryHealthTitle}
            </CardTitle>
            <PerformancePanelText
              transitionKey={countryHealthSubtitle}
              className="text-sm text-muted-foreground"
            >
              {countryHealthSubtitle}
            </PerformancePanelText>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <PerformanceHealthMapVisual
          locale={locale}
          messages={messages}
          activePanel={activePanel}
          featureCollection={featureCollection}
          mapFeatures={mapFeatures}
          countryMap={countryMap}
          loading={loading}
        />
        <div className="grid min-h-[18rem] divide-y divide-border/70 border-t border-border/70 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {(["poor", "needs-improvement", "great"] as const).map((status) => (
            <CountryStatusColumn
              key={status}
              locale={locale}
              messages={messages}
              activePanel={activePanel}
              status={status}
              rows={groupedRows[status]}
              sort={sort}
              onSort={updateSort}
              comparisonLabel={comparisonLabel}
              loading={loading}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
});
