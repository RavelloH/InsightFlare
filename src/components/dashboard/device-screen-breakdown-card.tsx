"use client";

import { useEffect, useMemo, useState } from "react";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchClientDimensionTrend } from "@/lib/dashboard/client-data";
import {
  aggregateScreenBuckets,
  parseScreenSizeLabel,
  type ScreenBucketKey,
} from "@/lib/dashboard/device-insights";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData, BrowserTrendSeries } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

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

interface DeviceScreenBreakdownCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

export function DeviceScreenBreakdownCard({
  locale,
  messages,
  siteId,
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
  const topSizes = useMemo(
    () =>
      screenTrend.series.map((series) => ({
        ...series,
        displayLabel: displaySeriesLabel(series, messages),
        share: totalVisitors > 0 ? series.visitors / totalVisitors : 0,
      })),
    [messages, screenTrend.series, totalVisitors],
  );
  const bucketSummary = useMemo(() => {
    const buckets = [...aggregateScreenBuckets(screenTrend.series).buckets];
    buckets.sort((left, right) => right.visitors - left.visitors);
    return buckets;
  }, [screenTrend.series]);
  const explicitCoverage = useMemo(() => {
    const explicitVisitors = screenTrend.series
      .filter((item) => !item.isOther)
      .reduce((sum, item) => sum + item.visitors, 0);
    return totalVisitors > 0 ? explicitVisitors / totalVisitors : 0;
  }, [screenTrend.series, totalVisitors]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{messages.devices.screenDistributionTitle}</CardTitle>
        <CardDescription>{messages.devices.screenDistributionSubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <ContentSwitch
          loading={loading}
          hasContent={topSizes.length > 0}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[260px]"
        >
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <section className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-foreground">
                    {messages.devices.topScreenSizesTitle}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {messages.devices.topSizesCoverageLabel}: {percentFormat(locale, explicitCoverage)}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">{messages.common.visitors}</div>
                  <div className="font-mono text-sm tabular-nums text-foreground">
                    {numberFormat(locale, totalVisitors)}
                  </div>
                </div>
              </div>

              <div className="grid gap-3">
                {topSizes.map((series, index) => (
                  <div
                    key={series.key}
                    className="grid grid-cols-[2.25rem_minmax(0,1fr)_max-content] items-center gap-3 rounded-none border border-border/60 bg-muted/15 px-3 py-2.5"
                  >
                    <div className="flex size-9 items-center justify-center rounded-none border border-border/60 bg-background font-mono text-xs text-muted-foreground">
                      {(index + 1).toString().padStart(2, "0")}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground">
                        {series.displayLabel}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {numberFormat(locale, series.visitors)} {messages.common.visitors}
                      </div>
                    </div>
                    <div className="text-right font-mono text-sm tabular-nums text-foreground">
                      {percentFormat(locale, series.share)}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-medium text-foreground">
                  {messages.devices.screenBucketTitle}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {messages.devices.screenBucketSubtitle}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {bucketSummary.map((bucket) => (
                  <div
                    key={bucket.key}
                    className="rounded-none border border-border/60 bg-background px-4 py-3"
                  >
                    <div className="text-sm font-medium text-foreground">
                      {bucketLabel(bucket.key, messages)}
                    </div>
                    <div className="mt-2 flex items-end justify-between gap-3">
                      <span className="text-xs text-muted-foreground">
                        {numberFormat(locale, bucket.visitors)} {messages.common.visitors}
                      </span>
                      <span className="font-mono text-sm tabular-nums text-foreground">
                        {percentFormat(locale, bucket.share)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </ContentSwitch>
      </CardContent>
    </Card>
  );
}
