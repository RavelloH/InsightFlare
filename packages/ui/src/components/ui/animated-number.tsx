import { type CSSProperties, lazy, Suspense } from "react";

export interface AnimatedNumberProps {
  value: number;
  continuous?: boolean;
  className?: string;
  style?: CSSProperties;
}

function StaticNumber({ value, className, style }: AnimatedNumberProps) {
  return (
    <span className={className} style={style}>
      {value}
    </span>
  );
}

const ClientNumber = lazy(() =>
  import("./animated-number-client").then((module) => ({
    default: module.AnimatedNumberClient,
  })),
);

function HydratedNumber(props: AnimatedNumberProps) {
  return (
    <Suspense fallback={<StaticNumber {...props} />}>
      <ClientNumber {...props} />
    </Suspense>
  );
}

export function AnimatedNumber(props: AnimatedNumberProps) {
  return typeof window === "undefined" ? (
    <StaticNumber {...props} />
  ) : (
    <HydratedNumber {...props} />
  );
}
