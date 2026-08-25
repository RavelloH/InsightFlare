import { useCallback, useEffect, useState } from "react";

interface UseInfiniteTableSentinelOptions {
  enabled: boolean;
  onReachEnd: () => void;
  rootMargin?: string;
}

export function useInfiniteTableSentinel({
  enabled,
  onReachEnd,
  rootMargin = "360px 0px",
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
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachEnd();
      },
      { root: null, rootMargin, threshold: 0.01 },
    );
    connectedSentinelNodes.forEach((node) => observer.observe(node));
    const frameId = window.requestAnimationFrame(() => {
      const isInTriggerRange = connectedSentinelNodes.some((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top <= window.innerHeight + 480 && rect.bottom >= -480;
      });
      if (isInTriggerRange) {
        onReachEnd();
      }
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [enabled, onReachEnd, rootMargin, sentinelNodes]);

  return setSentinelNode;
}
