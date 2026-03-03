"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  AnimatePresence,
  motion,
  type TargetAndTransition,
} from "motion/react";

export type TransitionType =
  | "fade"
  | "slide"
  | "scale"
  | "slideUp"
  | "slideDown";

export interface AutoTransitionProps {
  children: React.ReactNode;
  className?: string;
  duration?: number;
  type?: TransitionType;
  initial?: boolean;
  customVariants?: {
    initial?: TargetAndTransition;
    animate?: TargetAndTransition;
    exit?: TargetAndTransition;
  };
}

const transitionVariants: Record<
  TransitionType,
  {
    initial: TargetAndTransition;
    animate: TargetAndTransition;
    exit: TargetAndTransition;
  }
> = {
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  slide: {
    initial: { opacity: 0, x: -20 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: 20 },
  },
  slideUp: {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -20 },
  },
  slideDown: {
    initial: { opacity: 0, y: -20 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 20 },
  },
  scale: {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.95 },
  },
};

export function AutoTransition({
  children,
  className = "",
  duration = 0.3,
  type = "fade",
  initial = true,
  customVariants,
}: AutoTransitionProps) {
  const [hasRendered, setHasRendered] = useState(false);

  useEffect(() => {
    if (!hasRendered) setHasRendered(true);
  }, [hasRendered]);

  const key = useMemo(() => {
    if (!children) return "empty";

    const childArray = React.Children.toArray(children);
    const firstChild = childArray[0];

    if (React.isValidElement(firstChild) && firstChild.key) {
      return String(firstChild.key);
    }

    if (React.isValidElement(firstChild)) {
      const childType = firstChild.type;
      if (typeof childType === "string") return childType;
      if (typeof childType === "function") {
        return (
          (childType as { displayName?: string; name?: string }).displayName ||
          childType.name ||
          "component"
        );
      }
    }

    return typeof firstChild === "string" || typeof firstChild === "number"
      ? String(firstChild)
      : "node";
  }, [children]);

  const selectedVariants = customVariants || transitionVariants[type];
  const shouldAnimate = initial || hasRendered;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={key}
        className={className}
        initial={shouldAnimate ? selectedVariants.initial : false}
        animate={selectedVariants.animate}
        exit={selectedVariants.exit}
        transition={{ duration }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

