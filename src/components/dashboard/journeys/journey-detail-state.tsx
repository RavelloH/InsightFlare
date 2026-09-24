import type { ReactNode } from "react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface JourneyDetailStateSwitchProps {
  stateKey: string;
  children: ReactNode;
}

export function JourneyDetailStateSwitch({
  stateKey,
  children,
}: JourneyDetailStateSwitchProps) {
  return (
    <AutoResizer className="w-full" duration={0.26}>
      <AutoTransition
        initial={false}
        duration={0.22}
        type="fade"
        presenceMode="wait"
        className="w-full"
      >
        <div key={stateKey} className="w-full">
          {children}
        </div>
      </AutoTransition>
    </AutoResizer>
  );
}

interface JourneyDetailLoadingStateProps {
  kind: "visitor" | "session";
  loadingLabel: string;
}

export function JourneyDetailLoadingState({
  kind,
  loadingLabel,
}: JourneyDetailLoadingStateProps) {
  return (
    <div className="pb-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{loadingLabel}</span>
      <JourneyDetailHeroSkeleton kind={kind} />

      <div className="mx-auto mt-6 w-full max-w-[1400px] space-y-6 px-4 md:px-6">
        <JourneyDetailSummarySkeleton />
        {kind === "visitor" ? <VisitorActivitySkeleton /> : null}
        <JourneyDetailEventsSkeleton />
        <JourneyDetailBottomSkeleton />
        <JourneyDetailMapCardSkeleton />
      </div>
    </div>
  );
}

function JourneyDetailHeroSkeleton({ kind }: { kind: "visitor" | "session" }) {
  return (
    <div className="relative h-[17rem] overflow-hidden bg-muted/40 sm:h-[19rem]">
      <div className="absolute inset-0 bg-[linear-gradient(90deg,var(--muted)_1px,transparent_1px),linear-gradient(0deg,var(--muted)_1px,transparent_1px)] bg-[size:64px_64px] opacity-40" />
      <div className="absolute inset-0 bg-gradient-to-b from-background/20 via-transparent to-background" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-background via-background/70 to-transparent" />

      <div className="absolute inset-x-4 top-4 z-10 flex items-center justify-between gap-4 sm:inset-x-5 sm:top-5">
        <Skeleton className="h-4 w-24 bg-background/70" />
        <Skeleton
          className={cn(
            "h-3 bg-background/70",
            kind === "visitor" ? "w-44" : "w-52",
          )}
        />
      </div>

      <div className="absolute bottom-4 left-4 z-10 flex min-w-0 max-w-[calc(100%-2rem)] items-center gap-3 sm:bottom-5 sm:left-5">
        <Skeleton className="size-12 shrink-0 rounded-full bg-background/70" />
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-8 w-36 max-w-[64vw] bg-background/70" />
          <Skeleton
            className={cn(
              "h-3 max-w-[72vw] bg-background/70",
              kind === "visitor" ? "w-56" : "w-64",
            )}
          />
        </div>
      </div>
    </div>
  );
}

function JourneyDetailSummarySkeleton() {
  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid grid-cols-2 gap-px overflow-hidden bg-border/70 xl:grid-cols-4">
          {Array.from({ length: 16 }, (_, index) => (
            <div
              key={`summary-skeleton-${index}`}
              className={cn("min-w-0 bg-card p-4", index === 4 && "col-span-2")}
            >
              <Skeleton className="h-3 w-20" />
              <Skeleton
                className={cn(
                  "mt-3",
                  index < 4 ? "h-6 w-20" : "h-4 w-[min(18rem,88%)]",
                )}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function VisitorActivitySkeleton() {
  return (
    <section className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-28" />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-[repeat(18,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(28,minmax(0,1fr))] lg:grid-cols-[repeat(40,minmax(0,1fr))]">
            {Array.from({ length: 120 }, (_, index) => (
              <Skeleton
                key={`activity-skeleton-${index}`}
                className="aspect-square w-full"
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <JourneyDetailRowsSkeleton rows={5} />
      </div>
    </section>
  );
}

function JourneyDetailEventsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-[min(30rem,88%)]" />
      </CardHeader>
      <CardContent className="px-4">
        <div className="space-y-1.5">
          {Array.from({ length: 5 }, (_, index) => (
            <Card key={`event-skeleton-${index}`} size="sm" className="py-0">
              <CardContent className="p-0">
                <div className="flex items-center gap-2 px-1.5 py-1">
                  <Skeleton className="size-8 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-[min(26rem,80%)]" />
                    <Skeleton className="h-3 w-[min(18rem,68%)]" />
                  </div>
                  <div className="hidden w-32 shrink-0 space-y-2 sm:block">
                    <Skeleton className="ml-auto h-3 w-24" />
                    <Skeleton className="ml-auto h-3 w-20" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function JourneyDetailBottomSkeleton() {
  return (
    <section className="grid items-stretch gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent>
          <JourneyDetailRowsSkeleton rows={6} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-44" />
        </CardHeader>
        <CardContent>
          <JourneyDetailRowsSkeleton rows={6} />
        </CardContent>
      </Card>
    </section>
  );
}

function JourneyDetailMapCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-28" />
      </CardHeader>
      <CardContent>
        <Skeleton className="aspect-[960/360] w-full" />
      </CardContent>
    </Card>
  );
}

function JourneyDetailRowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={`detail-row-skeleton-${rows}-${index}`}
          className="grid grid-cols-[1fr_auto] items-center gap-4"
        >
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-4 w-[min(22rem,86%)]" />
            <Skeleton className="h-3 w-[min(14rem,60%)]" />
          </div>
          <Skeleton className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}
