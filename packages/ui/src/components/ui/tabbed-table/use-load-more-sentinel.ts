import { useEffect, useRef, useState } from "react";

interface UseLoadMoreSentinelOptions {
  enabled: boolean;
  onReachEnd?: () => void;
}

export function useLoadMoreSentinel({
  enabled,
  onReachEnd,
}: UseLoadMoreSentinelOptions) {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      triggeredRef.current = false;
      return;
    }
    if (
      !sentinel ||
      !onReachEnd ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const triggerLoadMore = () => {
      if (triggeredRef.current) return;
      triggeredRef.current = true;
      onReachEnd();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) triggerLoadMore();
      },
      { root: null, rootMargin: "0px", threshold: 0.01 },
    );
    observer.observe(sentinel);

    const frameId = window.requestAnimationFrame(() => {
      const rect = sentinel.getBoundingClientRect();
      if (rect.top <= window.innerHeight && rect.bottom >= 0) {
        triggerLoadMore();
      }
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [enabled, onReachEnd, sentinel]);

  return setSentinel;
}
