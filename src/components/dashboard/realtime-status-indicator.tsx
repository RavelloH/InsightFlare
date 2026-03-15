"use client";

import { AutoTransition } from "@/components/ui/auto-transition";
import type { AppMessages } from "@/lib/i18n/messages";
import type { RealtimeConnectionState } from "@/lib/realtime/types";

export function realtimeStatusText(
  messages: AppMessages,
  status: RealtimeConnectionState,
): string {
  if (status === "connected") return messages.realtime.connected;
  if (status === "connecting") return messages.realtime.connecting;
  if (status === "disconnected") return messages.realtime.reconnecting;
  return messages.realtime.failed;
}

export function RealtimeStatusDot({
  status,
}: {
  status: RealtimeConnectionState;
}) {
  return (
    <AutoTransition
      type="scale"
      duration={0.14}
      initial={false}
      className="relative inline-flex size-4 items-center justify-center"
    >
      {status === "connected" ? (
        <span key="connected" className="relative inline-flex size-4 items-center justify-center">
          <span className="absolute inline-flex size-3 rounded-full bg-emerald-500/70 dark:bg-emerald-400/70 animate-ping" />
          <span className="inline-flex size-2 rounded-full bg-emerald-500 dark:bg-emerald-400" />
        </span>
      ) : status === "connecting" ? (
        <span key="connecting" className="relative inline-flex size-4 items-center justify-center">
          <span className="inline-flex size-2 rounded-full bg-neutral-500 dark:bg-neutral-400 animate-pulse" />
        </span>
      ) : status === "disconnected" ? (
        <span key="disconnected" className="relative inline-flex size-4 items-center justify-center">
          <span className="absolute inline-flex size-3 rounded-full bg-amber-500/70 dark:bg-amber-400/70 animate-ping" />
          <span className="inline-flex size-2 rounded-full bg-amber-500 dark:bg-amber-400" />
        </span>
      ) : (
        <span key="failed" className="relative inline-flex size-4 items-center justify-center">
          <span className="absolute inline-flex size-3 rounded-full bg-rose-500/70 dark:bg-rose-400/70 animate-ping" />
          <span className="inline-flex size-2 rounded-full bg-rose-500 dark:bg-rose-400" />
        </span>
      )}
    </AutoTransition>
  );
}
