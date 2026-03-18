"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { AppMessages } from "@/lib/i18n/messages";

interface GeoCountryStatsPanelProps {
  locale: Locale;
  messages: AppMessages;
  loading: boolean;
  highlightCountryCode?: string | null;
  countryCounts: Array<{
    country: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
}

type MetricKey = "visitors" | "views" | "sessions";

interface ChartRow {
  country: string;
  label: string;
  value: number;
  fill: string;
}

interface EllipsisYAxisTickProps {
  x?: number;
  y?: number;
  payload?: {
    value?: string | number;
  };
}

const PANEL_METRICS: MetricKey[] = ["visitors", "views", "sessions"];
const BASE_BAR_OPACITY = [0.96, 0.84, 0.72, 0.62, 0.54, 0.46, 0.4, 0.34, 0.28, 0.22];
const LABEL_WIDTH = 92;
const LABEL_HEIGHT = 16;
const LABEL_INSET = 8;
const LABEL_SAFE_WIDTH = LABEL_WIDTH - LABEL_INSET;
const LABEL_MAX_UNITS = 11;

function truncateLabel(value: string, maxUnits: number): string {
  let usedUnits = 0;
  let result = "";

  for (const char of value) {
    const nextUnits = /[^\u0000-\u00ff]/.test(char) ? 2 : 1;
    if (usedUnits + nextUnits > maxUnits - 3) {
      return `${result}...`;
    }
    result += char;
    usedUnits += nextUnits;
  }

  return result;
}

function EllipsisYAxisTick({
  x = 0,
  y = 0,
  payload,
}: EllipsisYAxisTickProps) {
  const label = truncateLabel(String(payload?.value ?? ""), LABEL_MAX_UNITS);

  return (
    <g pointerEvents="none">
      <foreignObject
        x={x - LABEL_WIDTH + LABEL_INSET}
        y={y - LABEL_HEIGHT / 2}
        width={LABEL_SAFE_WIDTH}
        height={LABEL_HEIGHT}
      >
        <div
          className="h-4 overflow-hidden whitespace-nowrap text-right text-xs leading-4 text-muted-foreground"
          style={{ width: LABEL_SAFE_WIDTH }}
        >
          {label}
        </div>
      </foreignObject>
    </g>
  );
}

function metricLabel(metric: MetricKey, messages: AppMessages): string {
  if (metric === "visitors") return messages.common.visitors;
  if (metric === "sessions") return messages.common.sessions;
  return messages.common.views;
}

export function GeoCountryStatsPanel({
  locale,
  messages,
  loading,
  highlightCountryCode,
  countryCounts,
}: GeoCountryStatsPanelProps) {
  const [metric, setMetric] = useState<MetricKey>("visitors");

  const chartConfig = useMemo(
    () =>
      ({
        value: {
          label: metricLabel(metric, messages),
          color: "rgba(34, 197, 154, 0.96)",
        },
      }) satisfies ChartConfig,
    [messages, metric],
  );
  const chartRows = useMemo<ChartRow[]>(() => {
    return countryCounts
      .map((row, index) => {
        const country = String(row.country ?? "").trim().toUpperCase();
        const label = resolveCountryLabel(
          country,
          locale,
          messages.common.unknown,
        ).label;
        const value =
          metric === "visitors"
            ? Number(row.visitors ?? 0)
            : metric === "sessions"
              ? Number(row.sessions ?? 0)
              : Number(row.views ?? 0);
        const opacity =
          country === String(highlightCountryCode ?? "").trim().toUpperCase()
            ? 1
            : BASE_BAR_OPACITY[index] ?? 0.2;

        return {
          country,
          label,
          value,
          fill: `rgba(34, 197, 154, ${opacity})`,
        };
      })
      .filter((row) => row.value > 0)
      .sort((left, right) => right.value - left.value)
      .map((row, index) => ({
        ...row,
        fill:
          row.country === String(highlightCountryCode ?? "").trim().toUpperCase()
            ? "rgba(34, 197, 154, 1)"
            : `rgba(34, 197, 154, ${BASE_BAR_OPACITY[index] ?? 0.2})`,
      }));
  }, [countryCounts, highlightCountryCode, locale, messages.common.unknown, metric]);
  const metricText = metricLabel(metric, messages);
  const chartHeight = useMemo(
    () => Math.max(176, chartRows.length * 22 + 18),
    [chartRows.length],
  );
  const totalValue = useMemo(
    () =>
      chartRows.reduce((sum, row) => sum + row.value, 0),
    [chartRows],
  );

  return (
    <aside className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[44svh] p-3 sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:w-[23.5rem]">
      <Card className="pointer-events-auto h-full bg-background/75 backdrop-blur-xl">
        <CardHeader>
          <CardTitle>
            {locale === "zh" ? "国家/地区访问" : "Country / Region Access"}
          </CardTitle>
          <CardDescription>
            {locale === "zh"
              ? "当前筛选范围内的全部国家/地区分布"
              : "All countries in the current filtered range"}
          </CardDescription>
          <Tabs
            value={metric}
            onValueChange={(value) => setMetric(value as MetricKey)}
          >
            <TabsList variant="line" className="w-full">
              {PANEL_METRICS.map((key) => (
                <TabsTrigger key={key} value={key}>
                  {metricLabel(key, messages)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>

        <CardContent className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {loading ? (
            <div className="flex min-h-full items-center justify-center">
              <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                <span>{messages.common.loading}</span>
              </div>
            </div>
          ) : chartRows.length === 0 ? (
            <div className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
              {messages.common.noData}
            </div>
          ) : (
            <ChartContainer
              className="w-full aspect-auto"
              config={chartConfig}
              style={{ height: chartHeight }}
            >
              <BarChart
                accessibilityLayer
                data={chartRows}
                layout="vertical"
                barCategoryGap={6}
                margin={{
                  top: 0,
                  right: 8,
                  bottom: 0,
                  left: 0,
                }}
              >
                <YAxis
                  dataKey="label"
                  type="category"
                  interval={0}
                  tickLine={false}
                  tickMargin={6}
                  axisLine={false}
                  width={LABEL_WIDTH}
                  tick={<EllipsisYAxisTick />}
                />
                <XAxis dataKey="value" type="number" hide />
                <ChartTooltip
                  cursor={false}
                  content={(
                    <ChartTooltipContent
                      formatter={(value) => {
                        const numeric =
                          typeof value === "number"
                            ? value
                            : Number(value ?? 0);
                        return (
                          <div className="flex min-w-28 items-center justify-between gap-4">
                            <span>{metricText}</span>
                            <span className="font-mono">
                              {numberFormat(locale, numeric)}
                            </span>
                          </div>
                        );
                      }}
                    />
                  )}
                />
                <Bar dataKey="value" layout="vertical" radius={4} barSize={10}>
                  {chartRows.map((row) => (
                    <Cell key={`${row.country}-${metric}`} fill={row.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>

        <CardFooter className="flex-col items-start gap-2">
          <div className="flex w-full items-center justify-between gap-4 text-muted-foreground">
            <span>{metricText}</span>
            <span className="font-mono text-foreground">
              {numberFormat(locale, totalValue)}
            </span>
          </div>
        </CardFooter>
      </Card>
    </aside>
  );
}
