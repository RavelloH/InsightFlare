import { memo, useCallback, useSyncExternalStore } from "react";

const RELATIVE_TIME_REFRESH_MS = 1_000;

const relativeTimeFormatterCache = new Map<string, Intl.RelativeTimeFormat>();
let realtimeClockNow = Date.now();
let realtimeClockTimer: number | null = null;
const realtimeClockSubscribers = new Set<() => void>();

function getRelativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = relativeTimeFormatterCache.get(locale);
  if (cached) return cached;

  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
  });
  relativeTimeFormatterCache.set(locale, formatter);
  return formatter;
}

export function formatRelativeTime(
  locale: string,
  timestamp: number,
  now: number,
): string {
  const formatter = getRelativeTimeFormatter(locale);
  const diffSeconds = Math.round((timestamp - now) / 1000);
  const absoluteSeconds = Math.abs(diffSeconds);

  if (absoluteSeconds < 60) {
    return formatter.format(diffSeconds, "second");
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

function subscribeRealtimeClock(
  onStoreChange: () => void,
  enabled = true,
): () => void {
  if (!enabled || typeof window === "undefined") return () => undefined;

  realtimeClockSubscribers.add(onStoreChange);
  if (realtimeClockTimer === null) {
    realtimeClockNow = Date.now();
    realtimeClockTimer = window.setInterval(() => {
      realtimeClockNow = Date.now();
      realtimeClockSubscribers.forEach((subscriber) => subscriber());
    }, RELATIVE_TIME_REFRESH_MS);
  }

  return () => {
    realtimeClockSubscribers.delete(onStoreChange);
    if (realtimeClockSubscribers.size === 0 && realtimeClockTimer !== null) {
      window.clearInterval(realtimeClockTimer);
      realtimeClockTimer = null;
    }
  };
}

function getRealtimeClockSnapshot() {
  return realtimeClockNow;
}

export function useRealtimeClock(enabled = true) {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeRealtimeClock(onStoreChange, enabled),
    [enabled],
  );

  return useSyncExternalStore(
    subscribe,
    getRealtimeClockSnapshot,
    getRealtimeClockSnapshot,
  );
}

export const RealtimeRelativeTime = memo(function RealtimeRelativeTime({
  locale,
  timestamp,
}: {
  locale: string;
  timestamp: number;
}) {
  const now = useRealtimeClock();
  return formatRelativeTime(locale, timestamp, now);
});
