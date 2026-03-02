"use client";

import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Widget, WidgetHead, WidgetBody } from "@/components/widget/widget";
import { useRealtime } from "@/lib/hooks/use-realtime";
import { formatDateTime } from "@/lib/utils";

interface RealtimeFullViewProps {
  siteId: string;
  wsBaseUrl: string;
  wsToken?: string;
  labels: {
    title: string;
    wsHint: string;
    waitingLive: string;
    noEvents: string;
    live?: string;
  };
}

export function RealtimeFullView({ siteId, wsBaseUrl, wsToken, labels }: RealtimeFullViewProps) {
  const { events, status, wsUrl } = useRealtime(siteId, wsBaseUrl, wsToken);

  return (
    <Widget>
      <WidgetHead>
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          {labels.title}
        </div>
        <div className="flex items-center gap-2">
          {status === "open" && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span className="font-mono tabular-nums">{events.length}</span>
              <span className="text-muted-foreground">{labels.live || "live"}</span>
            </div>
          )}
          <Badge
            variant="outline"
            className={
              status === "open"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-muted text-muted-foreground"
            }
          >
            {status}
          </Badge>
        </div>
      </WidgetHead>
      <WidgetBody>
        {!wsUrl ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{labels.wsHint}</p>
        ) : events.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {status === "open" ? labels.noEvents : labels.waitingLive}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {events.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-3 hover:bg-def-100 transition-colors">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{item.pathname}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.country} · {item.deviceType} · {formatDateTime(item.eventAt)}
                  </span>
                </div>
                <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 h-5">
                  {item.eventType}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </WidgetBody>
    </Widget>
  );
}
