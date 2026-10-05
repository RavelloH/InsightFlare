import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import {
  AnalyticsTooltipProvider as ProductAnalyticsTooltipProvider,
  AnalyticsTooltipTarget as ProductAnalyticsTooltipTarget,
} from "@insightflare/product-ui/analytics-tooltip";
import { Badge } from "@insightflare/ui/badge";
import { Clickable } from "@insightflare/ui/clickable";
import { RiSearchLine } from "@remixicon/react";
import { toast } from "sonner";

import { useReportingTimeZone } from "@/components/time-zone-provider";
import { shortDateTimeWithSeconds } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

export type AnalyticsTooltipLocale = Locale;

export interface AnalyticsTooltipMessages {
  copyValue: string;
}

export interface AnalyticsTooltipDetail {
  label: string;
  value: ReactNode;
  copyValue?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface AnalyticsDetailsTooltipRequest {
  kind: "details";
  key: string;
  locale: AnalyticsTooltipLocale;
  items: readonly AnalyticsTooltipDetail[];
}

export interface AnalyticsCustomTooltipRequest {
  kind: "custom";
  key: string;
  content: ReactNode;
}

const DEFAULT_MESSAGES: AnalyticsTooltipMessages = {
  copyValue: "Copy value",
};

const RELATIVE_TIME_UNITS: Record<
  AnalyticsTooltipLocale,
  {
    day: [string, string];
    hour: [string, string];
    minute: [string, string];
    second: [string, string];
  }
> = {
  en: {
    day: ["day", "days"],
    hour: ["hour", "hours"],
    minute: ["minute", "minutes"],
    second: ["second", "seconds"],
  },
  zh: {
    day: ["天", "天"],
    hour: ["小时", "小时"],
    minute: ["分钟", "分钟"],
    second: ["秒", "秒"],
  },
  ja: {
    day: ["日", "日"],
    hour: ["時間", "時間"],
    minute: ["分", "分"],
    second: ["秒", "秒"],
  },
};

interface AnalyticsTooltipAppContextValue {
  browserTimeZone: string;
  messages: AnalyticsTooltipMessages;
  onCopyResult?: (success: boolean) => void;
}

const AnalyticsTooltipAppContext =
  createContext<AnalyticsTooltipAppContextValue | null>(null);

function formatPreciseRelativeTime(
  locale: AnalyticsTooltipLocale,
  timestamp: number,
  now: number,
): string {
  const diffSeconds = Math.round((timestamp - now) / 1000);
  let remainingSeconds = Math.abs(diffSeconds);
  const values = {
    day: Math.floor(remainingSeconds / 86_400),
    hour: 0,
    minute: 0,
    second: 0,
  };
  remainingSeconds %= 86_400;
  values.hour = Math.floor(remainingSeconds / 3_600);
  remainingSeconds %= 3_600;
  values.minute = Math.floor(remainingSeconds / 60);
  values.second = remainingSeconds % 60;

  const units = RELATIVE_TIME_UNITS[locale];
  const parts = (Object.keys(values) as Array<keyof typeof values>)
    .filter((unit) => values[unit] > 0)
    .map((unit) => {
      const value = values[unit];
      const [singular, plural] = units[unit];
      if (locale === "en") {
        return `${value} ${value === 1 ? singular : plural}`;
      }
      return `${value}${singular}`;
    });

  if (parts.length === 0) {
    const [singular] = units.second;
    parts.push(locale === "en" ? `0 ${singular}s` : `0${singular}`);
  }

  const value = locale === "en" ? parts.join(", ") : parts.join("");
  if (diffSeconds <= 0) {
    return locale === "en" ? `${value} ago` : `${value}前`;
  }
  return locale === "en"
    ? `in ${value}`
    : `${value}${locale === "zh" ? "后" : "後"}`;
}

function formatTimeZoneShortName(
  locale: AnalyticsTooltipLocale,
  timestamp: number,
  timeZone: string,
): string {
  try {
    const value = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(new Date(timestamp))
      .find((part) => part.type === "timeZoneName")?.value;
    return value?.trim() || timeZone;
  } catch {
    return timeZone;
  }
}

async function copyAnalyticsValue(
  value: string,
  onCopyResult?: (success: boolean) => void,
) {
  try {
    await navigator.clipboard.writeText(value);
    onCopyResult?.(true);
  } catch {
    onCopyResult?.(false);
  }
}

function AnalyticsTimeTooltipContent({
  locale,
  timestamp,
  appContext,
}: {
  locale: AnalyticsTooltipLocale;
  timestamp: number;
  appContext: AnalyticsTooltipAppContextValue;
}) {
  const [now, setNow] = useState(() => Date.now());
  const localTimeZone = appContext.browserTimeZone || "UTC";
  const localTimeZoneLabel = formatTimeZoneShortName(
    locale,
    timestamp,
    localTimeZone,
  );
  const utcTime = shortDateTimeWithSeconds(locale, timestamp, "UTC", {
    year: "numeric",
  });
  const localTime = shortDateTimeWithSeconds(locale, timestamp, localTimeZone, {
    year: "numeric",
  });

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="grid grid-cols-[max-content_max-content] items-center gap-x-2 gap-y-1.5 whitespace-nowrap">
      <div className="col-span-2 text-xs leading-5">
        {formatPreciseRelativeTime(locale, timestamp, now)}
      </div>
      <Badge
        asChild
        variant="link"
        className="w-12 cursor-copy px-1 text-[10px]"
      >
        <button
          type="button"
          aria-label={`${appContext.messages.copyValue}: ${utcTime}`}
          onClick={() =>
            void copyAnalyticsValue(utcTime, appContext.onCopyResult)
          }
        >
          UTC
        </button>
      </Badge>
      <div className="leading-5">
        <span>{utcTime}</span>
      </div>
      <Badge
        asChild
        variant="link"
        className="w-12 cursor-copy px-1 text-[10px]"
      >
        <button
          type="button"
          aria-label={`${appContext.messages.copyValue}: ${localTime}`}
          onClick={() =>
            void copyAnalyticsValue(localTime, appContext.onCopyResult)
          }
        >
          {localTimeZoneLabel}
        </button>
      </Badge>
      <div className="leading-5">
        <span>{localTime}</span>
      </div>
    </div>
  );
}

function AnalyticsDetailsTooltipContent({
  request,
  appContext,
}: {
  request: AnalyticsDetailsTooltipRequest;
  appContext: AnalyticsTooltipAppContextValue;
}) {
  return (
    <div className="grid w-max grid-cols-[max-content_max-content] items-center gap-x-2 gap-y-1.5 whitespace-nowrap">
      {request.items.map((item) => {
        const copyValue = item.copyValue;

        return (
          <div key={item.label} className="contents">
            {copyValue !== undefined ? (
              <Badge
                asChild
                variant="link"
                className="h-5 min-w-max cursor-copy px-1 text-[10px]"
              >
                <button
                  type="button"
                  aria-label={`${appContext.messages.copyValue}: ${copyValue}`}
                  onClick={() =>
                    void copyAnalyticsValue(copyValue, appContext.onCopyResult)
                  }
                >
                  {item.label}
                </button>
              </Badge>
            ) : (
              <span className="text-xs leading-5 text-background/70">
                {item.label}
              </span>
            )}
            <div className="inline-flex min-w-0 items-center gap-1 leading-5">
              <span>{item.value}</span>
              {item.action ? (
                <Clickable
                  className="shrink-0 text-background/70 transition-colors hover:text-background"
                  onClick={item.action.onClick}
                  aria-label={item.action.label}
                >
                  <RiSearchLine size="1.2em" />
                </Clickable>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AnalyticsTimeTooltipProvider({
  children,
  messages,
  retentionMode = "table-column",
}: {
  children: ReactNode;
  messages?: AppMessages;
  retentionMode?: "table-column" | "target";
}) {
  const { browserTimeZone } = useReportingTimeZone();
  const tooltipMessages = messages
    ? { copyValue: messages.events.copyValue }
    : DEFAULT_MESSAGES;
  const onCopyResult = messages
    ? (success: boolean) => {
        if (success) toast.success(messages.events.copiedValue);
        else toast.error(messages.events.copyValueFailed);
      }
    : undefined;

  return (
    <AnalyticsTooltipAppContext.Provider
      value={{ browserTimeZone, messages: tooltipMessages, onCopyResult }}
    >
      <ProductAnalyticsTooltipProvider retentionMode={retentionMode}>
        {children}
      </ProductAnalyticsTooltipProvider>
    </AnalyticsTooltipAppContext.Provider>
  );
}

export function AnalyticsTimeTooltipTarget({
  children,
  className,
  locale,
  timestamp,
}: {
  children: ReactNode;
  className?: string;
  locale: AnalyticsTooltipLocale;
  timestamp: number;
}) {
  const appContext = useContext(AnalyticsTooltipAppContext);
  if (!appContext) return <>{children}</>;

  return (
    <ProductAnalyticsTooltipTarget
      className={className}
      contentKey={`time:${locale}:${timestamp}`}
      content={
        <AnalyticsTimeTooltipContent
          locale={locale}
          timestamp={timestamp}
          appContext={appContext}
        />
      }
    >
      {children}
    </ProductAnalyticsTooltipTarget>
  );
}

export function AnalyticsDetailsTooltipTarget({
  children,
  className,
  locale,
  request,
}: {
  children: ReactNode;
  className?: string;
  locale: AnalyticsTooltipLocale;
  request: Omit<AnalyticsDetailsTooltipRequest, "kind" | "locale">;
}) {
  const appContext = useContext(AnalyticsTooltipAppContext);
  if (!appContext) return <>{children}</>;

  return (
    <ProductAnalyticsTooltipTarget
      className={className}
      contentKey={`details:${locale}:${request.key}`}
      content={
        <AnalyticsDetailsTooltipContent
          request={request}
          appContext={appContext}
        />
      }
    >
      {children}
    </ProductAnalyticsTooltipTarget>
  );
}

export function AnalyticsTooltipTarget({
  children,
  className,
  request,
}: {
  children: ReactNode;
  className?: string;
  request: Omit<AnalyticsCustomTooltipRequest, "kind">;
}) {
  return (
    <ProductAnalyticsTooltipTarget
      className={className}
      contentKey={`custom:${request.key}`}
      content={request.content}
    >
      {children}
    </ProductAnalyticsTooltipTarget>
  );
}
