import { useEffect, useState } from "react";
import { useRealtimeBroadcast } from "@/hooks/use-realtime-broadcast";
import {
  acquireRealtimeChannel,
  createIdleRealtimeChannelState,
  getRealtimeChannelState,
} from "@/lib/realtime/client";
import type { RealtimeChannelState } from "@/lib/realtime/types";

interface UseRealtimeChannelOptions {
  enabled?: boolean;
}

export function useRealtimeChannel(
  siteId?: string,
  options?: UseRealtimeChannelOptions,
): RealtimeChannelState {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<RealtimeChannelState>(() => {
    if (!enabled || !siteId) return createIdleRealtimeChannelState();
    return getRealtimeChannelState(siteId);
  });

  useRealtimeBroadcast((message) => {
    if (!enabled || !siteId) return;
    if (message.siteId !== siteId) return;
    setState(message.state);
  });

  useEffect(() => {
    if (!enabled || !siteId) {
      setState(createIdleRealtimeChannelState());
      return;
    }

    setState(getRealtimeChannelState(siteId));
    const release = acquireRealtimeChannel(siteId);
    return () => {
      release();
    };
  }, [enabled, siteId]);

  return state;
}
