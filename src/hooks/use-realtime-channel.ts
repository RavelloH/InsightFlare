import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  acquireRealtimeChannel,
  getRealtimeChannelSnapshot,
  subscribeRealtimeChannel,
} from "@/lib/realtime/client";
import type { RealtimeChannelState } from "@/lib/realtime/types";

interface UseRealtimeChannelOptions {
  enabled?: boolean;
}

type RealtimeStateSelector<T> = (state: RealtimeChannelState) => T;
type RealtimeStateEquality<T> = (left: T, right: T) => boolean;

export function useRealtimeChannelSelector<T>(
  siteId: string | undefined,
  selector: RealtimeStateSelector<T>,
  isEqual: RealtimeStateEquality<T> = Object.is,
  options?: UseRealtimeChannelOptions,
): T {
  const enabled = options?.enabled ?? true;
  const selectedRef = useRef<{
    snapshot: RealtimeChannelState | null;
    hasValue: boolean;
    value: T | undefined;
  }>({ snapshot: null, hasValue: false, value: undefined });
  const selectorRef = useRef(selector);
  const selectorIdentityRef = useRef(selector);
  if (selectorIdentityRef.current !== selector) {
    selectorIdentityRef.current = selector;
    selectedRef.current = {
      snapshot: null,
      hasValue: false,
      value: undefined,
    };
  }
  selectorRef.current = selector;
  const equalityRef = useRef(isEqual);
  equalityRef.current = isEqual;

  const getSelectedSnapshot = useCallback(() => {
    const snapshot = enabled
      ? getRealtimeChannelSnapshot(siteId)
      : getRealtimeChannelSnapshot();
    const previous = selectedRef.current;
    if (previous.snapshot === snapshot && previous.hasValue) {
      return previous.value as T;
    }

    const next = selectorRef.current(snapshot);
    if (previous.hasValue && equalityRef.current(previous.value as T, next)) {
      selectedRef.current = {
        snapshot,
        hasValue: true,
        value: previous.value,
      };
      return previous.value as T;
    }

    selectedRef.current = { snapshot, hasValue: true, value: next };
    return next;
  }, [enabled, siteId]);

  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeRealtimeChannel(siteId, listener) : () => {},
    [enabled, siteId],
  );

  const selected = useSyncExternalStore(
    subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );

  useEffect(() => {
    if (!enabled || !siteId) return;
    return acquireRealtimeChannel(siteId);
  }, [enabled, siteId]);

  return selected;
}
