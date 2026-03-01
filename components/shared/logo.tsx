import { Flame } from "lucide-react";
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  showText?: boolean;
}

export function Logo({ className, showText = true }: LogoProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Flame className="h-6 w-6 text-primary" />
      {showText && (
        <span className="font-[var(--font-display)] text-lg font-semibold">
          InsightFlare
        </span>
      )}
    </div>
  );
}
