"use client";

import { MetricCard } from "./metric-card";

interface OverviewGridProps {
  views: number;
  sessions: number;
  visitors: number;
  bounceRate: number;
  avgDurationMs: number;
  approximateVisitors?: boolean;
  labels: {
    views: string;
    sessions: string;
    visitors: string;
    bounceRate: string;
    avgDuration: string;
    hintViews: string;
    hintSessions: string;
    hintVisitorsExact: string;
    hintVisitorsApprox: string;
    hintBounce: string;
    hintDuration: string;
  };
}

function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function compactNum(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function OverviewGrid({ views, sessions, visitors, bounceRate, avgDurationMs, approximateVisitors, labels }: OverviewGridProps) {
  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <MetricCard
        label={labels.views}
        value={views}
        formatter={compactNum}
        hint={labels.hintViews}
      />
      <MetricCard
        label={labels.sessions}
        value={sessions}
        formatter={compactNum}
        hint={labels.hintSessions}
      />
      <MetricCard
        label={labels.visitors}
        value={visitors}
        formatter={compactNum}
        hint={approximateVisitors ? labels.hintVisitorsApprox : labels.hintVisitorsExact}
      />
      <MetricCard
        label={labels.bounceRate}
        value={bounceRate}
        formatter={formatPercent}
        hint={labels.hintBounce}
      />
      <MetricCard
        label={labels.avgDuration}
        value={avgDurationMs}
        formatter={formatDurationShort}
        hint={labels.hintDuration}
      />
    </section>
  );
}
