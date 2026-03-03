import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { AppMessages } from "@/lib/i18n/messages";
import type { DashboardFilters, RangePreset } from "@/lib/dashboard/server";
import { withRangeAndFilters } from "@/lib/dashboard/server";

interface RangeLinksProps {
  pathname: string;
  activeRange: RangePreset;
  messages: AppMessages;
  filters?: DashboardFilters;
}

const RANGE_KEYS: readonly RangePreset[] = ["24h", "7d", "30d", "90d"] as const;

function labelFor(messages: AppMessages, range: RangePreset): string {
  if (range === "24h") return messages.ranges.last24h;
  if (range === "30d") return messages.ranges.last30d;
  if (range === "90d") return messages.ranges.last90d;
  return messages.ranges.last7d;
}

export function RangeLinks({ pathname, activeRange, messages, filters }: RangeLinksProps) {
  return (
    <div className="flex items-center gap-1">
      {RANGE_KEYS.map((range) => (
        <Button
          key={range}
          variant={range === activeRange ? "default" : "outline"}
          size="sm"
          asChild
        >
          <Link href={withRangeAndFilters(pathname, range, filters)}>{labelFor(messages, range)}</Link>
        </Button>
      ))}
    </div>
  );
}
