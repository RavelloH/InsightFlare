import { useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  RiAlarmWarningLine,
  RiCalendarScheduleLine,
  RiCheckboxCircleLine,
  RiRefreshLine,
  RiTimeLine,
} from "@remixicon/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { DataTableSwitch } from "@/components/dashboard/common/data-table-switch";
import { PageHeading } from "@/components/dashboard/common/page-heading";
import { useDashboardQueryControls } from "@/components/dashboard/shell/dashboard-query-provider";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { numberFormat, shortDateTimeWithSeconds } from "@/lib/dashboard/format";
import type { ScheduledTasksInitialData } from "@/lib/dashboard/management-data";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type {
  ScheduledTaskRunGroup,
  ScheduledTasksData,
  ScheduledTaskStatus,
} from "@/lib/scheduled-tasks";

import {
  formatDuration,
  formatRate,
  HealthCell,
  localizedTaskInfo,
  RUN_PAGE_SIZE,
  ScheduledTaskRunLogDrawer,
  ScheduledTaskRunsTable,
  StatusBadge,
} from "./scheduled-tasks/runs";
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
const INITIAL_RUN_META = {
  limit: RUN_PAGE_SIZE,
  returned: 0,
  hasMore: false,
  nextCursor: null,
};
async function fetchScheduledTasks(params: {
  status?: string;
  runId?: string;
  limit?: number;
  cursor?: string | null;
  logLimit?: number;
  logCursor?: string | null;
  signal?: AbortSignal;
}): Promise<ScheduledTasksData> {
  const query: Record<string, string | number> = {
    limit: params.limit ?? RUN_PAGE_SIZE,
  };
  if (params.cursor) query.cursor = params.cursor;
  if (params.status && params.status !== "all") {
    query.status = params.status;
  }
  if (params.runId) {
    query.runId = params.runId;
  }
  if (params.logLimit) query.logLimit = params.logLimit;
  if (params.logCursor) query.logCursor = params.logCursor;
  return requestAdminService<ScheduledTasksData>("scheduled-tasks", {
    params: query,
    signal: params.signal,
  });
}
function appendUniqueRuns(
  current: ScheduledTaskRunGroup[],
  incoming: readonly ScheduledTaskRunGroup[],
): ScheduledTaskRunGroup[] {
  if (current.length === 0) return [...incoming];
  const seen = new Set(current.map((run) => run.id));
  const nextRuns = incoming.filter((run) => !seen.has(run.id));
  return nextRuns.length > 0 ? [...current, ...nextRuns] : current;
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
  const [updatingTaskKey, setUpdatingTaskKey] = useState<string | null>(null);
  const runsQuery = useInfiniteQuery({
    queryKey: ["dashboard", "scheduled-tasks", status],
    queryFn: ({ pageParam, signal }) =>
      fetchScheduledTasks({
        status,
        cursor: pageParam,
        limit: RUN_PAGE_SIZE,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.runs.pagination.hasMore
        ? lastPage.runs.pagination.nextCursor
        : undefined,
    initialData: initialData
      ? {
          pages: [initialData],
          pageParams: [null],
        }
      : undefined,
    initialDataUpdatedAt: initialData?.fetchedAt,
    staleTime: initialData ? 30_000 : 0,
    enabled: typeof window !== "undefined",
  });
  const runs = useMemo(
    () =>
      runsQuery.data?.pages.reduce<ScheduledTaskRunGroup[]>(
        (current, page) => appendUniqueRuns(current, page.runs.items),
        [],
      ) ?? [],
    [runsQuery.data?.pages],
  );
  const data = runsQuery.data?.pages.at(-1) ?? null;
  const runsMeta = data?.runs.pagination ?? INITIAL_RUN_META;
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

  const detailQuery = useInfiniteQuery({
    queryKey: ["dashboard", "scheduled-task-run", selectedRunId],
    queryFn: ({ pageParam, signal }) =>
      fetchScheduledTasks({
        runId: selectedRunId,
        limit: 1,
        cursor: null,
        logLimit: 200,
        logCursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.logs.pagination.hasMore
        ? lastPage.logs.pagination.nextCursor
        : undefined,
    enabled:
      typeof window !== "undefined" && drawerOpen && Boolean(selectedRunId),
  });
  const selectedRun =
    detailQuery.data?.pages.at(-1)?.selectedRun ??
    runs.find((run) => run.id === selectedRunId) ??
    null;
  const selectedLogs = selectedRun
    ? (detailQuery.data?.pages.flatMap((page) => page.logs.items) ?? [])
    : [];
  const detailLoading = detailQuery.isPending;
  const detailLoadingMore = detailQuery.isFetchingNextPage;
  const loadMoreLogs = useEffectEvent(() => {
    if (detailLoadingMore || !detailQuery.hasNextPage) return;
    void detailQuery.fetchNextPage();
  });

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
  async function toggleTask(task: ScheduledTasksData["tasks"][number]) {
    setUpdatingTaskKey(task.key);
    try {
      await requestAdminService<ScheduledTasksData>("scheduled-tasks", {
        method: "PATCH",
        body: { taskKey: task.key, enabled: !task.enabled },
      });
      await runsQuery.refetch();
      toast.success(t.taskStateSaved);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t.taskStateSaveFailed,
      );
    } finally {
      setUpdatingTaskKey(null);
    }
  }
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
            colSpan={9}
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
                <TableHead>{t.nextRun}</TableHead>
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
                    <button
                      type="button"
                      className="cursor-pointer disabled:cursor-wait"
                      disabled={updatingTaskKey === task.key}
                      aria-label={`${taskInfo.name}: ${task.enabled ? t.enabledYes : t.enabledNo}`}
                      onClick={() => void toggleTask(task)}
                    >
                      <Badge variant={task.enabled ? "secondary" : "outline"}>
                        {updatingTaskKey === task.key
                          ? messages.common.loading
                          : task.enabled
                            ? t.enabledYes
                            : t.enabledNo}
                      </Badge>
                    </button>
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
                  <TableCell className="font-mono text-xs">
                    {task.enabled && task.nextRunAt
                      ? shortDateTimeWithSeconds(
                          locale,
                          task.nextRunAt,
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
        loadingMore={detailLoadingMore}
        hasMore={Boolean(detailQuery.hasNextPage)}
        onLoadMore={loadMoreLogs}
        locale={locale}
        timeZone={timeZone}
        messages={messages}
        labels={t}
      />
    </div>
  );
}
