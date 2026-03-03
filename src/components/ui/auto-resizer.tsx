"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { motion, type Easing } from "motion/react";

export interface AutoResizerProps {
  children: ReactNode;
  className?: string;
  duration?: number;
  ease?: Easing | Easing[];
  initial?: boolean;
}

export function AutoResizer({
  children,
  className = "",
  duration = 0.3,
  ease = "easeInOut",
  initial = false,
}: AutoResizerProps) {
  const [height, setHeight] = useState<number | "auto">("auto");
  const [updateCount, setUpdateCount] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeight(entry.contentRect.height);
        setUpdateCount((prev) => prev + 1);
      }
    });

    resizeObserver.observe(contentRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  const shouldAnimate = initial || updateCount > 1;

  return (
    <motion.div
      className={className}
      style={{ overflow: "hidden" }}
      animate={{ height }}
      transition={{
        duration: shouldAnimate ? duration : 0,
        ease: ease as Easing | Easing[],
      }}
    >
      <div ref={contentRef}>{children}</div>
    </motion.div>
  );
}

