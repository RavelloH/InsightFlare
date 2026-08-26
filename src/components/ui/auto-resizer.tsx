import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { type Easing, motion } from "motion/react";

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
  const heightRef = useRef<number | "auto">(
    initial && animateHeight ? 0 : "auto",
  );
  const widthRef = useRef<number | "auto">(
    initial && animateWidth ? 0 : "auto",
  );

  useEffect(() => {
    if (!contentRef.current) return;
    const measureContent = (element: HTMLElement) => {
      const nextHeight = element.scrollHeight;
      const nextWidth = element.scrollWidth;
      let changed = false;

      if (animateHeight) {
        if (heightRef.current !== nextHeight) {
          heightRef.current = nextHeight;
          setHeight(nextHeight);
          changed = true;
        }
      }
      if (animateWidth) {
        if (widthRef.current !== nextWidth) {
          widthRef.current = nextWidth;
          setWidth(nextWidth);
          changed = true;
        }
      }
      if (changed) setUpdateCount((prev) => prev + 1);
    };

    measureContent(contentRef.current);

    let frameId: number | null = null;
    const scheduleMeasure = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        if (contentRef.current) measureContent(contentRef.current);
      });
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);

    resizeObserver.observe(contentRef.current);

    const mutationObserver =
      animateWidth && typeof MutationObserver !== "undefined"
        ? new MutationObserver(scheduleMeasure)
        : null;
    mutationObserver?.observe(contentRef.current, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [animateHeight, animateWidth]);

  const shouldAnimate = initial || updateCount > 1;
  const animateTarget: { height?: number | "auto"; width?: number | "auto" } =
    {};
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
        alignItems: animateWidth ? "flex-start" : undefined,
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
                flexShrink: 0,
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
