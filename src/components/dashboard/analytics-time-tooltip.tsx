import type { CSSProperties, MouseEvent, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { RiSearchLine } from "@remixicon/react";
import { toast } from "sonner";

import { useReportingTimeZone } from "@/components/time-zone-provider";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { Badge } from "@/components/ui/badge";
import { Clickable } from "@/components/ui/clickable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { intlLocale, shortDateTimeWithSeconds } from "@/lib/dashboard/format";
import { type Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

type TooltipSide = "left" | "right";

interface TimeTooltipRequest {
  kind: "time";
  locale: Locale;
  timestamp: number;
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
  locale: Locale;
  items: readonly AnalyticsTooltipDetail[];
}

export interface AnalyticsCustomTooltipRequest {
  kind: "custom";
  key: string;
  content: ReactNode;
}

type AnalyticsTooltipRequest =
  | TimeTooltipRequest
  | AnalyticsDetailsTooltipRequest
  | AnalyticsCustomTooltipRequest;

interface TooltipRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface ActiveTooltip {
  rect: TooltipRect;
  side: TooltipSide;
  target: HTMLElement;
  request: AnalyticsTooltipRequest;
}

interface AnalyticsTimeTooltipContextValue {
  groupId: string;
  show: (
    target: HTMLElement,
    request: AnalyticsTooltipRequest,
    clientX: number,
  ) => void;
  hide: () => void;
  cancelHide: () => void;
}

const AnalyticsTimeTooltipContext =
  createContext<AnalyticsTimeTooltipContextValue | null>(null);
const TIME_TOOLTIP_HIDE_DELAY_MS = 120;

const RELATIVE_TIME_UNITS: Record<
  Locale,
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

function getTooltipRect(target: HTMLElement): TooltipRect | null {
  if (!target.isConnected) return null;
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
}

function getTooltipSide(clientX: number): TooltipSide {
  return clientX < window.innerWidth / 2 ? "right" : "left";
}

function areRectsEqual(left: TooltipRect, right: TooltipRect): boolean {
  return (
    left.height === right.height &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width
  );
}

function isElement(value: EventTarget | null): value is Element {
  return value instanceof Element;
}

function formatPreciseRelativeTime(
  locale: Locale,
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
    return locale === "en"
      ? `${value} ago`
      : `${value}${locale === "zh" ? "前" : "前"}`;
  }
  return locale === "en"
    ? `in ${value}`
    : `${value}${locale === "zh" ? "后" : "後"}`;
}

function formatTimeZoneShortName(
  locale: Locale,
  timestamp: number,
  timeZone: string,
): string {
  try {
    const value = new Intl.DateTimeFormat(intlLocale(locale), {
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

async function copyAnalyticsValue(value: string, messages: AppMessages) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(messages.events.copiedValue);
  } catch {
    toast.error(messages.events.copyValueFailed);
  }
}

function AnalyticsTimeTooltipContent({
  locale,
  messages,
  timestamp,
  now,
  browserTimeZone,
}: {
  locale: Locale;
  messages: AppMessages;
  timestamp: number;
  now: number;
  browserTimeZone: string;
}) {
  const localTimeZone = browserTimeZone || "UTC";
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

  return (
    <AutoResizer animateWidth className="min-w-0" duration={0.16}>
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
            aria-label={`${messages.events.copyValue}: ${utcTime}`}
            onClick={() => void copyAnalyticsValue(utcTime, messages)}
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
            aria-label={`${messages.events.copyValue}: ${localTime}`}
            onClick={() => void copyAnalyticsValue(localTime, messages)}
          >
            {localTimeZoneLabel}
          </button>
        </Badge>
        <div className="leading-5">
          <span>{localTime}</span>
        </div>
      </div>
    </AutoResizer>
  );
}

function AnalyticsDetailsTooltipContent({
  messages,
  request,
}: {
  messages: AppMessages;
  request: AnalyticsDetailsTooltipRequest;
}) {
  return (
    <AutoResizer animateWidth className="min-w-0" duration={0.16}>
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
                    aria-label={`${messages.events.copyValue}: ${copyValue}`}
                    onClick={() => void copyAnalyticsValue(copyValue, messages)}
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
                    title={item.action.label}
                  >
                    <RiSearchLine size="1.2em" />
                  </Clickable>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </AutoResizer>
  );
}

function AnalyticsCustomTooltipContent({ content }: { content: ReactNode }) {
  return (
    <AutoResizer animateWidth className="min-w-0" duration={0.16}>
      {content}
    </AutoResizer>
  );
}

function AnalyticsTooltipContent({
  browserTimeZone,
  messages,
  now,
  request,
}: {
  browserTimeZone: string;
  messages?: AppMessages;
  now: number;
  request: AnalyticsTooltipRequest;
}) {
  if (request.kind === "custom") {
    return <AnalyticsCustomTooltipContent content={request.content} />;
  }

  if (!messages) return null;

  if (request.kind === "time") {
    return (
      <AnalyticsTimeTooltipContent
        locale={request.locale}
        messages={messages}
        timestamp={request.timestamp}
        now={now}
        browserTimeZone={browserTimeZone}
      />
    );
  }

  return (
    <AnalyticsDetailsTooltipContent messages={messages} request={request} />
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
  const groupId = useId();
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const [content, setContent] = useState<ActiveTooltip | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  const activeRef = useRef<ActiveTooltip | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const pointerMoveFrameRef = useRef<number | null>(null);
  const latestPointerMoveRef = useRef<{
    eventTarget: EventTarget | null;
    clientX: number;
    clientY: number;
  } | null>(null);
  const shouldAnimatePositionRef = useRef(false);
  const tooltipContentRef = useRef<HTMLDivElement | null>(null);
  const { browserTimeZone } = useReportingTimeZone();

  activeRef.current = active;

  useEffect(() => {
    setPortalContainer(document.body);
  }, []);

  const updateActive = useCallback(
    (
      target: HTMLElement,
      request: AnalyticsTooltipRequest,
      clientX: number,
    ) => {
      const rect = getTooltipRect(target);
      if (!rect) return;
      const nextSide = getTooltipSide(clientX);
      const current = activeRef.current;
      if (
        current?.target === target &&
        current.request.kind === request.kind &&
        (request.kind === "time"
          ? current.request.kind === "time" &&
            current.request.timestamp === request.timestamp
          : request.kind === "details"
            ? current.request.kind === "details" &&
              current.request.key === request.key
            : current.request.kind === "custom" &&
              current.request.key === request.key) &&
        current.side === nextSide &&
        areRectsEqual(current.rect, rect)
      ) {
        return;
      }
      shouldAnimatePositionRef.current = current !== null;
      const next = {
        rect,
        side: nextSide,
        target,
        request,
      } satisfies ActiveTooltip;
      activeRef.current = next;
      setContent(next);
      setActive(next);
    },
    [],
  );

  const hide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    activeRef.current = null;
    setActive(null);
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      hide();
    }, TIME_TOOLTIP_HIDE_DELAY_MS);
  }, [hide]);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const show = useCallback(
    (
      target: HTMLElement,
      request: AnalyticsTooltipRequest,
      clientX: number,
    ) => {
      cancelHide();
      updateActive(target, request, clientX);
    },
    [cancelHide, updateActive],
  );

  const isWithinRetentionZone = useCallback(
    (eventTarget: EventTarget | null, clientX: number, clientY: number) => {
      const current = activeRef.current;
      if (!current) return false;

      if (
        isElement(eventTarget) &&
        (eventTarget.closest(
          `[data-analytics-time-tooltip-group="${groupId}"]`,
        ) ||
          eventTarget.closest("[data-analytics-time-tooltip-content]"))
      ) {
        return true;
      }

      const cell = current.target.closest<HTMLTableCellElement>("td");
      if (retentionMode === "target") return false;

      const table = cell?.closest<HTMLTableElement>("table");
      const body = table?.tBodies[0];
      if (!cell || !body) return false;

      const cellRect = cell.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      return (
        clientX >= cellRect.left &&
        clientX <= cellRect.right &&
        clientY >= bodyRect.top &&
        clientY <= bodyRect.bottom
      );
    },
    [groupId, retentionMode],
  );

  const isActive = active !== null;

  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;

    const processPointerMove = () => {
      pointerMoveFrameRef.current = null;
      const latest = latestPointerMoveRef.current;
      if (!latest) return;

      if (
        isWithinRetentionZone(
          latest.eventTarget,
          latest.clientX,
          latest.clientY,
        )
      ) {
        cancelHide();
      } else {
        scheduleHide();
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (
        isElement(event.target) &&
        (event.target.closest(
          `[data-analytics-time-tooltip-group="${groupId}"]`,
        ) ||
          event.target.closest("[data-analytics-time-tooltip-content]"))
      ) {
        latestPointerMoveRef.current = null;
        cancelHide();
        return;
      }

      latestPointerMoveRef.current = {
        eventTarget: event.target,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      if (pointerMoveFrameRef.current !== null) return;
      pointerMoveFrameRef.current =
        window.requestAnimationFrame(processPointerMove);
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove, true);
      latestPointerMoveRef.current = null;
      if (pointerMoveFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerMoveFrameRef.current);
        pointerMoveFrameRef.current = null;
      }
    };
  }, [cancelHide, groupId, isActive, isWithinRetentionZone, scheduleHide]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  const contextValue = useMemo<AnalyticsTimeTooltipContextValue>(
    () => ({
      cancelHide,
      groupId,
      hide: scheduleHide,
      show,
    }),
    [cancelHide, groupId, scheduleHide, show],
  );

  const anchor = active ?? content;
  const anchorStyle: CSSProperties | undefined = anchor
    ? {
        height: anchor.rect.height,
        left: anchor.rect.left,
        top: anchor.rect.top,
        width: anchor.rect.width,
      }
    : undefined;

  useLayoutEffect(() => {
    const wrapper = tooltipContentRef.current?.parentElement;
    if (!wrapper) return;
    wrapper.style.transition =
      shouldAnimatePositionRef.current && active !== null
        ? "transform 160ms ease-out"
        : "none";
  }, [active]);

  return (
    <AnalyticsTimeTooltipContext.Provider value={contextValue}>
      {children}
      <Tooltip
        open={active !== null}
        onOpenChange={(open) => !open && scheduleHide()}
      >
        {portalContainer
          ? createPortal(
              <TooltipTrigger asChild>
                <span
                  aria-hidden="true"
                  className="pointer-events-none fixed z-0 opacity-0"
                  style={anchorStyle}
                />
              </TooltipTrigger>,
              portalContainer,
            )
          : null}
        {content ? (
          <TooltipContent
            ref={tooltipContentRef}
            className="max-w-none"
            side={content.side}
            sideOffset={8}
            align="center"
            data-analytics-time-tooltip-content=""
            onPointerEnter={cancelHide}
            onPointerLeave={scheduleHide}
            updatePositionStrategy="always"
          >
            <AnalyticsTooltipContent
              browserTimeZone={browserTimeZone}
              messages={messages}
              now={now}
              request={content.request}
            />
          </TooltipContent>
        ) : null}
      </Tooltip>
    </AnalyticsTimeTooltipContext.Provider>
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
  locale: Locale;
  timestamp: number;
}) {
  const context = useContext(AnalyticsTimeTooltipContext);

  if (!context) return <>{children}</>;

  const handleEnter = (event: MouseEvent<HTMLSpanElement>) => {
    context.cancelHide();
    context.show(
      event.currentTarget,
      { kind: "time", locale, timestamp },
      event.clientX,
    );
  };

  const handleMove = (event: MouseEvent<HTMLSpanElement>) => {
    context.show(
      event.currentTarget,
      { kind: "time", locale, timestamp },
      event.clientX,
    );
  };

  const handleLeave = (event: MouseEvent<HTMLSpanElement>) => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof HTMLElement &&
      relatedTarget.closest(
        `[data-analytics-time-tooltip-group="${context.groupId}"]`,
      )
    ) {
      return;
    }
    context.hide();
  };

  return (
    <span
      className={cn(className)}
      data-analytics-time-tooltip-group={context.groupId}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onMouseMove={handleMove}
    >
      {children}
    </span>
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
  locale: Locale;
  request: Omit<AnalyticsDetailsTooltipRequest, "kind" | "locale">;
}) {
  const context = useContext(AnalyticsTimeTooltipContext);

  if (!context) return <>{children}</>;

  const showDetails = (event: MouseEvent<HTMLSpanElement>) => {
    context.show(
      event.currentTarget,
      { ...request, kind: "details", locale },
      event.clientX,
    );
  };

  const handleEnter = (event: MouseEvent<HTMLSpanElement>) => {
    context.cancelHide();
    showDetails(event);
  };

  const handleLeave = (event: MouseEvent<HTMLSpanElement>) => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof HTMLElement &&
      relatedTarget.closest(
        `[data-analytics-time-tooltip-group="${context.groupId}"]`,
      )
    ) {
      return;
    }
    context.hide();
  };

  return (
    <span
      className={cn(className)}
      data-analytics-time-tooltip-group={context.groupId}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onMouseMove={showDetails}
    >
      {children}
    </span>
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
  const context = useContext(AnalyticsTimeTooltipContext);

  if (!context) return <>{children}</>;

  const showTooltip = (event: MouseEvent<HTMLSpanElement>) => {
    context.show(
      event.currentTarget,
      { ...request, kind: "custom" },
      event.clientX,
    );
  };

  const handleEnter = (event: MouseEvent<HTMLSpanElement>) => {
    context.cancelHide();
    showTooltip(event);
  };

  const handleLeave = (event: MouseEvent<HTMLSpanElement>) => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof HTMLElement &&
      relatedTarget.closest(
        `[data-analytics-time-tooltip-group="${context.groupId}"]`,
      )
    ) {
      return;
    }
    context.hide();
  };

  return (
    <span
      className={cn(className)}
      data-analytics-time-tooltip-group={context.groupId}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onMouseMove={showTooltip}
    >
      {children}
    </span>
  );
}
