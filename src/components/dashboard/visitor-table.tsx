"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import type { VisitorsData } from "@/lib/edge-client";

interface VisitorTableProps {
  visitors: VisitorsData["data"];
  emptyLabel?: string;
}

function shortId(value: string): string {
  if (!value) return "unknown";
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function VisitorTable({ visitors, emptyLabel = "No visitors" }: VisitorTableProps) {
  if (visitors.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="divide-y divide-border">
      {visitors.map((visitor) => (
        <div key={visitor.visitorId} className="flex items-center gap-3 px-4 py-2.5 hover:bg-def-100 transition-colors">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{shortId(visitor.visitorId)}</p>
            <p className="truncate text-xs text-muted-foreground">
              {visitor.latestPath || "/"} · {formatDateTime(visitor.lastSeenAt)}
            </p>
          </div>
          <Badge variant="outline" className="h-5 shrink-0 px-1.5 py-0 text-[10px]">
            {visitor.views}
          </Badge>
        </div>
      ))}
    </div>
  );
}

