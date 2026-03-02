"use client";

import { MetricCard } from "./metric-card";

type MetricKey = "views" | "sessions" | "visitors" | "bounceRate" | "avgDuration";

interface OverviewGridProps {
  views: number;
  sessions: number;
  visitors: number;
  bounceRate: number;
  avgDurationMs: number;
  approximateVisitors?: boolean;
  activeMetric?: MetricKey;
  onMetricClick?: (key: MetricKey) => void;
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

export function OverviewGrid({
  views,
  sessions,
  visitors,
  bounceRate,
  avgDurationMs,
  approximateVisitors,
  activeMetric,
  onMetricClick,
  labels,
}: OverviewGridProps) {
  const metrics: Array<{ key: MetricKey; label: string; value: number; formatter: (v: number) => string; hint: string }> = [
    { key: "views", label: labels.views, value: views, formatter: compactNum, hint: labels.hintViews },
    { key: "sessions", label: labels.sessions, value: sessions, formatter: compactNum, hint: labels.hintSessions },
    { key: "visitors", label: labels.visitors, value: visitors, formatter: compactNum, hint: approximateVisitors ? labels.hintVisitorsApprox : labels.hintVisitorsExact },
    { key: "bounceRate", label: labels.bounceRate, value: bounceRate, formatter: formatPercent, hint: labels.hintBounce },
    { key: "avgDuration", label: labels.avgDuration, value: avgDurationMs, formatter: formatDurationShort, hint: labels.hintDuration },
  ];

  return (
    <section className="rounded-md border border-border bg-card overflow-hidden grid grid-cols-2 md:grid-cols-5">
      {metrics.map((m) => (
        <MetricCard
          key={m.key}
          label={m.label}
          value={m.value}
          formatter={m.formatter}
          hint={m.hint}
          active={activeMetric === m.key}
          onClick={onMetricClick ? () => onMetricClick(m.key) : undefined}
          metricKey={m.key}
        />
      ))}
    </section>
  );
}

export type { MetricKey };
