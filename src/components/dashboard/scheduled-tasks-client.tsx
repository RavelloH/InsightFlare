import {
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import {
  RiAlarmWarningLine,
  RiCalendarScheduleLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiFileList3Line,
  RiRefreshLine,
  RiTimeLine,
} from "@remixicon/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { AnalyticsDataTable } from "@/components/dashboard/analytics-data-table";
import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { JsonTreePanel } from "@/components/dashboard/json-tree";
import { PageHeading } from "@/components/dashboard/page-heading";
import { EVENT_RECORD_DRAWER_Z_INDEX } from "@/components/dashboard/site-pages/floating-layer";
import { TableActionButton } from "@/components/dashboard/table-action-button";
import { AutoResizer } from "@/components/ui/auto-resizer";
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
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ModalOverlay, overlayZIndexFor } from "@/components/ui/modal-overlay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { requestAdminService } from "@/lib/admin-service-client";
import {
  durationFormat,
  numberFormat,
  percentFormat,
  shortDateTimeWithSeconds,
} from "@/lib/dashboard/format";
import type { ScheduledTasksInitialData } from "@/lib/dashboard/management-data";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type {
  ScheduledTaskRun,
  ScheduledTaskRunGroup,
  ScheduledTaskRunLog,
  ScheduledTaskRunsMeta,
  ScheduledTasksData,
  ScheduledTaskStatus,
} from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";

interface ScheduledTasksClientProps {
  locale: Locale;
  messages: AppMessages;
  initialData?: ScheduledTasksInitialData | null;
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
const RUN_TABLE_COLUMN_COUNT = 10;
const INITIAL_RUN_META: ScheduledTaskRunsMeta = {
  page: 1,
  pageSize: RUN_PAGE_SIZE,
  returned: 0,
  hasMore: false,
  nextPage: null,
};

async function fetchScheduledTasks(params: {
  status?: string;
  runId?: string;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}): Promise<ScheduledTasksData> {
  const query: Record<string, string | number> = {
    page: params.page ?? 1,
    pageSize: params.pageSize ?? RUN_PAGE_SIZE,
  };
  if (params.status && params.status !== "all") {
    query.status = params.status;
  }
  if (params.runId) {
    query.runId = params.runId;
  }
  return requestAdminService<ScheduledTasksData>("scheduled-tasks", {
    params: query,
    signal: params.signal,
  });
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

function formatDateOrDash(
  locale: Locale,
  value: number | null,
  timeZone: string | undefined,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? shortDateTimeWithSeconds(locale, value, timeZone)
    : "--";
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
  loading = false,
  tone = "default",
}: {
  icon: typeof RiTimeLine;
  label: string;
  value: string;
  detail: string;
  loading?: boolean;
  tone?: "default" | "good" | "warning" | "danger";
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
              className={cn(
                "min-w-0 truncate font-mono text-xl leading-7 font-semibold text-foreground tabular-nums",
                tone === "good" && "text-primary",
                tone === "warning" && "text-amber-500",
                tone === "danger" && "text-destructive",
              )}
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

function summaryValue(
  run: ScheduledTaskRun | ScheduledTaskRunGroup,
  key: string,
): string {
  const value = run.summary[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") return value;
  return "--";
}

function numericSummaryValue(
  run: ScheduledTaskRun | ScheduledTaskRunGroup,
  key: string,
): number {
  const value = run.summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function runSubtaskCount(
  run: ScheduledTaskRun | ScheduledTaskRunGroup,
): number {
  if ("runs" in run) {
    return run.runs.reduce(
      (total, taskRun) => total + runSubtaskCount(taskRun),
      0,
    );
  }
  if (Object.prototype.hasOwnProperty.call(run.summary, "rulesScanned")) {
    return numericSummaryValue(run, "rulesScanned");
  }
  if (Object.prototype.hasOwnProperty.call(run.summary, "candidateSites")) {
    return numericSummaryValue(run, "candidateSites");
  }
  if (Object.prototype.hasOwnProperty.call(run.summary, "sitesProcessed")) {
    return numericSummaryValue(run, "sitesProcessed");
  }
  return 0;
}

function runSummaryMetric(
  labels: AppMessages["managementPages"]["scheduledTasks"],
  run: ScheduledTaskRun | ScheduledTaskRunGroup,
  index: 0 | 1 | 2,
): { label: string; value: string } {
  if (
    Object.prototype.hasOwnProperty.call(run.summary, "rulesScanned") ||
    Object.prototype.hasOwnProperty.call(run.summary, "messagesCreated")
  ) {
    const metrics = [
      { label: labels.rulesScanned, key: "rulesScanned" },
      { label: labels.messagesCreated, key: "messagesCreated" },
      { label: labels.emailFailed, key: "emailFailed" },
    ] as const;
    const metric = metrics[index];
    return { label: metric.label, value: summaryValue(run, metric.key) };
  }
  const metrics = [
    { label: labels.sites, key: "sitesProcessed" },
    { label: labels.hours, key: "hoursAggregated" },
    { label: labels.rows, key: "rollupRowsWritten" },
  ] as const;
  const metric = metrics[index];
  return { label: metric.label, value: summaryValue(run, metric.key) };
}

function localizedTaskInfo(
  labels: AppMessages["managementPages"]["scheduledTasks"],
  task: { key: string; name: string; description?: string; schedule?: string },
) {
  const definition =
    task.key === "visit_hourly_rollup"
      ? labels.taskDefinitions.visit_hourly_rollup
      : task.key === "notification_tick"
        ? labels.taskDefinitions.notification_tick
        : null;
  return {
    name: definition?.name ?? task.name,
    description: definition?.description ?? task.description ?? "",
    schedule: definition?.schedule ?? task.schedule ?? "",
  };
}

function appendUniqueRuns(
  current: ScheduledTaskRunGroup[],
  incoming: ScheduledTaskRunGroup[],
): ScheduledTaskRunGroup[] {
  if (current.length === 0) return incoming;
  const seen = new Set(current.map((run) => run.id));
  const nextRuns = incoming.filter((run) => !seen.has(run.id));
  return nextRuns.length > 0 ? [...current, ...nextRuns] : current;
}

function ScheduledRunRowSkeleton({ index }: { index: number }) {
  const widths = [
    "w-32",
    "w-32",
    "w-32",
    "w-16",
    "w-20",
    "w-20",
    "w-20",
    "w-24",
    "w-16",
    "w-20",
  ];
  return (
    <>
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
    </>
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
  onLoadMore,
}: {
  locale: Locale;
  timeZone: string | undefined;
  labels: AppMessages["managementPages"]["scheduledTasks"];
  rows: ScheduledTaskRunGroup[];
  selectedRunId: string;
  onOpenRun: (run: ScheduledTaskRunGroup) => void;
  loadingRows: boolean;
  loadingMore: boolean;
  error: boolean;
  appendError: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const handleKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    run: ScheduledTaskRunGroup,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpenRun(run);
  };
  return (
    <AnalyticsDataTable
      minTableWidth="82rem"
      tableClassName="min-w-[82rem]"
      header={
        <TableRow>
          <TableHead className="pl-4">{labels.scheduledAt}</TableHead>
          <TableHead>{labels.startedAt}</TableHead>
          <TableHead>{labels.finishedAt}</TableHead>
          <TableHead>{labels.trigger}</TableHead>
          <TableHead>{labels.statusLabel}</TableHead>
          <TableHead className="text-right">{labels.duration}</TableHead>
          <TableHead>{labels.taskResult}</TableHead>
          <TableHead className="text-right">{labels.taskCount}</TableHead>
          <TableHead className="text-right">{labels.subtaskCount}</TableHead>
          <TableHead className="pr-4 text-right">{labels.logs}</TableHead>
        </TableRow>
      }
      rows={rows}
      renderRow={(run) => {
        const selected = selectedRunId === run.id;
        return {
          children: (
            <>
              <TableCell className="pl-4 font-mono text-xs">
                {formatDateOrDash(locale, run.scheduledAt, timeZone)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {shortDateTimeWithSeconds(locale, run.startedAt, timeZone)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {formatDateOrDash(locale, run.finishedAt, timeZone)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {run.triggerType}
              </TableCell>
              <TableCell>
                <StatusBadge status={run.status} labels={labels.status} />
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatDuration(locale, run.durationMs)}
              </TableCell>
              <TableCell>
                <div className="flex min-w-40 flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="outline">
                    {numberFormat(locale, run.taskCount)}
                  </Badge>
                  {run.successCount > 0 ? (
                    <span className="font-mono text-emerald-600 dark:text-emerald-400">
                      {labels.status.success}:
                      {numberFormat(locale, run.successCount)}
                    </span>
                  ) : null}
                  {run.failedCount > 0 ? (
                    <span className="font-mono text-destructive">
                      {labels.status.failed}:
                      {numberFormat(locale, run.failedCount)}
                    </span>
                  ) : null}
                  {run.partialCount > 0 ? (
                    <span className="font-mono text-amber-600 dark:text-amber-400">
                      {labels.status.partial}:
                      {numberFormat(locale, run.partialCount)}
                    </span>
                  ) : null}
                  {run.runningCount > 0 ? (
                    <span className="font-mono text-sky-600 dark:text-sky-400">
                      {labels.status.running}:
                      {numberFormat(locale, run.runningCount)}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="text-right font-mono">
                {numberFormat(locale, run.taskCount)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {numberFormat(locale, runSubtaskCount(run))}
              </TableCell>
              <TableCell className="pr-4 text-right">
                <TableActionButton
                  label={`${numberFormat(locale, run.logsCount)} ${labels.viewLogs}`}
                  onClick={() => onOpenRun(run)}
                  className={cn(selected && "text-foreground")}
                >
                  <RiFileList3Line className="size-4" />
                </TableActionButton>
              </TableCell>
            </>
          ),
          props: {
            role: "button",
            tabIndex: 0,
            className: cn(
              "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
              selected && "bg-muted/55",
            ),
            onClick: () => onOpenRun(run),
            onKeyDown: (event) => handleKeyDown(event, run),
          },
        };
      }}
      renderSkeletonRow={(index) => <ScheduledRunRowSkeleton index={index} />}
      getRowKey={(run) => run.id}
      skeletonRows={RUN_PAGE_SIZE}
      columnCount={RUN_TABLE_COLUMN_COUNT}
      loading={loadingRows}
      loadingMore={loadingMore}
      error={error}
      errorContent={labels.loadFailed}
      emptyContent={labels.noRuns}
      appendError={appendError}
      appendErrorContent={labels.loadFailed}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
    />
  );
}

function ScheduledTaskLogEntry({
  log,
  locale,
  timeZone,
  messages,
}: {
  log: ScheduledTaskRunLog;
  locale: Locale;
  timeZone: string | undefined;
  messages: AppMessages;
}) {
  return (
    <div className="border bg-muted/20 p-3 text-xs">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={cn(
              "truncate font-medium",
              log.level === "error" && "text-destructive",
              log.level === "warn" && "text-amber-600 dark:text-amber-400",
            )}
          >
            {log.event}
          </div>
          <div className="mt-0.5 text-muted-foreground">{log.message}</div>
        </div>
        <div className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {shortDateTimeWithSeconds(locale, log.createdAt, timeZone)}
        </div>
      </div>
      {Object.keys(log.data).length > 0 ? (
        <JsonTreePanel
          value={log.data}
          labels={messages.events}
          className="mt-2 bg-background p-2 pr-9 text-[11px]"
        />
      ) : null}
    </div>
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
  run: ScheduledTaskRunGroup | null;
  logs: ScheduledTaskRunLog[];
  loading: boolean;
  locale: Locale;
  timeZone: string | undefined;
  messages: AppMessages;
  labels: AppMessages["managementPages"]["scheduledTasks"];
}) {
  const logsByRunId = useMemo(() => {
    const grouped = new Map<string, ScheduledTaskRunLog[]>();
    for (const log of logs) {
      const runLogs = grouped.get(log.runId) ?? [];
      runLogs.push(log);
      grouped.set(log.runId, runLogs);
    }
    return grouped;
  }, [logs]);
  const bodyTransitionKey = loading ? "loading" : run ? run.id : "empty";

  return (
    <>
      <ModalOverlay
        layerId="scheduled-task-run-drawer"
        open={open}
        portal
        zIndex={overlayZIndexFor(EVENT_RECORD_DRAWER_Z_INDEX)}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }}
      />
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
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{labels.logTitle}</DrawerTitle>
            <DrawerDescription>
              <AutoResizer animateWidth>
                <AutoTransition
                  transitionKey={run ? run.id : loading ? "loading" : "empty"}
                  type="slide"
                  duration={0.18}
                  className="inline-flex items-center"
                >
                  {run ? (
                    <span key={run.id}>
                      {`${shortDateTimeWithSeconds(locale, run.startedAt, timeZone)} · ${numberFormat(locale, run.taskCount)} ${labels.taskCount}`}
                    </span>
                  ) : loading ? (
                    <span key="loading">{messages.common.loading}</span>
                  ) : (
                    <span key="empty">{labels.noRunSelected}</span>
                  )}
                </AutoTransition>
              </AutoResizer>
            </DrawerDescription>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            <AutoResizer initial>
              <AutoTransition
                transitionKey={bodyTransitionKey}
                initial={false}
                duration={0.18}
                type="fade"
                presenceMode="wait"
              >
                {loading ? (
                  <div
                    key="loading"
                    className="flex h-64 items-center justify-center text-muted-foreground"
                  >
                    <span className="inline-flex items-center gap-2">
                      <Spinner className="size-4" />
                      {messages.common.loading}
                    </span>
                  </div>
                ) : !run ? (
                  <div
                    key="empty"
                    className="flex h-64 items-center justify-center text-muted-foreground"
                  >
                    {labels.noRunSelected}
                  </div>
                ) : (
                  <div key={run.id} className="space-y-5">
                    <section className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge
                          status={run.status}
                          labels={labels.status}
                        />
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
                            {shortDateTimeWithSeconds(
                              locale,
                              run.startedAt,
                              timeZone,
                            )}
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
                          <dt className="text-muted-foreground">
                            {labels.taskCount}
                          </dt>
                          <dd className="font-mono text-xs">
                            {numberFormat(locale, run.taskCount)}
                          </dd>
                        </div>
                        <div className="space-y-1">
                          <dt className="text-muted-foreground">
                            {labels.statusLabel}
                          </dt>
                          <dd>{labels.status[run.status]}</dd>
                        </div>
                      </dl>
                    </section>

                    <section className="space-y-3">
                      <h3 className="text-sm font-medium">{labels.tasks}</h3>
                      {run.runs.length > 0 ? (
                        <div className="space-y-3">
                          {run.runs.map((taskRun) => {
                            const taskLogs = logsByRunId.get(taskRun.id) ?? [];
                            const taskInfo = localizedTaskInfo(labels, {
                              key: taskRun.taskKey,
                              name: taskRun.taskName,
                            });
                            return (
                              <div
                                key={taskRun.id}
                                className="border bg-card p-3"
                              >
                                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-medium">
                                      {taskInfo.name}
                                    </div>
                                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                                      {taskRun.id}
                                    </div>
                                  </div>
                                  <StatusBadge
                                    status={taskRun.status}
                                    labels={labels.status}
                                  />
                                </div>
                                <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
                                  <div className="space-y-1">
                                    <dt className="text-muted-foreground">
                                      {labels.duration}
                                    </dt>
                                    <dd className="font-mono">
                                      {formatDuration(
                                        locale,
                                        taskRun.durationMs,
                                      )}
                                    </dd>
                                  </div>
                                  {[0, 1].map((index) => {
                                    const metric = runSummaryMetric(
                                      labels,
                                      taskRun,
                                      index as 0 | 1,
                                    );
                                    return (
                                      <div
                                        key={metric.label}
                                        className="space-y-1"
                                      >
                                        <dt className="text-muted-foreground">
                                          {metric.label}
                                        </dt>
                                        <dd className="font-mono">
                                          {metric.value}
                                        </dd>
                                      </div>
                                    );
                                  })}
                                </dl>
                                {taskRun.errorMessage ? (
                                  <div className="mt-3 border border-destructive/30 bg-destructive/5 p-3 text-sm">
                                    <div className="flex items-center gap-2 font-medium text-destructive">
                                      <RiCloseCircleLine className="size-4" />
                                      {taskRun.errorName ?? labels.error}
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {taskRun.errorMessage}
                                    </p>
                                  </div>
                                ) : null}
                                <div className="mt-3 space-y-2">
                                  <h4 className="text-xs font-medium">
                                    {labels.logs}
                                  </h4>
                                  {taskLogs.length > 0 ? (
                                    taskLogs.map((log) => (
                                      <ScheduledTaskLogEntry
                                        key={log.id}
                                        log={log}
                                        locale={locale}
                                        timeZone={timeZone}
                                        messages={messages}
                                      />
                                    ))
                                  ) : (
                                    <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                                      {loading ? (
                                        <span className="inline-flex items-center gap-2">
                                          <Spinner className="size-4" />
                                          {messages.common.loading}
                                        </span>
                                      ) : (
                                        labels.noLogs
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                          {loading ? (
                            <span className="inline-flex items-center gap-2">
                              <Spinner className="size-4" />
                              {messages.common.loading}
                            </span>
                          ) : (
                            labels.noLogs
                          )}
                        </div>
                      )}
                    </section>
                  </div>
                )}
              </AutoTransition>
            </AutoResizer>
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>
    </>
  );
}

export function ScheduledTasksClient({
  locale,
  messages,
  initialData = null,
}: ScheduledTasksClientProps) {
  const t = messages.managementPages.scheduledTasks;
  const { timeZone } = useDashboardQueryControls();
  const [status, setStatus] = useState("all");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const runsQuery = useInfiniteQuery({
    queryKey: ["dashboard", "scheduled-tasks", status],
    queryFn: ({ pageParam, signal }) =>
      fetchScheduledTasks({
        status,
        page: pageParam,
        pageSize: RUN_PAGE_SIZE,
        signal,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.runsMeta.hasMore
        ? (lastPage.runsMeta.nextPage ?? undefined)
        : undefined,
    initialData: initialData
      ? {
          pages: [initialData],
          pageParams: [1],
        }
      : undefined,
    initialDataUpdatedAt: initialData?.fetchedAt,
    staleTime: initialData ? 30_000 : 0,
    enabled: typeof window !== "undefined",
  });
  const runs = useMemo(
    () =>
      runsQuery.data?.pages.reduce<ScheduledTaskRunGroup[]>(
        (current, page) => appendUniqueRuns(current, page.runs),
        [],
      ) ?? [],
    [runsQuery.data?.pages],
  );
  const data = runsQuery.data?.pages.at(-1) ?? null;
  const runsMeta = data?.runsMeta ?? INITIAL_RUN_META;
  const loadingInitial = runsQuery.isPending;
  const loadingMore = runsQuery.isFetchingNextPage;
  const error = runsQuery.isError && runs.length === 0;
  const appendError = runsQuery.isFetchNextPageError;
  const replacingRows =
    runsQuery.isPending ||
    (runsQuery.isFetching && !runsQuery.isFetchingNextPage);

  const loadNextPage = useEffectEvent(() => {
    if (
      loadingInitial ||
      loadingMore ||
      appendError ||
      !runsQuery.hasNextPage
    ) {
      return;
    }
    void runsQuery.fetchNextPage();
  });

  const detailQuery = useQuery({
    queryKey: ["dashboard", "scheduled-task-run", selectedRunId],
    queryFn: ({ signal }) =>
      fetchScheduledTasks({
        runId: selectedRunId,
        page: 1,
        pageSize: 1,
        signal,
      }),
    enabled:
      typeof window !== "undefined" && drawerOpen && Boolean(selectedRunId),
  });
  const selectedRun =
    detailQuery.data?.selectedRun ??
    runs.find((run) => run.id === selectedRunId) ??
    null;
  const selectedLogs = selectedRun ? (detailQuery.data?.logs ?? []) : [];
  const detailLoading = detailQuery.isPending;

  useEffect(() => {
    if (!runsQuery.isError || runs.length > 0) return;
    const message =
      runsQuery.error instanceof Error ? runsQuery.error.message : t.loadFailed;
    toast.error(message || t.loadFailed);
  }, [
    runs.length,
    runsQuery.error,
    runsQuery.errorUpdatedAt,
    runsQuery.isError,
    t.loadFailed,
  ]);

  useEffect(() => {
    if (!detailQuery.isError) return;
    const message =
      detailQuery.error instanceof Error
        ? detailQuery.error.message
        : t.loadFailed;
    toast.error(message || t.loadFailed);
  }, [
    detailQuery.error,
    detailQuery.errorUpdatedAt,
    detailQuery.isError,
    t.loadFailed,
  ]);

  const resetSelection = () => {
    setSelectedRunId("");
    setDrawerOpen(false);
  };
  const openRun = (run: ScheduledTaskRunGroup) => {
    setSelectedRunId(run.id);
    setDrawerOpen(true);
  };
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
              onClick={() => void runsQuery.refetch()}
            >
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                {replacingRows ? (
                  <Spinner className="size-4" />
                ) : (
                  <RiRefreshLine className="size-4" />
                )}
              </span>
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
                  <span key={replacingRows ? "loading" : "refresh"}>
                    {replacingRows ? messages.common.loading : t.refresh}
                  </span>
                </AutoTransition>
              </AutoResizer>
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
              loading={replacingRows}
              value={numberFormat(locale, data?.health.totalRuns24h ?? 0)}
              detail={`${t.retentionPrefix} ${data?.retentionDays ?? 30} ${t.days}`}
            />
            <HealthCell
              icon={RiCheckboxCircleLine}
              label={t.successRate24h}
              loading={replacingRows}
              value={formatRate(locale, data?.health.successRate24h ?? null)}
              detail={t.successRateDescription}
              tone={
                (data?.health.successRate24h ?? 1) >= 0.95 ? "good" : "warning"
              }
            />
            <HealthCell
              icon={RiAlarmWarningLine}
              label={t.problemRuns24h}
              loading={replacingRows}
              value={numberFormat(locale, failedOrPartial)}
              detail={`${t.failed}: ${numberFormat(locale, data?.health.failedRuns24h ?? 0)} / ${t.partial}: ${numberFormat(locale, data?.health.partialRuns24h ?? 0)}`}
              tone={failedOrPartial > 0 ? "danger" : "good"}
            />
            <HealthCell
              icon={RiTimeLine}
              label={t.lastRun}
              loading={replacingRows}
              value={
                data?.health.lastRunAt
                  ? shortDateTimeWithSeconds(
                      locale,
                      data.health.lastRunAt,
                      timeZone,
                    )
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
          <CardTitle className="inline-flex items-center gap-2">
            <RiCalendarScheduleLine className="size-4" />
            {t.taskListTitle}
          </CardTitle>
          <CardDescription>{t.taskListDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={replacingRows}
            hasContent={(data?.tasks.length ?? 0) > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={t.empty}
            colSpan={8}
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
            rows={(data?.tasks ?? []).map((task) => {
              const taskInfo = localizedTaskInfo(t, task);
              return (
                <TableRow key={task.key}>
                  <TableCell>
                    <div className="min-w-0">
                      <div className="font-medium">{taskInfo.name}</div>
                      <div className="max-w-md truncate text-xs text-muted-foreground">
                        {taskInfo.description}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {taskInfo.schedule}
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
                      ? shortDateTimeWithSeconds(
                          locale,
                          task.lastRun.startedAt,
                          timeZone,
                        )
                      : "--"}
                  </TableCell>
                </TableRow>
              );
            })}
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
          onLoadMore={loadNextPage}
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
