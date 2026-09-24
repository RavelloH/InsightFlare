import { type HTMLMotionProps, motion } from "motion/react";

import { cn } from "@/lib/utils";

const DATA_ROW_LAYOUT_TRANSITION = {
  layout: {
    duration: 0.34,
    ease: [0.22, 1, 0.36, 1],
  },
  opacity: {
    duration: 0.18,
    ease: [0.22, 1, 0.36, 1],
  },
} as const;

interface AnimatedDataTableRowProps extends HTMLMotionProps<"tr"> {
  reduceMotion?: boolean;
}

export function AnimatedDataTableRow({
  reduceMotion = false,
  className,
  children,
  ...props
}: AnimatedDataTableRowProps) {
  return (
    <motion.tr
      data-slot="table-row"
      layout={reduceMotion ? false : "position"}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
      transition={DATA_ROW_LAYOUT_TRANSITION}
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    >
      {children}
    </motion.tr>
  );
}
