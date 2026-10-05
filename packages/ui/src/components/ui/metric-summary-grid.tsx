import type { ReactElement } from "react";
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiSubtractLine,
} from "@remixicon/react";

import { cn } from "../../lib/utils";
import { AutoResizer } from "./auto-resizer";
import { AutoTransition } from "./auto-transition";
import { Card, CardContent } from "./card";
import { Skeleton } from "./skeleton";
import { Spinner } from "./spinner";

export type MetricSummaryTone = "default" | "positive" | "warning" | "critical";

export interface MetricSummaryChange {
  value: string;
  direction: "up" | "down" | "flat";
  tone?: "positive" | "negative" | "neutral";
}

export interface MetricSummaryItem {
  id: string;
  label: string;
  value: string;
  icon?: ReactElement;
  detail?: string;
  change?: MetricSummaryChange;
  tone?: MetricSummaryTone;
  loading?: boolean;
  detailLoading?: boolean;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
}

export interface MetricSummaryGridProps {
  items: readonly MetricSummaryItem[];
  columns?: 2 | 3 | 4;
  loading?: boolean;
  className?: string;
  ariaLabel?: string;
}

const COLUMN_CLASSES: Record<
  NonNullable<MetricSummaryGridProps["columns"]>,
  string
> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 xl:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
};

const VALUE_TONE_CLASSES: Record<MetricSummaryTone, string> = {
  default: "text-foreground",
  positive: "text-primary",
  warning: "text-amber-500",
  critical: "text-destructive",
};

const CHANGE_TONE_CLASSES: Record<
  NonNullable<MetricSummaryChange["tone"]>,
  string
> = {
  positive: "text-emerald-600",
  negative: "text-rose-600",
  neutral: "text-muted-foreground",
};

function MetricSummaryCell({
  item,
  loading,
}: {
  item: MetricSummaryItem;
  loading: boolean;
}) {
  const isLoading = item.loading ?? loading;
  const isDetailLoading = isLoading || item.detailLoading;
  const contentKey = isLoading
    ? "loading"
    : `${item.value}:${item.change?.value ?? ""}:${
        item.change?.direction ?? ""
      }`;
  const ChangeIcon =
    item.change?.direction === "up"
      ? RiArrowUpLine
      : item.change?.direction === "down"
        ? RiArrowDownLine
        : RiSubtractLine;

  const content = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {item.icon ? (
          <span className="inline-flex size-[11px] shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-[11px]">
            {item.icon}
          </span>
        ) : null}
        <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
          {item.label}
        </p>
      </div>
      <AutoResizer initial animateHeight={false} className="mt-3 h-7">
        <AutoTransition
          className="h-7"
          transitionKey={contentKey}
          initial={false}
          duration={0.2}
          type="fade"
          presenceMode="wait"
        >
          {isLoading ? (
            <div key="loading" className="flex h-7 items-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <div
              key={contentKey}
              className="flex h-7 min-w-0 items-end gap-1.5 leading-none"
            >
              <span
                className={cn(
                  "min-w-0 truncate font-mono text-xl leading-none font-semibold tabular-nums",
                  VALUE_TONE_CLASSES[item.tone ?? "default"],
                )}
              >
                {item.value}
              </span>
              {item.change ? (
                <span
                  className={cn(
                    "inline-flex shrink-0 items-end gap-0.5 font-mono text-xs leading-none tabular-nums",
                    CHANGE_TONE_CLASSES[item.change.tone ?? "neutral"],
                  )}
                >
                  <ChangeIcon aria-hidden="true" className="size-3.5" />
                  {item.change.value}
                </span>
              ) : null}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
      <AutoTransition
        className="mt-3 h-[14px]"
        initial={false}
        transitionKey={isDetailLoading ? "loading" : (item.detail ?? "detail")}
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        {isDetailLoading ? (
          <Skeleton
            key="loading"
            className="h-full w-[min(12rem,72%)] rounded-none"
          />
        ) : (
          <p
            key={item.detail ?? "detail"}
            className="h-[14px] min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground"
          >
            {item.detail}
          </p>
        )}
      </AutoTransition>
    </>
  );

  const cellClassName = cn(
    "min-w-0 bg-card p-4 text-left",
    item.onClick && "cursor-pointer transition-colors hover:bg-muted/35",
    item.pressed && "bg-muted/35",
    item.onClick &&
      "focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
  );

  if (!item.onClick) {
    return <div className={cellClassName}>{content}</div>;
  }

  return (
    <button
      type="button"
      className={cellClassName}
      onClick={item.onClick}
      aria-pressed={item.pressed}
      disabled={item.disabled}
    >
      {content}
    </button>
  );
}

export function MetricSummaryGrid({
  items,
  columns = 4,
  loading = false,
  className,
  ariaLabel,
}: MetricSummaryGridProps) {
  return (
    <Card className={cn("min-w-0 gap-0 overflow-hidden py-0", className)}>
      <CardContent className="p-0">
        <div
          aria-label={ariaLabel}
          role={ariaLabel ? "group" : undefined}
          className={cn(
            "grid grid-cols-1 gap-px overflow-hidden bg-border/70",
            COLUMN_CLASSES[columns],
          )}
        >
          {items.map((item) => (
            <MetricSummaryCell key={item.id} item={item} loading={loading} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
