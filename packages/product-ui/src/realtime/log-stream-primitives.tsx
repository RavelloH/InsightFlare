import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@insightflare/ui/tooltip";
import { VerticalScrollMask } from "@insightflare/ui/vertical-scroll-mask";
import type { PartialOptions } from "overlayscrollbars";

import { cn } from "../utils/cn";

const LOAD_MORE_THRESHOLD_PX = 160;
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;

export const BROWSER_ICON_DIR = "/images/browser";
export const OS_ICON_DIR = "/images/os";
export const UNKNOWN_ICON_KEY = "unknown";
export const BROWSER_APPLE_ICON_KEYS = new Set(["ios", "ios-webview"]);
export const OS_APPLE_ICON_KEYS = new Set(["ios", "mac-os"]);
export const VISITOR_AVATAR_COLORS = [
  "#0f172a",
  "#1d4ed8",
  "#0f766e",
  "#f59e0b",
  "#e11d48",
];

const PANEL_SCROLLBAR_OPTIONS = {
  update: {
    // Realtime list/detail content updates already call instance.update via syncKey.
    // Avoid scanning every mutation for image load listeners on each refresh.
    elementEvents: null,
  },
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

export function LogoIcon({
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

export function DomainOrUrlIcon({
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

export function MetaItem({
  icon,
  label,
  hideLabelOnMobile = false,
}: {
  icon: ReactNode;
  label: string;
  hideLabelOnMobile?: boolean;
}) {
  const metaItem = (
    <span
      className="inline-flex max-w-full items-center gap-1.5 text-[11px] text-muted-foreground"
      aria-label={hideLabelOnMobile ? label : undefined}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span
        className={cn(
          hideLabelOnMobile ? "hidden sm:inline sm:truncate" : "truncate",
        )}
      >
        {label}
      </span>
    </span>
  );

  return hideLabelOnMobile ? (
    <Tooltip>
      <TooltipTrigger asChild>{metaItem}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  ) : (
    metaItem
  );
}

function maybeReachScrollElementEnd(
  scrollElement: HTMLElement | null,
  onReachEnd?: (() => void) | null,
): void {
  if (!scrollElement || !onReachEnd) return;
  const remaining =
    scrollElement.scrollHeight -
    scrollElement.clientHeight -
    scrollElement.scrollTop;
  if (remaining <= LOAD_MORE_THRESHOLD_PX) {
    onReachEnd();
  }
}

export function LogStreamScrollbar({
  children,
  className,
  maskClassName,
  syncKey,
  onReachEnd,
}: {
  children: ReactNode;
  className?: string;
  maskClassName?: string;
  syncKey?: string | number | boolean | null;
  onReachEnd?: (() => void) | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onReachEndRef = useRef<(() => void) | null>(onReachEnd ?? null);
  useEffect(() => {
    onReachEndRef.current = onReachEnd ?? null;
  }, [onReachEnd]);

  useEffect(() => {
    const viewport = hostRef.current;
    if (!viewport) return;
    const checkEnd = () =>
      maybeReachScrollElementEnd(viewport, onReachEndRef.current);
    viewport.addEventListener("scroll", checkEnd, { passive: true });
    const animationFrame = requestAnimationFrame(checkEnd);

    return () => {
      viewport.removeEventListener("scroll", checkEnd);
      cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    const animationFrame = requestAnimationFrame(() =>
      maybeReachScrollElementEnd(hostRef.current, onReachEndRef.current),
    );
    return () => cancelAnimationFrame(animationFrame);
  }, [syncKey]);

  return (
    <VerticalScrollMask
      hostRef={hostRef}
      className={className}
      maskClassName={maskClassName}
      scrollbarOptions={PANEL_SCROLLBAR_OPTIONS}
      syncKey={syncKey}
    >
      {children}
    </VerticalScrollMask>
  );
}
