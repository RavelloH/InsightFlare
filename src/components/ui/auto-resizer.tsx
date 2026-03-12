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
  animateWidth?: boolean;
  animateHeight?: boolean;
}

export function AutoResizer({
  children,
  className = "",
  duration = 0.3,
  ease = "easeInOut",
  initial = false,
  animateWidth = false,
  animateHeight = true,
}: AutoResizerProps) {
  const [height, setHeight] = useState<number | "auto">(
    initial && animateHeight ? 0 : "auto",
  );
  const [width, setWidth] = useState<number | "auto">(
    initial && animateWidth ? 0 : "auto",
  );
  const [updateCount, setUpdateCount] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contentRef.current) return;
    const measureContent = (element: HTMLElement) => {
      const nextHeight = element.scrollHeight;
      const nextWidth = element.scrollWidth;
      if (animateHeight) {
        setHeight(nextHeight);
      }
      if (animateWidth) {
        setWidth(nextWidth);
      }
      setUpdateCount((prev) => prev + 1);
    };

    measureContent(contentRef.current);

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        measureContent(entry.target as HTMLElement);
      }
    });

    resizeObserver.observe(contentRef.current);
    return () => resizeObserver.disconnect();
  }, [animateHeight, animateWidth]);

  const shouldAnimate = initial || updateCount > 1;
  const animateTarget: { height?: number | "auto"; width?: number | "auto" } = {};
  if (animateHeight) {
    animateTarget.height = height;
  }
  if (animateWidth) {
    animateTarget.width = width;
  }

  return (
    <motion.div
      className={className}
      style={{
        overflow: "hidden",
        display: animateWidth ? "inline-flex" : undefined,
      }}
      animate={animateTarget}
      transition={{
        duration: shouldAnimate ? duration : 0,
        ease: ease as Easing | Easing[],
      }}
    >
      <div
        ref={contentRef}
        style={
          animateWidth
            ? {
                display: "inline-block",
                width: "max-content",
              }
            : undefined
        }
      >
        {children}
      </div>
    </motion.div>
  );
}
