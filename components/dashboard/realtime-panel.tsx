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
          <Activity className="h-5 w-5 text-primary" />
          {labels.title}
        </CardTitle>
        <Badge variant={status === "open" ? "default" : "outline"}>{status}</Badge>
      </CardHeader>
      <CardContent>
        {!wsUrl ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            <CircleAlert className="h-4 w-4" />
            {labels.wsHint}
          </div>
        ) : events.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            <PlugZap className="h-4 w-4" />
            {labels.waitingLive}
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((item) => (
              <div key={item.id} className="rounded-lg border p-3 transition-colors hover:bg-muted/50">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{item.pathname}</p>
                  <Badge variant="outline">{item.eventType}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
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
