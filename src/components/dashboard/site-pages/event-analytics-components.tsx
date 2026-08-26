import {
  Fragment,
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
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

import { AnalyticsDataTable } from "@/components/dashboard/analytics-data-table";
import {
  type AnalyticsTableColumnDefinition,
  AnalyticsTableColumnSettings,
  useAnalyticsTableColumns,
} from "@/components/dashboard/analytics-table-column-settings";
import {
  AnalyticsDetailsTooltipTarget,
  AnalyticsTimeTooltipTarget,
} from "@/components/dashboard/analytics-time-tooltip";
import { AnimatedDataTableRow } from "@/components/dashboard/animated-data-table-row";
import {
  createEventTrendChartData,
  createEventTrendChartSeries,
  EventTrendBarChart,
} from "@/components/dashboard/charts/event-trend-bar-chart";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import {
  GeoPointsMapIsland,
  type GeoPointsMapPoint,
} from "@/components/dashboard/geo-points-map-island";
import {
  BrowserMeta,
  CountryRegionMeta,
  DeviceMeta,
  formatDuration,
  formatPath,
  formatRelativeTime,
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
import { SessionDetailClientPage } from "@/components/dashboard/site-pages/session-detail-client-page";
import { VisitorDetailClientPage } from "@/components/dashboard/site-pages/visitor-detail-client-page";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  fetchEventRecordDetail,
  fetchEventsRecords,
  fetchEventTypeFields,
  fetchEventTypeFieldValues,
} from "@/lib/dashboard/client-data";
import { appendEventPayloadFilter } from "@/lib/dashboard/filter-state";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";
import type { TimeWindow } from "@/lib/dashboard/query-state";
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
const FIELD_TREE_CHILD_TRANSITION = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};

type EventRecordDetail = NonNullable<EventRecordDetailData["data"]>;

const EVENT_DETAIL_SKELETON_DATA: EventRecordDetail = {
  event: {
    eventId: "",
    eventName: "",
    occurredAt: 0,
    receivedAt: 0,
    sequence: 0,
    visitId: "",
    sessionId: "",
    visitorId: "",
    pathname: "",
    title: "",
    hostname: "",
    referrerHost: "",
    country: "",
    region: "",
    browser: "",
    browserVersion: "",
    os: "",
    osVersion: "",
    deviceType: "",
    nodeCount: 0,
    valueCount: 0,
  },
  context: {
    visitId: "",
    sessionId: "",
    visitorId: "",
    pathname: "",
    title: "",
    hostname: "",
    referrerHost: "",
    country: "",
    region: "",
    browser: "",
    browserVersion: "",
    os: "",
    osVersion: "",
    deviceType: "",
    performance: {
      ttfb: null,
      fcp: null,
      lcp: null,
      cls: null,
      inp: null,
    },
  },
  eventData: null,
};

type SortDirection = "asc" | "desc";
export type EventRecordSortKey = "occurredAt" | "eventName" | "pathname";

export interface EventRecordSortState {
  key: EventRecordSortKey;
  direction: SortDirection;
}

export const EVENT_RECORD_TABLE_COLUMN_IDS = [
  "visitor",
  "eventName",
  "eventId",
  "occurredAt",
  "page",
  "referrer",
  "location",
  "os",
  "browser",
  "device",
  "payload",
  "nodeCount",
] as const;

export type EventRecordTableColumnId =
  (typeof EVENT_RECORD_TABLE_COLUMN_IDS)[number];

export type EventPageCopy = AppMessages["events"];

export const DEFAULT_EVENT_RECORD_SORT: EventRecordSortState = {
  key: "occurredAt",
  direction: "desc",
};

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

function EventFieldTreeSkeleton({ loadingLabel }: { loadingLabel: string }) {
  const rows = [
    { indent: "pl-0", width: "w-28", branch: true },
    { indent: "pl-5", width: "w-24", branch: true },
    { indent: "pl-10", width: "w-32", branch: false },
    { indent: "pl-10", width: "w-20", branch: false },
    { indent: "pl-5", width: "w-28", branch: true },
    { indent: "pl-10", width: "w-24", branch: false },
  ];

  return (
    <div
      className="space-y-0.5 border border-border/50 bg-muted/10 px-2 py-2"
      aria-busy="true"
      aria-label={loadingLabel}
    >
      {rows.map((row, index) => (
        <div
          key={index}
          className={`flex h-8 items-center gap-2 ${row.indent}`}
        >
          <Skeleton className="size-6 shrink-0 rounded-none" />
          <Skeleton className={`h-3.5 ${row.width} rounded-none`} />
          {row.branch ? (
            <Skeleton className="ml-auto size-5 shrink-0 rounded-none" />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function formatEventFieldKeySegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
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
            <Skeleton key="loading" className="h-7 w-24 rounded-none" />
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
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : detail}
        className="mt-3 h-[14px]"
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <Skeleton
            key="loading"
            className="h-full w-[min(12rem,72%)] rounded-none"
          />
        ) : (
          <p
            key={detail}
            className="h-[14px] min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground"
          >
            {detail}
          </p>
        )}
      </AutoTransition>
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
  cumulativeLabel,
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
  cumulativeLabel: string;
  onSelectEvent?: (eventName: string) => void;
}) {
  const series = useMemo(
    () => createEventTrendChartSeries(trend.series, labels.other),
    [labels.other, trend.series],
  );
  const chartData = useMemo(
    () => createEventTrendChartData(trend.data, series),
    [series, trend.data],
  );

  return (
    <Card className="overflow-visible">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <CardTitle className="inline-flex items-center gap-2">
            <RiPulseLine className="size-4" />
            {title}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <EventTrendBarChart
          data={chartData}
          series={series}
          locale={locale}
          from={timeWindow.from}
          to={timeWindow.to}
          interval={timeWindow.interval}
          timeZone={timeWindow.timeZone}
          loading={loading}
          emptyLabel={labels.empty}
          cumulativeLabel={cumulativeLabel}
          totalLabel={labels.totalEvents}
          onSelectEvent={onSelectEvent}
        />
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
  align = "left",
  className,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
  align?: "left" | "center" | "right";
  className?: string;
}) {
  return (
    <TableHead
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className={className}
    >
      <div
        className={cn(
          "flex",
          align === "center" && "justify-center",
          align === "right" && "justify-end",
        )}
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
      </div>
    </TableHead>
  );
}

function EventRowSkeletonContent({
  index,
  columns,
}: {
  index: number;
  columns: readonly EventRecordTableColumnId[];
}) {
  const widths: Record<EventRecordTableColumnId, string> = {
    visitor: "w-24",
    eventName: "w-28",
    eventId: "w-24",
    occurredAt: "w-28",
    page: "w-32",
    referrer: "w-40",
    location: "w-24",
    os: "w-28",
    browser: "w-24",
    device: "w-24",
    payload: "w-20",
    nodeCount: "w-16",
  };
  return (
    <>
      {columns.map((columnId) => (
        <TableCell
          key={`${index}-${columnId}`}
          className={columnId === "visitor" ? "pl-4" : undefined}
        >
          {columnId === "visitor" ? (
            <div className="flex items-center gap-2">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
          ) : (
            <Skeleton
              className={cn(
                "h-4",
                widths[columnId],
                ["payload", "nodeCount"].includes(columnId) && "ml-auto",
                columnId === "occurredAt" && "mx-auto",
              )}
            />
          )}
        </TableCell>
      ))}
    </>
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

const EventRecordTableRowContent = memo(function EventRecordTableRowContent({
  locale,
  messages,
  labels,
  row,
  now,
  columns,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: EventPageCopy;
  row: EventRecord;
  now: number;
  columns: readonly EventRecordTableColumnId[];
}) {
  const visitorDisplayId = row.visitorId || row.sessionId || row.visitId;
  const visitorIdentifier = row.visitorId.trim()
    ? { label: messages.realtime.visitorId, value: row.visitorId.trim() }
    : row.sessionId.trim()
      ? { label: messages.sessionDetail.sessionId, value: row.sessionId.trim() }
      : { label: labels.visit, value: row.visitId.trim() };
  const referrerHost = row.referrerHost.trim();
  const cells: Record<EventRecordTableColumnId, ReactNode> = {
    visitor: (
      <TableCell className="max-w-36 pl-4">
        <div className="flex w-28 min-w-0 items-center gap-2">
          <VisitorAvatar
            seed={visitorDisplayId || row.eventId}
            className="size-6"
          />
          <AnalyticsDetailsTooltipTarget
            className="min-w-0 truncate"
            locale={locale}
            request={{
              key: `event-visitor:${row.eventId}:${visitorIdentifier.label}:${visitorIdentifier.value}`,
              items: [
                {
                  label: visitorIdentifier.label,
                  value: visitorIdentifier.value || messages.common.unknown,
                  copyValue: visitorIdentifier.value || undefined,
                },
              ],
            }}
          >
            <span className="min-w-0 truncate font-mono">
              {visitorDisplayId}
            </span>
          </AnalyticsDetailsTooltipTarget>
        </div>
      </TableCell>
    ),
    eventName: (
      <TableCell className="max-w-48">
        <AnalyticsDetailsTooltipTarget
          className="block truncate"
          locale={locale}
          request={{
            key: `event-name:${row.eventId}:${row.eventName}`,
            items: [
              {
                label: labels.eventName,
                value: row.eventName || messages.common.unknown,
                copyValue: row.eventName || undefined,
              },
            ],
          }}
        >
          <span className="block truncate font-medium">{row.eventName}</span>
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    eventId: (
      <TableCell className="max-w-32">
        <AnalyticsDetailsTooltipTarget
          className="block truncate"
          locale={locale}
          request={{
            key: `event-id:${row.eventId}`,
            items: [
              {
                label: labels.eventId,
                value: row.eventId || messages.common.unknown,
                copyValue: row.eventId || undefined,
              },
            ],
          }}
        >
          <span className="block truncate font-mono text-muted-foreground">
            {row.eventId}
          </span>
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    occurredAt: (
      <TableCell className="max-w-36 text-center font-mono text-muted-foreground">
        <AnalyticsTimeTooltipTarget
          className="block truncate"
          locale={locale}
          timestamp={row.occurredAt}
        >
          {formatRelativeTime(locale, row.occurredAt, now)}
        </AnalyticsTimeTooltipTarget>
      </TableCell>
    ),
    page: (
      <TableCell className="max-w-64">
        <AnalyticsDetailsTooltipTarget
          className="block truncate"
          locale={locale}
          request={{
            key: `event-page:${row.eventId}:${row.pathname}`,
            items: [
              {
                label: labels.page,
                value: formatPath(row.pathname),
                copyValue: formatPath(row.pathname),
              },
            ],
          }}
        >
          <span className="block truncate font-mono">
            {formatPath(row.pathname)}
          </span>
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    referrer: (
      <TableCell className="max-w-44">
        <AnalyticsDetailsTooltipTarget
          className="block"
          locale={locale}
          request={{
            key: `event-referrer:${row.eventId}:${referrerHost}`,
            items: [
              referrerHost
                ? {
                    label: messages.common.referrerHost,
                    value: referrerHost,
                    copyValue: referrerHost,
                  }
                : {
                    label: messages.common.referrer,
                    value: messages.overview.direct,
                  },
            ],
          }}
        >
          <ReferrerMeta
            referrerHost={row.referrerHost || ""}
            directLabel={messages.overview.direct}
            className="w-full"
          />
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    location: (
      <TableCell className="max-w-52">
        <AnalyticsDetailsTooltipTarget
          className="block"
          locale={locale}
          request={{
            key: `event-location:${row.eventId}:${row.country}:${row.region}`,
            items: [
              {
                label: messages.common.location,
                value: (
                  <CountryRegionMeta
                    locale={locale}
                    messages={messages}
                    country={row.country || ""}
                    region={row.region}
                    className="max-w-none text-background [&_.text-foreground]:text-background"
                  />
                ),
              },
            ],
          }}
        >
          <CountryRegionMeta
            locale={locale}
            messages={messages}
            country={row.country || ""}
            region={row.region}
            className="w-full"
          />
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    os: (
      <TableCell className="max-w-40">
        <OsMeta
          os={row.os || ""}
          version={row.osVersion}
          unknownLabel={messages.common.unknown}
          className="w-full"
        />
      </TableCell>
    ),
    browser: (
      <TableCell className="max-w-40">
        <BrowserMeta
          browser={row.browser || ""}
          version={row.browserVersion}
          unknownLabel={messages.common.unknown}
          className="w-full"
        />
      </TableCell>
    ),
    device: (
      <TableCell className="max-w-36">
        <DeviceMeta
          deviceType={row.deviceType || ""}
          deviceLabels={messages.common.deviceLabels}
          unknownLabel={messages.common.unknown}
          className="w-full"
        />
      </TableCell>
    ),
    payload: (
      <TableCell className="pr-4 text-right font-mono tabular-nums">
        {numberFormat(locale, row.valueCount)}
      </TableCell>
    ),
    nodeCount: (
      <TableCell className="pr-4 text-right font-mono tabular-nums">
        {numberFormat(locale, row.nodeCount)}
      </TableCell>
    ),
  };

  return (
    <>
      {columns.map((columnId) => (
        <Fragment key={columnId}>{cells[columnId]}</Fragment>
      ))}
    </>
  );
});

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
  onLoadMore,
  visibleColumnIds,
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
  onLoadMore: () => void;
  visibleColumnIds: readonly EventRecordTableColumnId[];
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <AnalyticsDataTable
      minTableWidth="92rem"
      tableClassName="min-w-[92rem]"
      header={
        <TableRow>
          {visibleColumnIds.map((columnId) => {
            const headers: Record<EventRecordTableColumnId, ReactNode> = {
              visitor: <TableHead className="pl-4">{labels.visitor}</TableHead>,
              eventName: (
                <SortHeader
                  label={labels.eventName}
                  active={sort.key === "eventName"}
                  direction={sort.direction}
                  onClick={() => onSort("eventName")}
                />
              ),
              eventId: <TableHead>{labels.eventId}</TableHead>,
              occurredAt: (
                <SortHeader
                  label={labels.occurredAt}
                  active={sort.key === "occurredAt"}
                  direction={sort.direction}
                  onClick={() => onSort("occurredAt")}
                  align="center"
                  className="text-center"
                />
              ),
              page: (
                <SortHeader
                  label={labels.page}
                  active={sort.key === "pathname"}
                  direction={sort.direction}
                  onClick={() => onSort("pathname")}
                />
              ),
              referrer: <TableHead>{labels.referrer}</TableHead>,
              location: <TableHead>{labels.location}</TableHead>,
              os: <TableHead>{labels.os}</TableHead>,
              browser: <TableHead>{labels.browser}</TableHead>,
              device: <TableHead>{labels.device}</TableHead>,
              payload: (
                <TableHead className="pr-4 text-right">
                  {labels.payload}
                </TableHead>
              ),
              nodeCount: (
                <TableHead className="pr-4 text-right">
                  {labels.nodeCount}
                </TableHead>
              ),
            };
            return <Fragment key={columnId}>{headers[columnId]}</Fragment>;
          })}
        </TableRow>
      }
      rows={rows}
      renderRow={(row) => ({
        children: (
          <EventRecordTableRowContent
            locale={locale}
            messages={messages}
            labels={labels}
            row={row}
            now={now}
            columns={visibleColumnIds}
          />
        ),
        props: {
          role: "button",
          tabIndex: 0,
          className:
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          onClick: () => onOpenRecord(row.eventId),
          onKeyDown: (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onOpenRecord(row.eventId);
          },
        },
      })}
      renderSkeletonRow={(index) => (
        <EventRowSkeletonContent index={index} columns={visibleColumnIds} />
      )}
      getRowKey={(row) => row.eventId}
      skeletonRows={EVENT_PAGE_SIZE}
      columnCount={visibleColumnIds.length}
      loading={loadingRows}
      loadingMore={loadingMore}
      error={error}
      errorContent={labels.loadError}
      emptyContent={labels.empty}
      appendError={appendError}
      appendErrorContent={labels.loadError}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      enableTimeTooltips
      messages={messages}
    />
  );
}

function DetailItem({
  label,
  value,
  loading = false,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  loading?: boolean;
  wide?: boolean;
}) {
  const skeletonClassName = wide
    ? "my-1 h-3 w-[min(20rem,88%)]"
    : "my-1 h-3 w-[min(11rem,78%)]";

  return (
    <div className={cn("space-y-1", wide && "sm:col-span-2")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <AutoResizer className="min-w-0" duration={0.2}>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : "ready"}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="flex min-h-5 min-w-0 items-center"
          >
            {loading ? (
              <Skeleton key="loading" className={skeletonClassName} />
            ) : (
              <div key="ready" className="min-h-5 min-w-0 leading-5">
                {value}
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </dd>
    </div>
  );
}

function hasValidEventCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const lat = Number(latitude);
  const lon = Number(longitude);
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function EventRecordPayloadState({
  detail,
  labels,
  loading,
}: {
  detail: EventRecordDetail;
  labels: EventPageCopy;
  loading: boolean;
}) {
  return (
    <AutoResizer className="w-full" duration={0.24}>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.22}
        type="fade"
        presenceMode="wait"
        className="w-full"
      >
        {loading ? (
          <div
            key="loading"
            className="space-y-3 border border-border/70 bg-muted/20 p-4"
          >
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-[78%]" />
            <Skeleton className="h-4 w-[62%]" />
            <Skeleton className="h-4 w-[70%]" />
            <Skeleton className="h-4 w-[48%]" />
          </div>
        ) : (
          <div key="ready" className="w-full">
            <JsonTreePanel value={detail.eventData ?? {}} labels={labels} />
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
}

function EventRecordLocationMap({
  locale,
  messages,
  context,
  loading,
}: {
  locale: Locale;
  messages: AppMessages;
  context: EventRecordDetail["context"];
  loading: boolean;
}) {
  const hasLocation = hasValidEventCoordinate(
    context.latitude,
    context.longitude,
  );
  const points = useMemo<GeoPointsMapPoint[]>(
    () =>
      hasLocation
        ? [
            {
              latitude: Number(context.latitude),
              longitude: Number(context.longitude),
              country: String(context.country ?? ""),
            },
          ]
        : [],
    [context.country, context.latitude, context.longitude, hasLocation],
  );

  return (
    <AutoResizer className="w-full" duration={0.24}>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.22}
        type="fade"
        presenceMode="wait"
        className="w-full"
      >
        {loading ? (
          <Skeleton key="loading" className="h-[11rem] w-full sm:h-[13rem]" />
        ) : (
          <div key="ready" className="w-full">
            <GeoPointsMapIsland
              locale={locale}
              messages={messages}
              points={points}
              emptyLabel={messages.realtime.visitorMapUnavailable}
              heightClassName="h-[11rem] sm:h-[13rem]"
              initialZoom={0.3}
              countryHoverEnabled={false}
            />
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
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
  missingLabel = unknownLabel,
): string {
  if (value === null || value === undefined) return missingLabel;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? formatShortDateTime(locale, value, undefined)
    : unknownLabel;
}

function formatEventDetailDateTimeOrAbsent(
  locale: Locale,
  value: number | null | undefined,
  hasValue: boolean,
  unknownLabel: string,
  absentLabel: string,
): string {
  return hasValue
    ? formatEventDetailDateTime(locale, value, unknownLabel)
    : absentLabel;
}

function formatEventDetailBoolean(
  value: boolean | undefined,
  messages: AppMessages,
): string {
  if (value === undefined) return messages.common.noData;
  if (typeof value !== "boolean") return messages.common.unknown;
  return value ? messages.sessionDetail.yes : messages.sessionDetail.no;
}

function formatEventDetailStatus(
  value: string | undefined,
  messages: AppMessages,
): string {
  const normalized = value?.trim() || "";
  if (!normalized) return messages.common.noData;
  const key = normalized as keyof AppMessages["realtime"]["statusLabels"];
  return key && messages.realtime.statusLabels[key]
    ? messages.realtime.statusLabels[key]
    : messages.common.unknown;
}

function formatEventDetailText(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel = missingLabel,
) {
  const normalized = value?.trim() || "";
  if (!normalized) return missingLabel;
  return ["unknown", "undefined", "null"].includes(
    normalized.toLocaleLowerCase(),
  )
    ? unknownLabel
    : normalized;
}

function formatEventDetailPath(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel: string,
): string {
  const normalized = value?.trim() || "";
  if (!normalized) return missingLabel;
  if (["unknown", "undefined", "null"].includes(normalized.toLowerCase())) {
    return unknownLabel;
  }
  return formatPath(normalized);
}

function formatEventDetailCity(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel: string,
): string {
  const normalized = value?.trim() || "";
  const parsed = parseGeoLocationValue(normalized);
  return formatEventDetailText(
    parsed?.localityName || parsed?.regionName || normalized,
    missingLabel,
    unknownLabel,
  );
}

function formatEventDetailScreen(
  width: number | null | undefined,
  height: number | null | undefined,
  unknownLabel: string,
  missingLabel = unknownLabel,
): string {
  if (width === null || width === undefined) {
    return height === null || height === undefined
      ? missingLabel
      : unknownLabel;
  }
  if (height === null || height === undefined) return unknownLabel;
  const screen = formatScreen(width, height);
  return screen === "/" ? unknownLabel : screen;
}

function formatEventDetailPerformance(
  locale: Locale,
  value: number | null | undefined,
  metric: "ttfb" | "fcp" | "lcp" | "cls" | "inp",
  unknownLabel: string,
  missingLabel = unknownLabel,
): string {
  if (value === null || value === undefined) return missingLabel;
  if (typeof value !== "number" || !Number.isFinite(value)) return unknownLabel;
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
  detail: detailData,
  loading,
  error,
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
  error: boolean;
}) {
  const detail = detailData ?? EVENT_DETAIL_SKELETON_DATA;
  const [nestedDetails, setNestedDetails] = useState<EventRecordNestedDetail[]>(
    [],
  );
  const nestedDetailKeyRef = useRef(0);
  const basePath = pathname.replace(/\/events(?:\/detail)?$/, "");
  const visitorId = detail.context.visitorId.trim();
  const sessionId = detail.context.sessionId.trim();
  const visitorPathname = `${basePath}/visitors`;
  const sessionPathname = `${basePath}/sessions`;
  const nestedDetailOpen = nestedDetails.length > 0;
  const missingDetailLabel = messages.common.noData;
  const unknownDetailLabel = messages.common.unknown;

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
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : detailData?.event.eventName}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-5"
            >
              {loading ? (
                <Skeleton key="loading" className="h-4 w-44" />
              ) : (
                <DrawerDescription key="ready">
                  {detailData?.event.eventName || labels.detailSubtitle}
                </DrawerDescription>
              )}
            </AutoTransition>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            {error ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {labels.loadError}
              </div>
            ) : !detailData && !loading ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {labels.detailNotFound}
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{labels.detailTitle}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={labels.eventId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.event.eventId,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.eventName}
                      value={
                        <span className="break-words text-[11px]">
                          {formatEventDetailText(
                            detail.event.eventName,
                            labels.noEventName,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.occurredAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.event.occurredAt,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.receivedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.event.receivedAt,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.payloadFields}
                      value={
                        <span className="text-[11px]">
                          {numberFormat(locale, detail.event.nodeCount)}{" "}
                          {labels.nodes} /{" "}
                          {numberFormat(locale, detail.event.valueCount)}{" "}
                          {labels.values}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{labels.payload}</h3>
                  <EventRecordPayloadState
                    detail={detail}
                    labels={labels}
                    loading={loading}
                  />
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.realtime.browsingSection}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={messages.common.title}
                      value={
                        <span className="break-words text-[11px]">
                          {formatEventDetailText(
                            detail.context.title,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.hostname}
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.hostname,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.path}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailPath(
                            detail.context.pathname,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.queryString}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.queryString,
                            messages.pages.noQuery,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.pages.hashTab}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.hash,
                            messages.pages.noHash,
                            unknownDetailLabel,
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
                      loading={loading}
                      label={messages.realtime.visitorId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            visitorId,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.userName}
                      value={formatEventDetailText(
                        detail.context.userName,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    {loading || detail.context.userId?.trim() ? (
                      <DetailItem
                        loading={loading}
                        label={messages.realtime.userId}
                        value={
                          <span className="break-all font-mono text-[11px]">
                            {detail.context.userId}
                          </span>
                        }
                      />
                    ) : null}
                    <DetailItem
                      loading={loading}
                      label={labels.browser}
                      value={
                        <BrowserMeta
                          browser={detail.context.browser || ""}
                          version={detail.context.browserVersion}
                          unknownLabel={unknownDetailLabel}
                          missingLabel={missingDetailLabel}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.os}
                      value={
                        <OsMeta
                          os={detail.context.os || ""}
                          version={detail.context.osVersion}
                          unknownLabel={unknownDetailLabel}
                          missingLabel={missingDetailLabel}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.device}
                      value={
                        <DeviceMeta
                          deviceType={detail.context.deviceType || ""}
                          deviceLabels={messages.common.deviceLabels}
                          unknownLabel={unknownDetailLabel}
                          missingLabel={missingDetailLabel}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.userAgent}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.userAgent,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.isEU}
                      value={formatEventDetailBoolean(
                        detail.context.isEU,
                        messages,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.screenSize}
                      value={formatEventDetailScreen(
                        detail.context.screenWidth,
                        detail.context.screenHeight,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.language}
                      value={formatEventDetailText(
                        detail.context.language,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.organization}
                      wide
                      value={formatEventDetailText(
                        detail.context.organization,
                        missingDetailLabel,
                        unknownDetailLabel,
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
                      loading={loading}
                      label={messages.realtime.sessionId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            sessionId,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.visitId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.visitId,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.status}
                      value={formatEventDetailStatus(
                        detail.context.status,
                        messages,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.startedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.context.startedAt,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.previousVisitStartedAt}
                      value={formatEventDetailDateTimeOrAbsent(
                        locale,
                        detail.context.previousVisitStartedAt,
                        Boolean(detail.context.previousVisitId?.trim()),
                        messages.common.unknown,
                        messages.campaigns.notSet,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.endedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.context.endedAt,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.duration}
                      value={
                        detail.context.durationMs === null ||
                        detail.context.durationMs === undefined
                          ? missingDetailLabel
                          : typeof detail.context.durationMs !== "number" ||
                              !Number.isFinite(detail.context.durationMs)
                            ? unknownDetailLabel
                            : formatDuration(locale, detail.context.durationMs)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.durationSource}
                      value={formatEventDetailText(
                        detail.context.durationSource,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.exitReason}
                      value={formatEventDetailText(
                        detail.context.exitReason,
                        missingDetailLabel,
                        unknownDetailLabel,
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
                      loading={loading}
                      label={labels.location}
                      wide
                      value={
                        <CountryRegionMeta
                          locale={locale}
                          messages={messages}
                          country={detail.context.country || ""}
                          region={detail.context.region}
                          city={detail.context.city}
                          missingLabel={missingDetailLabel}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.regionCode}
                      value={formatEventDetailText(
                        detail.context.regionCode,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.city}
                      value={formatEventDetailCity(
                        detail.context.city,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.continent}
                      value={formatEventDetailText(
                        detail.context.continent,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.timezone}
                      value={formatEventDetailText(
                        detail.context.timezone,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.postalCode}
                      value={formatEventDetailText(
                        detail.context.postalCode,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.metroCode}
                      value={formatEventDetailText(
                        detail.context.metroCode,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.latitude}
                      value={
                        detail.context.latitude === null ||
                        detail.context.latitude === undefined
                          ? missingDetailLabel
                          : typeof detail.context.latitude !== "number" ||
                              !Number.isFinite(detail.context.latitude)
                            ? unknownDetailLabel
                            : numberFormat(locale, detail.context.latitude)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.longitude}
                      value={
                        detail.context.longitude === null ||
                        detail.context.longitude === undefined
                          ? missingDetailLabel
                          : typeof detail.context.longitude !== "number" ||
                              !Number.isFinite(detail.context.longitude)
                            ? unknownDetailLabel
                            : numberFormat(locale, detail.context.longitude)
                      }
                    />
                  </dl>
                </section>

                <EventRecordLocationMap
                  locale={locale}
                  messages={messages}
                  context={detail.context}
                  loading={loading}
                />

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.realtime.sourceSection}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
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
                      loading={loading}
                      label={messages.sessionDetail.referrerUrl}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.referrerUrl,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmSource}
                      value={formatEventDetailText(
                        detail.context.utmSource,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmMedium}
                      value={formatEventDetailText(
                        detail.context.utmMedium,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmCampaign}
                      value={formatEventDetailText(
                        detail.context.utmCampaign,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmTerm}
                      value={formatEventDetailText(
                        detail.context.utmTerm,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmContent}
                      value={formatEventDetailText(
                        detail.context.utmContent,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
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
                      loading={loading}
                      label={messages.performance.ttfb}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.ttfb,
                        "ttfb",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.performance.fcp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.fcp,
                        "fcp",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.performance.lcp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.lcp,
                        "lcp",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.performance.cls}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.cls,
                        "cls",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.performance.inp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.inp,
                        "inp",
                        unknownDetailLabel,
                        missingDetailLabel,
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
  const eventColumnDefinitions = useMemo<
    readonly AnalyticsTableColumnDefinition<EventRecordTableColumnId>[]
  >(
    () => [
      { id: "visitor", label: labels.visitor, required: true },
      { id: "eventName", label: labels.eventName, required: true },
      { id: "eventId", label: labels.eventId },
      { id: "occurredAt", label: labels.occurredAt },
      { id: "page", label: labels.page },
      { id: "referrer", label: labels.referrer },
      { id: "location", label: labels.location },
      { id: "os", label: labels.os },
      { id: "browser", label: labels.browser },
      { id: "device", label: labels.device },
      { id: "payload", label: labels.payload },
      { id: "nodeCount", label: labels.nodeCount },
    ],
    [labels],
  );
  const eventColumns = useAnalyticsTableColumns({
    storageKey: "insightflare:analytics-table-columns:events",
    columns: eventColumnDefinitions,
  });
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
  const loadNextPage = useCallback(() => {
    if (loadingInitial || loadingMore || appendError || !hasMore) return;
    void fetchNextPage();
  }, [appendError, fetchNextPage, hasMore, loadingInitial, loadingMore]);

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
      fetchEventRecordDetail(siteId, selectedEventId, timeWindow, {
        signal,
        preserveErrors: true,
      }),
    enabled:
      typeof window !== "undefined" && drawerOpen && Boolean(selectedEventId),
  });
  const detail = detailQuery.data?.data ?? null;
  const detailLoading = detailQuery.isPending && !detail;
  const detailError = detailQuery.isError && !detail;

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

  const openRecord = useCallback((eventId: string) => {
    setSelectedEventId(eventId);
    setDrawerOpen(true);
  }, []);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="inline-flex items-center gap-2 text-sm font-medium">
            <RiFileList3Line className="size-4 shrink-0" />
            {labels.recordsTitle}
          </h2>
        </div>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
            <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={labels.search}
              className="pl-8"
            />
          </div>
          <AnalyticsTableColumnSettings
            columns={eventColumnDefinitions}
            orderedIds={eventColumns.orderedIds}
            visibleIds={eventColumns.visibleIds}
            onOrderChange={eventColumns.setOrder}
            onVisibilityChange={eventColumns.setVisible}
            onReset={eventColumns.reset}
            labels={messages.common.tableColumns}
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
        onLoadMore={loadNextPage}
        visibleColumnIds={eventColumns.visibleIds}
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
        error={detailError}
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
                  <EventFieldTreeSkeleton loadingLabel={labels.loading} />
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
