import { useCallback, useMemo, useState } from "react";
import { RiAddLine, RiCloseLine, RiDeleteBinLine } from "@remixicon/react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeading } from "@/components/dashboard/page-heading";
import {
  DETAIL_QUERY_PARAM,
  DetailDrawer,
} from "@/components/dashboard/site-pages/detail-query-modal";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { useInfiniteTableSentinel } from "@/components/dashboard/use-infinite-table-sentinel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import {
  createGoal,
  deleteGoal,
  fetchGoalDefinition,
  fetchGoals,
  updateGoal,
} from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { GoalDefinition } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import { GoalCard, GoalCardSkeleton } from "./goal-card";
import { GoalDetail } from "./goal-detail";
import { GoalEditor } from "./goal-editor";

export function goalDefinitionQueryKey(siteId: string, goalId: string) {
  return ["dashboard", "goal-definition", siteId, goalId] as const;
}

function GoalListLoading({
  locale,
  labels,
  canManage,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly canManage: boolean;
}) {
  return (
    <div className="grid min-w-0 items-stretch gap-4 md:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <GoalCardSkeleton
          key={index}
          locale={locale}
          labels={labels}
          canManage={canManage}
        />
      ))}
    </div>
  );
}

export function GoalsClientPage({
  locale,
  messages,
  siteId,
  pathname,
  canManage = false,
}: {
  readonly locale: Locale;
  readonly messages: AppMessages;
  readonly siteId: string;
  readonly pathname: string;
  readonly canManage?: boolean;
}) {
  const labels = messages.goals;
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const searchParams = useLiveSearchParams();
  const detailId = searchParams.get(DETAIL_QUERY_PARAM)?.trim() ?? "";
  const filterKey = useMemo(() => filterQueryKey(filters), [filters]);
  const queryClient = useQueryClient();
  const listKey = useMemo(
    () => ["dashboard", "goals", siteId] as const,
    [siteId],
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<GoalDefinition | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GoalDefinition | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const list = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchGoals(siteId, { limit: 50, cursor: pageParam, signal }),
    enabled: typeof window !== "undefined",
    getNextPageParam: (lastPage) =>
      lastPage.data.pagination.hasMore
        ? (lastPage.data.pagination.nextCursor ?? undefined)
        : undefined,
  });
  const goals = list.data?.pages.flatMap((page) => page.data.items) ?? [];
  const selected = goals.find((goal) => goal.id === detailId);
  const detailDefinition = useQuery({
    queryKey: goalDefinitionQueryKey(siteId, detailId),
    queryFn: ({ signal }) => fetchGoalDefinition(siteId, detailId, { signal }),
    enabled: Boolean(detailId && !selected),
  });
  const detailGoal = selected ?? detailDefinition.data?.data.goal;
  const openDetail = useCallback(
    (id: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(DETAIL_QUERY_PARAM, id);
      pushUrlWithoutNavigation(
        `${pathname}?${serializeDashboardSearchParams(params)}`,
      );
    },
    [pathname, searchParams],
  );
  const closeDetail = useCallback(() => {
    const params = new URLSearchParams(globalThis.location.search);
    params.delete(DETAIL_QUERY_PARAM);
    const query = serializeDashboardSearchParams(params);
    replaceUrlWithoutNavigation(query ? `${pathname}?${query}` : pathname);
  }, [pathname]);
  const openEdit = useCallback(
    (goal: GoalDefinition) => {
      closeDetail();
      setEditing(goal);
      setEditorOpen(true);
    },
    [closeDetail],
  );
  const save = useCallback(
    async (input: { name: string; filterDsl: string }) => {
      setSaving(true);
      try {
        const result = editing
          ? await updateGoal(siteId, editing.id, input)
          : await createGoal(siteId, input);
        await queryClient.invalidateQueries({ queryKey: listKey });
        if (editing) {
          await queryClient.invalidateQueries({
            queryKey: goalDefinitionQueryKey(siteId, editing.id),
          });
          if (
            editing.semanticFingerprint !== result.data.goal.semanticFingerprint
          ) {
            await queryClient.invalidateQueries({
              queryKey: ["dashboard", "goal-summary", siteId, editing.id],
            });
            await queryClient.invalidateQueries({
              queryKey: ["dashboard", "goal-timeseries", siteId, editing.id],
            });
          }
        }
        setEditorOpen(false);
        setEditing(null);
        toast.success(editing ? labels.updatedSuccess : labels.created);
        if (!editing) openDetail(result.data.goal.id);
      } catch (error) {
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : labels.saveFailed,
        );
      } finally {
        setSaving(false);
      }
    },
    [
      editing,
      labels.created,
      labels.saveFailed,
      labels.updatedSuccess,
      listKey,
      openDetail,
      queryClient,
      siteId,
    ],
  );
  const remove = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteGoal(siteId, deleteTarget.id);
      await queryClient.invalidateQueries({ queryKey: listKey });
      queryClient.removeQueries({
        queryKey: ["dashboard", "goal-summary", siteId, deleteTarget.id],
      });
      queryClient.removeQueries({
        queryKey: ["dashboard", "goal-timeseries", siteId, deleteTarget.id],
      });
      if (detailId === deleteTarget.id) closeDetail();
      setDeleteTarget(null);
      toast.success(labels.deleted);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : labels.deleteFailed,
      );
    } finally {
      setDeleting(false);
    }
  }, [
    closeDetail,
    deleteTarget,
    detailId,
    labels.deleteFailed,
    labels.deleted,
    listKey,
    queryClient,
    siteId,
  ]);
  const loadMore = useCallback(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, [list]);
  const sentinel = useInfiniteTableSentinel({
    enabled: Boolean(list.hasNextPage && !list.isFetchingNextPage),
    onReachEnd: loadMore,
  });
  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div className="flex min-w-0 items-center justify-between gap-4">
        <PageHeading title={labels.title} subtitle={labels.subtitle} />
        {canManage ? (
          <Button
            type="button"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <RiAddLine /> {labels.create}
          </Button>
        ) : null}
      </div>
      <AutoTransition
        initial={false}
        transitionKey={
          list.isPending
            ? "loading"
            : list.isError
              ? "error"
              : goals.length === 0
                ? "empty"
                : "ready"
        }
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="min-w-0"
      >
        {list.isPending ? (
          <GoalListLoading
            locale={locale}
            labels={labels}
            canManage={canManage}
          />
        ) : list.isError ? (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">
              {labels.loadError}
            </CardContent>
          </Card>
        ) : goals.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
              <p className="font-medium">{labels.empty}</p>
              <p className="text-sm text-muted-foreground">
                {labels.emptyHint}
              </p>
              {canManage ? (
                <Button
                  onClick={() => {
                    setEditing(null);
                    setEditorOpen(true);
                  }}
                >
                  <RiAddLine /> {labels.create}
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <div className="grid min-w-0 items-stretch gap-4 md:grid-cols-2">
            {goals.map((goal) => (
              <GoalCard
                key={goal.id}
                goal={goal}
                siteId={siteId}
                locale={locale}
                labels={labels}
                messages={messages}
                window={window}
                filters={filters}
                filterKey={filterKey}
                canManage={canManage}
                onOpen={() => openDetail(goal.id)}
                onEdit={() => openEdit(goal)}
                onDelete={() => setDeleteTarget(goal)}
              />
            ))}
          </div>
        )}
      </AutoTransition>
      {goals.length > 0 ? (
        <div ref={sentinel} aria-hidden="true" className="h-px w-full" />
      ) : null}
      <GoalEditor
        open={editorOpen}
        goal={editing}
        labels={labels}
        messages={messages}
        siteId={siteId}
        window={window}
        submitting={saving}
        onOpenChange={(open) => {
          if (!saving) setEditorOpen(open);
        }}
        onSubmit={save}
      />
      {detailId ? (
        <DetailDrawer
          ariaLabel={labels.title}
          drawerKey={`goal:${detailId}`}
          open
          onOpenChange={(open) => {
            if (!open) closeDetail();
          }}
        >
          <GoalDetail
            goal={detailGoal}
            siteId={siteId}
            locale={locale}
            labels={labels}
            messages={messages}
            window={window}
            filters={filters}
            filterKey={filterKey}
            canManage={canManage}
            actionPending={saving || deleting}
            onEdit={() => detailGoal && openEdit(detailGoal)}
            onDelete={() => detailGoal && setDeleteTarget(detailGoal)}
            loading={detailDefinition.isPending && !detailGoal}
            loadError={detailDefinition.isError}
          />
        </DetailDrawer>
      ) : null}
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle icon={RiDeleteBinLine}>
              {labels.deleteTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {labels.deleteDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              <RiCloseLine /> {labels.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {deleting ? <Spinner /> : <RiDeleteBinLine />}{" "}
              {labels.deleteConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
