"use client";

import { useAnimatedNumber } from "@/lib/hooks/use-animated-number";

interface AnimatedCounterProps {
  value: number;
  formatter?: (value: number) => string;
  duration?: number;
}

export function AnimatedCounter({ value, formatter, duration = 800 }: AnimatedCounterProps) {
  const animatedValue = useAnimatedNumber(value, duration);
  const display = formatter ? formatter(animatedValue) : Math.round(animatedValue).toString();

  return <span>{display}</span>;
}
