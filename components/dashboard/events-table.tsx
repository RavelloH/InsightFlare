"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import type { EventsData } from "@/lib/edge-client";

interface EventsTableProps {
  events: EventsData["data"];
  emptyLabel?: string;
}

export function EventsTable({ events, emptyLabel = "No events" }: EventsTableProps) {
  if (events.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="divide-y divide-border">
      {events.map((item) => (
        <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-def-100 transition-colors">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{item.pathname || "/"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {item.country || "??"} · {item.deviceType || "unknown"} · {formatDateTime(item.eventAt)}
            </p>
          </div>
          <Badge variant="outline" className="h-5 shrink-0 px-1.5 py-0 text-[10px]">
            {item.eventType || "event"}
          </Badge>
        </div>
      ))}
    </div>
  );
}

