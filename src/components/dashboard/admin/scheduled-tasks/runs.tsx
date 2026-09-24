import { type KeyboardEvent, useCallback, useMemo } from "react";
import type { RiTimeLine } from "@remixicon/react";
import { RiCloseCircleLine, RiFileList3Line } from "@remixicon/react";

import { AnalyticsDataTable } from "@/components/dashboard/common/analytics-data-table";
import { JsonTreePanel } from "@/components/dashboard/common/json-tree";
import { TableActionButton } from "@/components/dashboard/common/table-action-button";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  durationFormat,
  numberFormat,
  percentFormat,
  shortDateTimeWithSeconds,
} from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type {
  ScheduledTaskRun,
  ScheduledTaskRunGroup,
  ScheduledTaskRunLog,
  ScheduledTaskStatus,
} from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
export const RUN_PAGE_SIZE = 50;
export const RUN_TABLE_COLUMN_COUNT = 10;
export function formatDuration(locale: Locale, value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  if (value < 1000) return `${Math.round(value)}ms`;
  return durationFormat(locale, value);
}
export function formatRate(locale: Locale, value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return percentFormat(locale, value);
}
export function formatDateOrDash(
  locale: Locale,
  value: number | null,
  timeZone: string | undefined,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? shortDateTimeWithSeconds(locale, value, timeZone)
    : "--";
}
export function statusTone(status: ScheduledTaskStatus) {
  if (status === "success") return "text-emerald-600 dark:text-emerald-400";
  if (status === "partial") return "text-amber-600 dark:text-amber-400";
  if (status === "failed") return "text-destructive";
  if (status === "running") return "text-sky-600 dark:text-sky-400";
  return "text-muted-foreground";
}
export function StatusBadge({
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
export function HealthCell({
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
export function summaryValue(
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
export function numericSummaryValue(
  run: ScheduledTaskRun | ScheduledTaskRunGroup,
  key: string,
): number {
  const value = run.summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
export function runSubtaskCount(
  run: ScheduledTaskRun | ScheduledTaskRunGroup,
): number {
  if ("runs" in run) return Number(run.subtaskCount ?? 0);
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
export function runSummaryMetric(
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
export function localizedTaskInfo(
  labels: AppMessages["managementPages"]["scheduledTasks"],
  task: { key: string; name: string; description?: string; schedule?: string },
) {
  const definition =
    task.key === "visit_hourly_rollup"
      ? labels.taskDefinitions.visit_hourly_rollup
      : task.key === "notification_tick"
        ? labels.taskDefinitions.notification_tick
        : task.key === "database_maintenance"
          ? labels.taskDefinitions.database_maintenance
          : null;
  return {
    name: definition?.name ?? task.name,
    description: definition?.description ?? task.description ?? "",
    schedule: definition?.schedule ?? task.schedule ?? "",
  };
}
export function ScheduledRunRowSkeleton({ index }: { index: number }) {
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
export function ScheduledTaskRunsTable({
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
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTableRowElement>, run: ScheduledTaskRunGroup) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onOpenRun(run);
    },
    [onOpenRun],
  );
  const header = useMemo(
    () => (
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
    ),
    [labels],
  );
  const renderRow = useCallback(
    (run: ScheduledTaskRunGroup) => {
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
                {run.skippedCount > 0 ? (
                  <span className="font-mono text-muted-foreground">
                    {labels.status.skipped}:
                    {numberFormat(locale, run.skippedCount)}
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
          role: "button" as const,
          tabIndex: 0,
          className: cn(
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            selected && "bg-muted/55",
          ),
          onClick: () => onOpenRun(run),
          onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) =>
            handleKeyDown(event, run),
        },
      };
    },
    [handleKeyDown, labels, locale, onOpenRun, selectedRunId, timeZone],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => <ScheduledRunRowSkeleton index={index} />,
    [],
  );
  const getRowKey = useCallback((run: ScheduledTaskRunGroup) => run.id, []);
  return (
    <AnalyticsDataTable
      minTableWidth="82rem"
      tableClassName="min-w-[82rem]"
      header={header}
      rows={rows}
      renderRow={renderRow}
      renderSkeletonRow={renderSkeletonRow}
      getRowKey={getRowKey}
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
export function ScheduledTaskLogEntry({
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
export function ScheduledTaskRunLogDrawer({
  open,
  onOpenChange,
  run,
  logs,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  locale,
  timeZone,
  messages,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: ScheduledTaskRunGroup | null;
  logs: readonly ScheduledTaskRunLog[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
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
      <Drawer open={open} onOpenChange={onOpenChange} direction="right">
        <DrawerContent
          data-dashboard-floating-layer="scheduled-task-run-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
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
                                  <div className="flex items-center justify-between gap-2">
                                    <h4 className="text-xs font-medium">
                                      {labels.logs}
                                    </h4>
                                    <span className="font-mono text-[11px] text-muted-foreground">
                                      {numberFormat(locale, taskLogs.length)}
                                    </span>
                                  </div>
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
                          {hasMore ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="w-full"
                              disabled={loadingMore}
                              onClick={onLoadMore}
                            >
                              {loadingMore ? (
                                <span className="inline-flex items-center gap-2">
                                  <Spinner className="size-4" />
                                  {messages.common.loading}
                                </span>
                              ) : (
                                labels.loadMore
                              )}
                            </Button>
                          ) : null}
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
