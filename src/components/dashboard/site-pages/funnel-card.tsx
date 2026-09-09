import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchFunnelDetail } from "@/lib/dashboard/client-data";
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

function FunnelCardVisualizationSkeleton() {
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="inline-flex items-center gap-1">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
      <div className="space-y-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="min-w-0 space-y-2">
            <div className="flex min-w-0 items-start gap-2">
              <Skeleton className="h-4 w-3 shrink-0" />
              <Skeleton className="h-4 min-w-0 flex-1" />
              <Skeleton className="h-5 w-16 shrink-0" />
            </div>
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FunnelCardSkeleton({
  labels,
  canManage,
}: {
  readonly labels: AppMessages["funnels"];
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
        <FunnelCardVisualizationSkeleton />
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
  readonly canManage: boolean;
  readonly onOpen: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const { ref, near } = useNearViewport();
  const detail = useQuery({
    queryKey: funnelDetailQueryKey(siteId, funnel, window, filterKey),
    queryFn: ({ signal }) =>
      fetchFunnelDetail(siteId, funnel.id, window, filters, { signal }),
    enabled: near,
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
              compact
              loading={detail.isFetching || !detail.data}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
