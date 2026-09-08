import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchGoalSummary } from "@/lib/dashboard/client-data";
import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { GoalDefinition } from "@/lib/edge-client";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import { GoalActions } from "./goal-actions";
import { GoalVisualization } from "./goal-visualization";

const noop = () => undefined;

export function goalFilterSummary(
  goal: GoalDefinition,
  messages: Pick<AppMessages, "conditionDescription" | "filterBuilder">,
): string {
  try {
    return describeFilterExpression(
      parseFilterDsl(goal.filterDsl, analyticsFilterRegistry).root,
      analyticsFilterRegistry,
      messages,
    );
  } catch {
    return goal.filterDsl;
  }
}

export function GoalCardSkeleton({
  locale,
  labels,
  canManage,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly canManage: boolean;
}) {
  return (
    <Card className="h-full min-w-0" data-goal-card-skeleton="true">
      <CardHeader className="flex items-center justify-between gap-3 space-y-0">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Skeleton className="h-5 w-44" />
        </div>
        <div className="pointer-events-none">
          <GoalActions
            labels={labels}
            canManage={canManage}
            onOpen={noop}
            onEdit={noop}
            onDelete={noop}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 space-y-1 text-sm">
          <Skeleton className="h-4 w-full" />
        </div>
        <GoalVisualization locale={locale} labels={labels} loading />
      </CardContent>
    </Card>
  );
}

export function goalSummaryQueryKey(
  siteId: string,
  goal: Pick<GoalDefinition, "id" | "semanticFingerprint">,
  window: TimeWindow,
  filterKey: string,
  scope: string,
) {
  return [
    "dashboard",
    "goal-summary",
    siteId,
    goal.id,
    goal.semanticFingerprint,
    window.from,
    window.to,
    window.timeZone,
    filterKey,
    scope,
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

export function GoalCard({
  goal,
  siteId,
  locale,
  labels,
  messages,
  window,
  filters,
  filterKey,
  canManage,
  onOpen,
  onEdit,
  onDelete,
}: {
  readonly goal: GoalDefinition;
  readonly siteId: string;
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly messages: Pick<
    AppMessages,
    "conditionDescription" | "filterBuilder"
  >;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
  readonly filterKey: string;
  readonly canManage: boolean;
  readonly onOpen: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const { ref, near } = useNearViewport();
  const summary = useQuery({
    queryKey: goalSummaryQueryKey(siteId, goal, window, filterKey, "auto"),
    queryFn: ({ signal }) =>
      fetchGoalSummary(siteId, goal.id, window, filters, {
        signal,
        goalSemanticFingerprint: goal.semanticFingerprint,
      }),
    enabled: near,
  });
  return (
    <div ref={ref} className="h-full min-w-0">
      <Card
        className="h-full min-w-0 cursor-pointer transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
        role="button"
        tabIndex={0}
        aria-label={`${labels.open}: ${goal.name}`}
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
              {goal.name}
            </CardTitle>
          </div>
          <GoalActions
            labels={labels}
            canManage={canManage}
            onOpen={onOpen}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </CardHeader>
        <CardContent>
          <p className="mb-4 line-clamp-2 text-sm text-muted-foreground">
            {goalFilterSummary(goal, messages)}
          </p>
          {summary.isError ? (
            <p className="text-sm text-muted-foreground">
              {labels.detailLoadError}
            </p>
          ) : (
            <GoalVisualization
              summary={summary.data?.data.summary}
              locale={locale}
              labels={labels}
              loading={summary.isFetching || !summary.data}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
