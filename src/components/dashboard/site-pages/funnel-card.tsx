import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchFunnelDetail } from "@/lib/dashboard/client-data";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FunnelDefinition } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import { FunnelActions } from "./funnel-actions";
import {
  type FunnelDescriptionMessages,
  FunnelVisualization,
} from "./funnel-visualization";

const noop = () => undefined;

const FUNNEL_CARD_SKELETON_FUNNEL: FunnelDefinition = {
  id: "funnel-skeleton",
  siteId: "funnel-skeleton",
  name: "",
  filterDslVersion: 1,
  progressionScope: "session",
  conversionWindowMs: null,
  steps: Array.from({ length: 4 }, (_, index) => ({
    id: `funnel-skeleton-step-${index}`,
    filterDsl: "",
  })),
  semanticFingerprint: "funnel-skeleton",
  createdAt: 0,
  updatedAt: 0,
};

export function funnelDetailQueryKey(
  siteId: string,
  funnel: Pick<
    FunnelDefinition,
    "id" | "semanticFingerprint" | "progressionScope"
  >,
  window: TimeWindow,
  filterKey: string,
) {
  return [
    "dashboard",
    "funnel-detail",
    siteId,
    funnel.id,
    funnel.semanticFingerprint,
    funnel.progressionScope,
    window.from,
    window.to,
    window.timeZone,
    filterKey,
  ] as const;
}

function useNearViewport() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || typeof IntersectionObserver === "undefined") {
      if (typeof IntersectionObserver === "undefined") setNear(true);
      return;
    }
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return { ref, near };
}

export function FunnelCardSkeleton({
  locale,
  labels,
  descriptionMessages,
  canManage,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: FunnelDescriptionMessages;
  readonly canManage: boolean;
}) {
  return (
    <Card className="h-full min-w-0" data-funnel-card-skeleton="true">
      <CardHeader className="flex items-center justify-between gap-3 space-y-0">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-5 w-16" />
        </div>
        <div className="pointer-events-none">
          <FunnelActions
            labels={labels}
            canManage={canManage}
            onOpen={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </div>
      </CardHeader>
      <CardContent>
        <FunnelVisualization
          locale={locale}
          labels={labels}
          descriptionMessages={descriptionMessages}
          funnel={FUNNEL_CARD_SKELETON_FUNNEL}
          compact
          loading
        />
      </CardContent>
    </Card>
  );
}

export function FunnelCard({
  locale,
  labels,
  descriptionMessages,
  siteId,
  funnel,
  window,
  filters,
  filterKey,
  comparisonQuery,
  canManage,
  onOpen,
  onEdit,
  onDelete,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: FunnelDescriptionMessages;
  readonly siteId: string;
  readonly funnel: FunnelDefinition;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
  readonly filterKey: string;
  readonly comparisonQuery?: DashboardComparisonQuery | null;
  readonly canManage: boolean;
  readonly onOpen: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const { ref, near } = useNearViewport();
  const comparisonFilterKey = comparisonQuery
    ? filterQueryKey(comparisonQuery.filters)
    : "none";
  const detail = useQuery({
    queryKey: funnelDetailQueryKey(siteId, funnel, window, filterKey),
    queryFn: ({ signal }) =>
      fetchFunnelDetail(siteId, funnel.id, window, filters, { signal }),
    enabled: near,
  });
  const comparisonDetail = useQuery({
    queryKey: comparisonQuery
      ? funnelDetailQueryKey(
          siteId,
          funnel,
          comparisonQuery.window,
          comparisonFilterKey,
        )
      : ["dashboard", "funnel-detail-comparison-disabled", siteId, funnel.id],
    queryFn: ({ signal }) => {
      if (!comparisonQuery) {
        throw new Error("Comparison query is not enabled");
      }
      return fetchFunnelDetail(
        siteId,
        funnel.id,
        comparisonQuery.window,
        comparisonQuery.filters,
        { signal },
      );
    },
    enabled: near && Boolean(comparisonQuery),
  });

  return (
    <div ref={ref} className="h-full min-w-0">
      <Card
        className="h-full min-w-0 cursor-pointer transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
        role="button"
        tabIndex={0}
        aria-label={`${labels.open}: ${funnel.name}`}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
      >
        <CardHeader className="flex items-center justify-between gap-3 space-y-0">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <CardTitle className="min-w-0 truncate text-base">
              {funnel.name}
            </CardTitle>
            <Badge variant="outline" className="shrink-0">
              {funnel.progressionScope === "visitor"
                ? labels.visitors
                : labels.sessions}
            </Badge>
          </div>
          <FunnelActions
            labels={labels}
            canManage={canManage}
            onOpen={onOpen}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </CardHeader>
        <CardContent>
          {detail.isError ? (
            <p className="text-sm text-muted-foreground">
              {labels.detailLoadError}
            </p>
          ) : (
            <FunnelVisualization
              locale={locale}
              labels={labels}
              descriptionMessages={descriptionMessages}
              funnel={detail.data?.data.funnel ?? funnel}
              analysis={detail.data?.data.analysis}
              comparisonAnalysis={comparisonDetail.data?.data.analysis}
              compact
              loading={detail.isFetching || !detail.data}
              comparisonLoading={
                Boolean(comparisonQuery) &&
                (comparisonDetail.isFetching || !comparisonDetail.data)
              }
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
