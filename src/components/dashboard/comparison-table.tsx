import { memo } from "react";
import { RiBarChartLine, RiTimeLine, RiUserLine } from "@remixicon/react";

import { AutoTransition } from "@/components/ui/auto-transition";
import { Clickable } from "@/components/ui/clickable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import type {
  TabbedDataTableColumn,
  TabbedDataTableRowBase,
} from "./tabbed-data-table-card";

export type ComparisonTableMetric = "views" | "visitors" | "sessions";
export type ComparisonTableSortKey = "current" | "reference" | "change";

export interface ComparisonTableMetricChange {
  absolute: number;
  relative: number | null;
}

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeRateClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}

export function createComparisonTableColumns<
  TRow extends TabbedDataTableRowBase,
  TTab extends string,
>({
  metric,
  comparisonLabel,
  locale,
  messages,
  getCurrent,
  getReference,
  getChange,
}: {
  metric: ComparisonTableMetric;
  comparisonLabel: string;
  locale: Locale;
  messages: AppMessages;
  getCurrent: (row: TRow) => number;
  getReference: (row: TRow) => number | undefined;
  getChange: (row: TRow) => ComparisonTableMetricChange | undefined;
}): readonly TabbedDataTableColumn<TRow, ComparisonTableSortKey, TTab>[] {
  const currentLabel =
    metric === "views"
      ? messages.common.views
      : metric === "visitors"
        ? messages.common.visitors
        : messages.common.sessions;

  return [
    {
      key: "reference",
      label: comparisonLabel,
      getValue: (row) => getReference(row) ?? 0,
      sortValue: (row) => getReference(row) ?? 0,
      format: (value) => numberFormat(locale, value),
    },
    {
      key: "current",
      label: currentLabel,
      getValue: getCurrent,
      sortValue: getCurrent,
      format: (value) => numberFormat(locale, value),
    },
    {
      key: "change",
      label: messages.common.change,
      getValue: (row) => getChange(row)?.absolute ?? 0,
      sortValue: (row) => getChange(row)?.relative ?? Infinity,
      format: (_value, row) => {
        const change = getChange(row);
        if (!change) {
          return <span className="text-muted-foreground">—</span>;
        }
        if (change.relative === null) {
          return (
            <span className={changeRateClass(getCurrent(row) > 0 ? 100 : null)}>
              {getCurrent(row) > 0 ? messages.common.new : "—"}
            </span>
          );
        }
        return (
          <span className={changeRateClass(change.relative * 100)}>
            {formatChangeRate(change.relative * 100) ?? "0.0%"}
          </span>
        );
      },
    },
  ];
}

const METRIC_ICONS: Record<ComparisonTableMetric, typeof RiBarChartLine> = {
  views: RiBarChartLine,
  visitors: RiUserLine,
  sessions: RiTimeLine,
};

export const ComparisonMetricToggle = memo(function ComparisonMetricToggle({
  metric,
  metrics,
  messages,
  onMetricChange,
}: {
  metric: ComparisonTableMetric;
  metrics: readonly ComparisonTableMetric[];
  messages: AppMessages;
  onMetricChange: (metric: ComparisonTableMetric) => void;
}) {
  const currentIndex = Math.max(0, metrics.indexOf(metric));
  const nextMetric = metrics[(currentIndex + 1) % metrics.length] ?? metric;
  const label =
    metric === "views"
      ? messages.common.views
      : metric === "visitors"
        ? messages.common.visitors
        : messages.common.sessions;
  const Icon = METRIC_ICONS[metric];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Clickable
          className="size-6 text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={() => onMetricChange(nextMetric)}
        >
          <AutoTransition
            as="span"
            type="crossFade"
            duration={0.18}
            initial={false}
            transitionKey={metric}
            className="inline-flex size-4 items-center justify-center"
          >
            <Icon key={metric} className="size-4" aria-hidden="true" />
          </AutoTransition>
        </Clickable>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
