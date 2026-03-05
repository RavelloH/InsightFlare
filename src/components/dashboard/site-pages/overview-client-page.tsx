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
  emptyEventsData,
  emptyPagesData,
  emptySessionsData,
  fetchEvents,
  fetchOverview,
  fetchPages,
  fetchSessions,
  fetchTrend,
} from "@/lib/dashboard/client-data";
import type {
  EventsData,
  OverviewData,
  PagesData,
  SessionsData,
  TrendData,
} from "@/lib/edge-client";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
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

function emptyOverviewData(): OverviewData {
  return {
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
  };
}

function emptyTrendData(interval: TimeWindow["interval"]): TrendData {
  return {
    ok: true,
    interval,
    data: [],
  };
}

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
type PageCardSourceKey = "pages" | "events" | "sessions";

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
const PAGE_CARD_SOURCE_BY_TAB: Record<PageCardTab, PageCardSourceKey> = {
  path: "pages",
  title: "events",
  hostname: "events",
  entry: "sessions",
  exit: "sessions",
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

function OverviewPagesSection({
  locale,
  messages,
  siteId,
  pathname,
}: OverviewClientPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const livePathname = usePathname() || pathname;
  const isMobile = useIsMobile();
  const { filters, window } = useDashboardQuery();
  const [pagesData, setPagesData] = useState<PagesData>(emptyPagesData);
  const [eventsData, setEventsData] = useState<EventsData>(emptyEventsData);
  const [sessionsData, setSessionsData] =
    useState<SessionsData>(emptySessionsData);
  const [pageCardSourceLoaded, setPageCardSourceLoaded] = useState<
    Record<PageCardSourceKey, boolean>
  >({
    pages: false,
    events: false,
    sessions: false,
  });
  const [pageCardSourceLoading, setPageCardSourceLoading] = useState<
    Record<PageCardSourceKey, boolean>
  >({
    pages: false,
    events: false,
    sessions: false,
  });
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

  useEffect(() => {
    setPagesData(emptyPagesData());
    setEventsData(emptyEventsData());
    setSessionsData(emptySessionsData());
    setPageCardSourceLoaded({
      pages: false,
      events: false,
      sessions: false,
    });
    setPageCardSourceLoading({
      pages: false,
      events: false,
      sessions: false,
    });
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
  const activePageCardSource = PAGE_CARD_SOURCE_BY_TAB[pageCardTab];
  const activePageCardSourceLoaded = pageCardSourceLoaded[activePageCardSource];
  const activePageCardSourceLoading =
    pageCardSourceLoading[activePageCardSource];
  const pageCardLoading =
    activePageCardSourceLoading || !activePageCardSourceLoaded;
  const noDataText = messages.common.noData;

  useEffect(() => {
    if (activePageCardSourceLoaded || activePageCardSourceLoading) return;

    let active = true;
    setPageCardSourceLoading((prev) => ({
      ...prev,
      [activePageCardSource]: true,
    }));

    const markDone = () => {
      if (!active) return;
      setPageCardSourceLoaded((prev) => ({
        ...prev,
        [activePageCardSource]: true,
      }));
      setPageCardSourceLoading((prev) => ({
        ...prev,
        [activePageCardSource]: false,
      }));
    };

    if (activePageCardSource === "events") {
      fetchEvents(siteId, window, filters)
        .catch(() => emptyEventsData())
        .then((nextEvents) => {
          if (!active) return;
          setEventsData(nextEvents);
        })
        .finally(markDone);
    } else if (activePageCardSource === "sessions") {
      fetchSessions(siteId, window, filters)
        .catch(() => emptySessionsData())
        .then((nextSessions) => {
          if (!active) return;
          setSessionsData(nextSessions);
        })
        .finally(markDone);
    } else {
      fetchPages(siteId, window, filters)
        .catch(() => emptyPagesData())
        .then((nextPages) => {
          if (!active) return;
          setPagesData(nextPages);
        })
        .finally(markDone);
    }

    return () => {
      active = false;
      setPageCardSourceLoading((prev) =>
        prev[activePageCardSource]
          ? { ...prev, [activePageCardSource]: false }
          : prev,
      );
    };
  }, [
    activePageCardSource,
    activePageCardSourceLoaded,
    filters.browser,
    filters.country,
    filters.device,
    filters.eventType,
    siteId,
    window.from,
    window.interval,
    window.to,
  ]);
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
      pagesData.data.map((item) => ({
        key: `${item.pathname || "/"}|${item.query || ""}|${item.hash || ""}`,
        label: item.pathname || "/",
        views: Math.max(0, Number(item.views ?? 0)),
        sessions: Math.max(0, Number(item.sessions ?? 0)),
        mono: true,
      })),
    [pagesData.data],
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

    for (const event of eventsData.data) {
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
  }, [eventsData.data, messages.common.unknown]);
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

    for (const event of eventsData.data) {
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
  }, [eventsData.data, messages.common.unknown]);
  const entryRows = useMemo<PageCardRow[]>(() => {
    const map = new Map<string, { views: number; sessions: number }>();
    for (const session of sessionsData.data) {
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
  }, [sessionsData.data]);
  const exitRows = useMemo<PageCardRow[]>(() => {
    const map = new Map<string, { views: number; sessions: number }>();
    for (const session of sessionsData.data) {
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
  }, [sessionsData.data]);
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
    for (const event of eventsData.data) {
      const hostname = sanitizeHostname(String(event.hostname ?? ""));
      if (hostname.length > 0) return hostname;
    }
    if (typeof globalThis.window !== "undefined") {
      return sanitizeHostname(globalThis.window.location.hostname);
    }
    return "";
  }, [eventsData.data]);

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
              <span className="inline-flex items-center gap-2 break-words">
                {item.label}
                {rowTargetUrl ? (
                  <Clickable
                    className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    onClick={(event) =>
                      openPageCardRowTarget(rowTargetUrl, event)
                    }
                    aria-label={item.label}
                    title={item.label}
                  >
                    <RiArrowRightUpLine size="1.4em" />
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
        syncKey={`${pageCardTab}-${pageCardSearchTerm}-${searchedPageCardRows.length}-${pageCardLoading}`}
      >
        <DataTableSwitch
          loading={pageCardLoading}
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

  return (
    <>
      <TabbedScrollMaskCard
        value={pageCardTab}
        onValueChange={(value) => handlePageCardTabChange(value)}
        tabs={PAGE_CARD_TABS.map((tab) => ({
          value: tab,
          label: pageCardTabMeta[tab].label,
        }))}
        headerRight={pageCardSearchAction}
        syncKey={`${pageCardLoading}-${pageCardTab}-${pageCardSort.key}-${pageCardSort.direction}-${sortedPageCardRows.length}-${activePageCardQueryValue ?? "all"}-${visiblePageCardRows.length}`}
      >
        <DataTableSwitch
          loading={pageCardLoading}
          hasContent={visiblePageCardRows.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={noDataText}
          colSpan={3}
          contentKey={`${pageCardTab}-${activePageCardQueryValue ?? "all"}`}
          header={pageCardTableHeader}
          rows={renderPageCardRows(visiblePageCardRows)}
        />
      </TabbedScrollMaskCard>
      {pageCardSearchPanel}
    </>
  );
}

interface OverviewDataSectionProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

function OverviewMetricsSection({
  locale,
  messages,
  siteId,
  window,
  filters,
}: OverviewDataSectionProps) {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OverviewData>(emptyOverviewData);
  const [previousOverview, setPreviousOverview] =
    useState<OverviewData>(emptyOverviewData);
  const [detailSeries, setDetailSeries] = useState<TrendData["data"]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setOverview(emptyOverviewData());
    setPreviousOverview(emptyOverviewData());
    setDetailSeries([]);

    const previousTo = Math.max(window.from - 1, 0);
    const previousFrom = Math.max(previousTo - (window.to - window.from), 0);
    const previousWindow: TimeWindow = {
      ...window,
      from: previousFrom,
      to: previousTo,
    };

    (async () => {
      const current = await fetchOverview(siteId, window, filters, {
        includeChange: true,
        includeDetail: true,
      }).catch(() => emptyOverviewData());
      if (!active) return;
      setOverview(current);

      const [previous, trend] = await Promise.all([
        current.previousData
          ? Promise.resolve({
              ok: current.ok,
              data: current.previousData,
            } as OverviewData)
          : fetchOverview(siteId, previousWindow, filters).catch(() =>
              emptyOverviewData(),
            ),
        current.detail
          ? Promise.resolve({
              ok: current.ok,
              interval: current.detail.interval,
              data: current.detail.data,
            } as TrendData)
          : fetchTrend(siteId, window, filters).catch(() =>
              emptyTrendData(window.interval),
            ),
      ]);

      if (!active) return;
      setPreviousOverview(previous);
      setDetailSeries(trend.data);
    })().finally(() => {
      if (!active) return;
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [
    filters.browser,
    filters.country,
    filters.device,
    filters.eventType,
    siteId,
    window.from,
    window.interval,
    window.to,
  ]);

  const pagesPerSessionFormatter = useMemo(
    () =>
      new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 2,
      }),
    [locale],
  );
  const previous = previousOverview.data;
  const currentPagesPerSession =
    overview.data.sessions > 0
      ? overview.data.views / overview.data.sessions
      : 0;
  const previousPagesPerSession =
    previous.sessions > 0 ? previous.views / previous.sessions : 0;

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

  const metrics = [
    {
      label: messages.common.views,
      value: numberFormat(locale, overview.data.views),
      delta: toDeltaPercent(overview.data.views, previous.views),
      trend: viewsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.visitors,
      value: numberFormat(locale, overview.data.visitors),
      delta: toDeltaPercent(overview.data.visitors, previous.visitors),
      trend: visitorsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.sessions,
      value: numberFormat(locale, overview.data.sessions),
      delta: toDeltaPercent(overview.data.sessions, previous.sessions),
      trend: sessionsSeries,
      formatTrendValue: (value: number) =>
        numberFormat(locale, Math.round(value)),
    },
    {
      label: messages.common.bounceRate,
      value: percentFormat(locale, overview.data.bounceRate),
      delta: toDeltaPercent(overview.data.bounceRate, previous.bounceRate),
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
      value: durationFormat(locale, overview.data.avgDurationMs),
      delta: toDeltaPercent(
        overview.data.avgDurationMs,
        previous.avgDurationMs,
      ),
      trend: avgDurationSeries,
      formatTrendValue: (value: number) =>
        durationFormat(locale, Math.max(0, Math.round(value))),
    },
  ];

  return (
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
              <div key={item.label} className={metricCellBorderClasses(index)}>
                <div className="relative min-h-[74px]">
                  <div className="absolute inset-y-0 right-0 w-1/2 min-w-0">
                    <MetricAreaMap
                      points={item.trend}
                      color={METRIC_AREA_COLOR}
                      locale={locale}
                      label={item.label}
                      formatValue={item.formatTrendValue}
                    />
                  </div>
                  <div className="pointer-events-none relative z-10 flex min-h-[74px] min-w-0 flex-col justify-between px-3 py-2.5">
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
                </div>
              </div>
            );
          })}
        </section>
      </CardContent>
    </Card>
  );
}

function OverviewTrendSection({
  locale,
  messages,
  siteId,
  window,
  filters,
}: OverviewDataSectionProps) {
  const [loading, setLoading] = useState(true);
  const [trendData, setTrendData] = useState<TrendData>(() =>
    emptyTrendData(window.interval),
  );
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
    setTrendData(emptyTrendData(window.interval));

    fetchTrend(siteId, window, filters)
      .catch(() => emptyTrendData(window.interval))
      .then((nextTrend) => {
        if (!active) return;
        setTrendData(nextTrend);
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
    filters.browser,
    filters.country,
    filters.device,
    filters.eventType,
    siteId,
    window.from,
    window.interval,
    window.to,
  ]);

  const trendDisplayData = useMemo(() => {
    if (loading) {
      return buildEmptyTrendData(dataWindow);
    }
    return normalizeTrendData(dataWindow, trendData.data);
  }, [
    dataWindow.from,
    dataWindow.interval,
    dataWindow.to,
    loading,
    trendData.data,
  ]);

  return (
    <Card className="overflow-visible">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{messages.overview.trendTitle}</CardTitle>
        <span className="text-xs text-muted-foreground">
          {messages.common.lastUpdated}: {shortDateTime(locale, Date.now())}
        </span>
      </CardHeader>
      <CardContent>
        <TrendChart
          locale={locale}
          interval={dataWindow.interval}
          data={trendDisplayData}
          viewsLabel={messages.common.views}
          sessionsLabel={messages.common.sessions}
        />
      </CardContent>
    </Card>
  );
}

export function OverviewClientPage({
  locale,
  messages,
  siteId,
  pathname,
}: OverviewClientPageProps) {
  const { filters, window } = useDashboardQuery();

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.overview.title}
        subtitle={messages.overview.subtitle}
      />
      <OverviewMetricsSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
      <OverviewTrendSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        pathname={pathname}
      />
    </div>
  );
}
