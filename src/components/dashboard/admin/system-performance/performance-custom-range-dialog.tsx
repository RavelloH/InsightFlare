import { useEffect, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@insightflare/ui/button";
import { Calendar } from "@insightflare/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@insightflare/ui/dialog";

import { toDateRange } from "@/components/dashboard/shell/dashboard-header-controls/range";
import { normalizeCustomDateRange } from "@/lib/dashboard/query-state";
import type { SystemPerformanceV2Labels } from "@/lib/system-performance-labels";

export function PerformanceCustomRangeDialog({
  open,
  onOpenChange,
  onApply,
  from,
  to,
  timeZone,
  copy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (from: number, to: number) => void;
  from: number | null;
  to: number | null;
  timeZone: string;
  copy: SystemPerformanceV2Labels;
}) {
  const [pending, setPending] = useState<DateRange | undefined>();
  useEffect(() => {
    if (open)
      setPending(
        toDateRange(from ?? undefined, to ? to - 1 : undefined, timeZone),
      );
  }, [open, from, to, timeZone]);
  const normalized = normalizeCustomDateRange(pending, timeZone);
  const safeTo = normalized ? Math.min(normalized.to, Date.now() - 3000) : null;
  const valid =
    normalized &&
    safeTo !== null &&
    normalized.from < safeTo &&
    safeTo - normalized.from <= 90 * 86_400_000;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-fit max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>{copy.customRange}</DialogTitle>
          <DialogDescription>{copy.customRangeHelp}</DialogDescription>
        </DialogHeader>
        <Calendar
          mode="range"
          captionLayout="dropdown"
          numberOfMonths={1}
          selected={pending}
          disabled={{ after: new Date() }}
          onSelect={setPending}
        />
        <DialogFooter>
          <Button
            disabled={!valid}
            onClick={() => {
              if (!valid || safeTo === null) return;
              onApply(normalized.from, safeTo);
              onOpenChange(false);
            }}
          >
            {copy.applyRange}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
