"use client";

import {
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  RiAlarmWarningLine,
  RiCalendarScheduleLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiRefreshLine,
  RiTimeLine,
} from "@remixicon/react";
import { toast } from "sonner";

import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { JsonTree } from "@/components/dashboard/json-tree";
import { PageHeading } from "@/components/dashboard/page-heading";
import {
  EVENT_RECORD_DRAWER_OVERLAY_Z_INDEX,
  EVENT_RECORD_DRAWER_Z_INDEX,
  FLOATING_LAYER_Z_ATTR,
} from "@/components/dashboard/site-pages/floating-layer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchPrivateJson } from "@/lib/dashboard/client-request";
import {
  durationFormat,
  numberFormat,
  percentFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type {
  ScheduledTaskRun,
  ScheduledTaskRunLog,
  ScheduledTaskRunsMeta,
  ScheduledTasksData,
  ScheduledTaskStatus,
} from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";

interface ScheduledTasksClientProps {
  locale: Locale;
  messages: AppMessages;
}

const STATUS_OPTIONS: Array<ScheduledTaskStatus | "all"> = [
  "all",
  "running",
  "success",
  "partial",
  "failed",
  "skipped",
];
const RUN_PAGE_SIZE = 50;
const RUN_SKELETON_ROWS = 8;
const INITIAL_RUN_META: ScheduledTaskRunsMeta = {
  page: 1,
  pageSize: RUN_PAGE_SIZE,
  returned: 0,
  hasMore: false,
  nextPage: null,
};

async function fetchScheduledTasks(params: {
  taskKey?: string;
  status?: string;
  runId?: string;
  page?: number;
  pageSize?: number;
}): Promise<ScheduledTasksData> {
  const query: Record<string, string | number> = {
    page: params.page ?? 1,
    pageSize: params.pageSize ?? RUN_PAGE_SIZE,
  };
  if (params.taskKey && params.taskKey !== "all") {
    query.taskKey = params.taskKey;
  }
  if (params.status && params.status !== "all") {
    query.status = params.status;
  }
  if (params.runId) {
    query.runId = params.runId;
  }
  return fetchPrivateJson<ScheduledTasksData>(
    "/api/private/admin/scheduled-tasks",
    query,
    { dedupe: false },
  );
}

function formatDuration(locale: Locale, value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  if (value < 1000) return `${Math.round(value)}ms`;
  return durationFormat(locale, value);
}

function formatRate(locale: Locale, value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return percentFormat(locale, value);
}

function statusTone(status: ScheduledTaskStatus) {
  if (status === "success") return "text-emerald-600 dark:text-emerald-400";
  if (status === "partial") return "text-amber-600 dark:text-amber-400";
  if (status === "failed") return "text-destructive";
  if (status === "running") return "text-sky-600 dark:text-sky-400";
  return "text-muted-foreground";
}

function StatusBadge({
  status,
  labels,
}: {
  status: ScheduledTaskStatus;
  labels: AppMessages["managementPages"]["scheduledTasks"]["status"];
}) {
  const text = labels[status];
  const variant =
    status === "failed"
      ? "destructive"
      : status === "success"
        ? "secondary"
        : "outline";
  return (
    <Badge variant={variant} className={cn("capitalize", statusTone(status))}>
      {text}
    </Badge>
  );
}

function HealthCell({
  icon: Icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: typeof RiTimeLine;
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "good" | "warning" | "danger";
}) {
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
      <AutoTransition
        transitionKey={value}
        initial={false}
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        <p
          key={value}
          className={cn(
            "mt-3 min-w-0 truncate font-mono text-xl leading-7 font-semibold text-foreground tabular-nums",
            tone === "good" && "text-primary",
            tone === "warning" && "text-amber-500",
            tone === "danger" && "text-destructive",
          )}
        >
          {value}
        </p>
      </AutoTransition>
      <p className="mt-3 min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function summaryValue(run: ScheduledTaskRun, key: string): string {
  const value = run.summary[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") return value;
  return "--";
}

function appendUniqueRuns(
  current: ScheduledTaskRun[],
  incoming: ScheduledTaskRun[],
): ScheduledTaskRun[] {
  if (current.length === 0) return incoming;
  const seen = new Set(current.map((run) => run.id));
  const nextRuns = incoming.filter((run) => !seen.has(run.id));
  return nextRuns.length > 0 ? [...current, ...nextRuns] : current;
}

function ScheduledRunRowSkeleton({
  index,
  sentinelRef,
}: {
  index: number;
  sentinelRef?: (node: HTMLTableRowElement | null) => void;
}) {
  const widths = [
    "w-32",
    "w-44",
    "w-24",
    "w-20",
    "w-16",
    "w-16",
    "w-20",
    "w-20",
  ];
  return (
    <TableRow ref={sentinelRef} aria-hidden="true">
      {widths.map((width, cellIndex) => (
        <TableCell
          key={`${index}-${cellIndex}`}
          className={cn(
            cellIndex === 0 && "pl-4",
            cellIndex === widths.length - 1 && "pr-4",
          )}
        >
          <Skeleton className={cn("h-4", width)} />
        </TableCell>
      ))}
    </TableRow>
  );
}

function ScheduledTaskRunsTable({
  locale,
  timeZone,
  labels,
  rows,
  selectedRunId,
  onOpenRun,
  loadingRows,
  loadingMore,
  error,
  appendError,
  hasMore,
  sentinelRef,
}: {
  locale: Locale;
  timeZone: string | undefined;
  labels: AppMessages["managementPages"]["scheduledTasks"];
  rows: ScheduledTaskRun[];
  selectedRunId: string;
  onOpenRun: (run: ScheduledTaskRun) => void;
  loadingRows: boolean;
  loadingMore: boolean;
  error: boolean;
  appendError: boolean;
  hasMore: boolean;
  sentinelRef?: (node: HTMLTableRowElement | null) => void;
}) {
  const handleKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    run: ScheduledTaskRun,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpenRun(run);
  };
  const bodyState = loadingRows
    ? "loading"
    : error
      ? "error"
      : rows.length === 0 && !hasMore
        ? "empty"
        : "rows";

  return (
    <Card className="py-0">
      <CardContent className="px-0">
        <Table className="min-w-[58rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{labels.startedAt}</TableHead>
              <TableHead>{labels.task}</TableHead>
              <TableHead>{labels.statusLabel}</TableHead>
              <TableHead className="text-right">{labels.duration}</TableHead>
              <TableHead className="text-right">{labels.sites}</TableHead>
              <TableHead className="text-right">{labels.hours}</TableHead>
              <TableHead className="text-right">{labels.rows}</TableHead>
              <TableHead className="pr-4 text-right">{labels.logs}</TableHead>
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
              Array.from({ length: RUN_SKELETON_ROWS }, (_, index) => (
                <ScheduledRunRowSkeleton key={index} index={index} />
              ))
            ) : error ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-28 text-center text-muted-foreground"
                >
                  {labels.loadFailed}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 && !hasMore ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-28 text-center text-muted-foreground"
                >
                  {labels.noRuns}
                </TableCell>
              </TableRow>
            ) : (
              <>
                {rows.map((run) => {
                  const selected = selectedRunId === run.id;
                  return (
                    <TableRow
                      key={run.id}
                      role="button"
                      tabIndex={0}
                      className={cn(
                        "group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                        selected && "bg-muted/55",
                      )}
                      onClick={() => onOpenRun(run)}
                      onKeyDown={(event) => handleKeyDown(event, run)}
                    >
                      <TableCell className="pl-4 font-mono text-xs">
                        {shortDateTime(locale, run.startedAt, timeZone)}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{run.taskName}</div>
                        <div className="text-xs text-muted-foreground">
                          {run.triggerType}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={run.status}
                          labels={labels.status}
                        />
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatDuration(locale, run.durationMs)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {summaryValue(run, "sitesProcessed")}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {summaryValue(run, "hoursAggregated")}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {summaryValue(run, "rollupRowsWritten")}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <span
                          className={cn(
                            "inline-flex h-7 items-center px-2 text-xs font-medium transition-colors",
                            selected
                              ? "bg-secondary text-secondary-foreground"
                              : "text-muted-foreground group-hover:text-foreground",
                          )}
                        >
                          {labels.viewLogs}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {appendError ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="h-16 text-center text-muted-foreground"
                    >
                      {labels.loadFailed}
                    </TableCell>
                  </TableRow>
                ) : hasMore ? (
                  Array.from({ length: RUN_SKELETON_ROWS }, (_, index) => (
                    <ScheduledRunRowSkeleton
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
      </CardContent>
    </Card>
  );
}

function ScheduledTaskRunLogDrawer({
  open,
  onOpenChange,
  run,
  logs,
  loading,
  locale,
  timeZone,
  messages,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: ScheduledTaskRun | null;
  logs: ScheduledTaskRunLog[];
  loading: boolean;
  locale: Locale;
  timeZone: string | undefined;
  messages: AppMessages;
  labels: AppMessages["managementPages"]["scheduledTasks"];
}) {
  const overlay =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            aria-hidden="true"
            data-dashboard-floating-layer="scheduled-task-run-drawer-overlay"
            className="pointer-events-auto fixed inset-0 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
            style={{ zIndex: EVENT_RECORD_DRAWER_OVERLAY_Z_INDEX }}
            {...{
              [FLOATING_LAYER_Z_ATTR]: EVENT_RECORD_DRAWER_OVERLAY_Z_INDEX,
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }}
          />,
          document.body,
        )
      : null;

  return (
    <>
      {overlay}
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        direction="right"
        modal={false}
      >
        <DrawerContent
          data-dashboard-floating-layer="scheduled-task-run-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
          style={{ zIndex: EVENT_RECORD_DRAWER_Z_INDEX }}
          {...{
            [FLOATING_LAYER_Z_ATTR]: EVENT_RECORD_DRAWER_Z_INDEX,
          }}
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{labels.logTitle}</DrawerTitle>
            <DrawerDescription>
              {run
                ? `${run.taskName} · ${shortDateTime(locale, run.startedAt, timeZone)}`
                : loading
                  ? messages.common.loading
                  : labels.noRunSelected}
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {loading && !run ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Spinner className="size-4" />
                  {messages.common.loading}
                </span>
              </div>
            ) : !run ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {labels.noRunSelected}
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={run.status} labels={labels.status} />
                    <span className="font-mono text-xs text-muted-foreground">
                      {run.id}
                    </span>
                  </div>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <dt className="text-muted-foreground">
                        {labels.startedAt}
                      </dt>
                      <dd className="font-mono text-xs">
                        {shortDateTime(locale, run.startedAt, timeZone)}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-muted-foreground">
                        {labels.duration}
                      </dt>
                      <dd className="font-mono text-xs">
                        {formatDuration(locale, run.durationMs)}
                      </dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-muted-foreground">{labels.task}</dt>
                      <dd>{run.taskName}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-muted-foreground">
                        {labels.statusLabel}
                      </dt>
                      <dd>{labels.status[run.status]}</dd>
                    </div>
                  </dl>
                </section>

                {run.errorMessage ? (
                  <section className="border border-destructive/30 bg-destructive/5 p-3 text-sm">
                    <div className="flex items-center gap-2 font-medium text-destructive">
                      <RiCloseCircleLine className="size-4" />
                      {run.errorName ?? labels.error}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {run.errorMessage}
                    </p>
                  </section>
                ) : null}

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{labels.logs}</h3>
                  {logs.length > 0 ? (
                    <div className="space-y-2">
                      {logs.map((log) => (
                        <div
                          key={log.id}
                          className="border bg-muted/20 p-3 text-xs"
                        >
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div
                                className={cn(
                                  "truncate font-medium",
                                  log.level === "error" && "text-destructive",
                                  log.level === "warn" &&
                                    "text-amber-600 dark:text-amber-400",
                                )}
                              >
                                {log.event}
                              </div>
                              <div className="mt-0.5 text-muted-foreground">
                                {log.message}
                              </div>
                            </div>
                            <div className="shrink-0 font-mono text-[11px] text-muted-foreground">
                              {shortDateTime(locale, log.createdAt, timeZone)}
                            </div>
                          </div>
                          {Object.keys(log.data).length > 0 ? (
                            <div className="mt-2 overflow-x-auto border bg-background p-2 font-mono text-[11px] leading-relaxed">
                              <JsonTree
                                value={log.data}
                                labels={messages.events}
                              />
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                      {loading ? messages.common.loading : labels.noLogs}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

export function ScheduledTasksClient({
  locale,
  messages,
}: ScheduledTasksClientProps) {
  const t = messages.managementPages.scheduledTasks;
  const { timeZone } = useDashboardQueryControls();
  const [data, setData] = useState<ScheduledTasksData | null>(null);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [runsMeta, setRunsMeta] =
    useState<ScheduledTaskRunsMeta>(INITIAL_RUN_META);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [appendError, setAppendError] = useState(false);
  const [sentinelNode, setSentinelNode] = useState<HTMLTableRowElement | null>(
    null,
  );
  const latestRequestKeyRef = useRef("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [taskKey, setTaskKey] = useState("all");
  const [status, setStatus] = useState("all");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<ScheduledTaskRun | null>(null);
  const [selectedLogs, setSelectedLogs] = useState<ScheduledTaskRunLog[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const requestKey = useMemo(
    () => [taskKey, status, refreshNonce].join(":"),
    [refreshNonce, status, taskKey],
  );
  const replacingRows =
    loadingInitial || latestRequestKeyRef.current !== requestKey;

  const loadPage = useEffectEvent(
    async (page: number, mode: "replace" | "append") => {
      const capturedRequestKey = latestRequestKeyRef.current;
      if (mode === "replace") {
        setLoadingInitial(true);
        setError(false);
        setAppendError(false);
      } else {
        setLoadingMore(true);
        setAppendError(false);
      }

      try {
        const payload = await fetchScheduledTasks({
          taskKey,
          status,
          page,
          pageSize: RUN_PAGE_SIZE,
        });
        if (latestRequestKeyRef.current !== capturedRequestKey) return;
        setRuns((current) =>
          mode === "append"
            ? appendUniqueRuns(current, payload.runs)
            : payload.runs,
        );
        setRunsMeta(payload.runsMeta);
        setData((current) =>
          mode === "append" && current
            ? {
                ...current,
                generatedAt: payload.generatedAt,
                retentionDays: payload.retentionDays,
                tasks: payload.tasks,
                health: payload.health,
              }
            : payload,
        );
        setError(false);
        setAppendError(false);
      } catch (caught) {
        if (latestRequestKeyRef.current !== capturedRequestKey) return;
        if (mode === "replace") {
          const message =
            caught instanceof Error ? caught.message : t.loadFailed;
          setRuns([]);
          setRunsMeta(INITIAL_RUN_META);
          setError(true);
          setAppendError(false);
          toast.error(message || t.loadFailed);
        } else {
          setAppendError(true);
        }
      } finally {
        if (latestRequestKeyRef.current === capturedRequestKey) {
          if (mode === "replace") {
            setLoadingInitial(false);
          } else {
            setLoadingMore(false);
          }
        }
      }
    },
  );

  const loadNextPage = useEffectEvent(() => {
    if (
      loadingInitial ||
      loadingMore ||
      appendError ||
      !runsMeta.hasMore ||
      runsMeta.nextPage === null
    ) {
      return;
    }
    void loadPage(runsMeta.nextPage, "append");
  });

  useEffect(() => {
    latestRequestKeyRef.current = requestKey;
    setRuns([]);
    setRunsMeta(INITIAL_RUN_META);
    setError(false);
    setAppendError(false);
    setSentinelNode(null);
    void loadPage(1, "replace");
  }, [requestKey]);

  useEffect(() => {
    const target = sentinelNode;
    if (
      !target ||
      loadingInitial ||
      loadingMore ||
      appendError ||
      error ||
      !runsMeta.hasMore ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          loadNextPage();
        }
      },
      {
        root: null,
        rootMargin: "360px 0px",
        threshold: 0.01,
      },
    );

    observer.observe(target);
    const frameId = window.requestAnimationFrame(() => {
      const rect = target.getBoundingClientRect();
      if (rect.top <= window.innerHeight + 480 && rect.bottom >= -480) {
        loadNextPage();
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [
    appendError,
    error,
    loadingInitial,
    loadingMore,
    runsMeta.hasMore,
    runsMeta.nextPage,
    sentinelNode,
  ]);

  useEffect(() => {
    if (!drawerOpen || !selectedRunId) return;
    let active = true;
    setDetailLoading(true);
    fetchScheduledTasks({
      runId: selectedRunId,
      page: 1,
      pageSize: 1,
    })
      .then((payload) => {
        if (!active) return;
        setSelectedRun(payload.selectedRun);
        setSelectedLogs(payload.selectedRun ? payload.logs : []);
      })
      .catch((caught) => {
        if (!active) return;
        const message = caught instanceof Error ? caught.message : t.loadFailed;
        setSelectedLogs([]);
        toast.error(message || t.loadFailed);
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [drawerOpen, selectedRunId, t.loadFailed]);

  const resetSelection = () => {
    setSelectedRunId("");
    setSelectedRun(null);
    setSelectedLogs([]);
    setDrawerOpen(false);
  };
  const openRun = (run: ScheduledTaskRun) => {
    setSelectedRunId(run.id);
    setSelectedRun(run);
    setSelectedLogs([]);
    setDrawerOpen(true);
  };
  const taskOptions = useMemo(
    () => [
      { key: "all", name: t.allTasks },
      ...(data?.tasks.map((task) => ({ key: task.key, name: task.name })) ??
        []),
    ],
    [data?.tasks, t.allTasks],
  );
  const failedOrPartial =
    (data?.health.failedRuns24h ?? 0) + (data?.health.partialRuns24h ?? 0);

  return (
    <div className="space-y-5">
      <PageHeading
        title={messages.managementNav.scheduledTasks}
        subtitle={t.subtitle}
        actions={
          <>
            <Select
              value={taskKey}
              onValueChange={(value) => {
                setTaskKey(value);
                resetSelection();
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {taskOptions.map((task) => (
                  <SelectItem key={task.key} value={task.key}>
                    {task.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                resetSelection();
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === "all" ? t.allStatuses : t.status[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={replacingRows}
              onClick={() => setRefreshNonce((value) => value + 1)}
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {replacingRows ? (
                  <span
                    key="loading"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {messages.common.loading}
                  </span>
                ) : (
                  <span
                    key="refresh"
                    className="inline-flex items-center gap-2"
                  >
                    <RiRefreshLine className="size-4" />
                    {t.refresh}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </>
        }
      />

      <Card className="py-0">
        <CardContent className="p-0">
          <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
            <HealthCell
              icon={RiCalendarScheduleLine}
              label={t.runs24h}
              value={numberFormat(locale, data?.health.totalRuns24h ?? 0)}
              detail={`${t.retentionPrefix} ${data?.retentionDays ?? 30} ${t.days}`}
            />
            <HealthCell
              icon={RiCheckboxCircleLine}
              label={t.successRate24h}
              value={formatRate(locale, data?.health.successRate24h ?? null)}
              detail={t.successRateDescription}
              tone={
                (data?.health.successRate24h ?? 1) >= 0.95 ? "good" : "warning"
              }
            />
            <HealthCell
              icon={RiAlarmWarningLine}
              label={t.problemRuns24h}
              value={numberFormat(locale, failedOrPartial)}
              detail={`${t.failed}: ${numberFormat(locale, data?.health.failedRuns24h ?? 0)} / ${t.partial}: ${numberFormat(locale, data?.health.partialRuns24h ?? 0)}`}
              tone={failedOrPartial > 0 ? "danger" : "good"}
            />
            <HealthCell
              icon={RiTimeLine}
              label={t.lastRun}
              value={
                data?.health.lastRunAt
                  ? shortDateTime(locale, data.health.lastRunAt, timeZone)
                  : "--"
              }
              detail={
                data?.health.staleRunningRuns
                  ? `${t.staleRunning}: ${numberFormat(locale, data.health.staleRunningRuns)}`
                  : t.noStaleRunning
              }
              tone={data?.health.staleRunningRuns ? "warning" : "default"}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.taskListTitle}</CardTitle>
          <CardDescription>{t.taskListDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={replacingRows}
            hasContent={(data?.tasks.length ?? 0) > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={t.empty}
            colSpan={8}
            animate={false}
            header={
              <TableRow>
                <TableHead>{t.task}</TableHead>
                <TableHead>{t.schedule}</TableHead>
                <TableHead>{t.enabled}</TableHead>
                <TableHead>{t.lastStatus}</TableHead>
                <TableHead className="text-right">{t.runs30d}</TableHead>
                <TableHead className="text-right">{t.successRate30d}</TableHead>
                <TableHead className="text-right">{t.avgDuration}</TableHead>
                <TableHead>{t.lastRun}</TableHead>
              </TableRow>
            }
            rows={(data?.tasks ?? []).map((task) => (
              <TableRow key={task.key}>
                <TableCell>
                  <div className="min-w-0">
                    <div className="font-medium">{task.name}</div>
                    <div className="max-w-md truncate text-xs text-muted-foreground">
                      {task.description}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {task.schedule}
                </TableCell>
                <TableCell>
                  <Badge variant={task.enabled ? "secondary" : "outline"}>
                    {task.enabled ? t.enabledYes : t.enabledNo}
                  </Badge>
                </TableCell>
                <TableCell>
                  {task.lastRun ? (
                    <StatusBadge
                      status={task.lastRun.status}
                      labels={t.status}
                    />
                  ) : (
                    "--"
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {numberFormat(locale, task.runs30d)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatRate(locale, task.successRate30d)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatDuration(locale, task.avgDurationMs)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {task.lastRun
                    ? shortDateTime(locale, task.lastRun.startedAt, timeZone)
                    : "--"}
                </TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">{t.runHistoryTitle}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.runHistoryDescription}
          </p>
        </div>
        <ScheduledTaskRunsTable
          locale={locale}
          timeZone={timeZone}
          labels={t}
          rows={runs}
          selectedRunId={selectedRunId}
          onOpenRun={openRun}
          loadingRows={replacingRows}
          loadingMore={loadingMore}
          error={error}
          appendError={appendError}
          hasMore={runsMeta.hasMore}
          sentinelRef={setSentinelNode}
        />
      </section>

      <ScheduledTaskRunLogDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        run={selectedRun}
        logs={selectedLogs}
        loading={detailLoading}
        locale={locale}
        timeZone={timeZone}
        messages={messages}
        labels={t}
      />
    </div>
  );
}
