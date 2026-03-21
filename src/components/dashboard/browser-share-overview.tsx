"use client";

import { useEffect, useMemo, useState } from "react";
import { Label, PolarRadiusAxis, RadialBar, RadialBarChart } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import {
  fetchBrowserTrend,
  fetchBrowserEngineTrend,
} from "@/lib/dashboard/client-data";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { BrowserTrendData, BrowserTrendSeries } from "@/lib/edge-client";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
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

/* ---------- radial card ---------- */

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
    () => series.reduce((sum, s) => sum + s.visitors, 0),
    [series],
  );

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    for (let i = 0; i < series.length; i++) {
      config[series[i].key] = {
        label: series[i].label,
        color: series[i].isOther
          ? "var(--muted-foreground)"
          : CHART_COLORS[i % CHART_COLORS.length],
      };
    }
    return config;
  }, [series]);

  // RadialBarChart with stacked bars needs a single data row with all keys
  const chartData = useMemo(() => {
    const row: Record<string, number> = {};
    for (const s of series) {
      row[s.key] = s.visitors;
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
                  const key = item.dataKey as string;
                  const value = (item.value as number) ?? 0;
                  const cfg = chartConfig[key];
                  const share = totalVisitors > 0 ? value / totalVisitors : 0;

                  return (
                    <div className="grid min-w-[10rem] gap-1 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                      <div className="flex items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: cfg?.color }}
                        />
                        <span className="font-medium">{cfg?.label ?? key}</span>
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
                    if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                      const cx = viewBox.cx || 0;
                      const cy = viewBox.cy || 0;
                      const w = 200;
                      const h = 60;
                      return (
                        <foreignObject
                          x={cx - w / 2}
                          y={cy - h + 4}
                          width={w}
                          height={h}
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
                    }
                  }}
                />
              </PolarRadiusAxis>
              {series.map((s, i) => (
                <RadialBar
                  key={s.key}
                  dataKey={s.key}
                  stackId="a"
                  fill={
                    s.isOther
                      ? "var(--muted-foreground)"
                      : CHART_COLORS[i % CHART_COLORS.length]
                  }
                  className="stroke-transparent stroke-2"
                />
              ))}
            </RadialBarChart>
          </ChartContainer>

          {/* legend */}
          <div className="-mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            {series.map((s, i) => {
              const share = totalVisitors > 0 ? s.visitors / totalVisitors : 0;
              return (
                <div key={s.key} className="flex items-center gap-1.5 text-xs">
                  <span
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{
                      backgroundColor: s.isOther
                        ? "var(--muted-foreground)"
                        : CHART_COLORS[i % CHART_COLORS.length],
                    }}
                  />
                  <span className="text-muted-foreground">{s.label}</span>
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

/* ---------- main component ---------- */

interface BrowserShareOverviewProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

export function BrowserShareOverview({
  locale,
  messages,
  siteId,
  window: tw,
  filters,
}: BrowserShareOverviewProps) {
  const [browserTrend, setBrowserTrend] =
    useState<BrowserTrendData>(emptyTrend);
  const [engineTrend, setEngineTrend] = useState<BrowserTrendData>(emptyTrend);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      fetchBrowserTrend(siteId, tw, filters, { limit: 5 }).catch(() =>
        emptyTrend(),
      ),
      fetchBrowserEngineTrend(siteId, tw, filters, { limit: 5 }).catch(() =>
        emptyTrend(),
      ),
    ]).then(([bt, et]) => {
      if (!active) return;
      setBrowserTrend(bt);
      setEngineTrend(et);
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [siteId, tw.from, tw.to, filters]);

  const hasContent =
    browserTrend.series.length > 0 || engineTrend.series.length > 0;

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
          title={messages.browsers.browserShareTitle}
          series={browserTrend.series}
          locale={locale}
          messages={messages}
        />
        <ShareRadialCard
          title={messages.browsers.engineShareTitle}
          series={engineTrend.series}
          locale={locale}
          messages={messages}
        />
      </div>
    </ContentSwitch>
  );
}
