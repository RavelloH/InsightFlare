"use client";

import { RiErrorWarningLine as CircleAlert, RiPlug2Line as PlugZap } from "@remixicon/react";
import { Badge } from "@/components/ui/badge";
import { useRealtime } from "@/lib/hooks/use-realtime";

interface RealtimeEventListProps {
  siteId: string;
  wsBaseUrl: string;
  wsToken?: string;
  labels: {
    wsHint: string;
    waitingLive: string;
  };
}

export function RealtimeEventList({ siteId, wsBaseUrl, wsToken, labels }: RealtimeEventListProps) {
  const { events, status, wsUrl } = useRealtime(siteId, wsBaseUrl, wsToken);

  if (!wsUrl) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
        <CircleAlert className="h-3.5 w-3.5 shrink-0" />
        {labels.wsHint}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
        <PlugZap className="h-3.5 w-3.5 shrink-0" />
        {labels.waitingLive}
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {events.map((item) => (
        <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-def-100 transition-colors">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm">{item.pathname}</span>
            <span className="text-xs text-muted-foreground">
              {item.country} · {item.deviceType}
            </span>
          </div>
          <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 h-5">
            {item.eventType}
          </Badge>
        </div>
      ))}
    </div>
  );
}
