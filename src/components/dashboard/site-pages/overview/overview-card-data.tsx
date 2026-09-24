import { memo } from "react";
import { RiBarChartLine, RiUserLine } from "@remixicon/react";

import { type TabbedDataTableColumn } from "@/components/dashboard/common/tabbed-data-table-card";
import { resolveDeviceTypeMeta } from "@/components/dashboard/journeys/journey-display";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Clickable } from "@/components/ui/clickable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  TRAFFIC_CHANNEL_IDS,
  type TrafficChannelId,
} from "@/lib/analytics/traffic-channel-rules";
import { type OverviewTabRows } from "@/lib/dashboard/client/data/index";
import { numberFormat } from "@/lib/dashboard/format";
import { loadLocalTablePage } from "@/lib/dashboard/table-loader";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import type { OverviewTabData } from "@/lib/dashboard-api/client/edge";
import {
  resolveContinentLabel,
  resolveCountryFlagCode,
  resolveCountryLabel,
  resolveLanguageLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import {
  DIRECT_REFERRER_FILTER_VALUE,
  resolveGeoCityBreadcrumbData,
  resolveGeoDimensionRowRawValue,
  resolveGeoRegionBreadcrumbData,
} from "./overview-filter-model";
import {
  normalizeDimensionLabel,
  resolveBrowserLogoIconName,
  resolveOsLogoIconName,
  resolveTimezoneDisplayLabel,
} from "./overview-labels";
import { changeRateClass, formatChangeRate } from "./overview-model";
import { sanitizeHostname, toAbsoluteHttpsUrl } from "./overview-url";
import {
  type ClientDimensionCardTab,
  type GeoDimensionCardTab,
  type OverviewComparisonMetric,
  type PageCardRow,
  type PageCardSortKey,
  type PageCardTab,
  type SourceCardRow,
  type SourceCardTab,
} from "./types";
export function overviewTabData(
  value: OverviewTabRows | OverviewTabData["data"],
): OverviewTabData["data"] {
  if (!Array.isArray(value)) return value;
  return {
    items: value,
    pagination: {
      limit: value.length,
      returned: value.length,
      hasMore: false,
      nextCursor: null,
    },
  };
}
export function loadLocalOverviewTablePage(
  rows: readonly OverviewTabRows[number][],
  sort: { key: PageCardSortKey; direction: "asc" | "desc" },
  tab: string,
  limit: number,
  cursor: string | null,
  search: string,
): OverviewTabData["data"] {
  const metric = sort.key === "visitors" ? "visitors" : "views";
  const page = loadLocalTablePage({
    rows: [...rows],
    sort: { key: metric, direction: sort.direction },
    columns: [
      { key: "views", getValue: (row) => row.views },
      { key: "visitors", getValue: (row) => row.visitors },
    ],
    tab,
    limit,
    cursor,
    search,
    getSearchText: (row) => row.label,
  });
  return { ...page, items: [...page.items] };
}
export function createOverviewComparisonColumns(
  metric: OverviewComparisonMetric,
  comparisonLabel: string,
  locale: Locale,
  messages: AppMessages,
): readonly TabbedDataTableColumn<PageCardRow, PageCardSortKey, string>[] {
  return [
    {
      key: "reference",
      label: comparisonLabel,
      getValue: (row) => row.reference?.[metric] ?? 0,
      sortValue: (row) => row.reference?.[metric] ?? 0,
      format: (value) => numberFormat(locale, value),
    },
    {
      key: "current",
      label:
        metric === "views" ? messages.common.views : messages.common.visitors,
      getValue: (row) => row[metric],
      sortValue: (row) => row[metric],
      format: (value) => numberFormat(locale, value),
    },
    {
      key: "change",
      label: messages.common.change,
      getValue: (row) => row.change?.[metric].absolute ?? 0,
      sortValue: (row) => row.change?.[metric].relative ?? Infinity,
      format: (_value, row) => {
        const change = row.change?.[metric];
        if (!change) {
          return <span className="text-muted-foreground">—</span>;
        }
        if (change.relative === null) {
          return (
            <span className={changeRateClass(row[metric] > 0 ? 100 : null)}>
              {row[metric] > 0 ? messages.common.new : "—"}
            </span>
          );
        }
        const percentage = change.relative * 100;
        return (
          <span className={changeRateClass(percentage)}>
            {formatChangeRate(percentage) ?? "0.0%"}
          </span>
        );
      },
    },
  ];
}
export const ComparisonMetricToggle = memo(function ComparisonMetricToggle({
  metric,
  messages,
  onMetricChange,
}: {
  metric: OverviewComparisonMetric;
  messages: AppMessages;
  onMetricChange: (metric: OverviewComparisonMetric) => void;
}) {
  const nextMetric: OverviewComparisonMetric =
    metric === "views" ? "visitors" : "views";
  const label =
    metric === "views" ? messages.common.views : messages.common.visitors;
  const Icon = metric === "views" ? RiBarChartLine : RiUserLine;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Clickable
          className="size-6 text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={() => onMetricChange(nextMetric)}
        >
          <AutoTransition
            as="span"
            type="crossFade"
            duration={0.18}
            initial={false}
            transitionKey={metric}
            className="inline-flex size-4 items-center justify-center"
          >
            <Icon key={metric} className="size-4" aria-hidden="true" />
          </AutoTransition>
        </Clickable>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
export function buildPageCardExportRows(
  tab: PageCardTab,
  items: OverviewTabRows,
  messages: AppMessages,
  fallbackLabel?: string,
): PageCardRow[] {
  return items.map((item, index) => {
    const rawLabel = String(item.label ?? "").trim();
    const label =
      rawLabel ||
      (fallbackLabel ??
        (tab === "query"
          ? messages.pages.noQuery
          : tab === "title" || tab === "hostname"
            ? messages.common.unknown
            : "/"));
    return {
      key: item.key ?? `${tab}-${label}-${index}`,
      label,
      displayLabel: decodeUrlDisplayValue(label),
      views: Math.max(0, Number(item.views ?? 0)),
      visitors: Math.max(0, Number(item.visitors ?? 0)),
      reference: item.reference,
      change: item.change,
      mono: tab !== "title",
      filterValue: rawLabel || label,
    };
  });
}
export function buildSourceCardExportRows(
  tab: SourceCardTab,
  items: OverviewTabRows,
  directLabel: string,
  channelLabels: Record<TrafficChannelId, string>,
): SourceCardRow[] {
  return items.map((item, index) => {
    const raw = String(item.label ?? "").trim();
    if (tab === "channel") {
      const channelId = TRAFFIC_CHANNEL_IDS.includes(raw as TrafficChannelId)
        ? (raw as TrafficChannelId)
        : "other";
      return {
        key: item.key ?? `channel-${channelId}-${index}`,
        label: channelLabels[channelId],
        filterValue: channelId,
        targetUrl: null,
        views: Math.max(0, Number(item.views ?? 0)),
        visitors: Math.max(0, Number(item.visitors ?? 0)),
        reference: item.reference,
        change: item.change,
        mono: false,
        channelId,
      };
    }

    const domain =
      tab === "domain" && raw !== DIRECT_REFERRER_FILTER_VALUE
        ? sanitizeHostname(raw)
        : "";
    const targetUrl = tab === "link" && raw ? toAbsoluteHttpsUrl(raw) : null;
    const filterValue =
      tab === "domain"
        ? domain || DIRECT_REFERRER_FILTER_VALUE
        : raw || DIRECT_REFERRER_FILTER_VALUE;
    const label =
      tab === "domain"
        ? domain || directLabel
        : raw
          ? (targetUrl ?? raw)
          : directLabel;
    return {
      key: item.key ?? `${tab}-${filterValue}-${index}`,
      label,
      displayLabel: decodeUrlDisplayValue(label),
      filterValue,
      targetUrl,
      views: Math.max(0, Number(item.views ?? 0)),
      visitors: Math.max(0, Number(item.visitors ?? 0)),
      reference: item.reference,
      change: item.change,
      mono: true,
    };
  });
}
export function buildClientDimensionRows(
  tab: ClientDimensionCardTab,
  items: OverviewTabRows,
  locale: Locale,
  messages: AppMessages,
): PageCardRow[] {
  const options: {
    mono?: boolean;
    screenSize?: boolean;
    transformLabel?: (value: string) => string;
    resolveIconName?: (value: string) => string | null;
    resolveFilterValue?: (rawValue: string, normalizedLabel: string) => string;
  } = {
    browser: { resolveIconName: resolveBrowserLogoIconName },
    osVersion: { resolveIconName: resolveOsLogoIconName },
    deviceType: {
      transformLabel: (value: string) =>
        resolveDeviceTypeMeta(
          value,
          messages.common.deviceLabels,
          messages.common.unknown,
        ).label,
    },
    language: {
      transformLabel: (value: string) =>
        resolveLanguageLabel(value, locale, messages.common.unknown).label,
      resolveFilterValue: (rawValue: string, normalizedLabel: string) =>
        rawValue.trim() || normalizedLabel,
    },
    screenSize: { mono: true, screenSize: true },
  }[tab];

  return items.map((item, index) => {
    const rawValue = String(item.label ?? "");
    const rawLabel = normalizeDimensionLabel(
      rawValue,
      messages.common.unknown,
      { screenSize: options.screenSize },
    );
    const label = options.transformLabel
      ? options.transformLabel(rawLabel)
      : rawLabel;
    const filterValue =
      options.resolveFilterValue?.(rawValue, rawLabel) ?? rawLabel;
    return {
      key: item.key ?? `${label}-${index}`,
      label,
      rawLabel: rawValue.trim() || rawLabel,
      views: Math.max(0, Number(item.views ?? 0)),
      visitors: Math.max(0, Number(item.visitors ?? 0)),
      reference: item.reference,
      change: item.change,
      mono: options.mono ?? false,
      iconName: options.resolveIconName?.(rawLabel) ?? null,
      filterValue,
    };
  });
}
export function buildGeoDimensionRows(
  tab: GeoDimensionCardTab,
  items: OverviewTabRows,
  locale: Locale,
  messages: AppMessages,
  timezoneReferenceTimestampMs: number,
): PageCardRow[] {
  if (tab === "region") {
    return items.map((item, index) => {
      const value = resolveGeoDimensionRowRawValue(item);
      const regionData = resolveGeoRegionBreadcrumbData(
        value,
        locale,
        messages.common.unknown,
      );
      return {
        key: item.key ?? `${regionData.displayLabel}-${index}`,
        label: regionData.displayLabel,
        rawLabel: value.trim() || regionData.filterValue,
        views: Math.max(0, Number(item.views ?? 0)),
        visitors: Math.max(0, Number(item.visitors ?? 0)),
        reference: item.reference,
        change: item.change,
        mono: false,
        iconName: null,
        filterValue: regionData.filterValue,
        regionBreadcrumb: regionData.breadcrumb,
      };
    });
  }

  if (tab === "city") {
    return items.map((item, index) => {
      const value = resolveGeoDimensionRowRawValue(item);
      const cityData = resolveGeoCityBreadcrumbData(
        value,
        locale,
        messages.common.unknown,
      );
      return {
        key: item.key ?? `${cityData.displayLabel}-${index}`,
        label: cityData.displayLabel,
        rawLabel: value.trim() || cityData.filterValue,
        views: Math.max(0, Number(item.views ?? 0)),
        visitors: Math.max(0, Number(item.visitors ?? 0)),
        reference: item.reference,
        change: item.change,
        mono: false,
        iconName: null,
        filterValue: cityData.filterValue,
        cityBreadcrumb: cityData.breadcrumb ?? undefined,
      };
    });
  }

  return items.map((item, index) => {
    const originalValue = String(item.label ?? "");
    const rawLabel = normalizeDimensionLabel(
      originalValue,
      messages.common.unknown,
    );
    let label = rawLabel;
    let iconName: string | null = null;

    if (tab === "country") {
      const country = resolveCountryLabel(
        rawLabel,
        locale,
        messages.common.unknown,
      );
      label = country.label;
      const flagCode = resolveCountryFlagCode(country.code, locale);
      iconName = flagCode ? `flagpack:${flagCode.toLowerCase()}` : null;
    } else if (tab === "continent") {
      label = resolveContinentLabel(
        rawLabel,
        messages.common.unknown,
        messages.common.continentLabels,
      );
    } else if (tab === "timezone") {
      label = resolveTimezoneDisplayLabel({
        value: rawLabel,
        locale,
        unknownLabel: messages.common.unknown,
        timestampMs: timezoneReferenceTimestampMs,
        timezoneDeltaVsLocal: messages.geo.timezoneDeltaVsLocal,
      });
    }

    return {
      key: item.key ?? `${label}-${index}`,
      label,
      rawLabel: originalValue.trim() || rawLabel,
      views: Math.max(0, Number(item.views ?? 0)),
      visitors: Math.max(0, Number(item.visitors ?? 0)),
      reference: item.reference,
      change: item.change,
      mono: false,
      iconName,
      filterValue: originalValue.trim() || rawLabel,
    };
  });
}
