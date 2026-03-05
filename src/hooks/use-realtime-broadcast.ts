import { useEffect, useRef } from "react";
import {
  registerRealtimeBroadcastCallback,
  unregisterRealtimeBroadcastCallback,
} from "@/lib/realtime/broadcast-store";
import type { RealtimeBroadcastMessage } from "@/lib/realtime/types";

export function useRealtimeBroadcast(
  callback: (message: RealtimeBroadcastMessage) => void | Promise<void>,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const id = Symbol("realtime-broadcast-callback");
    registerRealtimeBroadcastCallback(id, (message) => callbackRef.current(message));
    return () => {
      unregisterRealtimeBroadcastCallback(id);
    };
  }, []);
}
