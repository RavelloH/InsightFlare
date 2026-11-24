import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";

import { epochSecondsToMs } from "@/components/dashboard/admin/team-management/model";
import { intlLocale } from "@/lib/dashboard/format";
import type { TeamTrafficPoint } from "@/lib/dashboard/team-dashboard-query";
import type { NotificationMessageData } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

export function ChangeText({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value))
    return <span className="text-muted-foreground">—</span>;
  if (Math.abs(value) < 0.05)
    return (
      <span className="font-mono text-muted-foreground tabular-nums">0.0%</span>
    );
  const Icon = value > 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono tabular-nums",
        value > 0 ? "text-emerald-600" : "text-rose-600",
      )}
    >
      <Icon className="size-3.5" />
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

/** Visitors per bucket as a compact bar strip, like the sidebar's site rows. */
export function TrendStrip({
  points,
  className = "h-5 w-24",
}: {
  points: readonly TeamTrafficPoint[];
  className?: string;
}) {
  const recent = points.slice(-30);
  if (!recent.length) return null;
  const max = Math.max(1, ...recent.map((point) => point.visitors));
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${recent.length * 3} 20`}
      preserveAspectRatio="none"
      className={cn("shrink-0", className)}
    >
      {recent.map((point, index) => {
        const height = Math.max(1, (point.visitors / max) * 20);
        return (
          <rect
            key={point.timestampMs}
            x={index * 3}
            y={20 - height}
            width={2}
            height={height}
            fill="var(--color-chart-1)"
          />
        );
      })}
    </svg>
  );
}

export function relativeTime(locale: Locale, timestampMs: number, now: number) {
  const format = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  });
  const seconds = Math.round((timestampMs - now) / 1000);
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const;
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size)
      return format.format(Math.round(seconds / size), unit);
  return format.format(0, "minute");
}

export function greeting(
  greetings: AppMessages["workspace"]["greetings"],
  now: number,
  name: string,
) {
  if (!now || !name) return "";
  const hour = new Date(now).getHours();
  const template =
    hour < 5 || hour >= 18
      ? greetings.evening
      : hour < 12
        ? greetings.morning
        : greetings.afternoon;
  return formatI18nTemplate(template, { name });
}

const severityDot: Record<string, string> = {
  critical: "bg-destructive",
  warning: "bg-amber-500",
};

export function AttentionRow({
  locale,
  message,
  siteName,
  now,
}: {
  locale: Locale;
  message: NotificationMessageData;
  siteName?: string;
  now: number;
}) {
  const at = epochSecondsToMs(message.triggeredAt ?? message.createdAt);
  return (
    <li>
      <Link
        href={`/${locale}/app/inbox`}
        className="flex items-start gap-2.5 px-4 py-2.5 text-xs hover:bg-muted/50"
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 size-1.5 shrink-0",
            severityDot[message.severity] ?? "bg-primary",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{message.title}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {[siteName, now ? relativeTime(locale, at, now) : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </Link>
    </li>
  );
}
