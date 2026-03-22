"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchClientCrossBreakdown, fetchClientDimensionTrend } from "@/lib/dashboard/client-data";
import {
  aggregateScreenBuckets,
  pickTopCrossCell,
  pickTopVisibleSeries,
  type ScreenBucketKey,
} from "@/lib/dashboard/device-insights";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserCrossBreakdownDimensionData,
  BrowserTrendData,
} from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
}

function emptyDimension(): BrowserCrossBreakdownDimensionData {
  return {
    columns: [],
    rows: [],
    totalViews: 0,
    totalVisitors: 0,
    totalSessions: 0,
  };
}

function bucketLabel(bucket: ScreenBucketKey, messages: AppMessages): string {
  return messages.devices.screenBucketLabels[bucket];
}

function trendLabel(
  label: string,
  isOther: boolean | undefined,
  messages: AppMessages,
): string {
  return isOther ? messages.devices.otherLabel : label;
}

function InsightPanel({
  label,
  value,
  meta,
  children,
}: {
  label: string;
  value?: string | null;
  meta?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-none border border-border/60 bg-muted/10 px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      {value ? (
        <div className="mt-2 text-lg font-medium text-foreground">{value}</div>
      ) : null}
      {meta ? (
        <div className="mt-1 text-sm text-muted-foreground">{meta}</div>
      ) : null}
      {children ? <div className="mt-3 grid gap-3">{children}</div> : null}
    </div>
  );
}

interface DevicePriorityCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

export function DevicePriorityCard({
  locale,
  messages,
  siteId,
  window,
  filters,
}: DevicePriorityCardProps) {
  const [loading, setLoading] = useState(true);
  const [deviceTrend, setDeviceTrend] = useState<BrowserTrendData>(emptyTrend);
  const [osTrend, setOsTrend] = useState<BrowserTrendData>(emptyTrend);
  const [screenTrend, setScreenTrend] = useState<BrowserTrendData>(emptyTrend);
  const [browserCross, setBrowserCross] = useState<BrowserCrossBreakdownDimensionData>(
    emptyDimension,
  );
  const [osCross, setOsCross] = useState<BrowserCrossBreakdownDimensionData>(emptyDimension);

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
      fetchClientDimensionTrend(siteId, window, "screenSize", filters, { limit: 10 }).catch(() =>
        emptyTrend()
      ),
      fetchClientCrossBreakdown(siteId, window, "deviceType", "browser", filters, {
        primaryLimit: 5,
        secondaryLimit: 6,
      }).catch(() => emptyDimension()),
      fetchClientCrossBreakdown(siteId, window, "deviceType", "operatingSystem", filters, {
        primaryLimit: 5,
        secondaryLimit: 6,
      }).catch(() => emptyDimension()),
    ])
      .then(([nextDeviceTrend, nextOsTrend, nextScreenTrend, nextBrowserCross, nextOsCross]) => {
        if (!active) return;
        setDeviceTrend(nextDeviceTrend);
        setOsTrend(nextOsTrend);
        setScreenTrend(nextScreenTrend);
        setBrowserCross(nextBrowserCross);
        setOsCross(nextOsCross);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [filters, siteId, window.from, window.to, window.interval]);

  const dominantDevice = useMemo(
    () => pickTopVisibleSeries(deviceTrend.series),
    [deviceTrend.series],
  );
  const deviceVisitorsTotal = useMemo(
    () => deviceTrend.series.reduce((sum, item) => sum + item.visitors, 0),
    [deviceTrend.series],
  );
  const dominantOs = useMemo(
    () => pickTopVisibleSeries(osTrend.series),
    [osTrend.series],
  );
  const osVisitorsTotal = useMemo(
    () => osTrend.series.reduce((sum, item) => sum + item.visitors, 0),
    [osTrend.series],
  );
  const topBrowserCombo = useMemo(
    () => pickTopCrossCell(browserCross),
    [browserCross],
  );
  const topOsCombo = useMemo(
    () => pickTopCrossCell(osCross),
    [osCross],
  );
  const screenSummary = useMemo(
    () => aggregateScreenBuckets(screenTrend.series),
    [screenTrend.series],
  );
  const focusBucket = useMemo(
    () =>
      [...screenSummary.buckets]
        .filter((bucket) => bucket.key !== "unclassified")
        .sort((left, right) => right.visitors - left.visitors)[0]
      ?? [...screenSummary.buckets].sort((left, right) => right.visitors - left.visitors)[0]
      ?? null,
    [screenSummary.buckets],
  );
  const classifiedCoverage = useMemo(
    () => (
      screenSummary.totalVisitors > 0
        ? screenSummary.classifiedVisitors / screenSummary.totalVisitors
        : 0
    ),
    [screenSummary.classifiedVisitors, screenSummary.totalVisitors],
  );
  const hasContent = Boolean(
    dominantDevice
    || dominantOs
    || focusBucket
    || topBrowserCombo
    || topOsCombo,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{messages.devices.priorityTitle}</CardTitle>
        <CardDescription>{messages.devices.prioritySubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <ContentSwitch
          loading={loading}
          hasContent={hasContent}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[220px]"
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <InsightPanel
              label={messages.devices.dominantSegmentLabel}
              value={dominantDevice
                ? trendLabel(dominantDevice.label, dominantDevice.isOther, messages)
                : null}
              meta={dominantDevice
                ? `${percentFormat(locale, dominantDevice.visitors / Math.max(1, deviceVisitorsTotal))} · ${numberFormat(locale, dominantDevice.visitors)} ${messages.common.visitors}`
                : null}
            />
            <InsightPanel
              label={messages.devices.dominantOsLabel}
              value={dominantOs
                ? trendLabel(dominantOs.label, dominantOs.isOther, messages)
                : null}
              meta={dominantOs
                ? `${percentFormat(locale, dominantOs.visitors / Math.max(1, osVisitorsTotal))} · ${numberFormat(locale, dominantOs.visitors)} ${messages.common.visitors}`
                : null}
            />
            <InsightPanel
              label={messages.devices.responsiveFocusLabel}
              value={focusBucket ? bucketLabel(focusBucket.key, messages) : null}
              meta={focusBucket
                ? `${percentFormat(locale, focusBucket.share)} · ${messages.devices.topSizesCoverageLabel}: ${percentFormat(locale, classifiedCoverage)}`
                : null}
            />
            <InsightPanel label={messages.devices.testMatrixTitle}>
              {topBrowserCombo ? (
                <div className="grid gap-1">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    {messages.common.browser}
                  </div>
                  <div className="text-sm font-medium text-foreground">
                    {topBrowserCombo.primaryLabel} x {topBrowserCombo.secondaryLabel}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {numberFormat(locale, topBrowserCombo.visitors)} {messages.common.visitors}
                    {" · "}
                    {percentFormat(locale, topBrowserCombo.share)}
                  </div>
                </div>
              ) : null}
              {topOsCombo ? (
                <div className="grid gap-1">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    {messages.common.operatingSystem}
                  </div>
                  <div className="text-sm font-medium text-foreground">
                    {topOsCombo.primaryLabel} x {topOsCombo.secondaryLabel}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {numberFormat(locale, topOsCombo.visitors)} {messages.common.visitors}
                    {" · "}
                    {percentFormat(locale, topOsCombo.share)}
                  </div>
                </div>
              ) : null}
            </InsightPanel>
          </div>
        </ContentSwitch>
      </CardContent>
    </Card>
  );
}
