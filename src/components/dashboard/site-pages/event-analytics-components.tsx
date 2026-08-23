import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RemixiconComponentType } from "@remixicon/react";
import {
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiArrowUpSLine,
  RiCheckLine,
  RiDatabase2Line,
  RiExternalLinkLine,
  RiFileList3Line,
  RiFilter3Line,
  RiFilterOffLine,
  RiPulseLine,
  RiSearchLine,
  RiStackLine,
} from "@remixicon/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { AnalyticsTableCard } from "@/components/dashboard/analytics-table-card";
import { AnimatedDataTableRow } from "@/components/dashboard/animated-data-table-row";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import {
  BrowserMeta,
  CountryRegionMeta,
  DeviceMeta,
  formatPath,
  formatRelativeTime,
  formatDuration,
  formatScreen,
  formatShortDateTime,
  OsMeta,
  ReferrerMeta,
  VisitorAvatar,
} from "@/components/dashboard/journey-display";
import { JsonTreePanel } from "@/components/dashboard/json-tree";
import { PageHeading } from "@/components/dashboard/page-heading";
import { DetailDrawer } from "@/components/dashboard/site-pages/detail-drawer";
import {
  EVENT_FILTER_DIALOG_Z_INDEX,
  EVENT_RECORD_DRAWER_Z_INDEX,
  NESTED_DETAIL_DRAWER_Z_INDEX,
} from "@/components/dashboard/site-pages/floating-layer";
import { useInfiniteTableSentinel } from "@/components/dashboard/use-infinite-table-sentinel";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { ModalOverlay, overlayZIndexFor } from "@/components/ui/modal-overlay";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildComplementaryOklchPalette } from "@/lib/dashboard/chart-colors";
import {
  fetchEventRecordDetail,
  fetchEventsRecords,
  fetchEventTypeFields,
  fetchEventTypeFieldValues,
} from "@/lib/dashboard/client-data";
import { appendEventPayloadFilter } from "@/lib/dashboard/filter-state";
import {
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import dynamic from "@/lib/dynamic";
import type {
  EventField,
  EventFieldValueStat,
  EventRecord,
  EventRecordDetailData,
  EventsTrendData,
  EventTrendSeries,
} from "@/lib/edge-client";
import type { FilterDocument, FilterValue } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";

const EVENT_PAGE_SIZE = 50;
type EventPayloadFilterValue = FilterValue;
interface EventPayloadFilterRule {
  path: string;
  operator: "eq" | "neq";
  value: EventPayloadFilterValue;
}
const EVENT_SKELETON_ROWS = 8;
const OTHER_SERIES_KEY = "other";
const FIELD_TREE_CHILD_TRANSITION = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

const VisitorDetailClientPage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/visitor-detail-client-page").then(
      (module) => module.VisitorDetailClientPage,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    ),
  },
);

const SessionDetailClientPage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/session-detail-client-page").then(
      (module) => module.SessionDetailClientPage,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    ),
  },
);

type SortDirection = "asc" | "desc";
export type EventRecordSortKey = "occurredAt" | "eventName" | "pathname";

export interface EventRecordSortState {
  key: EventRecordSortKey;
  direction: SortDirection;
}

export type EventPageCopy = AppMessages["events"];

export const DEFAULT_EVENT_RECORD_SORT: EventRecordSortState = {
  key: "occurredAt",
  direction: "desc",
};

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 9)}...`;
}

function normalizeEventFieldPath(path: string): string {
  const normalized = String(path ?? "").trim();
  if (!normalized || normalized === "/") return "";
  return normalized.startsWith("/")
    ? normalized.replace(/\/+/g, "/")
    : `/${normalized.replace(/^\/+/, "")}`;
}

function eventFieldKey(field: Pick<EventField, "path" | "valueType">): string {
  return `${field.valueType}\u0000${normalizeEventFieldPath(field.path)}`;
}

function eventFieldValueKey(value: EventFieldValueStat["value"]): string {
  return JSON.stringify(value);
}

function formatFieldValueLabel(value: EventFieldValueStat["value"]): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 0 ? value : '""';
  return String(value);
}

function payloadFilterValueType(
  value: EventPayloadFilterValue,
): "string" | "number" | "boolean" | "null" {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function payloadFilterValuesEqual(
  left: EventPayloadFilterValue,
  right: EventPayloadFilterValue,
): boolean {
  if (typeof left === "number" || typeof right === "number") {
    return Number(left) === Number(right);
  }
  return left === right;
}

function normalizePayloadFilterInputPath(path: string): string {
  const normalized = path.trim().slice(0, 240);
  if (!normalized || normalized === "/") return "";
  if (normalized.startsWith("/")) return normalizeEventFieldPath(normalized);
  return normalizeEventFieldPath(
    normalized
      .replace(/^\$\.?/, "")
      .replace(/\[(?:\d+|\*)\]/g, ".*")
      .split(".")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join("/"),
  );
}

function formatPayloadFilterPathForInput(path: string): string {
  const normalized = normalizeEventFieldPath(path);
  if (!normalized) return "";
  return normalized.slice(1).split("/").filter(Boolean).join(".");
}

function formatPayloadFilterValueForInput(
  value: EventPayloadFilterValue,
): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function formatPayloadFilterRules(rules: EventPayloadFilterRule[]): string {
  return rules
    .map(
      (rule) =>
        `${formatPayloadFilterPathForInput(rule.path)} ${
          rule.operator === "neq" ? "!=" : "=="
        } ${formatPayloadFilterValueForInput(rule.value)}`,
    )
    .join("\n");
}

function parsePayloadFilterValue(rawValue: string): EventPayloadFilterValue {
  const value = rawValue.trim();
  if (!value) throw new Error("Empty filter value");
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== "string") throw new Error("Invalid string value");
      return parsed;
    }
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  return value.slice(0, 240);
}

function parsePayloadFilterInput(
  input: string,
): { ok: true; rules: EventPayloadFilterRule[] } | { ok: false } {
  const conditions = input
    .split(/\n|&&/g)
    .map((condition) => condition.trim())
    .filter(Boolean);
  const rules: EventPayloadFilterRule[] = [];

  try {
    for (const condition of conditions) {
      const match = condition.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
      if (!match) return { ok: false };
      const path = normalizePayloadFilterInputPath(match[1] ?? "");
      if (!path) return { ok: false };
      const value = parsePayloadFilterValue(match[3] ?? "");
      rules.push({
        path,
        operator: match[2] === "!=" ? "neq" : "eq",
        value,
      });
    }
  } catch {
    return { ok: false };
  }

  return { ok: true, rules };
}

function isPayloadFilterActive(
  rules: EventPayloadFilterRule[],
  path: string,
  value: EventPayloadFilterValue,
): boolean {
  const normalizedPath = normalizeEventFieldPath(path);
  return rules.some(
    (rule) =>
      rule.operator === "eq" &&
      normalizeEventFieldPath(rule.path) === normalizedPath &&
      payloadFilterValueType(rule.value) === payloadFilterValueType(value) &&
      payloadFilterValuesEqual(rule.value, value),
  );
}

function PayloadFilterActiveCountBadge({ count }: { count: number }) {
  const hasCount = count > 0;
  return (
    <AutoResizer
      initial
      animateWidth
      animateHeight={false}
      className="inline-flex shrink-0 items-center"
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
        {hasCount ? (
          <span
            key={`payload-filter-count-${count}`}
            className="inline-flex min-w-5 items-center justify-center rounded-full border border-primary/40 bg-primary/15 px-1.5 text-[11px] leading-4 font-semibold text-primary"
          >
            {count}
          </span>
        ) : (
          <span
            key="payload-filter-count-empty"
            className="inline-flex w-0 overflow-hidden"
            aria-hidden
          />
        )}
      </AutoTransition>
    </AutoResizer>
  );
}

function PayloadFilterButton({
  labels,
  count,
  onClick,
}: {
  labels: EventPageCopy;
  count: number;
  onClick: () => void;
}) {
  const hasActiveFilters = count > 0;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "gap-2 transition-colors",
        hasActiveFilters &&
          "!border-primary/60 !bg-primary/10 !text-primary hover:!bg-primary/15 hover:!text-primary aria-expanded:!bg-primary/15 dark:!border-primary/60 dark:!bg-primary/20 dark:hover:!bg-primary/25",
      )}
      style={
        hasActiveFilters
          ? {
              borderColor: "hsl(var(--primary) / 0.6)",
              backgroundColor: "hsl(var(--primary) / 0.12)",
              color: "hsl(var(--primary))",
            }
          : undefined
      }
      onClick={onClick}
    >
      <RiFilter3Line className="size-4" />
      {labels.payloadFilter}
      <PayloadFilterActiveCountBadge count={count} />
    </Button>
  );
}

interface EventFieldTreeNode {
  path: string;
  segment: string;
  fields: EventField[];
  children: EventFieldTreeNode[];
}

function createEventFieldTreeNode(
  path: string,
  segment: string,
): EventFieldTreeNode {
  return {
    path,
    segment,
    fields: [],
    children: [],
  };
}

function buildEventFieldTree(fields: EventField[]): EventFieldTreeNode {
  const root = createEventFieldTreeNode("", "");
  const childMaps = new Map<
    EventFieldTreeNode,
    Map<string, EventFieldTreeNode>
  >();

  const ensureChild = (
    parent: EventFieldTreeNode,
    segment: string,
    path: string,
  ): EventFieldTreeNode => {
    let childMap = childMaps.get(parent);
    if (!childMap) {
      childMap = new Map();
      childMaps.set(parent, childMap);
    }
    const existing = childMap.get(segment);
    if (existing) return existing;
    const child = createEventFieldTreeNode(path, segment);
    childMap.set(segment, child);
    parent.children.push(child);
    return child;
  };

  for (const field of fields) {
    const normalizedPath = normalizeEventFieldPath(field.path);
    if (!normalizedPath) {
      root.fields.push(field);
      continue;
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    let parent = root;
    let currentPath = "";
    for (const segment of segments) {
      currentPath = `${currentPath}/${segment}`;
      parent = ensureChild(parent, segment, currentPath);
    }
    parent.fields.push(field);
  }

  return root;
}

function collectEventFieldTreeExpansionKeys(
  node: EventFieldTreeNode,
  keys = new Set<string>(),
): Set<string> {
  if (node.children.length > 0 || node.path === "") {
    keys.add(node.path || "/");
  }
  for (const child of node.children) {
    collectEventFieldTreeExpansionKeys(child, keys);
  }
  return keys;
}

function formatEventFieldKeySegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function tickDateFormat(
  localeCode: string,
  interval: TimeWindow["interval"],
  timeZone: string,
): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "month") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      year: "numeric",
      month: "short",
    });
  }
  return new Intl.DateTimeFormat(localeCode, {
    timeZone,
    month: "short",
    day: "numeric",
  });
}

function tooltipDateFormat(
  localeCode: string,
  interval: TimeWindow["interval"],
  timeZone: string,
): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "month") {
    return new Intl.DateTimeFormat(localeCode, {
      timeZone,
      year: "numeric",
      month: "long",
    });
  }
  return new Intl.DateTimeFormat(localeCode, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function eventSeriesLabel(series: EventTrendSeries, labels: EventPageCopy) {
  return series.isOther ? labels.other : series.label || series.eventName;
}

function EventMetricCell({
  icon: Icon,
  label,
  value,
  detail,
  loading = false,
}: {
  icon: RemixiconComponentType;
  label: string;
  value: string;
  detail: string;
  loading?: boolean;
}) {
  const contentKey = loading ? "loading" : value;

  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-[11px]" />
        </span>
        <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
          {label}
        </p>
      </div>
      <AutoResizer initial className="mt-3">
        <AutoTransition
          transitionKey={contentKey}
          initial={false}
          duration={0.2}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <div key="loading" className="flex h-7 items-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <p
              key={value}
              className="min-w-0 truncate font-mono text-xl leading-7 font-semibold text-foreground"
            >
              {value}
            </p>
          )}
        </AutoTransition>
      </AutoResizer>
      <p className="mt-3 min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

export function EventMetricGrid({
  locale,
  labels,
  summary,
  includeShare,
  loading = false,
}: {
  locale: Locale;
  labels: EventPageCopy;
  summary: {
    events: number;
    eventTypes: number;
    sessions: number;
    visitors: number;
    avgEventsPerSession: number;
    shareOfAllEvents?: number;
  };
  includeShare?: boolean;
  loading?: boolean;
}) {
  const average = numberFormat(
    locale,
    Number(summary.avgEventsPerSession || 0),
  );
  const share =
    includeShare && summary.shareOfAllEvents !== undefined
      ? percentFormat(locale, summary.shareOfAllEvents)
      : null;

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
          <EventMetricCell
            icon={RiPulseLine}
            label={labels.totalEvents}
            loading={loading}
            value={numberFormat(locale, summary.events)}
            detail={
              share
                ? `${labels.shareOfAllEvents}: ${share}`
                : labels.detailSubtitle
            }
          />
          <EventMetricCell
            icon={RiStackLine}
            label={labels.eventTypes}
            loading={loading}
            value={numberFormat(locale, summary.eventTypes)}
            detail={labels.breakdownTitle}
          />
          <EventMetricCell
            icon={RiFileList3Line}
            label={labels.sessions}
            loading={loading}
            value={numberFormat(locale, summary.sessions)}
            detail={`${labels.avgEventsPerSession}: ${average}`}
          />
          <EventMetricCell
            icon={RiDatabase2Line}
            label={labels.visitors}
            loading={loading}
            value={numberFormat(locale, summary.visitors)}
            detail={labels.recordsTitle}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function EventTrendStackedBarCard({
  locale,
  labels,
  trend,
  window: timeWindow,
  title,
  loading,
  onSelectEvent,
}: {
  locale: Locale;
  labels: EventPageCopy;
  trend:
    | EventsTrendData
    | { series: EventTrendSeries[]; data: EventsTrendData["data"] };
  window: TimeWindow;
  title: string;
  loading?: boolean;
  onSelectEvent?: (eventName: string) => void;
}) {
  const localeCode = intlLocale(locale);
  const axisTickFormatter = useMemo(
    () => tickDateFormat(localeCode, timeWindow.interval, timeWindow.timeZone),
    [localeCode, timeWindow.interval, timeWindow.timeZone],
  );
  const tooltipFormatter = useMemo(
    () =>
      tooltipDateFormat(localeCode, timeWindow.interval, timeWindow.timeZone),
    [localeCode, timeWindow.interval, timeWindow.timeZone],
  );
  const series = useMemo(() => {
    const palette = buildComplementaryOklchPalette(
      trend.series.filter((item) => !item.isOther).length,
    );
    let paletteIndex = 0;

    return trend.series.map((item) => {
      if (item.isOther) {
        return {
          ...item,
          displayLabel: eventSeriesLabel(item, labels),
          color: "var(--muted-foreground)",
        };
      }

      const color =
        palette[paletteIndex] ?? palette[palette.length - 1] ?? "#2dd4bf";
      paletteIndex += 1;

      return {
        ...item,
        displayLabel: eventSeriesLabel(item, labels),
        color,
      };
    });
  }, [labels, trend.series]);
  const chartConfig = useMemo(
    () =>
      series.reduce((config, item) => {
        config[item.key] = {
          label: item.displayLabel,
          color: item.color,
        };
        return config;
      }, {} as ChartConfig),
    [series],
  );
  const chartData = useMemo(
    () =>
      trend.data.map((point) => {
        const row: Record<string, number> = {
          timestampMs: point.timestampMs,
          totalEvents: point.totalEvents,
        };
        for (const item of series) {
          row[item.key] = Number(point.eventsBySeries[item.key] ?? 0);
        }
        return row;
      }),
    [series, trend.data],
  );
  const hasContent = series.length > 0 && chartData.length > 0;

  const selectSeries = (item: EventTrendSeries) => {
    if (item.isOther || item.key === OTHER_SERIES_KEY) return;
    onSelectEvent?.(item.eventName);
  };

  return (
    <Card className="overflow-visible">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <CardTitle className="inline-flex items-center gap-2">
            <RiPulseLine className="size-4" />
            {title}
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            {series.map((item) => (
              <button
                key={item.key}
                type="button"
                disabled={item.isOther || !onSelectEvent}
                className={cn(
                  "inline-flex h-6 max-w-48 items-center gap-1.5 border px-2 text-xs transition-colors",
                  item.isOther || !onSelectEvent
                    ? "cursor-default text-muted-foreground"
                    : "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                )}
                title={item.displayLabel}
                onClick={() => selectSeries(item)}
              >
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: item.color }}
                />
                <span className="truncate">{item.displayLabel}</span>
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative min-h-[320px]">
          <AutoResizer initial>
            <AutoTransition
              transitionKey={
                loading && !hasContent
                  ? "loading"
                  : hasContent
                    ? "chart"
                    : "empty"
              }
              initial={false}
              duration={0.2}
              type="fade"
            >
              {loading && !hasContent ? (
                <div key="loading" className="space-y-4">
                  <Skeleton className="h-[280px] w-full" />
                  <div className="flex flex-wrap justify-center gap-2">
                    {Array.from({ length: 5 }, (_, index) => (
                      <Skeleton key={index} className="h-5 w-20" />
                    ))}
                  </div>
                </div>
              ) : !hasContent ? (
                <div
                  key="empty"
                  className="flex h-[320px] items-center justify-center text-muted-foreground"
                >
                  {labels.empty}
                </div>
              ) : (
                <ChartContainer
                  key="chart"
                  className="h-[320px] w-full aspect-auto"
                  config={chartConfig}
                >
                  <BarChart
                    accessibilityLayer
                    data={chartData}
                    margin={{ left: 12, right: 12, top: 12 }}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="timestampMs"
                      tickFormatter={(value) =>
                        axisTickFormatter.format(new Date(Number(value ?? 0)))
                      }
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      minTickGap={12}
                    />
                    <YAxis
                      tickFormatter={(value) =>
                        numberFormat(locale, Number(value ?? 0))
                      }
                      tickLine={false}
                      axisLine={false}
                      width={48}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          className="min-w-[16rem]"
                          indicator="line"
                          labelFormatter={(value, payload) => {
                            const timestamp = Number(
                              payload?.[0]?.payload?.timestampMs ?? value ?? 0,
                            );
                            return tooltipFormatter.format(new Date(timestamp));
                          }}
                          formatter={(value, name, _item, _index, payload) => {
                            const row = payload as unknown as Record<
                              string,
                              number
                            >;
                            const seriesKey = String(name ?? "");
                            const numeric = Math.max(
                              0,
                              Number(row[seriesKey] ?? value ?? 0),
                            );
                            const currentSeries = series.find(
                              (item) => item.key === seriesKey,
                            );
                            return (
                              <div className="flex w-full items-center gap-3">
                                <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                  <span
                                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                                    style={{
                                      backgroundColor: currentSeries?.color,
                                    }}
                                  />
                                  <span
                                    className="truncate text-muted-foreground"
                                    title={
                                      currentSeries?.displayLabel ?? seriesKey
                                    }
                                  >
                                    {currentSeries?.displayLabel ?? seriesKey}
                                  </span>
                                </span>
                                <span className="ml-auto shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
                                  {numberFormat(locale, numeric)}
                                </span>
                              </div>
                            );
                          }}
                        />
                      }
                    />
                    {series.map((item) => (
                      <Bar
                        key={item.key}
                        dataKey={item.key}
                        stackId="events"
                        fill={`var(--color-${item.key})`}
                        radius={0}
                        isAnimationActive
                        onClick={() => selectSeries(item)}
                        className={cn(
                          item.isOther || !onSelectEvent
                            ? ""
                            : "cursor-pointer",
                        )}
                      />
                    ))}
                  </BarChart>
                </ChartContainer>
              )}
            </AutoTransition>
          </AutoResizer>

          <AutoTransition
            type="fade"
            duration={0.2}
            className="pointer-events-none absolute right-2 top-2"
          >
            {loading && hasContent ? (
              <span
                key="event-trend-loading"
                className="inline-flex items-center gap-2 border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
              >
                <Spinner className="size-3.5" />
                {labels.loading}
              </span>
            ) : (
              <div key="event-trend-idle" className="h-0 w-0 overflow-hidden" />
            )}
          </AutoTransition>
        </div>
      </CardContent>
    </Card>
  );
}

function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: SortDirection;
}) {
  if (active) {
    return direction === "desc" ? (
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
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <TableHead
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={onClick}
      >
        {label}
        <SortIndicator active={active} direction={direction} />
      </button>
    </TableHead>
  );
}

function EventRowSkeleton({
  index,
  sentinelRef,
}: {
  index: number;
  sentinelRef?: (node: HTMLTableRowElement | null) => void;
}) {
  const widths = [
    "w-24",
    "w-28",
    "w-24",
    "w-28",
    "w-32",
    "w-40",
    "w-24",
    "w-28",
    "w-24",
    "w-24",
    "w-20",
  ];
  return (
    <TableRow ref={sentinelRef} aria-hidden="true">
      {widths.map((width, cellIndex) => (
        <TableCell
          key={`${index}-${cellIndex}`}
          className={cellIndex === 0 ? "pl-4" : undefined}
        >
          <Skeleton className={cn("h-4", width)} />
        </TableCell>
      ))}
    </TableRow>
  );
}

function appendUniqueEvents(
  current: EventRecord[],
  incoming: EventRecord[],
): EventRecord[] {
  if (current.length === 0) return incoming;
  const seen = new Set(current.map((row) => row.eventId));
  const nextRows = incoming.filter((row) => !seen.has(row.eventId));
  return nextRows.length > 0 ? [...current, ...nextRows] : current;
}

function EventRecordsTable({
  locale,
  messages,
  labels,
  rows,
  sort,
  onSort,
  onOpenRecord,
  loadingRows,
  loadingMore,
  error,
  appendError,
  hasMore,
  sentinelRef,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: EventPageCopy;
  rows: EventRecord[];
  sort: EventRecordSortState;
  onSort: (key: EventRecordSortKey) => void;
  onOpenRecord: (eventId: string) => void;
  loadingRows: boolean;
  loadingMore: boolean;
  error: boolean;
  appendError: boolean;
  hasMore: boolean;
  sentinelRef?: (node: HTMLTableRowElement | null) => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const handleKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    eventId: string,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpenRecord(eventId);
  };

  const bodyState = loadingRows
    ? "loading"
    : error
      ? "error"
      : rows.length === 0 && !hasMore
        ? "empty"
        : "rows";

  return (
    <AnalyticsTableCard minTableWidth="92rem">
      <Table className="min-w-[92rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">{labels.visitor}</TableHead>
            <SortHeader
              label={labels.eventName}
              active={sort.key === "eventName"}
              direction={sort.direction}
              onClick={() => onSort("eventName")}
            />
            <TableHead>{labels.eventId}</TableHead>
            <SortHeader
              label={labels.occurredAt}
              active={sort.key === "occurredAt"}
              direction={sort.direction}
              onClick={() => onSort("occurredAt")}
            />
            <SortHeader
              label={labels.page}
              active={sort.key === "pathname"}
              direction={sort.direction}
              onClick={() => onSort("pathname")}
            />
            <TableHead>{labels.referrer}</TableHead>
            <TableHead>{labels.location}</TableHead>
            <TableHead>{labels.os}</TableHead>
            <TableHead>{labels.browser}</TableHead>
            <TableHead>{labels.device}</TableHead>
            <TableHead className="pr-4 text-right">{labels.payload}</TableHead>
          </TableRow>
        </TableHeader>
        <AutoTransition
          as="tbody"
          transitionKey={bodyState}
          initial={false}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          aria-busy={loadingRows || loadingMore}
          data-slot="table-body"
          className="[&_tr:last-child]:border-0"
        >
          {loadingRows ? (
            Array.from({ length: EVENT_SKELETON_ROWS }, (_, index) => (
              <EventRowSkeleton key={index} index={index} />
            ))
          ) : error ? (
            <TableRow>
              <TableCell
                colSpan={11}
                className="h-28 text-center text-muted-foreground"
              >
                {labels.loadError}
              </TableCell>
            </TableRow>
          ) : rows.length === 0 && !hasMore ? (
            <TableRow>
              <TableCell
                colSpan={11}
                className="h-28 text-center text-muted-foreground"
              >
                {labels.empty}
              </TableCell>
            </TableRow>
          ) : (
            <>
              {rows.map((row) => (
                <TableRow
                  key={row.eventId}
                  role="button"
                  tabIndex={0}
                  className="group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                  onClick={() => onOpenRecord(row.eventId)}
                  onKeyDown={(event) => handleKeyDown(event, row.eventId)}
                >
                  <TableCell className="max-w-36 pl-4">
                    <div className="flex w-28 min-w-0 items-center gap-2">
                      <VisitorAvatar
                        seed={row.visitorId || row.eventId}
                        className="size-6"
                      />
                      <span className="min-w-0 truncate font-mono">
                        {shortId(row.visitorId || row.sessionId || row.visitId)}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-48">
                    <span
                      className="block truncate font-medium"
                      title={row.eventName}
                    >
                      {row.eventName}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-32">
                    <span className="block truncate font-mono text-muted-foreground">
                      {shortId(row.eventId)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-36 font-mono text-muted-foreground">
                    <span className="block truncate">
                      {formatRelativeTime(locale, row.occurredAt, now)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-64">
                    <span
                      className="block truncate font-mono"
                      title={formatPath(row.pathname)}
                    >
                      {formatPath(row.pathname)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-44">
                    <ReferrerMeta
                      referrerHost={row.referrerHost || ""}
                      directLabel={messages.overview.direct}
                      className="w-full"
                    />
                  </TableCell>
                  <TableCell className="max-w-52">
                    <CountryRegionMeta
                      locale={locale}
                      messages={messages}
                      country={row.country || ""}
                      region={row.region}
                      className="w-full"
                    />
                  </TableCell>
                  <TableCell className="max-w-40">
                    <OsMeta
                      os={row.os || ""}
                      version={row.osVersion}
                      unknownLabel={messages.common.unknown}
                      className="w-full"
                    />
                  </TableCell>
                  <TableCell className="max-w-40">
                    <BrowserMeta
                      browser={row.browser || ""}
                      version={row.browserVersion}
                      unknownLabel={messages.common.unknown}
                      className="w-full"
                    />
                  </TableCell>
                  <TableCell className="max-w-36">
                    <DeviceMeta
                      deviceType={row.deviceType || ""}
                      deviceLabels={messages.common.deviceLabels}
                      unknownLabel={messages.common.unknown}
                      className="w-full"
                    />
                  </TableCell>
                  <TableCell className="pr-4 text-right font-mono tabular-nums">
                    {numberFormat(locale, row.valueCount)}
                  </TableCell>
                </TableRow>
              ))}
              {appendError ? (
                <TableRow>
                  <TableCell
                    colSpan={11}
                    className="h-16 text-center text-muted-foreground"
                  >
                    {labels.loadError}
                  </TableCell>
                </TableRow>
              ) : hasMore ? (
                Array.from({ length: EVENT_SKELETON_ROWS }, (_, index) => (
                  <EventRowSkeleton
                    key={`append-${rows.length}-${index}`}
                    index={index}
                    sentinelRef={index === 0 ? sentinelRef : undefined}
                  />
                ))
              ) : null}
            </>
          )}
        </AutoTransition>
      </Table>
    </AnalyticsTableCard>
  );
}

function DetailItem({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("space-y-1", wide && "sm:col-span-2")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{value}</dd>
    </div>
  );
}

function isInsideDetailDrawer(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest("[data-detail-drawer-root]") !== null
  );
}

function formatEventDetailDateTime(
  locale: Locale,
  value: number | null | undefined,
  unknownLabel: string,
): string {
  return typeof value === "number" && value > 0
    ? formatShortDateTime(locale, value, undefined)
    : unknownLabel;
}

function formatEventDetailBoolean(
  value: boolean | undefined,
  messages: AppMessages,
): string {
  if (value === undefined) return messages.common.unknown;
  return value ? messages.sessionDetail.yes : messages.sessionDetail.no;
}

function formatEventDetailStatus(
  value: string | undefined,
  messages: AppMessages,
): string {
  const key = value?.trim() as keyof AppMessages["realtime"]["statusLabels"];
  return key && messages.realtime.statusLabels[key]
    ? messages.realtime.statusLabels[key]
    : messages.common.unknown;
}

function formatEventDetailText(value: string | null | undefined, unknownLabel: string) {
  const normalized = value?.trim() || "";
  return normalized || unknownLabel;
}

function formatEventDetailScreen(
  width: number | null | undefined,
  height: number | null | undefined,
  unknownLabel: string,
): string {
  const screen = formatScreen(width, height);
  return screen === "/" ? unknownLabel : screen;
}

function formatEventDetailPerformance(
  locale: Locale,
  value: number | null | undefined,
  metric: "ttfb" | "fcp" | "lcp" | "cls" | "inp",
  unknownLabel: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return unknownLabel;
  }
  const formatted = numberFormat(locale, value);
  return metric === "cls" ? formatted : `${formatted} ms`;
}

type EventRecordNestedDetail = {
  kind: "visitor" | "session";
  id: string;
  stackKey: string;
};

export function EventRecordDetailDrawer({
  locale,
  messages,
  labels,
  siteId,
  pathname,
  open,
  onOpenChange,
  detail,
  loading,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: EventPageCopy;
  siteId: string;
  pathname: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: EventRecordDetailData["data"] | null;
  loading: boolean;
}) {
  const [nestedDetails, setNestedDetails] = useState<EventRecordNestedDetail[]>(
    [],
  );
  const nestedDetailKeyRef = useRef(0);
  const basePath = pathname.replace(/\/events(?:\/detail)?$/, "");
  const visitorId = detail?.context.visitorId?.trim() || "";
  const sessionId = detail?.context.sessionId?.trim() || "";
  const visitorPathname = `${basePath}/visitors`;
  const sessionPathname = `${basePath}/sessions`;
  const nestedDetailOpen = nestedDetails.length > 0;

  useEffect(() => {
    if (!open) setNestedDetails([]);
  }, [open]);

  const openNestedDetail = (kind: "visitor" | "session", id: string) => {
    const normalizedId = id.trim();
    if (!normalizedId) return;

    setNestedDetails((current) => {
      const topDetail = current.at(-1);
      if (topDetail?.kind === kind && topDetail.id === normalizedId) {
        return current;
      }

      nestedDetailKeyRef.current += 1;
      return [
        ...current,
        {
          kind,
          id: normalizedId,
          stackKey: `${kind}:${normalizedId}:${nestedDetailKeyRef.current}`,
        },
      ];
    });
  };

  const closeNestedDetail = (stackKey: string) => {
    setNestedDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      if (index < 0) return current;
      return current.slice(0, index);
    });
  };

  const openVisitorDetail = (nextVisitorId: string) => {
    openNestedDetail("visitor", nextVisitorId);
  };

  const openSessionDetail = (nextSessionId: string) => {
    openNestedDetail("session", nextSessionId);
  };

  const stopSideDrawerOverlayEvent = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
  };

  const closeSideDrawerFromOverlay = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    stopSideDrawerOverlayEvent(event);
    if (!nestedDetailOpen) onOpenChange(false);
  };

  return (
    <>
      <ModalOverlay
        data-event-record-drawer-overlay=""
        layerId="event-record-drawer"
        open={open}
        portal
        zIndex={overlayZIndexFor(EVENT_RECORD_DRAWER_Z_INDEX)}
        onPointerDown={stopSideDrawerOverlayEvent}
        onPointerUp={stopSideDrawerOverlayEvent}
        onClick={closeSideDrawerFromOverlay}
      />
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        direction="right"
        modal={false}
      >
        <DrawerContent
          data-dashboard-floating-layer="event-record-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
          style={{ zIndex: EVENT_RECORD_DRAWER_Z_INDEX }}
          onEscapeKeyDown={(event) => {
            if (nestedDetailOpen) event.preventDefault();
          }}
          onFocusOutside={(event) => {
            if (isInsideDetailDrawer(event.detail.originalEvent.target)) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (isInsideDetailDrawer(event.detail.originalEvent.target)) {
              event.preventDefault();
            }
          }}
          onPointerDownOutside={(event) => {
            if (isInsideDetailDrawer(event.detail.originalEvent.target)) {
              event.preventDefault();
            }
          }}
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{labels.detailTitle}</DrawerTitle>
            <DrawerDescription>
              {detail?.event.eventName || labels.detailSubtitle}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            {loading ? (
              <div className="space-y-4">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : !detail ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {labels.empty}
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{labels.detailTitle}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={labels.eventId}
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {detail.event.eventId}
                        </span>
                      }
                    />
                    <DetailItem
                      label={labels.eventName}
                      value={
                        <span className="break-words text-[11px]">
                          {detail.event.eventName || messages.common.unknown}
                        </span>
                      }
                    />
                    <DetailItem
                      label={labels.occurredAt}
                      value={formatShortDateTime(
                        locale,
                        detail.event.occurredAt,
                        undefined,
                      )}
                    />
                    <DetailItem
                      label={labels.receivedAt}
                      value={formatShortDateTime(
                        locale,
                        detail.event.receivedAt,
                        undefined,
                      )}
                    />
                    <DetailItem
                      label={labels.payloadFields}
                      value={
                        <span className="text-[11px]">
                          {numberFormat(locale, detail.event.nodeCount)}{" "}
                          {labels.nodes} / {numberFormat(locale, detail.event.valueCount)}{" "}
                          {labels.values}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{labels.payload}</h3>
                  <JsonTreePanel value={detail.eventData} labels={labels} />
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.realtime.browsingSection}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={messages.common.title}
                      value={
                        <span className="break-words text-[11px]">
                          {detail.context.title || messages.common.unknown}
                        </span>
                      }
                    />
                    <DetailItem
                      label={messages.common.hostname}
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {detail.context.hostname || messages.common.unknown}
                        </span>
                      }
                    />
                    <DetailItem
                      label={messages.common.path}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatPath(detail.context.pathname)}
                        </span>
                      }
                    />
                    <DetailItem
                      label={messages.realtime.queryString}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.queryString,
                            messages.common.unknown,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      label={messages.pages.hashTab}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.hash,
                            messages.common.unknown,
                          )}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.navigation.visitors}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={messages.realtime.visitorId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {visitorId || messages.common.unknown}
                        </span>
                      }
                    />
                    {detail.context.userName?.trim() ? (
                      <DetailItem
                        label={messages.realtime.userName}
                        value={
                          <span className="break-words text-[11px]">
                            {detail.context.userName}
                          </span>
                        }
                      />
                    ) : null}
                    {detail.context.userId?.trim() ? (
                      <DetailItem
                        label={messages.realtime.userId}
                        value={
                          <span className="break-all font-mono text-[11px]">
                            {detail.context.userId}
                          </span>
                        }
                      />
                    ) : null}
                    <DetailItem
                      label={labels.browser}
                      value={
                        <BrowserMeta
                          browser={detail.context.browser || ""}
                          version={detail.context.browserVersion}
                          unknownLabel={messages.common.unknown}
                        />
                      }
                    />
                    <DetailItem
                      label={labels.os}
                      value={
                        <OsMeta
                          os={detail.context.os || ""}
                          version={detail.context.osVersion}
                          unknownLabel={messages.common.unknown}
                        />
                      }
                    />
                    <DetailItem
                      label={labels.device}
                      value={
                        <DeviceMeta
                          deviceType={detail.context.deviceType || ""}
                          deviceLabels={messages.common.deviceLabels}
                          unknownLabel={messages.common.unknown}
                        />
                      }
                    />
                    <DetailItem
                      label={messages.realtime.userAgent}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.userAgent,
                            messages.common.unknown,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      label={messages.realtime.isEU}
                      value={formatEventDetailBoolean(detail.context.isEU, messages)}
                    />
                    <DetailItem
                      label={messages.common.screenSize}
                      value={formatEventDetailScreen(
                        detail.context.screenWidth,
                        detail.context.screenHeight,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.common.language}
                      value={formatEventDetailText(
                        detail.context.language,
                        messages.common.unknown,
                      )}
                    />
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={!visitorId}
                      onClick={() => openVisitorDetail(visitorId)}
                    >
                      <RiExternalLinkLine data-icon="inline-start" />
                      {labels.openVisitor}
                    </Button>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.navigation.sessions}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={messages.realtime.sessionId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {sessionId || messages.common.unknown}
                        </span>
                      }
                    />
                    <DetailItem
                      label={messages.realtime.visitId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {detail.context.visitId || messages.common.unknown}
                        </span>
                      }
                    />
                    <DetailItem
                      label={messages.realtime.status}
                      value={formatEventDetailStatus(detail.context.status, messages)}
                    />
                    <DetailItem
                      label={messages.realtime.startedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.context.startedAt,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.previousVisitStartedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.context.previousVisitStartedAt,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.endedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.context.endedAt,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.duration}
                      value={
                        detail.context.durationMs === null ||
                        detail.context.durationMs === undefined
                          ? messages.common.unknown
                          : formatDuration(locale, detail.context.durationMs)
                      }
                    />
                    <DetailItem
                      label={messages.realtime.durationSource}
                      value={formatEventDetailText(
                        detail.context.durationSource,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.exitReason}
                      value={formatEventDetailText(
                        detail.context.exitReason,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.common.organization}
                      wide
                      value={formatEventDetailText(
                        detail.context.organization,
                        messages.common.unknown,
                      )}
                    />
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={!sessionId}
                      onClick={() => openSessionDetail(sessionId)}
                    >
                      <RiExternalLinkLine data-icon="inline-start" />
                      {labels.openSession}
                    </Button>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.realtime.geographySection}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={labels.location}
                      value={
                        <CountryRegionMeta
                          locale={locale}
                          messages={messages}
                          country={detail.context.country || ""}
                          region={detail.context.region}
                        />
                      }
                    />
                    <DetailItem
                      label={messages.common.regionCode}
                      value={formatEventDetailText(
                        detail.context.regionCode,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.common.city}
                      value={formatEventDetailText(
                        detail.context.city,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.common.continent}
                      value={formatEventDetailText(
                        detail.context.continent,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.common.timezone}
                      value={formatEventDetailText(
                        detail.context.timezone,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.postalCode}
                      value={formatEventDetailText(
                        detail.context.postalCode,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.metroCode}
                      value={formatEventDetailText(
                        detail.context.metroCode,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.common.latitude}
                      value={
                        detail.context.latitude === null ||
                        detail.context.latitude === undefined
                          ? messages.common.unknown
                          : numberFormat(locale, detail.context.latitude)
                      }
                    />
                    <DetailItem
                      label={messages.common.longitude}
                      value={
                        detail.context.longitude === null ||
                        detail.context.longitude === undefined
                          ? messages.common.unknown
                          : numberFormat(locale, detail.context.longitude)
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.realtime.sourceSection}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={labels.referrer}
                      value={
                        <ReferrerMeta
                          referrerHost={detail.context.referrerHost || ""}
                          referrerUrl={detail.context.referrerUrl}
                          directLabel={messages.overview.direct}
                        />
                      }
                    />
                    <DetailItem
                      label={messages.sessionDetail.referrerUrl}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.referrerUrl,
                            messages.common.unknown,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      label={messages.realtime.utmSource}
                      value={formatEventDetailText(
                        detail.context.utmSource,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.utmMedium}
                      value={formatEventDetailText(
                        detail.context.utmMedium,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.utmCampaign}
                      value={formatEventDetailText(
                        detail.context.utmCampaign,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.utmTerm}
                      value={formatEventDetailText(
                        detail.context.utmTerm,
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.realtime.utmContent}
                      value={formatEventDetailText(
                        detail.context.utmContent,
                        messages.common.unknown,
                      )}
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.sessionDetail.performanceTitle}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      label={messages.performance.ttfb}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.ttfb,
                        "ttfb",
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.performance.fcp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.fcp,
                        "fcp",
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.performance.lcp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.lcp,
                        "lcp",
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.performance.cls}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.cls,
                        "cls",
                        messages.common.unknown,
                      )}
                    />
                    <DetailItem
                      label={messages.performance.inp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.inp,
                        "inp",
                        messages.common.unknown,
                      )}
                    />
                  </dl>
                </section>
              </div>
            )}
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>

      {nestedDetails.map((nestedDetail) => (
        <DetailDrawer
          key={nestedDetail.stackKey}
          ariaLabel={
            nestedDetail.kind === "visitor"
              ? messages.visitors.title
              : messages.sessionDetail.visitDetailsTitle
          }
          drawerKey={nestedDetail.stackKey}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closeNestedDetail(nestedDetail.stackKey);
          }}
          zIndex={NESTED_DETAIL_DRAWER_Z_INDEX}
        >
          {nestedDetail.kind === "visitor" ? (
            <VisitorDetailClientPage
              locale={locale}
              messages={messages}
              siteId={siteId}
              pathname={visitorPathname}
              visitorId={nestedDetail.id}
              onOpenSession={openSessionDetail}
            />
          ) : (
            <SessionDetailClientPage
              locale={locale}
              messages={messages}
              siteId={siteId}
              pathname={sessionPathname}
              sessionId={nestedDetail.id}
              onOpenVisitor={openVisitorDetail}
            />
          )}
        </DetailDrawer>
      ))}
    </>
  );
}

export function EventRecordsSection({
  locale,
  messages,
  labels,
  siteId,
  pathname,
  window: timeWindow,
  filters,
  eventName,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: EventPageCopy;
  siteId: string;
  pathname: string;
  window: TimeWindow;
  filters: FilterDocument;
  eventName?: string;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<EventRecordSortState>(
    DEFAULT_EVENT_RECORD_SORT,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState("");
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  const {
    data,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetching,
    isFetchingNextPage,
    isPending,
  } = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "event-records",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      filtersKey,
      debouncedQuery,
      sort.key,
      sort.direction,
      eventName ?? "",
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchEventsRecords(siteId, timeWindow, filters, {
        cursor: pageParam,
        pageSize: EVENT_PAGE_SIZE,
        sortBy: sort.key,
        sortDir: sort.direction,
        search: debouncedQuery,
        eventName,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasMore ? lastPage.meta.nextCursor : undefined,
    enabled: typeof window !== "undefined",
  });
  const rows = useMemo(
    () =>
      data?.pages.reduce<EventRecord[]>(
        (current, page) => appendUniqueEvents(current, page.data),
        [],
      ) ?? [],
    [data?.pages],
  );
  const loadingInitial = isPending;
  const loadingMore = isFetchingNextPage;
  const error = Boolean(queryError) && rows.length === 0;
  const appendError = isFetchNextPageError;
  const replacingRows = isPending || (isFetching && !isFetchingNextPage);
  const hasMore = hasNextPage ?? false;
  const loadNextPage = () => {
    if (loadingInitial || loadingMore || appendError || !hasMore) return;
    void fetchNextPage();
  };

  const sentinelRef = useInfiniteTableSentinel({
    enabled:
      !loadingInitial && !loadingMore && !appendError && !error && hasMore,
    onReachEnd: loadNextPage,
  });

  const detailQuery = useQuery({
    queryKey: [
      "dashboard",
      "event-record-detail",
      siteId,
      selectedEventId,
      timeWindow.from,
      timeWindow.to,
    ],
    queryFn: ({ signal }) =>
      fetchEventRecordDetail(siteId, selectedEventId, timeWindow, { signal }),
    enabled:
      typeof window !== "undefined" && drawerOpen && Boolean(selectedEventId),
  });
  const detail = detailQuery.data?.data ?? null;
  const detailLoading = detailQuery.isPending;

  const toggleSort = (key: EventRecordSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" },
    );
  };

  const openRecord = (eventId: string) => {
    setSelectedEventId(eventId);
    setDrawerOpen(true);
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="inline-flex items-center gap-2 text-sm font-medium">
            <RiFileList3Line className="size-4 shrink-0" />
            {labels.recordsTitle}
          </h2>
        </div>
        <div className="relative w-full sm:max-w-xs">
          <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.search}
            className="pl-8"
          />
        </div>
      </div>

      <EventRecordsTable
        locale={locale}
        messages={messages}
        labels={labels}
        rows={rows}
        sort={sort}
        onSort={toggleSort}
        onOpenRecord={openRecord}
        loadingRows={replacingRows}
        loadingMore={loadingMore}
        error={error}
        appendError={appendError}
        hasMore={hasMore}
        sentinelRef={sentinelRef}
      />

      <EventRecordDetailDrawer
        locale={locale}
        messages={messages}
        labels={labels}
        siteId={siteId}
        pathname={pathname}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        detail={detail}
        loading={detailLoading}
      />
    </section>
  );
}

export function EventFieldsCard({
  locale,
  labels,
  siteId,
  window: timeWindow,
  filters,
  eventName,
  loading,
  fields,
}: {
  locale: Locale;
  labels: EventPageCopy;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  eventName: string;
  loading: boolean;
  fields: EventField[];
}) {
  const fieldsSectionRef = useRef<HTMLElement | null>(null);
  const [fieldsVisible, setFieldsVisible] = useState(false);
  const reduceDataRowMotion = useReducedMotion() ?? false;
  const [payloadFilters, setPayloadFilters] = useState<
    EventPayloadFilterRule[]
  >([]);
  const [payloadFilterDialogOpen, setPayloadFilterDialogOpen] = useState(false);
  const [payloadFilterDraft, setPayloadFilterDraft] = useState("");
  const [payloadFilterError, setPayloadFilterError] = useState("");
  const payloadFiltersKey = useMemo(
    () => JSON.stringify(payloadFilters),
    [payloadFilters],
  );
  const activePayloadFilterCount = payloadFilters.length;
  const effectiveFilters = useMemo<FilterDocument>(() => {
    if (payloadFilters.length === 0) return filters;
    return payloadFilters.reduce(
      (document, rule) =>
        appendEventPayloadFilter(
          document,
          rule.path,
          rule.operator,
          rule.value,
        ),
      filters,
    );
  }, [filters, payloadFilters, payloadFiltersKey]);
  const effectiveFiltersKey = useMemo(
    () => JSON.stringify(effectiveFilters ?? {}),
    [effectiveFilters],
  );
  const baseFiltersKey = useMemo(
    () => JSON.stringify(filters ?? {}),
    [filters],
  );
  useEffect(() => {
    const section = fieldsSectionRef.current;
    if (!section) return;
    if (typeof IntersectionObserver === "undefined") {
      setFieldsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setFieldsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px", threshold: 0.01 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  const fieldsQuery = useQuery({
    queryKey: [
      "dashboard",
      "event-type-fields",
      siteId,
      eventName,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      baseFiltersKey,
    ],
    queryFn: ({ signal }) =>
      fetchEventTypeFields(siteId, timeWindow, eventName, filters, {
        signal,
      }),
    enabled: typeof window !== "undefined" && fieldsVisible && !loading,
  });
  const filteredFieldsQuery = useQuery({
    queryKey: [
      "dashboard",
      "event-filtered-fields",
      siteId,
      eventName,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      effectiveFiltersKey,
    ],
    queryFn: ({ signal }) =>
      fetchEventTypeFields(siteId, timeWindow, eventName, effectiveFilters, {
        signal,
      }),
    enabled:
      typeof window !== "undefined" &&
      fieldsVisible &&
      activePayloadFilterCount > 0 &&
      !loading,
  });
  const baseFields = fieldsQuery.data?.fields ?? fields;
  const filteredFields = filteredFieldsQuery.data?.fields ?? [];
  const filteredFieldsLoading = filteredFieldsQuery.isPending;
  const filteredFieldsError = filteredFieldsQuery.isError;
  const activeFields =
    activePayloadFilterCount > 0
      ? filteredFieldsLoading && filteredFields.length === 0
        ? baseFields
        : filteredFields
      : baseFields;
  const fieldListLoading =
    loading ||
    (fieldsVisible && fieldsQuery.isPending) ||
    (activePayloadFilterCount > 0 && filteredFieldsLoading);
  const fieldListError =
    fieldsQuery.isError ||
    (activePayloadFilterCount > 0 && filteredFieldsError);
  const fieldTree = useMemo(
    () => buildEventFieldTree(activeFields),
    [activeFields],
  );
  const defaultExpandedFieldKeys = useMemo(
    () => collectEventFieldTreeExpansionKeys(fieldTree),
    [fieldTree],
  );
  const preferredSelectedField = useMemo(() => {
    if (activeFields.length === 0) return null;
    return (
      activeFields.find(
        (field) =>
          field.valueType !== "object" &&
          field.valueType !== "array" &&
          normalizeEventFieldPath(field.path) !== "",
      ) ??
      activeFields.find(
        (field) => normalizeEventFieldPath(field.path) !== "",
      ) ??
      activeFields[0] ??
      null
    );
  }, [activeFields]);
  const fieldRequestKey = useMemo(
    () =>
      [
        siteId,
        eventName,
        timeWindow.from,
        timeWindow.to,
        timeWindow.interval,
        timeWindow.timeZone,
        effectiveFiltersKey,
      ].join(":"),
    [
      eventName,
      effectiveFiltersKey,
      siteId,
      timeWindow.from,
      timeWindow.interval,
      timeWindow.timeZone,
      timeWindow.to,
    ],
  );
  const [selectedFieldKey, setSelectedFieldKey] = useState("");
  const [expandedFieldKeys, setExpandedFieldKeys] = useState<Set<string>>(
    () => new Set(defaultExpandedFieldKeys),
  );

  const selectedField = useMemo(() => {
    if (activeFields.length === 0) return null;
    if (selectedFieldKey) {
      const match = activeFields.find(
        (field) => eventFieldKey(field) === selectedFieldKey,
      );
      if (match) return match;
    }
    return preferredSelectedField;
  }, [activeFields, preferredSelectedField, selectedFieldKey]);

  const selectedFieldResolvedKey = selectedField
    ? eventFieldKey(selectedField)
    : "";

  useEffect(() => {
    setExpandedFieldKeys(new Set(defaultExpandedFieldKeys));
  }, [defaultExpandedFieldKeys, fieldRequestKey]);

  const fieldValuesQuery = useQuery({
    queryKey: [
      "dashboard",
      "event-field-values",
      siteId,
      eventName,
      selectedField?.path ?? "",
      selectedField?.valueType ?? "",
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      effectiveFiltersKey,
    ],
    queryFn: ({ signal }) =>
      fetchEventTypeFieldValues(
        siteId,
        timeWindow,
        eventName,
        selectedField?.path ?? "",
        selectedField?.valueType ?? "string",
        effectiveFilters,
        { limit: 25, signal },
      ),
    enabled:
      typeof window !== "undefined" &&
      !fieldListLoading &&
      Boolean(selectedField),
  });
  const fieldValues = fieldValuesQuery.data?.data ?? [];
  const fieldValuesLoading = fieldValuesQuery.isPending;
  const fieldValuesError = fieldValuesQuery.isError;

  const fieldValueTotal = useMemo(
    () =>
      fieldValues.reduce(
        (sum, item) => sum + Math.max(0, Number(item.occurrences ?? 0)),
        0,
      ),
    [fieldValues],
  );

  const openPayloadFilterDialog = () => {
    setPayloadFilterDraft(formatPayloadFilterRules(payloadFilters));
    setPayloadFilterError("");
    setPayloadFilterDialogOpen(true);
  };

  const applyPayloadFilterDraft = () => {
    const parsed = parsePayloadFilterInput(payloadFilterDraft);
    if (!parsed.ok) {
      setPayloadFilterError(labels.payloadFilterInvalid);
      return;
    }
    setPayloadFilters(parsed.rules);
    setPayloadFilterError("");
    setPayloadFilterDialogOpen(false);
  };

  const clearPayloadFilters = () => {
    setPayloadFilterDraft("");
    setPayloadFilters([]);
    setPayloadFilterError("");
  };

  const applyFieldValueFilter = (
    field: EventField,
    value: EventPayloadFilterValue,
  ) => {
    const path = normalizeEventFieldPath(field.path);
    if (!path) return;
    setPayloadFilters((current) => {
      const hasSameValueFilter = current.some(
        (rule) =>
          rule.operator === "eq" &&
          normalizeEventFieldPath(rule.path) === path &&
          payloadFilterValueType(rule.value) ===
            payloadFilterValueType(value) &&
          payloadFilterValuesEqual(rule.value, value),
      );
      const withoutCurrentPath = current.filter(
        (rule) => normalizeEventFieldPath(rule.path) !== path,
      );
      if (hasSameValueFilter) return withoutCurrentPath;
      return [
        ...withoutCurrentPath,
        {
          path,
          operator: "eq",
          value,
        },
      ];
    });
  };

  const toggleFieldExpansion = (fieldKey: string) => {
    setExpandedFieldKeys((current) => {
      const next = new Set(current);
      if (next.has(fieldKey)) {
        next.delete(fieldKey);
      } else {
        next.add(fieldKey);
      }
      return next;
    });
  };

  const renderFieldTreeNode = (
    node: EventFieldTreeNode,
    depth: number,
  ): ReactNode => {
    const nodeKey = node.path || "/";
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedFieldKeys.has(nodeKey);
    const isRoot = node.path === "";
    const isArrayItem = node.segment === "*";
    const selectableField =
      node.fields.find(
        (field) =>
          eventFieldKey(field) === selectedFieldResolvedKey &&
          field.valueType !== "object" &&
          field.valueType !== "array",
      ) ??
      node.fields.find(
        (field) => field.valueType !== "object" && field.valueType !== "array",
      ) ??
      null;
    const selectableFieldKey = selectableField
      ? eventFieldKey(selectableField)
      : "";
    const isSelected =
      Boolean(selectableFieldKey) &&
      selectableFieldKey === selectedFieldResolvedKey;
    const indentStyle = { paddingLeft: `${depth * 1.25}rem` };
    const fieldLabel = isRoot
      ? labels.payload
      : isArrayItem
        ? "*"
        : formatEventFieldKeySegment(node.segment);
    const childRows = isExpanded
      ? node.children.map((child) => renderFieldTreeNode(child, depth + 1))
      : null;
    const selectField = () => {
      if (!selectableField || fieldListLoading) return;
      setSelectedFieldKey(selectableFieldKey);
    };
    const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (!selectableField || fieldListLoading) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectField();
    };

    const openLine = (
      <div
        key={`${nodeKey}:open`}
        role={selectableField ? "button" : undefined}
        tabIndex={selectableField && !fieldListLoading ? 0 : undefined}
        onClick={selectableField ? selectField : undefined}
        onKeyDown={selectableField ? handleRowKeyDown : undefined}
        className={cn(
          "group flex items-center gap-2 rounded px-1 py-1 transition-[background-color,box-shadow,filter] duration-200",
          selectableField &&
            "cursor-pointer hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
          isSelected && "bg-accent/25 ring-1 ring-border/70",
          fieldListLoading && "opacity-80",
        )}
        style={indentStyle}
      >
        {hasChildren ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 rounded-none text-primary shadow-none transition-colors hover:bg-primary/10 hover:text-primary"
            onClick={(event) => {
              event.stopPropagation();
              toggleFieldExpansion(nodeKey);
            }}
            disabled={fieldListLoading}
            aria-label={isExpanded ? labels.collapseField : labels.expandField}
            title={isExpanded ? labels.collapseField : labels.expandField}
          >
            <RiArrowDownSLine
              className={cn(
                "size-3.5 transition-transform duration-200 ease-out",
                isExpanded ? "rotate-0" : "-rotate-90",
              )}
            />
          </Button>
        ) : (
          <span className="size-6 shrink-0" />
        )}

        <div className="min-w-0 flex-1 truncate">
          <span
            className={cn(
              "text-foreground",
              isArrayItem && "text-muted-foreground",
            )}
          >
            {fieldLabel}
          </span>
        </div>

        {selectableField ? (
          <button
            type="button"
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
            )}
            onClick={(event) => {
              event.stopPropagation();
              selectField();
            }}
            disabled={fieldListLoading}
            aria-label={`${labels.fieldValuesTitle}: ${fieldLabel}`}
            title={labels.fieldValuesTitle}
          >
            <RiSearchLine className="size-3.5" />
          </button>
        ) : null}
      </div>
    );

    if (!hasChildren) return openLine;

    return (
      <div key={nodeKey} className="space-y-0.5">
        {openLine}
        <AutoResizer duration={0.22} ease={[0.22, 1, 0.36, 1]}>
          <AutoTransition
            initial={false}
            duration={0.18}
            customVariants={FIELD_TREE_CHILD_TRANSITION}
            presenceMode="sync"
            transitionKey={
              isExpanded ? `${nodeKey}:expanded` : `${nodeKey}:collapsed`
            }
          >
            {childRows ? <div className="space-y-0.5">{childRows}</div> : null}
          </AutoTransition>
        </AutoResizer>
      </div>
    );
  };

  const fieldValueTableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{labels.values}</div>
      </TableHead>
      <TableHead className="h-8 w-24 p-0">
        <div className="px-4 text-right">{labels.occurrences}</div>
      </TableHead>
    </TableRow>
  );

  const fieldValueRows = (
    <AnimatePresence initial={false} mode="popLayout">
      {fieldValues.map((item) => {
        const count = Math.max(0, Number(item.occurrences ?? 0));
        const progressPercent =
          fieldValueTotal > 0 ? (count / fieldValueTotal) * 100 : 0;
        const valueLabel = formatFieldValueLabel(item.value);
        const activeValueFilter =
          selectedField !== null &&
          isPayloadFilterActive(payloadFilters, selectedField.path, item.value);
        const selectValueFilter = () => {
          if (!selectedField || fieldListLoading) return;
          applyFieldValueFilter(selectedField, item.value);
        };
        const handleValueRowKeyDown = (
          event: KeyboardEvent<HTMLTableRowElement>,
        ) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          selectValueFilter();
        };

        return (
          <AnimatedDataTableRow
            key={eventFieldValueKey(item.value)}
            reduceMotion={reduceDataRowMotion}
            role="button"
            tabIndex={fieldListLoading ? undefined : 0}
            data-state={activeValueFilter ? "selected" : undefined}
            onClick={selectValueFilter}
            onKeyDown={handleValueRowKeyDown}
            className={cn(
              "cursor-pointer bg-no-repeat transition-[background-size,background-color,filter] duration-300 ease-out hover:bg-muted/30 hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
              activeValueFilter &&
                "bg-primary/10 hover:bg-primary/15 data-[state=selected]:bg-primary/10",
            )}
            style={{
              backgroundImage:
                "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
              backgroundSize: `${progressPercent.toFixed(2)}% 100%`,
              backgroundPosition: "left top",
            }}
          >
            <TableCell className="whitespace-normal p-0 align-top">
              <div
                className="px-4 py-2 font-mono leading-5 break-words whitespace-normal"
                title={valueLabel}
              >
                {valueLabel}
              </div>
            </TableCell>
            <TableCell className="p-0">
              <div className="px-4 py-2 text-right font-mono tabular-nums">
                {numberFormat(locale, count)}
              </div>
            </TableCell>
          </AnimatedDataTableRow>
        );
      })}
    </AnimatePresence>
  );

  return (
    <>
      <section ref={fieldsSectionRef} className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="inline-flex items-center gap-2 text-sm font-medium">
              <RiFileList3Line className="size-4 shrink-0" />
              {labels.fieldsTitle}
            </h2>
          </div>
          <PayloadFilterButton
            labels={labels}
            count={activePayloadFilterCount}
            onClick={openPayloadFilterDialog}
          />
        </div>

        <div className="grid items-stretch gap-6 xl:grid-cols-2">
          <Card className="h-full overflow-hidden py-0">
            <CardHeader className="space-y-2 pt-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="inline-flex items-center gap-2">
                    <RiDatabase2Line className="size-4" />
                    {labels.payloadFields}
                  </CardTitle>
                  {fieldListLoading ? <Spinner className="size-3.5" /> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {labels.fieldsSubtitle}
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 pb-5">
              <div className="max-h-[38rem] overflow-auto pr-1 font-mono text-[13px] leading-6">
                {fieldListLoading ? (
                  <div
                    className="flex min-h-32 items-center justify-center gap-2 border border-border/50 bg-muted/20 px-4 py-6 font-sans text-sm text-muted-foreground"
                    aria-busy="true"
                  >
                    <Spinner className="size-4" />
                    {labels.loading}
                  </div>
                ) : fieldListError ? (
                  <div className="rounded-none border border-border/50 bg-muted/20 px-4 py-6 font-sans text-sm text-muted-foreground">
                    {labels.loadError}
                  </div>
                ) : activeFields.length === 0 ? (
                  <div className="rounded-none border border-border/50 bg-muted/20 px-4 py-6 font-sans text-sm text-muted-foreground">
                    {labels.emptyFields}
                  </div>
                ) : fieldTree.children.length > 0 ? (
                  <div className="min-w-max">
                    {fieldTree.children.map((child) =>
                      renderFieldTreeNode(child, 0),
                    )}
                  </div>
                ) : (
                  <div className="min-w-max">
                    {renderFieldTreeNode(fieldTree, 0)}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="h-full overflow-hidden py-0">
            <CardHeader className="space-y-2 pt-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CardTitle className="inline-flex items-center gap-2">
                      <RiStackLine className="size-4" />
                      {labels.fieldValuesTitle}
                    </CardTitle>
                    {fieldValuesLoading ? (
                      <Spinner className="size-3.5" />
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {labels.fieldValuesSubtitle}
                  </p>
                </div>
                {selectedField ? (
                  <AutoTransition
                    initial={false}
                    transitionKey={selectedFieldResolvedKey}
                    className="min-w-0 shrink-0"
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 pt-1">
                      <Badge variant="ghost" className="shrink-0">
                        {selectedField.valueType}
                      </Badge>
                      <span className="max-w-[18rem] truncate font-mono text-xs text-muted-foreground">
                        {selectedField.path || "/"}
                      </span>
                    </div>
                  </AutoTransition>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <DataTableSwitch
                loading={
                  fieldListLoading ||
                  (Boolean(selectedField) && fieldValuesLoading)
                }
                hasContent={
                  Boolean(selectedField) &&
                  !fieldValuesError &&
                  fieldValues.length > 0
                }
                loadingLabel={labels.loading}
                emptyLabel={
                  fieldValuesError ? labels.loadError : labels.fieldValuesEmpty
                }
                colSpan={2}
                header={fieldValueTableHeader}
                rows={fieldValueRows}
                contentKey={`${selectedFieldResolvedKey}-${fieldValues.length}-${fieldValueTotal}`}
              />
            </CardContent>
          </Card>
        </div>
      </section>

      <ResponsiveDialog
        open={payloadFilterDialogOpen}
        onOpenChange={setPayloadFilterDialogOpen}
      >
        <ResponsiveDialogContent
          data-dashboard-floating-layer="event-filter-dialog"
          desktopClassName="max-w-xl"
          style={{ zIndex: EVENT_FILTER_DIALOG_Z_INDEX }}
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiFilter3Line}>
              {labels.payloadFilterTitle}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {labels.payloadFilterSubtitle}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-2">
            <textarea
              value={payloadFilterDraft}
              onChange={(event) => {
                setPayloadFilterDraft(event.target.value);
                if (payloadFilterError) setPayloadFilterError("");
              }}
              placeholder={labels.payloadFilterPlaceholder}
              className="min-h-32 w-full resize-y rounded-none border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
            />
            {payloadFilterError ? (
              <p className="text-xs text-destructive">{payloadFilterError}</p>
            ) : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={clearPayloadFilters}
            >
              <RiFilterOffLine className="size-4" />
              <span>{labels.payloadFilterClear}</span>
            </Button>
            <Button type="button" onClick={applyPayloadFilterDraft}>
              <RiCheckLine className="size-4" />
              <span>{labels.payloadFilterApply}</span>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}

export function EventPageHeader({
  messages,
  title,
  subtitle,
  backHref,
  backLabel,
  onBack,
}: {
  messages: AppMessages;
  title: string;
  subtitle: string;
  backHref?: string;
  backLabel?: string;
  onBack?: () => void;
}) {
  const router = useRouter();
  const handleBack = onBack
    ? onBack
    : backHref
      ? () => navigateWithTransition(router, backHref)
      : null;

  return (
    <PageHeading
      title={title}
      subtitle={subtitle}
      actions={
        handleBack ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleBack}
          >
            <RiArrowLeftLine data-icon="inline-start" />
            {backLabel || messages.common.backToTeam}
          </Button>
        ) : null
      }
    />
  );
}
