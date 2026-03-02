"use client";

import { useRealtime } from "@/lib/hooks/use-realtime";

interface LiveCounterProps {
  siteId: string;
  wsBaseUrl: string;
  wsToken?: string;
  label?: string;
}

export function LiveCounter({ siteId, wsBaseUrl, wsToken, label = "live" }: LiveCounterProps) {
  const { events, status } = useRealtime(siteId, wsBaseUrl, wsToken);
  const count = events.length;

  if (status !== "open" && status !== "connecting") {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <span className="font-mono tabular-nums">{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}
