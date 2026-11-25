import { useEffect, useRef, useState } from "react";

// Chart visibility uses a viewport root and a fixed threshold. Only rootMargin
// varies, so charts with identical options can share one observer.
type VisibilityPool = {
  observer: IntersectionObserver;
  subscribers: Map<Element, (visible: boolean) => void>;
};
const visibilityPools = new Map<string, VisibilityPool>();

function observeChartVisibility(
  element: Element,
  rootMargin: string,
  onVisibility: (visible: boolean) => void,
) {
  let pool = visibilityPools.get(rootMargin);
  if (!pool) {
    const subscribers = new Map<Element, (visible: boolean) => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          subscribers.get(entry.target)?.(
            entry.isIntersecting || entry.intersectionRatio > 0,
          );
        }
      },
      { root: null, rootMargin, threshold: 0.01 },
    );
    pool = { observer, subscribers };
    visibilityPools.set(rootMargin, pool);
  }
  const { observer, subscribers } = pool;
  subscribers.set(element, onVisibility);
  observer.observe(element);
  return () => {
    subscribers.delete(element);
    observer.unobserve(element);
    if (subscribers.size === 0) {
      observer.disconnect();
      visibilityPools.delete(rootMargin);
    }
  };
}

export function useChartVisibility(rootMargin = "120px 0px") {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasMeasuredVisibility, setHasMeasuredVisibility] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      setHasMeasuredVisibility(true);
      return;
    }

    return observeChartVisibility(container, rootMargin, (nextVisible) => {
      setIsVisible(nextVisible);
      setHasMeasuredVisibility(true);
    });
  }, [rootMargin]);

  return {
    containerRef,
    isVisible,
    hasMeasuredVisibility,
  };
}

export function useAnimationOnChartSwitch({
  switchKey,
  hasData,
  isVisible,
  hasMeasuredVisibility,
}: {
  switchKey: string;
  hasData: boolean;
  isVisible: boolean;
  hasMeasuredVisibility: boolean;
}): boolean {
  const appliedKeyRef = useRef<string | null>(null);
  const hasInitializedRef = useRef(false);
  const animationEnabledRef = useRef(false);

  if (!hasMeasuredVisibility) {
    return false;
  }

  // Visibility is measured after the first render. Treat that measurement as
  // initialization, rather than as a chart-data switch that should replay.
  if (!hasInitializedRef.current) {
    hasInitializedRef.current = true;
    appliedKeyRef.current = switchKey;
    animationEnabledRef.current = false;
    return false;
  }

  if (appliedKeyRef.current !== switchKey) {
    appliedKeyRef.current = switchKey;
    animationEnabledRef.current = hasData && isVisible;
  }

  return animationEnabledRef.current;
}
