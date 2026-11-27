import { useCallback, useEffect, useRef, useState } from "react";

interface UseInfiniteTableSentinelOptions {
  enabled: boolean;
  onReachEnd: () => void;
  rootMargin?: string;
  triggerDistance?: number;
}

export function useInfiniteTableSentinel({
  enabled,
  onReachEnd,
  rootMargin = "360px 0px",
  triggerDistance = 480,
}: UseInfiniteTableSentinelOptions) {
  // React 19 callback-ref cleanup identifies the precise detached node.
  // Register in O(1) per row rather than rebuilding a growing array/Set
  // for each of the many skeleton refs in the same commit.
  const sentinelNodes = useRef(new Set<HTMLElement>());
  const [nodeVersion, setNodeVersion] = useState(0);

  const setSentinelNode = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const nodes = sentinelNodes.current;
    nodes.add(node);
    setNodeVersion((version) => version + 1);
    return () => {
      if (nodes.delete(node)) setNodeVersion((version) => version + 1);
    };
  }, []);

  useEffect(() => {
    if (nodeVersion === 0) return;
    const connectedSentinelNodes = [...sentinelNodes.current].filter(
      (node) => node.isConnected,
    );

    if (
      connectedSentinelNodes.length === 0 ||
      !enabled ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    // IntersectionObserver delivers an initial layout snapshot even when a
    // row is clipped by a nested scroll container. Reuse that snapshot for
    // the initial prefetch margin instead of forcing synchronous layout on
    // every skeleton row in an animation frame.
    const initialNodes = new Set(connectedSentinelNodes);
    const observer = new IntersectionObserver(
      (entries) => {
        const viewportHeight = window.innerHeight;
        let shouldLoad = false;
        for (const entry of entries) {
          const initial = initialNodes.delete(entry.target as HTMLElement);
          const rect = entry.boundingClientRect;
          if (
            entry.isIntersecting ||
            (initial &&
              rect.top <= viewportHeight + triggerDistance &&
              rect.bottom >= -triggerDistance)
          ) {
            shouldLoad = true;
          }
        }
        if (shouldLoad) onReachEnd();
      },
      { root: null, rootMargin, threshold: 0.01 },
    );
    connectedSentinelNodes.forEach((node) => observer.observe(node));
    return () => {
      observer.disconnect();
    };
  }, [enabled, onReachEnd, rootMargin, nodeVersion, triggerDistance]);

  return setSentinelNode;
}
