"use client";

import { Activity, CircleAlert, PlugZap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRealtime } from "@/lib/hooks/use-realtime";
import { formatDateTime } from "@/lib/utils";

interface RealtimePanelProps {
  siteId: string;
  wsBaseUrl: string;
  wsToken?: string;
  labels: {
    title: string;
    wsHint: string;
    waitingLive: string;
  };
}

export function RealtimePanel({ siteId, wsBaseUrl, wsToken, labels }: RealtimePanelProps) {
  const { events, status, wsUrl } = useRealtime(siteId, wsBaseUrl, wsToken);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <span className="bg-def-200 rounded-lg p-1 inline-flex">
            <Activity className="h-4 w-4" />
          </span>
          {labels.title}
        </CardTitle>
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
      </CardHeader>
      <CardContent>
        {!wsUrl ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            <span className="bg-def-200 rounded-lg p-1 inline-flex">
              <CircleAlert className="h-3.5 w-3.5" />
            </span>
            {labels.wsHint}
          </div>
        ) : events.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            <span className="bg-def-200 rounded-lg p-1 inline-flex">
              <PlugZap className="h-3.5 w-3.5" />
            </span>
            {labels.waitingLive}
          </div>
        ) : (
          <div className="space-y-1.5">
            {events.map((item) => (
              <div key={item.id} className="rounded-md border p-2.5 transition-colors hover:bg-muted/50">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">{item.pathname}</p>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">{item.eventType}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.country} · {item.deviceType} · {formatDateTime(item.eventAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
