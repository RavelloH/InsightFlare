"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AppMessages } from "@/lib/i18n/messages";

type ConnectionState = "connecting" | "connected" | "disconnected";

interface LiveEvent {
  id: string;
  eventType: string;
  eventAt: number;
  pathname: string;
  visitorId: string;
  country: string;
  browser: string;
}

interface RealtimePanelProps {
  siteId: string;
  locale: "en" | "zh";
  messages: AppMessages;
}

function toWsUrl(siteId: string): string {
  const configuredBase = process.env.NEXT_PUBLIC_INSIGHTFLARE_EDGE_URL || "";
  const origin = configuredBase.length > 0 ? configuredBase : window.location.origin;
  const url = new URL("/admin/ws", origin);
  url.searchParams.set("siteId", siteId);

  const wsToken = process.env.NEXT_PUBLIC_ADMIN_WS_TOKEN || "";
  if (wsToken) {
    url.searchParams.set("token", wsToken);
  }

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function normalizeLiveEvent(payload: unknown): LiveEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const eventAt = Number(record.eventAt ?? record.event_at ?? Date.now());

  return {
    id: String(record.id ?? `${eventAt}-${String(record.visitorId ?? "")}`),
    eventType: String(record.eventType ?? record.event_type ?? ""),
    eventAt: Number.isFinite(eventAt) ? eventAt : Date.now(),
    pathname: String(record.pathname ?? "/"),
    visitorId: String(record.visitorId ?? record.visitor_id ?? ""),
    country: String(record.country ?? ""),
    browser: String(record.browser ?? ""),
  };
}

function formatTime(locale: "en" | "zh", timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function RealtimePanel({ siteId, locale, messages }: RealtimePanelProps) {
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [events, setEvents] = useState<LiveEvent[]>([]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");

      socket = new WebSocket(toWsUrl(siteId));

      socket.onopen = () => {
        setStatus("connected");
      };

      socket.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data as string) as {
            type?: string;
            data?: unknown;
          };
          if (payload.type !== "event") return;
          const normalized = normalizeLiveEvent(payload.data);
          if (!normalized) return;
          setEvents((previous) => [normalized, ...previous].slice(0, 20));
        } catch {
          // Ignore malformed realtime payload.
        }
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        if (disposed) return;
        setStatus("disconnected");
        reconnectTimer = setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
    };
  }, [siteId]);

  const activeNow = useMemo(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const visitors = new Set<string>();
    for (const event of events) {
      if (event.eventAt >= cutoff && event.visitorId) {
        visitors.add(event.visitorId);
      }
    }
    return visitors.size;
  }, [events]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle>{messages.realtime.title}</CardTitle>
          <p className="text-xs text-muted-foreground">{messages.realtime.subtitle}</p>
        </div>
        <Badge variant={status === "connected" ? "default" : "outline"}>
          {status === "connected" ? messages.realtime.connected : messages.realtime.disconnected}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline justify-between rounded-none border border-border p-3">
          <p className="text-sm text-muted-foreground">{messages.realtime.activeNow}</p>
          <p className="text-2xl font-semibold">{activeNow}</p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">{messages.realtime.recentEvents}</p>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{messages.common.noData}</p>
          ) : (
            <div className="space-y-2">
              {events.map((event) => (
                <div key={event.id} className="flex items-center justify-between border-b pb-2 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{event.eventType || messages.common.unknown}</p>
                    <p className="truncate text-muted-foreground">
                      {event.pathname || "/"} · {event.country || messages.common.unknown} · {event.browser || messages.common.unknown}
                    </p>
                  </div>
                  <p className="pl-3 text-muted-foreground">{formatTime(locale, event.eventAt)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
