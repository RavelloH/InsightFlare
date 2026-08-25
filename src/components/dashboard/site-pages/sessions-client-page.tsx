import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiSearchLine } from "@remixicon/react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { PageHeading } from "@/components/dashboard/page-heading";
import {
  type SessionSortKey,
  type SessionSortState,
  SessionsTableCard,
} from "@/components/dashboard/sessions-table-card";
import {
  DETAIL_QUERY_PARAM,
  DetailDrawer,
} from "@/components/dashboard/site-pages/detail-query-modal";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { Input } from "@/components/ui/input";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import { fetchSessions } from "@/lib/dashboard/client-data";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import dynamic from "@/lib/dynamic";
import type { JourneySession } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface SessionsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

const SESSION_PAGE_SIZE = 50;

const SessionDetailClientPage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/session-detail-client-page").then(
      (module) => module.SessionDetailClientPage,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    ),
  },
);

const VisitorDetailClientPage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/visitor-detail-client-page").then(
      (module) => module.VisitorDetailClientPage,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    ),
  },
);

const DEFAULT_SESSION_SORT: SessionSortState = {
  key: "startedAt",
  direction: "desc",
};

type NestedJourneyDetail = {
  kind: "session" | "visitor";
  id: string;
  stackKey: string;
};

function appendUniqueSessions(
  current: JourneySession[],
  incoming: JourneySession[],
): JourneySession[] {
  if (current.length === 0) return incoming;
  const seen = new Set(current.map((row) => row.sessionId));
  const nextRows = incoming.filter((row) => !seen.has(row.sessionId));
  return nextRows.length > 0 ? [...current, ...nextRows] : current;
}

function detailQueryTarget(
  pathname: string,
  searchParams: URLSearchParams,
  detailId: string,
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.set(DETAIL_QUERY_PARAM, detailId);
  params.delete("visitorId");
  params.delete("sessionId");
  const query = serializeDashboardSearchParams(params);
  return query ? `${pathname}?${query}` : pathname;
}

export function SessionsClientPage({
  locale,
  messages,
  siteId,
  pathname,
}: SessionsClientPageProps) {
  const labels = messages.sessions;
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<SessionSortState>(DEFAULT_SESSION_SORT);
  const searchParams = useLiveSearchParams();
  const detailSessionId = searchParams.get(DETAIL_QUERY_PARAM)?.trim() || "";
  const [nestedDetails, setNestedDetails] = useState<NestedJourneyDetail[]>([]);
  const nestedDetailKeyRef = useRef(0);
  const openedDetailFromListRef = useRef(false);
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    if (!detailSessionId) {
      openedDetailFromListRef.current = false;
      setNestedDetails([]);
    }
  }, [detailSessionId]);

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
      "sessions",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.timeZone,
      filtersKey,
      debouncedQuery,
      sort.key,
      sort.direction,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchSessions(siteId, timeWindow, filters, {
        cursor: pageParam,
        pageSize: SESSION_PAGE_SIZE,
        sortBy: sort.key,
        sortDir: sort.direction,
        search: debouncedQuery,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasMore ? lastPage.meta.nextCursor : undefined,
    enabled: typeof window !== "undefined",
  });
  const rows = useMemo(
    () =>
      data?.pages.reduce<JourneySession[]>(
        (current, page) => appendUniqueSessions(current, page.data),
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

  const toggleSort = (key: SessionSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" },
    );
  };

  const openSessionDetail = useCallback(
    (sessionId: string) => {
      openedDetailFromListRef.current = true;
      pushUrlWithoutNavigation(
        detailQueryTarget(pathname, searchParams, sessionId),
      );
    },
    [pathname, searchParams],
  );
  const openSessionDetailRef = useRef(openSessionDetail);
  openSessionDetailRef.current = openSessionDetail;
  const stableOpenSessionDetail = useCallback((sessionId: string) => {
    openSessionDetailRef.current(sessionId);
  }, []);

  const closeSessionDetail = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(DETAIL_QUERY_PARAM)) return;

    if (openedDetailFromListRef.current) {
      openedDetailFromListRef.current = false;
      window.history.back();
      return;
    }

    params.delete(DETAIL_QUERY_PARAM);
    const query = serializeDashboardSearchParams(params);
    replaceUrlWithoutNavigation(query ? `${pathname}?${query}` : pathname);
  }, [pathname]);
  const visitorsPathname = useMemo(
    () => pathname.replace(/\/sessions(?:\/detail)?$/, "/visitors"),
    [pathname],
  );
  const openNestedDetail = useCallback(
    (kind: NestedJourneyDetail["kind"], id: string) => {
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
    },
    [],
  );
  const closeNestedDetail = useCallback((stackKey: string) => {
    setNestedDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      return index < 0 ? current : current.slice(0, index);
    });
  }, []);

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.sessions.title}
        subtitle={messages.sessions.subtitle}
      />

      <div className="relative w-full sm:max-w-xs">
        <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={labels.search}
          className="pl-8"
        />
      </div>

      <SessionsTableCard
        locale={locale}
        messages={messages}
        labels={labels}
        rows={rows}
        onOpenSession={stableOpenSessionDetail}
        sort={sort}
        onSort={toggleSort}
        loadingRows={replacingRows}
        loadingMore={loadingMore}
        error={error}
        appendError={appendError}
        hasMore={hasMore}
        skeletonRows={SESSION_PAGE_SIZE}
        onLoadMore={loadNextPage}
      />

      {detailSessionId ? (
        <DetailDrawer
          ariaLabel={messages.sessionDetail.visitDetailsTitle}
          drawerKey={`session:${detailSessionId}`}
          open={Boolean(detailSessionId)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setNestedDetails([]);
              closeSessionDetail();
            }
          }}
        >
          <SessionDetailClientPage
            locale={locale}
            messages={messages}
            siteId={siteId}
            pathname={pathname}
            sessionId={detailSessionId}
            onOpenVisitor={(visitorId) =>
              openNestedDetail("visitor", visitorId)
            }
          />
        </DetailDrawer>
      ) : null}

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
              pathname={pathname}
              sessionId={nestedDetail.id}
              onOpenVisitor={(visitorId) =>
                openNestedDetail("visitor", visitorId)
              }
            />
          )}
        </DetailDrawer>
      ))}
    </div>
  );
}
