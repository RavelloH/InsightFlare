"use client";

import { useEffect, useMemo, useState } from "react";
import { Label, PolarRadiusAxis, RadialBar, RadialBarChart } from "recharts";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { fetchClientDimensionTrend } from "@/lib/dashboard/client-data";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData, BrowserTrendSeries } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--muted-foreground)",
] as const;

function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
}

function seriesLabel(series: BrowserTrendSeries, messages: AppMessages): string {
  return series.isOther ? messages.devices.otherLabel : series.label;
}

function ShareRadialCard({
  title,
  series,
  locale,
  messages,
}: {
  title: string;
  series: BrowserTrendSeries[];
  locale: Locale;
  messages: AppMessages;
}) {
  const totalVisitors = useMemo(
    () => series.reduce((sum, item) => sum + item.visitors, 0),
    [series],
  );

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    for (let index = 0; index < series.length; index += 1) {
      const item = series[index];
      config[item.key] = {
        label: seriesLabel(item, messages),
        color: item.isOther
          ? "var(--muted-foreground)"
          : CHART_COLORS[index % CHART_COLORS.length],
      };
    }
    return config;
  }, [messages, series]);

  const chartData = useMemo(() => {
    const row: Record<string, number> = {};
    for (const item of series) {
      row[item.key] = item.visitors;
    }
    return [row];
  }, [series]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center">
          <ChartContainer
            config={chartConfig}
            className="mx-auto aspect-[2/1] w-full"
          >
            <RadialBarChart
              data={chartData}
              endAngle={180}
              innerRadius="60%"
              outerRadius="100%"
            >
              <ChartTooltip
                cursor={false}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const item = payload[0];
                  const key = String(item.dataKey ?? "");
                  const value = Number(item.value ?? 0);
                  const share = totalVisitors > 0 ? value / totalVisitors : 0;
                  const label = String(chartConfig[key]?.label ?? key);
                  const color = chartConfig[key]?.color;

                  return (
                    <div className="grid min-w-[10rem] gap-1 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                      <div className="flex items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: color }}
                        />
                        <span className="font-medium">{label}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          {numberFormat(locale, value)} {messages.common.visitors}
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {percentFormat(locale, share)}
                        </span>
                      </div>
                    </div>
                  );
                }}
              />
              <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
                <Label
                  content={({ viewBox }) => {
                    if (!viewBox || !("cx" in viewBox) || !("cy" in viewBox)) return null;
                    const cx = viewBox.cx || 0;
                    const cy = viewBox.cy || 0;
                    const width = 200;
                    const height = 60;
                    return (
                      <foreignObject
                        x={cx - width / 2}
                        y={cy - height + 4}
                        width={width}
                        height={height}
                      >
                        <div className="flex h-full flex-col items-center justify-end">
                          <span className="text-center text-[clamp(1rem,3cqi,1.75rem)] font-bold leading-tight text-foreground">
                            {numberFormat(locale, totalVisitors)}
                          </span>
                          <span className="text-[clamp(0.625rem,1.5cqi,0.75rem)] text-muted-foreground">
                            {messages.common.visitors}
                          </span>
                        </div>
                      </foreignObject>
                    );
                  }}
                />
              </PolarRadiusAxis>
              {series.map((item, index) => (
                <RadialBar
                  key={item.key}
                  dataKey={item.key}
                  stackId="device-share"
                  fill={
                    item.isOther
                      ? "var(--muted-foreground)"
                      : CHART_COLORS[index % CHART_COLORS.length]
                  }
                  className="stroke-transparent stroke-2"
                />
              ))}
            </RadialBarChart>
          </ChartContainer>

          <div className="-mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            {series.map((item, index) => {
              const share = totalVisitors > 0 ? item.visitors / totalVisitors : 0;
              return (
                <div key={item.key} className="flex items-center gap-1.5 text-xs">
                  <span
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{
                      backgroundColor: item.isOther
                        ? "var(--muted-foreground)"
                        : CHART_COLORS[index % CHART_COLORS.length],
                    }}
                  />
                  <span className="text-muted-foreground">
                    {seriesLabel(item, messages)}
                  </span>
                  <span className="font-mono tabular-nums text-foreground">
                    {percentFormat(locale, share)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface DeviceShareOverviewProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

export function DeviceShareOverview({
  locale,
  messages,
  siteId,
  window,
  filters,
}: DeviceShareOverviewProps) {
  const [deviceTrend, setDeviceTrend] = useState<BrowserTrendData>(emptyTrend);
  const [osTrend, setOsTrend] = useState<BrowserTrendData>(emptyTrend);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      fetchClientDimensionTrend(siteId, window, "deviceType", filters, { limit: 5 }).catch(() =>
        emptyTrend()
      ),
      fetchClientDimensionTrend(siteId, window, "operatingSystem", filters, { limit: 5 }).catch(
        () => emptyTrend(),
      ),
    ])
      .then(([nextDeviceTrend, nextOsTrend]) => {
        if (!active) return;
        setDeviceTrend(nextDeviceTrend);
        setOsTrend(nextOsTrend);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [filters, siteId, window.from, window.to, window.interval]);

  const hasContent = deviceTrend.series.length > 0 || osTrend.series.length > 0;

  return (
    <ContentSwitch
      loading={loading}
      hasContent={hasContent}
      loadingLabel={messages.common.loading}
      emptyContent={<p>{messages.common.noData}</p>}
      minHeightClassName="min-h-[200px]"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <ShareRadialCard
          title={messages.devices.deviceShareTitle}
          series={deviceTrend.series}
          locale={locale}
          messages={messages}
        />
        <ShareRadialCard
          title={messages.devices.osShareTitle}
          series={osTrend.series}
          locale={locale}
          messages={messages}
        />
      </div>
    </ContentSwitch>
  );
}
