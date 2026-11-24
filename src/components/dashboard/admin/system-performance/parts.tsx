import type { ReactNode } from "react";
import { Badge } from "@insightflare/ui/badge";
import { Button } from "@insightflare/ui/button";
import { RiCloseLine, RiInformationLine } from "@remixicon/react";

import { cn } from "@/lib/utils";

import {
  type PerformanceCopy,
  resultLabel,
  resultTone,
  template,
} from "./model";

/** Full-width message used when a view has nothing meaningful to show. */
export function StatusPanel({
  message,
  tone = "muted",
  action,
}: {
  message: string;
  tone?: "muted" | "error";
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex min-h-48 flex-col items-center justify-center gap-3 border border-dashed px-6 py-10 text-center"
    >
      <p
        className={cn(
          "max-w-md text-sm",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {message}
      </p>
      {action}
    </div>
  );
}

export function InlineNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <RiInformationLine className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function ResultBadge({
  copy,
  result,
}: {
  copy: PerformanceCopy;
  result: string;
}) {
  return (
    <Badge
      variant={result === "failure" ? "destructive" : "outline"}
      className={resultTone(result)}
    >
      {resultLabel(copy, result)}
    </Badge>
  );
}

export interface ActiveFilter {
  id: string;
  label: string;
  value: string;
  onRemove: () => void;
}

export function ActiveFilters({
  copy,
  filters,
  onClear,
}: {
  copy: PerformanceCopy;
  filters: readonly ActiveFilter[];
  onClear: () => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((filter) => (
        <span
          key={filter.id}
          className="inline-flex h-7 max-w-full items-center gap-1.5 border bg-muted/40 pl-2.5 pr-1 text-xs"
        >
          <span className="text-muted-foreground">{filter.label}</span>
          <span className="truncate font-mono">{filter.value}</span>
          <button
            type="button"
            className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            aria-label={template(copy.filters.remove, { label: filter.label })}
            onClick={filter.onRemove}
          >
            <RiCloseLine className="size-3.5" />
          </button>
        </span>
      ))}
      {filters.length > 1 ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          {copy.filters.clearAll}
        </Button>
      ) : null}
    </div>
  );
}

/** Dense label/value grid used inside cards and the detail drawer. */
export function StatGrid({
  items,
  className,
}: {
  items: ReadonlyArray<{
    id: string;
    label: string;
    value: ReactNode;
    note?: ReactNode;
  }>;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid gap-px overflow-hidden border bg-border",
        "grid-cols-2 sm:grid-cols-3",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.id} className="min-w-0 bg-card p-4">
          <dt className="truncate text-xs text-muted-foreground">
            {item.label}
          </dt>
          <dd className="mt-1.5 truncate text-lg font-medium tabular-nums">
            {item.value}
          </dd>
          {item.note ? (
            <dd className="mt-1 truncate text-xs text-muted-foreground">
              {item.note}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

/** Keyboard-accessible clickable table row props. */
export function rowActivation(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    className:
      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
    onClick: onActivate,
    onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}
