import { useCallback, useEffect, useState } from "react";

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
  const [sentinelNodes, setSentinelNodes] = useState<HTMLElement[]>([]);

  const setSentinelNode = useCallback((node: HTMLElement | null) => {
    setSentinelNodes((currentNodes) => {
      const nextNodes = new Set(
        currentNodes.filter((currentNode) => currentNode.isConnected),
      );
      if (node) nextNodes.add(node);

      const nextNodeList = [...nextNodes];
      if (
        nextNodeList.length === currentNodes.length &&
        nextNodeList.every(
          (currentNode, index) => currentNode === currentNodes[index],
        )
      ) {
        return currentNodes;
      }
      return nextNodeList;
    });
  }, []);

  useEffect(() => {
    const connectedSentinelNodes = sentinelNodes.filter(
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
  }, [enabled, onReachEnd, rootMargin, sentinelNodes, triggerDistance]);

  return setSentinelNode;
}
