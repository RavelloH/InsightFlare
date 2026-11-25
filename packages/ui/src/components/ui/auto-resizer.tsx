import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { type Easing, motion } from "motion/react";

// All AutoResizer content nodes use the same ResizeObserver. Each subscriber
// retains its own measurement frame and animation state.
const resizeSubscribers = new Map<Element, () => void>();
let sharedResizeObserver: ResizeObserver | null = null;

function observeContentResize(element: Element, onResize: () => void) {
  if (!sharedResizeObserver) {
    sharedResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) resizeSubscribers.get(entry.target)?.();
    });
  }
  const observer = sharedResizeObserver;
  resizeSubscribers.set(element, onResize);
  observer.observe(element);
  return () => {
    resizeSubscribers.delete(element);
    observer.unobserve(element);
    if (resizeSubscribers.size === 0) {
      observer.disconnect();
      sharedResizeObserver = null;
    }
  };
}

export interface AutoResizerProps {
  children: ReactNode;
  className?: string;
  duration?: number;
  ease?: Easing | Easing[];
  initial?: boolean;
  animateWidth?: boolean;
  animateHeight?: boolean;
  maxHeight?: number;
}

export function AutoResizer({
  children,
  className = "",
  duration = 0.3,
  ease = "easeInOut",
  initial = false,
  animateWidth = false,
  animateHeight = true,
  maxHeight,
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
    if (!contentRef.current || (!animateHeight && !animateWidth)) return;
    const measureContent = (element: HTMLElement) => {
      let changed = false;

      if (animateHeight) {
        const nextHeight = element.scrollHeight;
        const targetHeight =
          maxHeight === undefined
            ? nextHeight
            : Math.min(nextHeight, maxHeight);
        if (heightRef.current !== targetHeight) {
          heightRef.current = targetHeight;
          setHeight(targetHeight);
          changed = true;
        }
      }
      if (animateWidth) {
        const nextWidth = element.scrollWidth;
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

    const stopObserving = observeContentResize(
      contentRef.current,
      scheduleMeasure,
    );

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
      stopObserving();
      mutationObserver?.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [animateHeight, animateWidth, maxHeight]);

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
      data-slot="auto-resizer"
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
