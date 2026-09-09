import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RiSearchLine } from "@remixicon/react";
import { useInfiniteQuery } from "@tanstack/react-query";

import {
  AnalyticsTableColumnSettings,
  useAnalyticsTableColumns,
} from "@/components/dashboard/analytics-table-column-settings";
import {
  createSessionTableColumnDefinitions,
  SESSION_TABLE_COLUMNS_STORAGE_KEY,
  type SessionSortKey,
  type SessionSortState,
  SessionsTableCard,
} from "@/components/dashboard/sessions-table-card";
import { DetailDrawer } from "@/components/dashboard/site-pages/detail-query-modal";
import { SessionDetailClientPage } from "@/components/dashboard/site-pages/session-detail-client-page";
import { VisitorDetailClientPage } from "@/components/dashboard/site-pages/visitor-detail-client-page";
import {
  createVisitorTableColumnDefinitions,
  DEFAULT_VISITOR_SORT,
  VISITOR_PAGE_SIZE,
  VISITOR_TABLE_COLUMNS_STORAGE_KEY,
  VisitorAnalyticsTable,
  type VisitorRow,
  type VisitorSortKey,
  type VisitorSortState,
} from "@/components/dashboard/site-pages/visitors-client-page";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fetchSessions, fetchVisitors } from "@/lib/dashboard/client-data";
import type { JourneyAnalysisContext } from "@/lib/dashboard/client-data-types";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { JourneySession, VisitorsData } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

type Entity = "visitor" | "session";

function appendUniqueVisitors(
  current: VisitorRow[],
  incoming: readonly VisitorRow[],
): VisitorRow[] {
  if (current.length === 0) return [...incoming];
  const seen = new Set(current.map((row) => row.visitorId));
  const next = incoming.filter((row) => !seen.has(row.visitorId));
  return next.length > 0 ? [...current, ...next] : current;
}

function appendUniqueSessions(
  current: JourneySession[],
  incoming: readonly JourneySession[],
): JourneySession[] {
  if (current.length === 0) return [...incoming];
  const seen = new Set(current.map((row) => row.sessionId));
  const next = incoming.filter((row) => !seen.has(row.sessionId));
  return next.length > 0 ? [...current, ...next] : current;
}

type NestedJourneyDetail = {
  kind: Entity;
  id: string;
  stackKey: string;
};

function detailPath(pathname: string, entity: Entity): string {
  return pathname.replace(
    /\/[^/]+(?:\/detail)?$/,
    entity === "visitor" ? "/visitors" : "/sessions",
  );
}

export function AnalysisJourneyTable({
  entity,
  siteId,
  pathname,
  locale,
  messages,
  window: timeWindow,
  filters,
  analysisContext,
  toolbarLeading,
  enabled = true,
}: {
  readonly entity: Entity;
  readonly siteId: string;
  readonly pathname: string;
  readonly locale: Locale;
  readonly messages: AppMessages;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
  readonly analysisContext: JourneyAnalysisContext;
  readonly toolbarLeading?: ReactNode;
  readonly enabled?: boolean;
}) {
  const visitorLabels = messages.visitors;
  const sessionLabels = messages.sessions;
  const [visitorQuery, setVisitorQuery] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [visitorDebouncedQuery, setVisitorDebouncedQuery] = useState("");
  const [sessionDebouncedQuery, setSessionDebouncedQuery] = useState("");
  const [visitorSort, setVisitorSort] =
    useState<VisitorSortState>(DEFAULT_VISITOR_SORT);
  const [sessionSort, setSessionSort] = useState<SessionSortState>({
    key: "startedAt",
    direction: "desc",
  });
  const [now, setNow] = useState(() => Date.now());
  const [nestedDetails, setNestedDetails] = useState<NestedJourneyDetail[]>([]);
  const nestedDetailKeyRef = useRef(0);
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const analysisKey = useMemo(
    () =>
      analysisContext.type === "goal"
        ? [analysisContext.type, analysisContext.goalId]
        : [
            analysisContext.type,
            analysisContext.funnelId,
            analysisContext.stepId,
          ],
    [analysisContext],
  );

  const visitorColumnDefinitions = useMemo(
    () =>
      createVisitorTableColumnDefinitions(
        visitorLabels,
        messages.visitorDetail.visitorId,
      ),
    [messages.visitorDetail.visitorId, visitorLabels],
  );
  const visitorColumns = useAnalyticsTableColumns({
    storageKey: VISITOR_TABLE_COLUMNS_STORAGE_KEY,
    columns: visitorColumnDefinitions,
  });
  const sessionColumnDefinitions = useMemo(
    () => createSessionTableColumnDefinitions(sessionLabels),
    [sessionLabels],
  );
  const sessionColumns = useAnalyticsTableColumns({
    storageKey: SESSION_TABLE_COLUMNS_STORAGE_KEY,
    columns: sessionColumnDefinitions,
  });

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setVisitorDebouncedQuery(visitorQuery.trim()),
      300,
    );
    return () => window.clearTimeout(timeoutId);
  }, [visitorQuery]);

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setSessionDebouncedQuery(sessionQuery.trim()),
      300,
    );
    return () => window.clearTimeout(timeoutId);
  }, [sessionQuery]);

  const visitorList = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "analysis-visitors",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.timeZone,
      filtersKey,
      ...analysisKey,
      visitorDebouncedQuery,
      visitorSort.key,
      visitorSort.direction,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchVisitors(siteId, timeWindow, filters, {
        cursor: pageParam,
        limit: VISITOR_PAGE_SIZE,
        sortBy: visitorSort.key,
        sortDir: visitorSort.direction,
        search: visitorDebouncedQuery,
        analysisContext,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: VisitorsData) =>
      lastPage.data.pagination.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
    enabled: enabled && entity === "visitor" && typeof window !== "undefined",
  });
  const sessionList = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "analysis-sessions",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.timeZone,
      filtersKey,
      ...analysisKey,
      sessionDebouncedQuery,
      sessionSort.key,
      sessionSort.direction,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchSessions(siteId, timeWindow, filters, {
        cursor: pageParam,
        limit: 50,
        sortBy: sessionSort.key,
        sortDir: sessionSort.direction,
        search: sessionDebouncedQuery,
        analysisContext,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.data.pagination.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
    enabled: enabled && entity === "session" && typeof window !== "undefined",
  });

  const visitorRows = useMemo(
    () =>
      visitorList.data?.pages.reduce<VisitorRow[]>(
        (current, page) => appendUniqueVisitors(current, page.data.items),
        [],
      ) ?? [],
    [visitorList.data?.pages],
  );
  const sessionRows = useMemo(
    () =>
      sessionList.data?.pages.reduce<JourneySession[]>(
        (current, page) => appendUniqueSessions(current, page.data.items),
        [],
      ) ?? [],
    [sessionList.data?.pages],
  );

  const openNestedDetail = useCallback((kind: Entity, id: string) => {
    const normalizedId = id.trim();
    if (!normalizedId) return;
    setNestedDetails((current) => {
      const top = current.at(-1);
      if (top?.kind === kind && top.id === normalizedId) return current;
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
  }, []);
  const closeNestedDetail = useCallback((stackKey: string) => {
    setNestedDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      return index < 0 ? current : current.slice(0, index);
    });
  }, []);

  const toggleVisitorSort = useCallback((key: VisitorSortKey) => {
    setVisitorSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" },
    );
  }, []);
  const toggleSessionSort = useCallback((key: SessionSortKey) => {
    setSessionSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" },
    );
  }, []);

  const visitorLoading = visitorList.isPending;
  const visitorLoadingMore = visitorList.isFetchingNextPage;
  const visitorError = Boolean(visitorList.error) && visitorRows.length === 0;
  const visitorAppendError = visitorList.isFetchNextPageError;
  const visitorHasMore = visitorList.hasNextPage ?? false;
  const loadMoreVisitors = useCallback(() => {
    if (
      visitorLoading ||
      visitorLoadingMore ||
      visitorAppendError ||
      !visitorHasMore
    )
      return;
    void visitorList.fetchNextPage();
  }, [
    visitorAppendError,
    visitorHasMore,
    visitorList,
    visitorLoading,
    visitorLoadingMore,
  ]);
  const sessionLoading = sessionList.isPending;
  const sessionLoadingMore = sessionList.isFetchingNextPage;
  const sessionError = Boolean(sessionList.error) && sessionRows.length === 0;
  const sessionAppendError = sessionList.isFetchNextPageError;
  const sessionHasMore = sessionList.hasNextPage ?? false;
  const loadMoreSessions = useCallback(() => {
    if (
      sessionLoading ||
      sessionLoadingMore ||
      sessionAppendError ||
      !sessionHasMore
    )
      return;
    void sessionList.fetchNextPage();
  }, [
    sessionAppendError,
    sessionHasMore,
    sessionList,
    sessionLoading,
    sessionLoadingMore,
  ]);

  const isVisitor = entity === "visitor";
  const visitorsPathname = detailPath(pathname, "visitor");
  const sessionsPathname = detailPath(pathname, "session");

  return (
    <TooltipProvider>
      <div className="min-w-0 space-y-3">
        <div className="flex min-w-0 items-center gap-2">
          {toolbarLeading ? (
            <div className="shrink-0">{toolbarLeading}</div>
          ) : null}
          <div className="relative min-w-0 flex-1 sm:ml-auto sm:w-80 sm:flex-none">
            <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={isVisitor ? visitorQuery : sessionQuery}
              onChange={(event) =>
                isVisitor
                  ? setVisitorQuery(event.target.value)
                  : setSessionQuery(event.target.value)
              }
              placeholder={
                isVisitor ? visitorLabels.search : sessionLabels.search
              }
              className="pl-8"
            />
          </div>
          {isVisitor ? (
            <AnalyticsTableColumnSettings
              columns={visitorColumnDefinitions}
              orderedIds={visitorColumns.orderedIds}
              visibleIds={visitorColumns.visibleIds}
              onOrderChange={visitorColumns.setOrder}
              onVisibilityChange={visitorColumns.setVisible}
              onReset={visitorColumns.reset}
              labels={messages.common.tableColumns}
            />
          ) : (
            <AnalyticsTableColumnSettings
              columns={sessionColumnDefinitions}
              orderedIds={sessionColumns.orderedIds}
              visibleIds={sessionColumns.visibleIds}
              onOrderChange={sessionColumns.setOrder}
              onVisibilityChange={sessionColumns.setVisible}
              onReset={sessionColumns.reset}
              labels={messages.common.tableColumns}
            />
          )}
        </div>

        {isVisitor ? (
          <VisitorAnalyticsTable
            locale={locale}
            messages={messages}
            labels={visitorLabels}
            rows={visitorRows}
            now={now}
            columns={visitorColumns.visibleIds}
            sort={visitorSort}
            onToggleSort={toggleVisitorSort}
            onOpenDetail={(visitorId) => openNestedDetail("visitor", visitorId)}
            loading={
              visitorLoading || (visitorList.isFetching && !visitorLoadingMore)
            }
            loadingMore={visitorLoadingMore}
            error={visitorError}
            errorContent={visitorLabels.loadError}
            emptyContent={visitorLabels.empty}
            appendError={visitorAppendError}
            appendErrorContent={visitorLabels.loadError}
            hasMore={visitorHasMore}
            onLoadMore={loadMoreVisitors}
          />
        ) : (
          <SessionsTableCard
            locale={locale}
            messages={messages}
            labels={sessionLabels}
            rows={sessionRows}
            onOpenSession={(sessionId) =>
              openNestedDetail("session", sessionId)
            }
            onOpenVisitor={(visitorId) =>
              openNestedDetail("visitor", visitorId)
            }
            sort={sessionSort}
            onSort={toggleSessionSort}
            loadingRows={
              sessionLoading || (sessionList.isFetching && !sessionLoadingMore)
            }
            loadingMore={sessionLoadingMore}
            error={sessionError}
            appendError={sessionAppendError}
            hasMore={sessionHasMore}
            onLoadMore={loadMoreSessions}
            visibleColumnIds={sessionColumns.visibleIds}
          />
        )}

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
          >
            {nestedDetail.kind === "visitor" ? (
              <VisitorDetailClientPage
                locale={locale}
                messages={messages}
                siteId={siteId}
                pathname={visitorsPathname}
                visitorId={nestedDetail.id}
                onOpenSession={(sessionId) =>
                  openNestedDetail("session", sessionId)
                }
              />
            ) : (
              <SessionDetailClientPage
                locale={locale}
                messages={messages}
                siteId={siteId}
                pathname={sessionsPathname}
                sessionId={nestedDetail.id}
                onOpenVisitor={(visitorId) =>
                  openNestedDetail("visitor", visitorId)
                }
              />
            )}
          </DetailDrawer>
        ))}
      </div>
    </TooltipProvider>
  );
}
