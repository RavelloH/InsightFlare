import { useEffect, useRef, useState } from "react";

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

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const nextVisible = Boolean(
          entry?.isIntersecting || (entry?.intersectionRatio ?? 0) > 0,
        );
        setIsVisible(nextVisible);
        setHasMeasuredVisibility(true);
      },
      {
        root: null,
        rootMargin,
        threshold: 0.01,
      },
    );

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
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
