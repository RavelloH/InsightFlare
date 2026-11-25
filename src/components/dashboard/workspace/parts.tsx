import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";

import { epochSecondsToMs } from "@/components/dashboard/admin/team-management/model";
import { intlLocale } from "@/lib/dashboard/format";
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
