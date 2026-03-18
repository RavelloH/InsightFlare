"use client";

import {
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Icon } from "@iconify/react";
import Avatar from "boring-avatars";
import { RiGlobalLine } from "@remixicon/react";
import { motion, useReducedMotion } from "motion/react";
import { OverlayScrollbars } from "overlayscrollbars";
import type { PartialOptions } from "overlayscrollbars";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { intlLocale, shortDateTime } from "@/lib/dashboard/format";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { RealtimeEvent } from "@/lib/realtime/types";
import { cn } from "@/lib/utils";

interface RealtimeLogStreamCardProps {
  locale: Locale;
  messages: AppMessages;
  hasConnected: boolean;
  events: RealtimeEvent[];
}

const PRESENCE_LEAVE_EVENT = "__presence_leave";
const RELATIVE_TIME_REFRESH_MS = 1_000;
const INITIAL_VISIBLE_EVENTS = 24;
const LOAD_MORE_STEP = 24;
const LOAD_MORE_THRESHOLD_PX = 160;
const VISITOR_AVATAR_COLORS = [
  "#0f172a",
  "#1d4ed8",
  "#0f766e",
  "#f59e0b",
  "#e11d48",
];
const BROWSER_ICON_DIR = "/images/browser";
const OS_ICON_DIR = "/images/os";
const UNKNOWN_ICON_KEY = "unknown";
const BROWSER_APPLE_ICON_KEYS = new Set(["ios", "ios-webview"]);
const OS_APPLE_ICON_KEYS = new Set(["ios", "mac-os"]);
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
const PANEL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;
const LOG_STREAM_ITEM_TRANSITION = {
  duration: 0.2,
  ease: [0.22, 1, 0.36, 1],
} as const;
const LOG_STREAM_SLOT_TRANSITION = {
  duration: 0.24,
  ease: [0.22, 1, 0.36, 1],
} as const;
const LOG_STREAM_ITEM_GAP_PX = 8;

type RealtimeLogEventKind = "enter" | "exit" | "view" | "custom";
type IncomingInsertionPhase = "idle" | "measuring" | "shifting" | "revealing";

function classifyRealtimeLogEvent(eventType: string): RealtimeLogEventKind {
  if (eventType === "visit") return "enter";
  if (eventType === PRESENCE_LEAVE_EVENT) return "exit";
  if (eventType === "pageview") return "view";
  return "custom";
}

function eventTitlePrefix(
  messages: AppMessages,
  kind: RealtimeLogEventKind,
): string {
  if (kind === "enter") return messages.realtime.enterPage;
  if (kind === "exit") return messages.realtime.leavePage;
  if (kind === "view") return messages.realtime.viewPage;
  return messages.realtime.customEvent;
}

function formatLogTitle(
  locale: Locale,
  messages: AppMessages,
  event: RealtimeEvent,
  kind: RealtimeLogEventKind,
): string {
  const separator = locale === "zh" ? "：" : ":";
  const prefix = eventTitlePrefix(messages, kind);
  const pathname = event.pathname.trim() || "/";
  const content = kind === "custom"
    ? event.eventType.trim() || messages.common.unknown
    : pathname;
  return `${prefix}${separator}${content}`;
}

function resolveBrowserIconKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return UNKNOWN_ICON_KEY;
  if (normalized.includes("android webview") || normalized.includes("android-webview")) {
    return "android-webview";
  }
  if (normalized.includes("chromium-webview")) return "chromium-webview";
  if (normalized.includes("edge ios")) return "edge-ios";
  if (normalized.includes("edge")) return "edge-chromium";
  if (normalized.includes("chrome ios") || normalized.includes("crios")) return "crios";
  if (normalized.includes("firefox ios") || normalized.includes("fxios")) return "fxios";
  if (normalized.includes("ios webview")) return "ios-webview";
  if (normalized === "ios") return "ios";
  if (normalized.includes("arc")) return "arc";
  if (normalized.includes("opera mini")) return "opera-mini";
  if (normalized.includes("opera gx")) return "opera-gx";
  if (normalized.includes("opera")) return "opera";
  if (normalized.includes("samsung")) return "samsung";
  if (normalized.includes("wechat")) return "wechat";
  if (normalized.includes("duckduckgo")) return "duckduckgo";
  if (normalized.includes("instagram")) return "instagram";
  if (normalized.includes("facebook")) return "facebook";
  if (normalized.includes("huawei")) return "huawei";
  if (normalized.includes("qqbrowser") || normalized.includes("qq browser") || normalized === "qq") {
    return "qq";
  }
  if (normalized.includes("ucbrowser") || normalized.includes("uc browser")) return "uc";
  if (normalized.includes("brave")) return "brave";
  if (normalized.includes("miui")) return "miui";
  if (normalized.includes("firefox")) return "firefox";
  if (normalized.includes("safari")) return "safari";
  if (normalized.includes("chrome") || normalized.includes("chromium")) return "chrome";
  if (normalized.includes("android")) return "android";
  return UNKNOWN_ICON_KEY;
}

function resolveOsIconKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return UNKNOWN_ICON_KEY;
  if (normalized.includes("windows 11")) return "windows-11";
  if (normalized.includes("windows 10")) return "windows-10";
  if (normalized.startsWith("windows")) return "windows-10";
  if (
    normalized.startsWith("mac")
    || normalized.startsWith("os x")
    || normalized.startsWith("darwin")
  ) {
    return "mac-os";
  }
  if (normalized.startsWith("ios")) return "ios";
  if (normalized.startsWith("android")) return "android-os";
  if (normalized.startsWith("chrome os") || normalized.startsWith("chromium os")) {
    return "chrome-os";
  }
  if (
    normalized.includes("linux")
    || normalized.startsWith("ubuntu")
    || normalized.startsWith("debian")
    || normalized.startsWith("fedora")
  ) {
    return "linux";
  }
  return UNKNOWN_ICON_KEY;
}

function sanitizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
    .replace(/\/+.*$/, "");
}

function resolveFaviconUrlForLabel(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || raw.startsWith("/")) return null;
  try {
    if (ABSOLUTE_URL_PATTERN.test(raw)) {
      const parsed = new URL(raw);
      return `${parsed.origin}/favicon.ico`;
    }
    if (raw.startsWith("//")) {
      const parsed = new URL(`https:${raw}`);
      return `${parsed.origin}/favicon.ico`;
    }
    const hostname = sanitizeHostname(raw);
    if (!hostname) return null;
    const parsed = new URL(`https://${hostname}`);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function leadingLabelLetter(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}

function handleImageFallback(
  event: SyntheticEvent<HTMLImageElement>,
  fallbackSrc: string,
): void {
  const target = event.currentTarget;
  if (target.dataset.fallbackApplied === "true") return;
  target.dataset.fallbackApplied = "true";
  target.src = fallbackSrc;
}

function LogoIcon({
  src,
  fallbackSrc,
  invertInDark = false,
}: {
  src: string;
  fallbackSrc: string;
  invertInDark?: boolean;
}) {
  return (
    <img
      src={src}
      alt=""
      width={16}
      height={16}
      className={`block h-4 w-4 shrink-0 ${invertInDark ? "dark:invert" : ""}`}
      loading="lazy"
      decoding="async"
      onError={(event) => {
        handleImageFallback(event, fallbackSrc);
      }}
    />
  );
}

function DomainOrUrlIcon({
  label,
  unknownLabel,
}: {
  label: string;
  unknownLabel: string;
}) {
  const normalized = label.trim();
  const src =
    normalized.length === 0 || normalized === unknownLabel
      ? null
      : resolveFaviconUrlForLabel(normalized);
  const [iconLoaded, setIconLoaded] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setIconLoaded(false);
    setIconFailed(false);

    if (!src) return;

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      setIconLoaded(true);
    };
    image.onerror = () => {
      if (!active) return;
      setIconFailed(true);
    };
    image.src = src;

    return () => {
      active = false;
    };
  }, [src]);

  const showFavicon = Boolean(src) && iconLoaded && !iconFailed;
  const fallbackValue = normalized === unknownLabel ? "" : normalized;

  return showFavicon ? (
    <img
      src={src!}
      alt=""
      width={16}
      height={16}
      className="block size-4 shrink-0 object-contain"
      loading="lazy"
      decoding="async"
    />
  ) : (
    <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] bg-card text-[10px] font-medium leading-none text-muted-foreground">
      {leadingLabelLetter(fallbackValue)}
    </span>
  );
}

function MetaItem({
  icon,
  label,
  hideLabelOnMobile = false,
}: {
  icon: ReactNode;
  label: string;
  hideLabelOnMobile?: boolean;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 text-[11px] text-muted-foreground"
      aria-label={hideLabelOnMobile ? label : undefined}
      title={hideLabelOnMobile ? label : undefined}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className={cn(hideLabelOnMobile ? "hidden sm:inline sm:truncate" : "truncate")}>
        {label}
      </span>
    </span>
  );
}

function maybeReachScrollEnd(
  instance: ReturnType<typeof OverlayScrollbars> | null,
  onReachEnd?: (() => void) | null,
): void {
  if (!instance || !onReachEnd) return;
  const scrollElement = instance.elements().scrollOffsetElement;
  const remaining =
    scrollElement.scrollHeight
    - scrollElement.clientHeight
    - scrollElement.scrollTop;
  if (remaining <= LOAD_MORE_THRESHOLD_PX) {
    onReachEnd();
  }
}

function LogStreamScrollbar({
  children,
  className,
  syncKey,
  onReachEnd,
}: {
  children: ReactNode;
  className?: string;
  syncKey?: string | number | boolean | null;
  onReachEnd?: (() => void) | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(null);
  const onReachEndRef = useRef<(() => void) | null>(onReachEnd ?? null);

  useEffect(() => {
    onReachEndRef.current = onReachEnd ?? null;
  }, [onReachEnd]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, PANEL_SCROLLBAR_OPTIONS);
    if (existing) {
      existing.options(PANEL_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;
    instance.update(true);

    const removeScrollListener = instance.on("scroll", () => {
      maybeReachScrollEnd(instance, onReachEndRef.current);
    });
    requestAnimationFrame(() => {
      maybeReachScrollEnd(instance, onReachEndRef.current);
    });

    return () => {
      removeScrollListener();
      if (!existing) {
        instance.destroy();
      }
      if (scrollbarRef.current === instance) {
        scrollbarRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const instance = scrollbarRef.current;
    if (!instance) return;
    instance.update(true);
    requestAnimationFrame(() => {
      maybeReachScrollEnd(instance, onReachEndRef.current);
    });
  }, [syncKey]);

  return (
    <div
      ref={hostRef}
      className={cn("overflow-hidden", className)}
      data-overlayscrollbars-initialize
    >
      {children}
    </div>
  );
}

function formatRelativeTime(locale: Locale, timestamp: number, now: number): string {
  const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  });
  const diffSeconds = Math.round((timestamp - now) / 1000);
  const absoluteSeconds = Math.abs(diffSeconds);

  if (absoluteSeconds < 60) {
    return formatter.format(diffSeconds, "second");
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

interface RealtimeLogStreamItemProps {
  event: RealtimeEvent;
  locale: Locale;
  messages: AppMessages;
  now: number;
}

function areRealtimeLogStreamItemPropsEqual(
  previousProps: RealtimeLogStreamItemProps,
  nextProps: RealtimeLogStreamItemProps,
) {
  return previousProps.locale === nextProps.locale
    && previousProps.messages === nextProps.messages
    && previousProps.now === nextProps.now
    && previousProps.event.id === nextProps.event.id
    && previousProps.event.eventType === nextProps.event.eventType
    && previousProps.event.eventAt === nextProps.event.eventAt
    && previousProps.event.pathname === nextProps.event.pathname
    && previousProps.event.visitorId === nextProps.event.visitorId
    && previousProps.event.sessionId === nextProps.event.sessionId
    && previousProps.event.browser === nextProps.event.browser
    && previousProps.event.osVersion === nextProps.event.osVersion
    && previousProps.event.country === nextProps.event.country
    && previousProps.event.referrerHost === nextProps.event.referrerHost;
}

const RealtimeLogStreamItemCard = memo(
  function RealtimeLogStreamItemCard({
    event,
    locale,
    messages,
    now,
  }: RealtimeLogStreamItemProps) {
    const kind = classifyRealtimeLogEvent(event.eventType.trim());
    const avatarSeed =
      event.visitorId.trim() || event.sessionId.trim() || event.id;
    const browserLabel = event.browser.trim() || messages.common.unknown;
    const browserIconKey = resolveBrowserIconKey(event.browser);
    const osLabel = event.osVersion.trim() || messages.common.unknown;
    const osIconKey = resolveOsIconKey(event.osVersion);
    const { label: countryLabel, code: countryCode } = resolveCountryLabel(
      event.country,
      locale,
      messages.common.unknown,
    );
    const countryFlagCode = resolveCountryFlagCode(countryCode, locale);
    const sourceLabel = event.referrerHost.trim() || messages.overview.direct;

    return (
      <Card size="sm">
        <CardContent className="px-3">
          <div className="flex items-start gap-3">
            <div className="shrink-0 self-center">
              <Avatar
                size={34}
                name={avatarSeed}
                variant="ring"
                colors={VISITOR_AVATAR_COLORS}
                aria-hidden="true"
              />
            </div>
            <div className="flex min-w-0 flex-1 items-stretch justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <p className="min-w-0 truncate text-sm font-medium text-foreground">
                  {formatLogTitle(locale, messages, event, kind)}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <MetaItem
                    icon={(
                      <LogoIcon
                        src={`${BROWSER_ICON_DIR}/${browserIconKey}.svg`}
                        fallbackSrc={`${BROWSER_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
                        invertInDark={BROWSER_APPLE_ICON_KEYS.has(browserIconKey)}
                      />
                    )}
                    label={browserLabel}
                    hideLabelOnMobile
                  />
                  <MetaItem
                    icon={(
                      <LogoIcon
                        src={`${OS_ICON_DIR}/${osIconKey}.svg`}
                        fallbackSrc={`${OS_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
                        invertInDark={OS_APPLE_ICON_KEYS.has(osIconKey)}
                      />
                    )}
                    label={osLabel}
                    hideLabelOnMobile
                  />
                  <MetaItem
                    icon={countryFlagCode ? (
                      <Icon
                        icon={`flagpack:${countryFlagCode.toLowerCase()}`}
                        style={{ width: 16, height: 12 }}
                        className="block shrink-0"
                      />
                    ) : (
                        <RiGlobalLine className="size-3.5 text-muted-foreground" />
                      )}
                    label={countryLabel}
                    hideLabelOnMobile
                  />
                  <MetaItem
                    icon={(
                      <DomainOrUrlIcon
                        label={sourceLabel}
                        unknownLabel={messages.overview.direct}
                      />
                    )}
                    label={sourceLabel}
                  />
                </div>
              </div>
              <div className="shrink-0 self-stretch">
                <div className="flex h-full min-w-[7.5rem] flex-col items-end justify-between text-right">
                  <p className="font-mono text-[11px] text-foreground">
                    {formatRelativeTime(locale, event.eventAt, now)}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {shortDateTime(locale, event.eventAt)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  },
  areRealtimeLogStreamItemPropsEqual,
);

function RealtimeLogStreamItem({
  event,
  locale,
  messages,
  now,
}: RealtimeLogStreamItemProps) {
  return (
    <div role="listitem">
      <RealtimeLogStreamItemCard
        event={event}
        locale={locale}
        messages={messages}
        now={now}
      />
    </div>
  );
}

function haveSameEventOrder(left: RealtimeEvent[], right: RealtimeEvent[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((event, index) => event.id === right[index]?.id);
}

export function RealtimeLogStreamCard({
  locale,
  messages,
  hasConnected,
  events,
}: RealtimeLogStreamCardProps) {
  const [now, setNow] = useState(() => Date.now());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_EVENTS);
  const [displayedEvents, setDisplayedEvents] = useState<RealtimeEvent[]>([]);
  const [queuedEvents, setQueuedEvents] = useState<RealtimeEvent[]>([]);
  const [incomingEvent, setIncomingEvent] = useState<RealtimeEvent | null>(null);
  const [incomingPhase, setIncomingPhase] = useState<IncomingInsertionPhase>("idle");
  const [incomingSlotHeight, setIncomingSlotHeight] = useState(0);
  const reduceMotion = useReducedMotion();
  const incomingMeasureRef = useRef<HTMLDivElement | null>(null);
  const incomingEventRef = useRef<RealtimeEvent | null>(null);
  const desiredVisibleEventsRef = useRef<RealtimeEvent[]>([]);

  const visibleEvents = events.slice(0, visibleCount);
  const hasMoreEvents = visibleCount < events.length;
  const isInitialLoading = !hasConnected && visibleEvents.length === 0;

  useEffect(() => {
    desiredVisibleEventsRef.current = visibleEvents;
  }, [visibleEvents]);

  useEffect(() => {
    incomingEventRef.current = incomingEvent;
  }, [incomingEvent]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, RELATIVE_TIME_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    setVisibleCount((previous) => {
      if (events.length <= 0) return INITIAL_VISIBLE_EVENTS;
      return Math.min(events.length, Math.max(previous, INITIAL_VISIBLE_EVENTS));
    });
  }, [events.length]);

  useEffect(() => {
    if (visibleEvents.length === 0) {
      if (displayedEvents.length > 0) setDisplayedEvents([]);
      if (queuedEvents.length > 0) setQueuedEvents([]);
      if (incomingEvent) setIncomingEvent(null);
      if (incomingPhase !== "idle") setIncomingPhase("idle");
      if (incomingSlotHeight !== 0) setIncomingSlotHeight(0);
      return;
    }

    const displayedIds = new Set(displayedEvents.map((event) => event.id));
    const queuedIds = new Set(queuedEvents.map((event) => event.id));
    const knownIds = new Set(displayedIds);
    for (const queuedId of queuedIds) knownIds.add(queuedId);
    if (incomingEvent) knownIds.add(incomingEvent.id);

    if (displayedEvents.length === 0 && knownIds.size === 0) {
      if (!haveSameEventOrder(displayedEvents, visibleEvents)) {
        setDisplayedEvents(visibleEvents);
      }
      return;
    }

    const firstKnownIndex = visibleEvents.findIndex((event) => knownIds.has(event.id));
    if (firstKnownIndex === -1) {
      if (!haveSameEventOrder(displayedEvents, visibleEvents)) {
        setDisplayedEvents(visibleEvents);
      }
      if (queuedEvents.length > 0) setQueuedEvents([]);
      if (incomingEvent) setIncomingEvent(null);
      if (incomingPhase !== "idle") setIncomingPhase("idle");
      if (incomingSlotHeight !== 0) setIncomingSlotHeight(0);
      return;
    }

    const nextTopIncoming = visibleEvents
      .slice(0, firstKnownIndex)
      .filter((event) => !knownIds.has(event.id));
    if (nextTopIncoming.length > 0) {
      setQueuedEvents((previous) => {
        const previousIds = new Set(previous.map((event) => event.id));
        const additions = [...nextTopIncoming]
          .reverse()
          .filter((event) => !previousIds.has(event.id) && incomingEvent?.id !== event.id);
        if (additions.length === 0) return previous;
        return [...previous, ...additions];
      });
    }

    const retainedDisplayed = visibleEvents
      .slice(firstKnownIndex)
      .filter((event) => displayedIds.has(event.id));
    const tailMissing = visibleEvents
      .slice(firstKnownIndex)
      .filter((event) => !knownIds.has(event.id));
    const nextDisplayedEvents = [...retainedDisplayed, ...tailMissing];
    if (!haveSameEventOrder(displayedEvents, nextDisplayedEvents)) {
      setDisplayedEvents(nextDisplayedEvents);
    }
  }, [
    displayedEvents,
    incomingEvent,
    incomingPhase,
    incomingSlotHeight,
    queuedEvents,
    visibleEvents,
  ]);

  useEffect(() => {
    if (incomingEvent || queuedEvents.length === 0) return;
    const [nextIncomingEvent, ...remainingQueuedEvents] = queuedEvents;
    setQueuedEvents(remainingQueuedEvents);
    setIncomingEvent(nextIncomingEvent);
    setIncomingPhase("measuring");
    setIncomingSlotHeight(0);
  }, [incomingEvent, queuedEvents]);

  useEffect(() => {
    if (!incomingEvent) return;
    const measureNode = incomingMeasureRef.current;
    if (!measureNode) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(measureNode.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setIncomingSlotHeight((previous) =>
        previous === nextHeight ? previous : nextHeight,
      );
    };

    updateHeight();
    const resizeObserver = new ResizeObserver(() => {
      updateHeight();
    });
    resizeObserver.observe(measureNode);

    return () => {
      resizeObserver.disconnect();
    };
  }, [incomingEvent, locale, messages]);

  useEffect(() => {
    if (incomingPhase !== "measuring" || incomingSlotHeight <= 0) return;
    const frameId = window.requestAnimationFrame(() => {
      setIncomingPhase("shifting");
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [incomingPhase, incomingSlotHeight]);

  useEffect(() => {
    if (incomingPhase !== "shifting") return;
    const timeoutId = window.setTimeout(() => {
      setIncomingPhase("revealing");
    }, reduceMotion ? 0 : LOG_STREAM_SLOT_TRANSITION.duration * 1000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [incomingPhase, reduceMotion]);

  useEffect(() => {
    if (incomingPhase !== "revealing") return;
    const timeoutId = window.setTimeout(() => {
      const nextIncomingEvent = incomingEventRef.current;
      if (!nextIncomingEvent) return;

      const desiredVisibleEvents = desiredVisibleEventsRef.current;
      const desiredVisibleIds = new Set(
        desiredVisibleEvents.map((event) => event.id),
      );

      setDisplayedEvents((previous) => {
        const mergedIds = new Set<string>();
        for (const event of [nextIncomingEvent, ...previous]) {
          if (!desiredVisibleIds.has(event.id) || mergedIds.has(event.id)) continue;
          mergedIds.add(event.id);
        }
        return desiredVisibleEvents.filter((event) => mergedIds.has(event.id));
      });
      setIncomingEvent(null);
      setIncomingPhase("idle");
      setIncomingSlotHeight(0);
    }, reduceMotion ? 0 : LOG_STREAM_ITEM_TRANSITION.duration * 1000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [incomingPhase, reduceMotion]);

  const loadMoreEvents = () => {
    if (!hasMoreEvents) return;
    setVisibleCount((previous) =>
      Math.min(events.length, previous + LOAD_MORE_STEP),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{messages.realtime.recentEvents}</CardTitle>
      </CardHeader>
      <CardContent>
        {isInitialLoading ? (
          <div className="flex min-h-56 items-center justify-center text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Spinner className="size-3.5" />
              {messages.common.loading}
            </span>
          </div>
        ) : displayedEvents.length === 0 && !incomingEvent ? (
          <div className="flex min-h-56 items-center justify-center text-muted-foreground">
            {messages.common.noData}
          </div>
        ) : (
          <LogStreamScrollbar
            className="max-h-[30rem]"
            syncKey={`${displayedEvents.length}:${events.length}:${incomingEvent?.id ?? "none"}:${incomingPhase}:${incomingSlotHeight}`}
            onReachEnd={hasMoreEvents ? loadMoreEvents : null}
          >
            <div className="relative p-1">
              {incomingEvent ? (
                <>
                  <div
                    ref={incomingMeasureRef}
                    className="pointer-events-none invisible absolute inset-x-1 top-1"
                    aria-hidden="true"
                  >
                    <div style={{ paddingBottom: LOG_STREAM_ITEM_GAP_PX }}>
                      <RealtimeLogStreamItemCard
                        event={incomingEvent}
                        locale={locale}
                        messages={messages}
                        now={now}
                      />
                    </div>
                  </div>
                  <motion.div
                    className="pointer-events-none absolute inset-x-1 top-1 z-10"
                    initial={false}
                    animate={
                      incomingPhase === "revealing"
                        ? { opacity: 1, y: 0 }
                        : { opacity: 0, y: reduceMotion ? 0 : 8 }
                    }
                    transition={reduceMotion ? { duration: 0 } : LOG_STREAM_ITEM_TRANSITION}
                  >
                    <div style={{ paddingBottom: LOG_STREAM_ITEM_GAP_PX }}>
                      <RealtimeLogStreamItemCard
                        event={incomingEvent}
                        locale={locale}
                        messages={messages}
                        now={now}
                      />
                    </div>
                  </motion.div>
                  <motion.div
                    aria-hidden="true"
                    className="overflow-hidden"
                    initial={false}
                    animate={{
                      height:
                        incomingPhase === "shifting" || incomingPhase === "revealing"
                          ? incomingSlotHeight
                          : 0,
                    }}
                    transition={reduceMotion ? { duration: 0 } : LOG_STREAM_SLOT_TRANSITION}
                  />
                </>
              ) : null}
              <div className="space-y-2" role="list">
                {displayedEvents.map((event) => (
                  <RealtimeLogStreamItem
                    key={event.id}
                    event={event}
                    locale={locale}
                    messages={messages}
                    now={now}
                  />
                ))}
              </div>
            </div>
          </LogStreamScrollbar>
        )}
      </CardContent>
    </Card>
  );
}
