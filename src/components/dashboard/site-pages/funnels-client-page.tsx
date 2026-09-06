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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import {
  createFunnel,
  deleteFunnel,
  fetchFunnelDetail,
  fetchFunnels,
  updateFunnel,
} from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FunnelDefinition, FunnelStep } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import { FunnelCard } from "./funnel-card";
import { funnelDetailQueryKey } from "./funnel-card";
import { FunnelDetail } from "./funnel-detail";
import { FunnelEditor } from "./funnel-editor";

interface FunnelsClientPageProps {
  readonly locale: Locale;
  readonly messages: AppMessages;
  readonly siteId: string;
  readonly pathname: string;
  readonly canManage?: boolean;
}

function detailTarget(
  pathname: string,
  searchParams: URLSearchParams,
  funnelId: string,
) {
  const params = new URLSearchParams(searchParams.toString());
  params.set(DETAIL_QUERY_PARAM, funnelId);
  return `${pathname}?${serializeDashboardSearchParams(params)}`;
}

function FunnelListLoading() {
  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Card key={index}>
          <CardContent className="space-y-4 p-5">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function FunnelDetailDrawer({
  locale,
  labels,
  descriptionMessages,
  siteId,
  funnel,
  funnelId,
  window,
  filters,
  filterKey,
  canManage,
  onEdit,
  onDelete,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: AppMessages;
  readonly siteId: string;
  readonly funnel?: FunnelDefinition;
  readonly funnelId: string;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
  readonly filterKey: string;
  readonly canManage: boolean;
  readonly onEdit: (funnel: FunnelDefinition) => void;
  readonly onDelete: (funnel: FunnelDefinition) => void;
}) {
  const detail = useQuery({
    queryKey: funnel
      ? funnelDetailQueryKey(siteId, funnel, window, filterKey)
      : ["dashboard", "funnel-detail", siteId, funnelId, filterKey],
    queryFn: ({ signal }) =>
      fetchFunnelDetail(siteId, funnelId, window, filters, { signal }),
    enabled: Boolean(funnelId),
  });
  return (
    <FunnelDetail
      locale={locale}
      labels={labels}
      descriptionMessages={descriptionMessages}
      payload={detail.data}
      loading={detail.isPending}
      error={detail.isError}
      canManage={canManage}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

export function FunnelsClientPage({
  locale,
  messages,
  siteId,
  pathname,
  canManage = false,
}: FunnelsClientPageProps) {
  const labels = messages.funnels;
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const searchParams = useLiveSearchParams();
  const detailId = searchParams.get(DETAIL_QUERY_PARAM)?.trim() ?? "";
  const queryClient = useQueryClient();
  const filterKey = useMemo(() => filterQueryKey(filters), [filters]);
  const listKey = useMemo(
    () => ["dashboard", "funnels", siteId] as const,
    [siteId],
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<FunnelDefinition | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FunnelDefinition | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const list = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchFunnels(siteId, { limit: 50, cursor: pageParam, signal }),
    enabled: typeof window !== "undefined",
    getNextPageParam: (lastPage) =>
      lastPage.data.pagination.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
  });
  const funnels = list.data?.pages.flatMap((page) => page.data.items) ?? [];
  const selected = funnels.find((funnel) => funnel.id === detailId);

  const openDetail = useCallback(
    (id: string) => {
      pushUrlWithoutNavigation(detailTarget(pathname, searchParams, id));
    },
    [pathname, searchParams],
  );
  const closeDetail = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete(DETAIL_QUERY_PARAM);
    const query = serializeDashboardSearchParams(params);
    replaceUrlWithoutNavigation(query ? `${pathname}?${query}` : pathname);
  }, [pathname]);
  const openCreate = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);
  const openEdit = useCallback(
    (funnel: FunnelDefinition) => {
      closeDetail();
      setEditing(funnel);
      setEditorOpen(true);
    },
    [closeDetail],
  );

  const save = useCallback(
    async (input: {
      name: string;
      progressionScope: "session" | "visitor";
      conversionWindowMs: number | null;
      steps: FunnelStep[];
    }) => {
      setSaving(true);
      try {
        const payload = editing
          ? await updateFunnel(siteId, editing.id, input)
          : await createFunnel(siteId, input);
        await queryClient.invalidateQueries({ queryKey: listKey });
        if (editing) {
          await queryClient.invalidateQueries({
            queryKey: ["dashboard", "funnel-detail", siteId, editing.id],
          });
        }
        setEditorOpen(false);
        setEditing(null);
        toast.success(editing ? labels.updatedSuccess : labels.created);
        if (!editing) openDetail(payload.data.funnel.id);
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
      await deleteFunnel(siteId, deleteTarget.id);
      await queryClient.invalidateQueries({ queryKey: listKey });
      queryClient.removeQueries({
        queryKey: ["dashboard", "funnel-detail", siteId, deleteTarget.id],
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

  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div className="flex min-w-0 items-center justify-between gap-4">
        <PageHeading
          title={messages.funnels.title}
          subtitle={messages.funnels.subtitle}
        />
        {canManage ? (
          <Button type="button" className="shrink-0" onClick={openCreate}>
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
              : funnels.length === 0
                ? "empty"
                : "ready"
        }
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="min-w-0"
      >
        {list.isPending ? (
          <FunnelListLoading />
        ) : list.isError ? (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">
              {labels.loadError}
            </CardContent>
          </Card>
        ) : funnels.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
              <p className="font-medium">{labels.empty}</p>
              <p className="text-sm text-muted-foreground">
                {labels.emptyHint}
              </p>
              {canManage ? (
                <Button type="button" onClick={openCreate}>
                  <RiAddLine /> {labels.create}
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <div className="grid min-w-0 items-start gap-4 md:grid-cols-2">
            {funnels.map((funnel) => (
              <FunnelCard
                key={funnel.id}
                locale={locale}
                labels={labels}
                descriptionMessages={messages}
                siteId={siteId}
                funnel={funnel}
                window={timeWindow}
                filters={filters}
                filterKey={filterKey}
                canManage={canManage}
                onOpen={() => openDetail(funnel.id)}
                onEdit={() => openEdit(funnel)}
                onDelete={() => setDeleteTarget(funnel)}
              />
            ))}
          </div>
        )}
      </AutoTransition>

      <FunnelEditor
        open={editorOpen}
        funnel={editing}
        labels={labels}
        messages={messages}
        siteId={siteId}
        window={timeWindow}
        submitting={saving}
        onOpenChange={(open) => {
          if (!saving) setEditorOpen(open);
        }}
        onSubmit={save}
      />

      {detailId ? (
        <DetailDrawer
          ariaLabel={messages.funnels.title}
          drawerKey={`funnel:${detailId}`}
          open
          onOpenChange={(open) => {
            if (!open) closeDetail();
          }}
        >
          <FunnelDetailDrawer
            locale={locale}
            labels={labels}
            descriptionMessages={messages}
            siteId={siteId}
            funnel={selected}
            funnelId={detailId}
            window={timeWindow}
            filters={filters}
            filterKey={filterKey}
            canManage={canManage}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
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
