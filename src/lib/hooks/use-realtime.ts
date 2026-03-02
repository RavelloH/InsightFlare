"use client";

import { useEffect, useMemo, useState } from "react";

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

export function useRealtime(siteId: string, wsBaseUrl: string, wsToken?: string) {
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

  return { events, status, wsUrl };
}

export type { RealtimeEvent };
