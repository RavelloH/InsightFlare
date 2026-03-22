"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { fetchBrowserRadar } from "@/lib/dashboard/client-data";
import {
  durationFormat,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { BrowserRadarData, BrowserRadarItem } from "@/lib/edge-client";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
] as const;

type RadarMetricKey =
  | "duration"
  | "engagement"
  | "depth"
  | "loyalty"
  | "frequency"
  | "traffic";

const METRIC_KEYS: RadarMetricKey[] = [
  "duration",
  "engagement",
  "depth",
  "loyalty",
  "frequency",
  "traffic",
];

function formatRawMetric(
  locale: Locale,
  metricKey: RadarMetricKey,
  value: number,
): string {
  switch (metricKey) {
    case "duration":
      return durationFormat(locale, value);
    case "engagement":
    case "loyalty":
    case "traffic":
      return percentFormat(locale, value);
    case "depth":
    case "frequency":
      return numberFormat(locale, Number(value.toFixed(1)));
  }
}

interface SingleRadarPoint {
  metric: string;
  metricKey: RadarMetricKey;
  value: number;
}

function buildNormalizedPoints(
  item: BrowserRadarItem,
  maxByMetric: Record<RadarMetricKey, number>,
  metricLabels: Record<RadarMetricKey, string>,
): SingleRadarPoint[] {
  return METRIC_KEYS.map((key) => {
    const max = maxByMetric[key];
    return {
      metric: metricLabels[key],
      metricKey: key,
      value: max > 0 ? Math.round((item.metrics[key] / max) * 100) : 0,
    };
  });
}

/* ---------- single browser radar ---------- */

function SingleBrowserRadar({
  item,
  points,
  color,
  locale,
  chartConfig,
}: {
  item: BrowserRadarItem;
  points: SingleRadarPoint[];
  color: string;
  locale: Locale;
  chartConfig: ChartConfig;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <ChartContainer config={chartConfig} className="aspect-square w-full">
        <RadarChart data={points} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid />
          <PolarAngleAxis dataKey="metric" tick={{ fontSize: 10 }} />
          <PolarRadiusAxis
            angle={30}
            domain={[0, 100]}
            tick={false}
            axisLine={false}
          />
          <Radar
            name={item.browser}
            dataKey="value"
            stroke={color}
            fill={color}
            fillOpacity={0.15}
          />
          <ChartTooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = points.find((p) => p.metric === label);
              if (!point) return null;
              const raw = item.metrics[point.metricKey];

              return (
                <div className="grid min-w-[8rem] gap-0.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                  <div className="font-medium">{label}</div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {item.browser}
                    </span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatRawMetric(locale, point.metricKey, raw)}
                    </span>
                  </div>
                </div>
              );
            }}
          />
        </RadarChart>
      </ChartContainer>
      <div className="flex items-center gap-1.5 text-xs">
        <span
          className="size-2.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
        />
        <span className="font-medium">{item.browser}</span>
      </div>
    </div>
  );
}

/* ---------- main component ---------- */

interface BrowserPerformanceRadarCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

export function BrowserPerformanceRadarCard({
  locale,
  messages,
  siteId,
  window: tw,
  filters,
}: BrowserPerformanceRadarCardProps) {
  const [data, setData] = useState<BrowserRadarItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetchBrowserRadar(siteId, tw, filters)
      .catch(() => ({ ok: true, data: [] }) as BrowserRadarData)
      .then((res) => {
        if (!active) return;
        setData(Array.isArray(res.data) ? res.data : []);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [siteId, tw.from, tw.to, filters]);

  const metricLabels = useMemo(
    () => ({
      duration: messages.browsers.radarDuration,
      engagement: messages.browsers.radarEngagement,
      depth: messages.browsers.radarDepth,
      loyalty: messages.browsers.radarLoyalty,
      frequency: messages.browsers.radarFrequency,
      traffic: messages.browsers.radarTraffic,
    }),
    [messages],
  );

  const maxByMetric = useMemo(() => {
    const result = {} as Record<RadarMetricKey, number>;
    for (const key of METRIC_KEYS) {
      result[key] = Math.max(...data.map((i) => i.metrics[key]), 0);
    }
    return result;
  }, [data]);

  const hasContent = data.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{messages.browsers.radarTitle}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {messages.browsers.radarSubtitle}
        </p>
      </CardHeader>
      <CardContent>
        <ContentSwitch
          loading={loading}
          hasContent={hasContent}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[200px]"
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {data.map((item, i) => {
              const color = CHART_COLORS[i % CHART_COLORS.length];
              const points = buildNormalizedPoints(
                item,
                maxByMetric,
                metricLabels,
              );
              const config: ChartConfig = {
                value: { label: item.browser, color },
              };
              return (
                <SingleBrowserRadar
                  key={item.browser}
                  item={item}
                  points={points}
                  color={color}
                  locale={locale}
                  chartConfig={config}
                />
              );
            })}
          </div>
        </ContentSwitch>
      </CardContent>
    </Card>
  );
}
