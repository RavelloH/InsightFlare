"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type HTMLMotionProps,
} from "motion/react";
import { Cell, Pie, PieChart } from "recharts";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { TabbedScrollMaskCard } from "@/components/dashboard/tabbed-scroll-mask-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { fetchClientDimensionTrend } from "@/lib/dashboard/client-data";
import {
  aggregateScreenBuckets,
  classifyScreenBucket,
  parseScreenSizeLabel,
  type ParsedScreenSize,
  type ScreenBucketKey,
} from "@/lib/dashboard/device-insights";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData, BrowserTrendSeries } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { RiArrowDownSLine, RiArrowUpSLine } from "@remixicon/react";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--muted-foreground)",
] as const;

type ScreenSortKey = "visitors" | "views" | "sessions";
type ScreenListTab = "screenSize";

interface ScreenListItem extends BrowserTrendSeries {
  displayLabel: string;
  share: number;
  parsed: ParsedScreenSize | null;
  bucket: ScreenBucketKey;
}

const DATA_ROW_LAYOUT_TRANSITION = {
  layout: {
    duration: 0.34,
    ease: [0.22, 1, 0.36, 1],
  },
  opacity: {
    duration: 0.18,
    ease: [0.22, 1, 0.36, 1],
  },
} as const;

interface AnimatedDataTableRowProps extends HTMLMotionProps<"tr"> {
  reduceMotion?: boolean;
}

function AnimatedDataTableRow({
  reduceMotion = false,
  className,
  children,
  ...props
}: AnimatedDataTableRowProps) {
  return (
    <motion.tr
      data-slot="table-row"
      layout={reduceMotion ? false : "position"}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
      transition={DATA_ROW_LAYOUT_TRANSITION}
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    >
      {children}
    </motion.tr>
  );
}

function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
}

function formatScreenLabel(label: string): string {
  const parsed = parseScreenSizeLabel(label);
  if (!parsed) return label;
  return `${parsed.width} x ${parsed.height}`;
}

function displaySeriesLabel(series: BrowserTrendSeries, messages: AppMessages): string {
  return series.isOther ? messages.devices.otherLabel : formatScreenLabel(series.label);
}

function bucketLabel(bucket: ScreenBucketKey, messages: AppMessages): string {
  return messages.devices.screenBucketLabels[bucket];
}

function resolvePreviewUrl(siteDomain: string): string | null {
  const normalized = String(siteDomain ?? "").trim().replace(/\/+$/, "");
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (
    normalized.startsWith("localhost")
    || normalized.startsWith("127.")
    || normalized.endsWith(".local")
  ) {
    return `http://${normalized}`;
  }
  return `https://${normalized}`;
}

function ScreenCategoryPieCard({
  locale,
  messages,
  bucketSummary,
}: {
  locale: Locale;
  messages: AppMessages;
  bucketSummary: Array<{
    key: ScreenBucketKey;
    visitors: number;
    share: number;
  }>;
}) {
  const chartData = useMemo(
    () =>
      bucketSummary.map((bucket, index) => ({
        ...bucket,
        label: bucketLabel(bucket.key, messages),
        fill: CHART_COLORS[index % CHART_COLORS.length],
      })),
    [bucketSummary, messages],
  );
  const chartConfig = useMemo(
    () =>
      chartData.reduce((config, item) => {
        config[item.key] = {
          label: item.label,
          color: item.fill,
        };
        return config;
      }, {} as ChartConfig),
    [chartData],
  );

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>{messages.devices.screenBucketTitle}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col items-center justify-center gap-6">
        <ChartContainer
          className="aspect-square w-full max-w-[18rem]"
          config={chartConfig}
        >
          <PieChart accessibilityLayer>
            <ChartTooltip
              cursor={false}
              content={({ active, payload }) => {
                const item = payload?.[0]?.payload as
                  | (typeof chartData)[number]
                  | undefined;
                if (!active || !item) return null;

                return (
                  <div className="grid min-w-[11rem] gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                    <div className="font-medium">{item.label}</div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">
                        {numberFormat(locale, item.visitors)} {messages.common.visitors}
                      </span>
                      <span className="font-mono font-medium tabular-nums text-foreground">
                        {percentFormat(locale, item.share)}
                      </span>
                    </div>
                  </div>
                );
              }}
            />
            <Pie
              data={chartData}
              dataKey="visitors"
              nameKey="label"
              innerRadius={54}
              outerRadius={90}
              paddingAngle={2}
              stroke="var(--background)"
              strokeWidth={1}
              startAngle={90}
              endAngle={-270}
            >
              {chartData.map((item) => (
                <Cell key={item.key} fill={item.fill} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          {chartData.map((item) => (
            <div key={item.key} className="flex items-center gap-1.5 text-xs">
              <span
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: item.fill }}
              />
              <span className="text-muted-foreground">{item.label}</span>
              <span className="font-mono tabular-nums text-foreground">
                {percentFormat(locale, item.share)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ScreenValueListCard({
  locale,
  messages,
  items,
  loading,
}: {
  locale: Locale;
  messages: AppMessages;
  items: ScreenListItem[];
  loading: boolean;
}) {
  const reduceDataRowMotion = useReducedMotion() ?? false;
  const [sort, setSort] = useState<{ key: ScreenSortKey; direction: "asc" | "desc" }>({
    key: "visitors",
    direction: "desc",
  });
  const sortedItems = useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...items].sort((left, right) => {
      const primary = (left[sort.key] - right[sort.key]) * direction;
      if (primary !== 0) return primary;
      if (right.views !== left.views) return right.views - left.views;
      if (right.sessions !== left.sessions) return right.sessions - left.sessions;
      return left.displayLabel.localeCompare(right.displayLabel);
    });
  }, [items, sort.direction, sort.key]);
  const progressTotal = useMemo(
    () =>
      sortedItems.reduce(
        (sum, item) => sum + Math.max(0, Number(item[sort.key] ?? 0)),
        0,
      ),
    [sort.key, sortedItems],
  );

  const toggleSort = (key: ScreenSortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  };

  const renderSortIndicator = (key: ScreenSortKey) => {
    if (sort.key === key) {
      return sort.direction === "desc" ? (
        <RiArrowDownSLine className="size-3.5" />
      ) : (
        <RiArrowUpSLine className="size-3.5" />
      );
    }

    return (
      <span className="inline-flex flex-col leading-none text-muted-foreground">
        <RiArrowUpSLine className="-mb-1 size-3.5" />
        <RiArrowDownSLine className="-mt-1 size-3.5" />
      </span>
    );
  };

  const tableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{messages.common.screenSize}</div>
      </TableHead>
      <TableHead className="h-8 w-20 p-0">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              sort.key === "visitors" ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => toggleSort("visitors")}
          >
            {messages.common.visitors}
            {renderSortIndicator("visitors")}
          </button>
        </div>
      </TableHead>
      <TableHead className="h-8 w-20 p-0">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              sort.key === "views" ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => toggleSort("views")}
          >
            {messages.common.views}
            {renderSortIndicator("views")}
          </button>
        </div>
      </TableHead>
      <TableHead className="h-8 w-20 p-0">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              sort.key === "sessions" ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => toggleSort("sessions")}
          >
            {messages.common.sessions}
            {renderSortIndicator("sessions")}
          </button>
        </div>
      </TableHead>
    </TableRow>
  );

  const rows = (
    <AnimatePresence initial={false} mode="popLayout">
      {sortedItems.map((item) => {
        const rowValue = Math.max(0, Number(item[sort.key] ?? 0));
        const progressPercent = progressTotal > 0
          ? Math.min(100, (rowValue / progressTotal) * 100)
          : 0;
        const progressWidth = `${progressPercent.toFixed(2)}%`;

        return (
          <AnimatedDataTableRow
            key={item.key}
            reduceMotion={reduceDataRowMotion}
            className="bg-no-repeat transition-[background-size,filter] duration-300 ease-out hover:brightness-95"
            style={{
              backgroundImage: "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
              backgroundSize: `${progressWidth} 100%`,
              backgroundPosition: "left top",
            }}
          >
            <TableCell className="p-0 whitespace-normal align-top">
              <div className="px-4 py-2 font-mono leading-5 whitespace-normal break-words text-foreground">
                {item.displayLabel}
              </div>
            </TableCell>
            <TableCell className="p-0">
              <div className="px-2 py-2 text-right">
                {numberFormat(locale, item.visitors)}
              </div>
            </TableCell>
            <TableCell className="p-0">
              <div className="px-2 py-2 text-right">
                {numberFormat(locale, item.views)}
              </div>
            </TableCell>
            <TableCell className="p-0">
              <div className="px-4 py-2 text-right">
                {numberFormat(locale, item.sessions)}
              </div>
            </TableCell>
          </AnimatedDataTableRow>
        );
      })}
    </AnimatePresence>
  );

  return (
    <TabbedScrollMaskCard<ScreenListTab>
      value="screenSize"
      onValueChange={() => {}}
      tabs={[]}
      headerHidden
      className="h-full"
      syncKey={`${loading}-${sort.key}-${sort.direction}-${sortedItems.length}`}
    >
      <DataTableSwitch
        loading={loading}
        hasContent={sortedItems.length > 0}
        loadingLabel={messages.common.loading}
        emptyLabel={messages.common.noData}
        colSpan={4}
        header={tableHeader}
        rows={rows}
      />
    </TabbedScrollMaskCard>
  );
}

function ScreenPreviewCard({
  locale,
  messages,
  previewUrl,
  items,
}: {
  locale: Locale;
  messages: AppMessages;
  previewUrl: string | null;
  items: ScreenListItem[];
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [frameBounds, setFrameBounds] = useState({ width: 0, height: 0 });
  const [selectedKey, setSelectedKey] = useState<string>("");

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    const update = () => {
      setFrameBounds({
        width: node.clientWidth,
        height: node.clientHeight,
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedKey("");
      return;
    }
    if (!items.some((item) => item.key === selectedKey)) {
      setSelectedKey(items[0].key);
    }
  }, [items, selectedKey]);

  const selectedItem = useMemo(
    () => items.find((item) => item.key === selectedKey) ?? items[0] ?? null,
    [items, selectedKey],
  );
  const selectedViewport = selectedItem?.parsed ?? null;
  const scale = useMemo(() => {
    if (!selectedViewport) return 1;
    if (frameBounds.width <= 0 || frameBounds.height <= 0) return 1;
    return Math.min(
      (frameBounds.width - 32) / selectedViewport.width,
      (frameBounds.height - 32) / selectedViewport.height,
      1,
    );
  }, [frameBounds.height, frameBounds.width, selectedViewport]);
  const scaledWidth = selectedViewport ? Math.max(1, Math.round(selectedViewport.width * scale)) : 0;
  const scaledHeight = selectedViewport ? Math.max(1, Math.round(selectedViewport.height * scale)) : 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <CardTitle>{messages.devices.screenPreviewTitle}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={items.length === 0}>
              <Button
                variant="outline"
                size="sm"
                className="min-w-44 justify-between font-normal"
              >
                <span className="truncate">
                  {selectedItem?.displayLabel ?? messages.devices.selectedViewportLabel}
                </span>
                <RiArrowDownSLine className="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={selectedItem?.key ?? ""}
                onValueChange={setSelectedKey}
              >
                {items.map((item) => (
                  <DropdownMenuRadioItem key={item.key} value={item.key}>
                    {item.displayLabel}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {previewUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={previewUrl} target="_blank" rel="noreferrer">
                {messages.devices.openSiteLabel}
              </a>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">{messages.devices.selectedViewportLabel}</span>
          <span className="font-medium text-foreground">
            {selectedItem?.displayLabel ?? messages.devices.previewUnavailableLabel}
          </span>
          {selectedItem ? (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {numberFormat(locale, selectedItem.visitors)} {messages.common.visitors}
              {" · "}
              {percentFormat(locale, selectedItem.share)}
            </span>
          ) : null}
        </div>

        <div
          ref={viewportRef}
          className="relative flex min-h-[26rem] items-center justify-center overflow-hidden px-2 py-4 sm:min-h-[34rem]"
        >
          {previewUrl && selectedViewport ? (
            <div
              className="relative shrink-0"
              style={{
                width: scaledWidth,
                height: scaledHeight,
              }}
            >
              <div
                className="absolute left-0 top-0 overflow-hidden border border-border/60 bg-background"
                style={{
                  width: selectedViewport.width,
                  height: selectedViewport.height,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                }}
              >
                <iframe
                  title={`${messages.devices.screenPreviewTitle}-${selectedItem?.displayLabel ?? "preview"}`}
                  src={previewUrl}
                  className="block border-0 bg-background"
                  style={{
                    width: selectedViewport.width,
                    height: selectedViewport.height,
                  }}
                  loading="lazy"
                />
              </div>
            </div>
          ) : (
            <div className="max-w-md text-center text-sm text-muted-foreground">
              {messages.devices.previewUnavailableLabel}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface DeviceScreenBreakdownCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

export function DeviceScreenBreakdownCard({
  locale,
  messages,
  siteId,
  siteDomain,
  window,
  filters,
}: DeviceScreenBreakdownCardProps) {
  const [loading, setLoading] = useState(true);
  const [screenTrend, setScreenTrend] = useState<BrowserTrendData>(emptyTrend);

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetchClientDimensionTrend(siteId, window, "screenSize", filters, { limit: 10 })
      .catch(() => emptyTrend())
      .then((nextTrend) => {
        if (!active) return;
        setScreenTrend(nextTrend);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [filters, siteId, window.from, window.to, window.interval]);

  const totalVisitors = useMemo(
    () => screenTrend.series.reduce((sum, item) => sum + item.visitors, 0),
    [screenTrend.series],
  );
  const listItems = useMemo<ScreenListItem[]>(
    () =>
      screenTrend.series.map((series) => {
        const parsed = parseScreenSizeLabel(series.label);
        return {
          ...series,
          displayLabel: displaySeriesLabel(series, messages),
          share: totalVisitors > 0 ? series.visitors / totalVisitors : 0,
          parsed,
          bucket: parsed ? classifyScreenBucket(series.label) : "unclassified",
        };
      }),
    [messages, screenTrend.series, totalVisitors],
  );
  const explicitItems = useMemo(
    () => listItems.filter((item) => item.parsed && !item.isOther),
    [listItems],
  );
  const bucketSummary = useMemo(() => {
    const buckets = [...aggregateScreenBuckets(screenTrend.series).buckets];
    buckets.sort((left, right) => right.visitors - left.visitors);
    return buckets;
  }, [screenTrend.series]);
  const previewUrl = useMemo(
    () => resolvePreviewUrl(siteDomain),
    [siteDomain],
  );

  return (
    <section className="space-y-4">
      <div className="px-1">
        <h2 className="text-sm font-medium text-foreground">
          {messages.devices.screenDistributionTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {messages.devices.screenDistributionSubtitle}
        </p>
      </div>

      <ContentSwitch
        loading={loading}
        hasContent={listItems.length > 0}
        loadingLabel={messages.common.loading}
        emptyContent={<p>{messages.common.noData}</p>}
        minHeightClassName="min-h-[320px]"
      >
        <div className="space-y-4">
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            <ScreenCategoryPieCard
              locale={locale}
              messages={messages}
              bucketSummary={bucketSummary}
            />
            <ScreenValueListCard
              locale={locale}
              messages={messages}
              items={explicitItems}
              loading={loading}
            />
          </div>

          <ScreenPreviewCard
            locale={locale}
            messages={messages}
            previewUrl={previewUrl}
            items={explicitItems}
          />
        </div>
      </ContentSwitch>
    </section>
  );
}
