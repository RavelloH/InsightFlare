import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { resolveDeviceTypeMeta } from "@/components/dashboard/journey-display";
import { ShareRadialCard } from "@/components/dashboard/share-radial-card";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Spinner } from "@/components/ui/spinner";
import { fetchClientDimensionTrend } from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
}

function emptyTrendUnlessAborted(error: unknown): BrowserTrendData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyTrend();
}

function seriesLabel(
  series: BrowserTrendData["series"][number],
  messages: AppMessages,
): string {
  if (series.isOther) return messages.devices.otherLabel;
  return series.label;
}

interface DeviceShareOverviewProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

export function DeviceShareOverview({
  locale,
  messages,
  siteId,
  window,
  filters,
}: DeviceShareOverviewProps) {
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);
  const { data, isFetching } = useQuery({
    queryKey: [
      "dashboard",
      "device-share-overview",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
    ],
    queryFn: async ({ signal }) => {
      const [deviceTrend, osTrend] = await Promise.all([
        fetchClientDimensionTrend(siteId, window, "deviceType", filters, {
          limit: 5,
          signal,
        }).catch(emptyTrendUnlessAborted),
        fetchClientDimensionTrend(siteId, window, "operatingSystem", filters, {
          limit: 5,
          signal,
        }).catch(emptyTrendUnlessAborted),
      ]);
      return { deviceTrend, osTrend };
    },
    enabled: typeof window !== "undefined",
  });
  const deviceTrend = data?.deviceTrend ?? emptyTrend();
  const osTrend = data?.osTrend ?? emptyTrend();
  const showOverlayLoading = isFetching && data !== undefined;
  const showInitialLoading = isFetching && data === undefined;

  return (
    <div className="relative">
      <div className="grid gap-4">
        <ShareRadialCard
          title={messages.devices.deviceShareTitle}
          items={deviceTrend.series.map((item) => {
            const deviceMeta = resolveDeviceTypeMeta(
              item.label,
              messages.common.deviceLabels,
              messages.common.unknown,
            );
            return {
              key: item.key,
              label: item.isOther
                ? messages.devices.otherLabel
                : deviceMeta.label,
              value: item.visitors,
              isOther: item.isOther,
              icon: item.isOther ? undefined : deviceMeta.Icon,
            };
          })}
          locale={locale}
          valueLabel={messages.common.visitors}
          loading={showInitialLoading}
          emptyLabel={messages.common.noData}
        />
        <ShareRadialCard
          title={messages.devices.osShareTitle}
          items={osTrend.series.map((item) => ({
            key: item.key,
            label: seriesLabel(item, messages),
            value: item.visitors,
            isOther: item.isOther,
          }))}
          locale={locale}
          valueLabel={messages.common.visitors}
          loading={showInitialLoading}
          emptyLabel={messages.common.noData}
        />
      </div>

      <AutoTransition
        type="fade"
        duration={0.22}
        className="pointer-events-none absolute top-2 right-2"
      >
        {showOverlayLoading ? (
          <span
            key="device-share-overlay-loading"
            className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
          >
            <Spinner className="size-3.5" />
            {messages.common.loading}
          </span>
        ) : (
          <div
            key="device-share-overlay-idle"
            className="h-0 w-0 overflow-hidden"
          />
        )}
      </AutoTransition>
    </div>
  );
}
