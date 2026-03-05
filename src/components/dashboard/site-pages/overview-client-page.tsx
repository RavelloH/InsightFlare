"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  RiArrowDownLine,
  RiArrowRightUpLine,
  RiSearchLine,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiArrowUpSLine,
} from "@remixicon/react";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";
import { OverlayScrollbars } from "overlayscrollbars";
import type { PartialOptions } from "overlayscrollbars";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { PageHeading } from "@/components/dashboard/page-heading";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { EngagementChart } from "@/components/dashboard/engagement-chart";
import { TopItemsChart } from "@/components/dashboard/top-items-chart";
import { DistributionDonutChart } from "@/components/dashboard/distribution-donut-chart";
import { SessionDurationChart } from "@/components/dashboard/session-duration-chart";
import { RealtimePanel } from "@/components/dashboard/realtime-panel";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { TabbedScrollMaskCard } from "@/components/dashboard/tabbed-scroll-mask-card";
import { Spinner } from "@/components/ui/spinner";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Clickable } from "@/components/ui/clickable";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import {
  loadFilterOptions,
  loadOverviewBundle,
  type FilterOptions,
  type OverviewBundle,
} from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

interface OverviewClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

function toDeltaPercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function emptyOverviewBundle(interval: TimeWindow["interval"]): OverviewBundle {
  return {
    overview: {
      ok: true,
      data: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        bounceRate: 0,
        approximateVisitors: false,
      },
    },
    previousOverview: {
      ok: true,
      data: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        bounceRate: 0,
        approximateVisitors: false,
      },
    },
    trend: {
      ok: true,
      interval,
      data: [],
    },
    pages: { ok: true, data: [] },
    referrers: { ok: true, data: [] },
    sessions: { ok: true, data: [] },
    events: { ok: true, data: [] },
    countries: { ok: true, data: [] },
    devices: { ok: true, data: [] },
    browsers: { ok: true, data: [] },
    eventTypes: { ok: true, data: [] },
  };
}

const EMPTY_FILTER_OPTIONS: FilterOptions = {
  countries: [],
  devices: [],
  browsers: [],
  eventTypes: [],
};
const METRIC_AREA_COLOR = "var(--color-chart-1)";
const MAX_TREND_PLACEHOLDER_POINTS = 120;

function trendStepMs(interval: TimeWindow["interval"]): number {
  if (interval === "minute") return 60 * 1000;
  if (interval === "hour") return 60 * 60 * 1000;
  if (interval === "day") return 24 * 60 * 60 * 1000;
  if (interval === "week") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function buildEmptyTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval">,
): Array<{
  timestampMs: number;
  views: number;
  sessions: number;
}> {
  const stepMs = trendStepMs(window.interval);
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    return [];
  }

  const fromBucket = Math.floor(window.from / stepMs);
  const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
  const totalBuckets = toBucket - fromBucket + 1;
  const stride = Math.max(
    1,
    Math.ceil(totalBuckets / MAX_TREND_PLACEHOLDER_POINTS),
  );
  const points: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }> = [];

  for (let bucket = fromBucket; bucket <= toBucket; bucket += stride) {
    points.push({
      timestampMs: bucket * stepMs,
      views: 0,
      sessions: 0,
    });
  }

  const lastTimestampMs = toBucket * stepMs;
  if (
    points.length === 0 ||
    points[points.length - 1]?.timestampMs !== lastTimestampMs
  ) {
    points.push({
      timestampMs: lastTimestampMs,
      views: 0,
      sessions: 0,
    });
  }

  return points;
}

function normalizeTrendData(
  window: Pick<TimeWindow, "from" | "to" | "interval">,
  points: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }>,
): Array<{
  timestampMs: number;
  views: number;
  sessions: number;
}> {
  const stepMs = trendStepMs(window.interval);
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    return points;
  }

  const fromBucket = Math.floor(window.from / stepMs);
  const toBucket = Math.max(fromBucket, Math.floor(window.to / stepMs));
  const byBucket = new Map<number, { views: number; sessions: number }>();

  for (const point of points) {
    const bucket = Math.floor(Number(point.timestampMs ?? 0) / stepMs);
    if (!Number.isFinite(bucket) || bucket < fromBucket || bucket > toBucket) {
      continue;
    }
    const prev = byBucket.get(bucket) ?? { views: 0, sessions: 0 };
    byBucket.set(bucket, {
      views: prev.views + Math.max(0, Number(point.views ?? 0)),
      sessions: prev.sessions + Math.max(0, Number(point.sessions ?? 0)),
    });
  }

  const normalized: Array<{
    timestampMs: number;
    views: number;
    sessions: number;
  }> = [];
  for (let bucket = fromBucket; bucket <= toBucket; bucket += 1) {
    const value = byBucket.get(bucket);
    normalized.push({
      timestampMs: bucket * stepMs,
      views: value?.views ?? 0,
      sessions: value?.sessions ?? 0,
    });
  }

  return normalized;
}

function metricCellBorderClasses(index: number): string {
  const mobileHasLeft = index % 2 === 1;
  const mobileHasTop = index >= 2;
  const wideHasLeft = index % 3 !== 0;
  const wideHasTop = index >= 3;

  return cn(
    mobileHasLeft ? "border-l" : "",
    mobileHasTop ? "border-t" : "",
    mobileHasLeft !== wideHasLeft
      ? wideHasLeft
        ? "sm:border-l"
        : "sm:border-l-0"
      : "",
    mobileHasTop !== wideHasTop
      ? wideHasTop
        ? "sm:border-t"
        : "sm:border-t-0"
      : "",
  );
}

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeRateClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}

function ChangeRateInline({ value }: { value: number | null }) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value)}`}
    >
      <Icon className="size-3.5" />
      {formatChangeRate(value)}
    </span>
  );
}

interface MetricAreaPoint {
  timestampMs: number;
  value: number;
}

type PageCardTab = "path" | "title" | "hostname" | "entry" | "exit";
type PageCardSortKey = "views" | "sessions";
type PageCardNavigableTab = "path" | "hostname" | "entry" | "exit";

interface PageCardRow {
  key: string;
  label: string;
  views: number;
  sessions: number;
  mono: boolean;
}

const PAGE_CARD_TABS: PageCardTab[] = [
  "path",
  "title",
  "hostname",
  "entry",
  "exit",
];
const PAGE_CARD_NAVIGABLE_TABS = new Set<PageCardNavigableTab>([
  "path",
  "hostname",
  "entry",
  "exit",
]);
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
const PAGE_CARD_QUERY_PARAM_BY_TAB: Record<PageCardTab, string> = {
  path: "path",
  title: "title",
  hostname: "hostname",
  entry: "entry",
  exit: "exit",
};
const PANEL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;

function isPageCardNavigableTab(tab: PageCardTab): tab is PageCardNavigableTab {
  return PAGE_CARD_NAVIGABLE_TABS.has(tab as PageCardNavigableTab);
}

function sanitizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
    .replace(/\/+.*$/, "");
}

function toAbsoluteHttpsUrl(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0) return null;
  try {
    if (ABSOLUTE_URL_PATTERN.test(raw)) {
      return new URL(raw).toString();
    }
    if (raw.startsWith("//")) {
      return new URL(`https:${raw}`).toString();
    }
    return new URL(`https://${raw}`).toString();
  } catch {
    return null;
  }
}

function resolvePageCardTargetUrl(params: {
  tab: PageCardTab;
  value: string;
  unknownLabel: string;
  fallbackHostname: string;
}): string | null {
  const { tab, value, unknownLabel, fallbackHostname } = params;
  const raw = value.trim();
  if (raw.length === 0 || raw === unknownLabel) {
    return null;
  }

  if (tab === "hostname") {
    return toAbsoluteHttpsUrl(raw);
  }

  if (tab === "path" || tab === "entry" || tab === "exit") {
    if (raw.startsWith("/")) {
      const host = sanitizeHostname(fallbackHostname);
      if (host.length === 0) return null;
      try {
        return new URL(raw, `https://${host}`).toString();
      } catch {
        return null;
      }
    }
    return toAbsoluteHttpsUrl(raw);
  }

  return null;
}

function PanelScrollbar({
  children,
  className,
  syncKey,
}: {
  children: ReactNode;
  className?: string;
  syncKey?: string | number | boolean | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, PANEL_SCROLLBAR_OPTIONS);
    if (existing) {
      existing.options(PANEL_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;
    instance.update(true);

    return () => {
      if (!existing) {
        instance.destroy();
      }
      if (scrollbarRef.current === instance) {
        scrollbarRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    scrollbarRef.current?.update(true);
  }, [syncKey]);

  return (
    <div
      ref={hostRef}
      className={cn("overflow-hidden", className)}
      data-overlayscrollbars-initialize
    >
      {children}
    </div>
  );
}

function MetricAreaMap({
  points,
  color,
  locale,
  label,
  formatValue,
}: {
  points: MetricAreaPoint[];
  color: string;
  locale: Locale;
  label: string;
  formatValue: (value: number) => string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );
  const chartData = useMemo(() => {
    const normalized = points.map((point, index) => ({
      index,
      timestampMs: Number.isFinite(point.timestampMs) ? point.timestampMs : 0,
      value: Number.isFinite(point.value) ? Math.max(0, point.value) : 0,
    }));

    if (normalized.length >= 2) return normalized;
    if (normalized.length === 1) {
      const first = normalized[0] ?? { index: 0, value: 0, timestampMs: 0 };
      return [
        first,
        {
          index: 1,
          value: first.value,
          timestampMs: first.timestampMs + 1,
        },
      ];
    }
    return [
      { index: 0, value: 0, timestampMs: 0 },
      { index: 1, value: 0, timestampMs: 1 },
    ];
  }, [points]);

  return (
    <div className="h-full w-full">
      <div className="relative h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 12, right: 0, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.36} />
                <stop offset="100%" stopColor={color} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <Tooltip
              cursor={{ stroke: color, strokeOpacity: 0.28, strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload || payload.length === 0) return null;
                const item = payload[0]?.payload as
                  | { timestampMs?: number; value?: number }
                  | undefined;
                const timestampMs = Number(item?.timestampMs ?? 0);
                const value = Number(item?.value ?? 0);

                return (
                  <div className="rounded-none border border-border/50 bg-background px-2 py-1 text-[11px] shadow-xl">
                    <p className="text-muted-foreground">
                      {dateFormatter.format(new Date(timestampMs))}
                    </p>
                    <p className="font-mono text-foreground">
                      {label}: {formatValue(value)}
                    </p>
                  </div>
                );
              }}
            />
            <Area
              type="linear"
              dataKey="value"
              stroke={color}
              fill={`url(#${gradientId})`}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 2, stroke: color, fill: color }}
              isAnimationActive
              animationDuration={280}
            />
          </AreaChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 bg-gradient-to-r from-card via-card/80 to-transparent" />
      </div>
    </div>
  );
}

export function OverviewClientPage({
  locale,
  messages,
  siteId,
  pathname,
}: OverviewClientPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const livePathname = usePathname() || pathname;
  const isMobile = useIsMobile();
  const { range, filters, window } = useDashboardQuery();
  const [bundle, setBundle] = useState<OverviewBundle | null>(null);
  const [filterOptions, setFilterOptions] =
    useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [pageCardTab, setPageCardTab] = useState<PageCardTab>("path");
  const [pageCardSort, setPageCardSort] = useState<{
    key: PageCardSortKey;
    direction: "asc" | "desc";
  }>({
    key: "views",
    direction: "desc",
  });
  const [pageCardSearchOpen, setPageCardSearchOpen] = useState(false);
  const [pageCardSearchTerm, setPageCardSearchTerm] = useState("");
  const [dataWindow, setDataWindow] = useState<
    Pick<TimeWindow, "from" | "to" | "interval">
  >(() => ({
    from: window.from,
    to: window.to,
    interval: window.interval,
  }));

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      loadOverviewBundle(siteId, window, filters),
      loadFilterOptions(siteId, window),
    ])
      .then(([nextBundle, nextFilterOptions]) => {
        if (!active) return;
        setBundle(nextBundle);
        setFilterOptions(nextFilterOptions);
        setDataWindow({
          from: window.from,
          to: window.to,
          interval: window.interval,
        });
      })
      .catch(() => {
        if (!active) return;
        setBundle(emptyOverviewBundle(window.interval));
        setFilterOptions(EMPTY_FILTER_OPTIONS);
        setDataWindow({
          from: window.from,
          to: window.to,
          interval: window.interval,
        });
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    siteId,
    window.from,
    window.to,
    window.interval,
    filters.country,
    filters.device,
    filters.browser,
    filters.eventType,
  ]);
  useEffect(() => {
    if (!pageCardSearchOpen) {
      setPageCardSearchTerm("");
    }
  }, [pageCardSearchOpen]);

  const data = useMemo(
    () => bundle ?? emptyOverviewBundle(dataWindow.interval),
    [bundle, dataWindow.interval],
  );
  const pagesPerSessionFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 2,
      }),
    [locale],
  );

  const previous = data.previousOverview.data;
  const noDataText = messages.common.noData;
  const currentPagesPerSession =
    data.overview.data.sessions > 0
      ? data.overview.data.views / data.overview.data.sessions
      : 0;
  const previousPagesPerSession =
    previous.sessions > 0 ? previous.views / previous.sessions : 0;
  const detailSeries = data.overview.detail?.data ?? data.trend.data;
  const trendDisplayData = useMemo(() => {
    if (!bundle && loading) {
      return buildEmptyTrendData(dataWindow);
    }
    return normalizeTrendData(dataWindow, data.trend.data);
  }, [
    bundle,
    loading,
    dataWindow.from,
    dataWindow.to,
    dataWindow.interval,
    data.trend.data,
  ]);

  const viewsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.views,
  }));
  const visitorsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.visitors,
  }));
  const sessionsSeries = detailSeries.map((point) => ({
    timestampMs: point.timestampMs,
    value: point.sessions,
  }));
  const bounceRateSeries = detailSeries
    .filter((point) => point.views > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.bounces / point.views,
    }));
  const pagesPerSessionSeries = detailSeries
    .filter((point) => point.sessions > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.views / point.sessions,
    }));
  const avgDurationSeries = detailSeries
    .filter((point) => point.views > 0)
    .map((point) => ({
      timestampMs: point.timestampMs,
      value: point.avgDurationMs,
    }));

  const eventTypeItems = data.eventTypes.data.map((item) => ({
    label: item.value || messages.common.unknown,
    value: item.views,
  }));
  const compositionItems = [
    { label: messages.common.views, value: data.overview.data.views },
    { label: messages.common.sessions, value: data.overview.data.sessions },
    { label: messages.common.visitors, value: data.overview.data.visitors },
    { label: messages.common.bounces, value: data.overview.data.bounces },
  ];
  const pageCardTabMeta: Record<
    PageCardTab,
    { label: string; columnLabel: string; mono: boolean }
  > = {
    path: {
      label: messages.common.path,
      columnLabel: messages.common.path,
      mono: true,
    },
    title: {
      label: messages.common.title,
      columnLabel: messages.common.title,
      mono: false,
    },
    hostname: {
      label: messages.common.hostname,
      columnLabel: messages.common.hostname,
      mono: true,
    },
    entry: {
      label: messages.common.entryPage,
      columnLabel: messages.common.entryPage,
      mono: true,
    },
    exit: {
      label: messages.common.exitPage,
      columnLabel: messages.common.exitPage,
      mono: true,
    },
  };
  const pathRows = useMemo<PageCardRow[]>(
    () =>
      data.pages.data.map((item) => ({
        key: `${item.pathname || "/"}|${item.query || ""}|${item.hash || ""}`,
        label: item.pathname || "/",
        views: Math.max(0, Number(item.views ?? 0)),
        sessions: Math.max(0, Number(item.sessions ?? 0)),
        mono: true,
      })),
    [data.pages.data],
  );
  const titleRows = useMemo<PageCardRow[]>(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        views: number;
        sessionIds: Set<string>;
        unknownSessions: number;
      }
    >();

    for (const event of data.events.data) {
      const rawTitle = String(event.title ?? "").trim();
      const label = rawTitle.length > 0 ? rawTitle : messages.common.unknown;
      const key = label;
      const prev = map.get(key) ?? {
        key,
        label,
        views: 0,
        sessionIds: new Set<string>(),
        unknownSessions: 0,
      };
      prev.views += 1;
      const sessionId = String(event.sessionId ?? "").trim();
      if (sessionId.length > 0) {
        prev.sessionIds.add(sessionId);
      } else {
        prev.unknownSessions += 1;
      }
      map.set(key, prev);
    }

    return Array.from(map.values()).map((item) => ({
      key: item.key,
      label: item.label,
      views: item.views,
      sessions: item.sessionIds.size + item.unknownSessions,
      mono: false,
    }));
  }, [data.events.data, messages.common.unknown]);
  const hostnameRows = useMemo<PageCardRow[]>(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        views: number;
        sessionIds: Set<string>;
        unknownSessions: number;
      }
    >();

    for (const event of data.events.data) {
      const rawHostname = String(event.hostname ?? "").trim();
      const label =
        rawHostname.length > 0 ? rawHostname : messages.common.unknown;
      const key = label;
      const prev = map.get(key) ?? {
        key,
        label,
        views: 0,
        sessionIds: new Set<string>(),
        unknownSessions: 0,
      };
      prev.views += 1;
      const sessionId = String(event.sessionId ?? "").trim();
      if (sessionId.length > 0) {
        prev.sessionIds.add(sessionId);
      } else {
        prev.unknownSessions += 1;
      }
      map.set(key, prev);
    }

    return Array.from(map.values()).map((item) => ({
      key: item.key,
      label: item.label,
      views: item.views,
      sessions: item.sessionIds.size + item.unknownSessions,
      mono: true,
    }));
  }, [data.events.data, messages.common.unknown]);
  const entryRows = useMemo<PageCardRow[]>(() => {
    const map = new Map<string, { views: number; sessions: number }>();
    for (const session of data.sessions.data) {
      const label = String(session.entryPath ?? "").trim() || "/";
      const prev = map.get(label) ?? { views: 0, sessions: 0 };
      map.set(label, {
        views: prev.views + Math.max(0, Number(session.views ?? 0)),
        sessions: prev.sessions + 1,
      });
    }
    return Array.from(map.entries()).map(([label, value]) => ({
      key: label,
      label,
      views: value.views,
      sessions: value.sessions,
      mono: true,
    }));
  }, [data.sessions.data]);
  const exitRows = useMemo<PageCardRow[]>(() => {
    const map = new Map<string, { views: number; sessions: number }>();
    for (const session of data.sessions.data) {
      const label = String(session.exitPath ?? "").trim() || "/";
      const prev = map.get(label) ?? { views: 0, sessions: 0 };
      map.set(label, {
        views: prev.views + Math.max(0, Number(session.views ?? 0)),
        sessions: prev.sessions + 1,
      });
    }
    return Array.from(map.entries()).map(([label, value]) => ({
      key: label,
      label,
      views: value.views,
      sessions: value.sessions,
      mono: true,
    }));
  }, [data.sessions.data]);
  const pageCardRows = useMemo<Record<PageCardTab, PageCardRow[]>>(
    () => ({
      path: pathRows,
      title: titleRows,
      hostname: hostnameRows,
      entry: entryRows,
      exit: exitRows,
    }),
    [pathRows, titleRows, hostnameRows, entryRows, exitRows],
  );
  const activePageTabMeta = pageCardTabMeta[pageCardTab];
  const sortedPageCardRows = useMemo(() => {
    const source = pageCardRows[pageCardTab];
    const direction = pageCardSort.direction === "asc" ? 1 : -1;

    return [...source].sort((left, right) => {
      const primary =
        (left[pageCardSort.key] - right[pageCardSort.key]) * direction;
      if (primary !== 0) return primary;
      return left.label.localeCompare(right.label);
    });
  }, [pageCardRows, pageCardSort.direction, pageCardSort.key, pageCardTab]);
  const pageCardProgressTotal = useMemo(
    () =>
      sortedPageCardRows.reduce(
        (sum, item) => sum + Math.max(0, Number(item[pageCardSort.key] ?? 0)),
        0,
      ),
    [sortedPageCardRows, pageCardSort.key],
  );
  const activePageCardQueryValue = useMemo(() => {
    const queryParamKey = PAGE_CARD_QUERY_PARAM_BY_TAB[pageCardTab];
    const raw = searchParams.get(queryParamKey);
    if (!raw) return null;
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  }, [pageCardTab, searchParams]);
  const visiblePageCardRows = useMemo(
    () =>
      activePageCardQueryValue
        ? sortedPageCardRows.filter(
            (row) => row.label === activePageCardQueryValue,
          )
        : sortedPageCardRows,
    [activePageCardQueryValue, sortedPageCardRows],
  );
  const normalizedPageCardSearchTerm = pageCardSearchTerm
    .trim()
    .toLocaleLowerCase();
  const searchedPageCardRows = useMemo(() => {
    if (!normalizedPageCardSearchTerm) return sortedPageCardRows;
    return sortedPageCardRows.filter((row) =>
      row.label.toLocaleLowerCase().includes(normalizedPageCardSearchTerm),
    );
  }, [normalizedPageCardSearchTerm, sortedPageCardRows]);
  const pageCardDefaultHostname = useMemo(() => {
    for (const event of data.events.data) {
      const hostname = sanitizeHostname(String(event.hostname ?? ""));
      if (hostname.length > 0) return hostname;
    }
    if (typeof globalThis.window !== "undefined") {
      return sanitizeHostname(globalThis.window.location.hostname);
    }
    return "";
  }, [data.events.data]);

  const togglePageCardSort = (key: PageCardSortKey) => {
    setPageCardSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
        : { key, direction: "desc" },
    );
  };
  const setPageCardQueryFilter = (
    next: { tab: PageCardTab; value: string } | null,
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const queryKey of Object.values(PAGE_CARD_QUERY_PARAM_BY_TAB)) {
      params.delete(queryKey);
    }
    if (next) {
      const queryKey = PAGE_CARD_QUERY_PARAM_BY_TAB[next.tab];
      const normalized = next.value.trim();
      if (normalized.length > 0) {
        params.set(queryKey, normalized);
      }
    }
    const current = searchParams.toString();
    const updated = params.toString();
    if (updated === current) return;
    const target = updated ? `${livePathname}?${updated}` : livePathname;
    router.replace(target, { scroll: false });
  };
  const handlePageCardTabChange = (tab: PageCardTab) => {
    if (tab !== pageCardTab) {
      setPageCardTab(tab);
    }
  };
  const togglePageCardRowFilter = (rowKey: string) => {
    const normalized = rowKey.trim();
    const isActive = activePageCardQueryValue === normalized;
    setPageCardQueryFilter(
      isActive ? null : { tab: pageCardTab, value: normalized },
    );
  };
  const openPageCardRowTarget = (
    targetUrl: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    globalThis.window.open(targetUrl, "_blank", "noopener,noreferrer");
  };
  const renderSortIndicator = (key: PageCardSortKey) => {
    if (pageCardSort.key === key) {
      return pageCardSort.direction === "desc" ? (
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
  const pageCardSearchLabel = locale === "zh" ? "搜索" : "Search";
  const pageCardSearchPlaceholder =
    locale === "zh"
      ? `搜索${activePageTabMeta.label}`
      : `Search ${activePageTabMeta.label}`;
  const pageCardSearchTitle =
    locale === "zh"
      ? `搜索${activePageTabMeta.label}`
      : `Search ${activePageTabMeta.label}`;
  const pageCardTableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{activePageTabMeta.columnLabel}</div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              pageCardSort.key === "views"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => togglePageCardSort("views")}
          >
            {messages.common.views}
            {renderSortIndicator("views")}
          </button>
        </div>
      </TableHead>
      <TableHead className="h-8 p-0 w-20">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              pageCardSort.key === "sessions"
                ? "text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => togglePageCardSort("sessions")}
          >
            {messages.common.sessions}
            {renderSortIndicator("sessions")}
          </button>
        </div>
      </TableHead>
    </TableRow>
  );
  const renderPageCardRows = (rows: PageCardRow[]) =>
    rows.map((item) => {
      const rowValue = Math.max(0, Number(item[pageCardSort.key] ?? 0));
      const progressPercent =
        pageCardProgressTotal > 0
          ? Math.min(100, (rowValue / pageCardProgressTotal) * 100)
          : 0;
      const progressWidth = `${progressPercent.toFixed(2)}%`;
      const rowTargetUrl = isPageCardNavigableTab(pageCardTab)
        ? resolvePageCardTargetUrl({
            tab: pageCardTab,
            value: item.label,
            unknownLabel: messages.common.unknown,
            fallbackHostname: pageCardDefaultHostname,
          })
        : null;
      const rowFilterActive = activePageCardQueryValue === item.label;

      return (
        <TableRow
          key={`${pageCardTab}-${item.key}`}
          className={cn(
            "group/row cursor-pointer bg-no-repeat transition-[background-size,filter] duration-300 ease-out hover:brightness-95",
            rowFilterActive && "brightness-95",
          )}
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
            backgroundSize: `${progressWidth} 100%`,
            backgroundPosition: "left top",
          }}
          onClick={() => togglePageCardRowFilter(item.label)}
        >
          <TableCell className="p-0 whitespace-normal align-top">
            <div
              className={cn(
                "px-4 py-2 leading-5 whitespace-normal break-words",
                activePageTabMeta.mono && "font-mono",
              )}
            >
              <span className="inline break-words">
                {item.label}
                {rowTargetUrl ? (
                  <Clickable
                    className="ml-1 inline-flex h-[1em] w-[1em] [vertical-align:-0.125em] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    onClick={(event) =>
                      openPageCardRowTarget(rowTargetUrl, event)
                    }
                    aria-label={item.label}
                    title={item.label}
                  >
                    <RiArrowRightUpLine className="size-full" />
                  </Clickable>
                ) : null}
              </span>
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
        </TableRow>
      );
    });
  const pageCardSearchContent = (
    <div className="space-y-3">
      <Input
        value={pageCardSearchTerm}
        onChange={(event) => setPageCardSearchTerm(event.target.value)}
        placeholder={pageCardSearchPlaceholder}
      />
      <PanelScrollbar
        className="max-h-[60vh] pr-1"
        syncKey={`${pageCardTab}-${pageCardSearchTerm}-${searchedPageCardRows.length}-${loading}`}
      >
        <DataTableSwitch
          loading={loading}
          hasContent={searchedPageCardRows.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={noDataText}
          colSpan={3}
          contentKey={`search-${pageCardTab}-${pageCardSearchTerm}-${activePageCardQueryValue ?? "all"}`}
          header={pageCardTableHeader}
          rows={renderPageCardRows(searchedPageCardRows)}
        />
      </PanelScrollbar>
    </div>
  );
  const pageCardSearchPanel = isMobile ? (
    <Drawer open={pageCardSearchOpen} onOpenChange={setPageCardSearchOpen}>
      <DrawerContent className="max-h-[90vh]">
        <DrawerHeader>
          <DrawerTitle>{pageCardSearchTitle}</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4">{pageCardSearchContent}</div>
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog open={pageCardSearchOpen} onOpenChange={setPageCardSearchOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{pageCardSearchTitle}</DialogTitle>
        </DialogHeader>
        {pageCardSearchContent}
      </DialogContent>
    </Dialog>
  );
  const pageCardSearchAction = (
    <Clickable
      className="size-6 text-muted-foreground hover:text-foreground"
      onClick={() => setPageCardSearchOpen(true)}
      aria-label={pageCardSearchLabel}
      title={pageCardSearchLabel}
    >
      <RiSearchLine className="size-4" />
    </Clickable>
  );

  const metrics = [
    {
      label: messages.common.views,
      value: numberFormat(locale, data.overview.data.views),
      delta: toDeltaPercent(data.overview.data.views, previous.views),
      trend: viewsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.visitors,
      value: numberFormat(locale, data.overview.data.visitors),
      delta: toDeltaPercent(data.overview.data.visitors, previous.visitors),
      trend: visitorsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.sessions,
      value: numberFormat(locale, data.overview.data.sessions),
      delta: toDeltaPercent(data.overview.data.sessions, previous.sessions),
      trend: sessionsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.bounceRate,
      value: percentFormat(locale, data.overview.data.bounceRate),
      delta: toDeltaPercent(data.overview.data.bounceRate, previous.bounceRate),
      inverted: true,
      trend: bounceRateSeries,
      formatTrendValue: (value: number) => percentFormat(locale, value),
    },
    {
      label: messages.teamManagement.sites.pagesPerSession,
      value: pagesPerSessionFormatter.format(currentPagesPerSession),
      delta: toDeltaPercent(currentPagesPerSession, previousPagesPerSession),
      trend: pagesPerSessionSeries,
      formatTrendValue: (value: number) =>
        pagesPerSessionFormatter.format(value),
    },
    {
      label: messages.common.avgDuration,
      value: durationFormat(locale, data.overview.data.avgDurationMs),
      delta: toDeltaPercent(
        data.overview.data.avgDurationMs,
        previous.avgDurationMs,
      ),
      trend: avgDurationSeries,
      formatTrendValue: (value: number) =>
        durationFormat(locale, Math.max(0, Math.round(value))),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.overview.title}
        subtitle={messages.overview.subtitle}
      />

      <Card className="gap-0 py-0">
        <CardContent className="px-0">
          <section className="grid grid-cols-2 sm:grid-cols-3">
            {metrics.map((item, index) => {
              const hasDelta =
                typeof item.delta === "number" && Number.isFinite(item.delta);
              const effectiveDelta = hasDelta
                ? item.inverted
                  ? -(item.delta ?? 0)
                  : (item.delta ?? 0)
                : null;

              return (
                <div
                  key={item.label}
                  className={metricCellBorderClasses(index)}
                >
                  <div className="flex min-h-[74px] items-stretch gap-3">
                    <div className="flex min-w-0 flex-1 flex-col justify-between px-3 py-2.5">
                      <p className="truncate text-xs text-muted-foreground mb-4">
                        {item.label}
                      </p>
                      <div>
                        <AutoResizer initial>
                          <AutoTransition initial>
                            {loading ? (
                              <div
                                key="loading"
                                className="inline-flex items-center"
                              >
                                <Spinner className="size-5" />
                              </div>
                            ) : (
                              <p
                                key="value"
                                className="inline-flex items-end gap-1.5 font-mono text-2xl font-semibold leading-none tracking-tight"
                              >
                                <span>{item.value}</span>
                                <ChangeRateInline value={effectiveDelta} />
                              </p>
                            )}
                          </AutoTransition>
                        </AutoResizer>
                      </div>
                    </div>
                    <div className="w-1/2 min-w-0">
                      <MetricAreaMap
                        points={item.trend}
                        color={METRIC_AREA_COLOR}
                        locale={locale}
                        label={item.label}
                        formatValue={item.formatTrendValue}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        </CardContent>
      </Card>

      <Card className="overflow-visible">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{messages.overview.trendTitle}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {messages.common.lastUpdated}: {shortDateTime(locale, Date.now())}
          </span>
        </CardHeader>
        <CardContent>
          {!loading && data.trend.data.length === 0 ? (
            <div className="flex min-h-[120px] items-center justify-center text-sm text-muted-foreground">
              <p>{noDataText}</p>
            </div>
          ) : (
            <TrendChart
              locale={locale}
              interval={dataWindow.interval}
              data={trendDisplayData}
              viewsLabel={messages.common.views}
              sessionsLabel={messages.common.sessions}
            />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TabbedScrollMaskCard
          value={pageCardTab}
          onValueChange={(value) => handlePageCardTabChange(value)}
          tabs={PAGE_CARD_TABS.map((tab) => ({
            value: tab,
            label: pageCardTabMeta[tab].label,
          }))}
          headerRight={pageCardSearchAction}
          syncKey={`${loading}-${pageCardTab}-${pageCardSort.key}-${pageCardSort.direction}-${sortedPageCardRows.length}-${activePageCardQueryValue ?? "all"}-${visiblePageCardRows.length}`}
        >
          <DataTableSwitch
            loading={loading}
            hasContent={visiblePageCardRows.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={3}
            contentKey={`${pageCardTab}-${activePageCardQueryValue ?? "all"}`}
            header={pageCardTableHeader}
            rows={renderPageCardRows(visiblePageCardRows)}
          />
        </TabbedScrollMaskCard>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.topReferrers}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTableSwitch
              loading={loading}
              hasContent={data.referrers.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              contentKey={2}
              header={
                <TableRow>
                  <TableHead>{messages.common.referrer}</TableHead>
                  <TableHead className="text-right">
                    {messages.common.views}
                  </TableHead>
                  <TableHead className="text-right">
                    {messages.common.sessions}
                  </TableHead>
                </TableRow>
              }
              rows={data.referrers.data.map((item) => (
                <TableRow key={`${item.referrer}-${item.views}`}>
                  <TableCell className="max-w-[260px] truncate font-mono">
                    {item.referrer || messages.common.unknown}
                  </TableCell>
                  <TableCell className="text-right">
                    {numberFormat(locale, item.views)}
                  </TableCell>
                  <TableCell className="text-right">
                    {numberFormat(locale, item.sessions)}
                  </TableCell>
                </TableRow>
              ))}
            />
          </CardContent>
        </Card>
      </div>
      {pageCardSearchPanel}

      <RealtimePanel siteId={siteId} locale={locale} messages={messages} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.engagementTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.trend.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <EngagementChart
                locale={locale}
                data={data.trend.data}
                viewsLabel={messages.common.views}
                sessionsLabel={messages.common.sessions}
              />
            </ContentSwitch>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.compositionTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={compositionItems.some((item) => item.value > 0)}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <DistributionDonutChart items={compositionItems} />
            </ContentSwitch>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.eventTypesTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={eventTypeItems.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <DistributionDonutChart items={eventTypeItems} />
            </ContentSwitch>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.sessionDurationTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.sessions.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <SessionDurationChart
                durationsMs={data.sessions.data.map(
                  (item) => item.totalDurationMs,
                )}
              />
            </ContentSwitch>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{messages.navigation.geo}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.countries.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <TopItemsChart
                valueLabel={messages.common.views}
                items={data.countries.data.map((item) => ({
                  label: item.value || messages.common.unknown,
                  value: item.views,
                }))}
              />
            </ContentSwitch>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.navigation.devices}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.devices.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <DistributionDonutChart
                items={data.devices.data.map((item) => ({
                  label: item.value || messages.common.unknown,
                  value: item.views,
                }))}
              />
            </ContentSwitch>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.navigation.browsers}</CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={data.browsers.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{noDataText}</p>}
            >
              <DistributionDonutChart
                items={data.browsers.data.map((item) => ({
                  label: item.value || messages.common.unknown,
                  value: item.views,
                }))}
              />
            </ContentSwitch>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.recentSessions}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTableSwitch
              loading={loading}
              hasContent={data.sessions.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              header={
                <TableRow>
                  <TableHead>{messages.common.startedAt}</TableHead>
                  <TableHead className="text-right">
                    {messages.common.views}
                  </TableHead>
                  <TableHead className="text-right">
                    {messages.common.duration}
                  </TableHead>
                </TableRow>
              }
              rows={data.sessions.data.map((session) => (
                <TableRow key={session.sessionId}>
                  <TableCell>
                    {shortDateTime(locale, session.startedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {numberFormat(locale, session.views)}
                  </TableCell>
                  <TableCell className="text-right">
                    {durationFormat(locale, session.totalDurationMs)}
                  </TableCell>
                </TableRow>
              ))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.recentEvents}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTableSwitch
              loading={loading}
              hasContent={data.events.data.length > 0}
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              colSpan={3}
              header={
                <TableRow>
                  <TableHead>{messages.common.event}</TableHead>
                  <TableHead>{messages.common.page}</TableHead>
                  <TableHead className="text-right">
                    {messages.common.startedAt}
                  </TableHead>
                </TableRow>
              }
              rows={data.events.data.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    {event.eventType || messages.common.unknown}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate font-mono">
                    {event.pathname || "/"}
                  </TableCell>
                  <TableCell className="text-right">
                    {shortDateTime(locale, event.eventAt)}
                  </TableCell>
                </TableRow>
              ))}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
