"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, CircleAlert, PlugZap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/utils";

interface RealtimePanelProps {
  siteId: string;
  wsBaseUrl: string;
  wsToken?: string;
}

interface RealtimeEvent {
  id: string;
  eventType: string;
  eventAt: number;
  pathname: string;
  country: string;
  deviceType: string;
}

function normalizeWsUrl(baseUrl: string, siteId: string, token?: string): string | null {
  if (!baseUrl || baseUrl.trim().length === 0) return null;
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/admin/ws";
  url.searchParams.set("siteId", siteId);
  if (token && token.length > 0) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export function RealtimePanel({ siteId, wsBaseUrl, wsToken }: RealtimePanelProps): React.JSX.Element {
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "open" | "closed" | "error">("idle");
  const wsUrl = useMemo(() => normalizeWsUrl(wsBaseUrl, siteId, wsToken), [wsBaseUrl, siteId, wsToken]);

  useEffect(() => {
    if (!wsUrl) return;

    setStatus("connecting");
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => setStatus("open");
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("error");
    ws.onmessage = (event) => {
      try {
        const packet = JSON.parse(String(event.data)) as {
          type?: string;
          data?: Partial<RealtimeEvent>;
        };
        if (packet.type !== "event" || !packet.data) return;
        const next: RealtimeEvent = {
          id: packet.data.id || crypto.randomUUID(),
          eventType: packet.data.eventType || "unknown",
          eventAt: Number(packet.data.eventAt || Date.now()),
          pathname: packet.data.pathname || "/",
          country: packet.data.country || "??",
          deviceType: packet.data.deviceType || "unknown",
        };
        setEvents((prev) => [next, ...prev].slice(0, 20));
      } catch {
        // ignore malformed ws packets
      }
    };

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
          <Activity className="h-5 w-5 text-accent" />
          Realtime Stream
        </CardTitle>
        <Badge variant={status === "open" ? "default" : "outline"}>{status}</Badge>
      </CardHeader>
      <CardContent>
        {!wsUrl ? (
          <div className="flex items-center gap-2 rounded-xl2 border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            <CircleAlert className="h-4 w-4" />
            Set `NEXT_PUBLIC_INSIGHTFLARE_WS_URL` to enable realtime stream.
          </div>
        ) : events.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl2 border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
            <PlugZap className="h-4 w-4" />
            Waiting for live events...
          </div>
        ) : (
          <div className="space-y-2">
            {events.map((item) => (
              <div key={item.id} className="rounded-xl2 border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">{item.pathname}</p>
                  <Badge variant="outline">{item.eventType}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-500">
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

