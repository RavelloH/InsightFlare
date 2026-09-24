import { useEffect, useMemo, useState } from "react";

import { AutoTransition } from "@/components/ui/auto-transition";
import { cn } from "@/lib/utils";

interface SiteBrandIconProps {
  siteId?: string;
  siteName: string;
  domain: string;
  iconSrc?: string | null;
  size?: "sm" | "md";
  className?: string;
}

function resolveFaviconUrl(domain: string): string | null {
  const trimmed = domain.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function leadingLetter(name: string): string {
  const normalized = name.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}

export function SiteBrandIcon({
  siteId,
  siteName,
  domain,
  iconSrc,
  size = "sm",
  className,
}: SiteBrandIconProps) {
  const explicitSrc = String(iconSrc || "").trim();
  const remoteSrc = useMemo(() => resolveFaviconUrl(domain), [domain]);
  const src = explicitSrc || remoteSrc;
  const isExplicitIcon = explicitSrc.length > 0;
  const [iconLoaded, setIconLoaded] = useState(isExplicitIcon);
  const [iconFailed, setIconFailed] = useState(false);
  const sizeClassName = size === "md" ? "size-5" : "size-4";

  useEffect(() => {
    setIconFailed(false);

    if (!src) {
      setIconLoaded(false);
      return;
    }

    if (isExplicitIcon) {
      setIconLoaded(true);
      return;
    }

    setIconLoaded(false);

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
  }, [src, isExplicitIcon]);

  const showIcon = Boolean(src) && iconLoaded && !iconFailed;

  return (
    <AutoTransition
      type="fade"
      duration={0.18}
      initial={false}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        sizeClassName,
        className,
      )}
    >
      {showIcon ? (
        <img
          key={`icon-${siteId || src}`}
          src={src!}
          alt=""
          className={cn("shrink-0", sizeClassName)}
          onError={() => setIconFailed(true)}
        />
      ) : (
        <span
          key="fallback"
          className={cn(
            "inline-flex shrink-0 items-center justify-center bg-muted text-[10px] font-medium text-muted-foreground",
            sizeClassName,
          )}
        >
          {leadingLetter(siteName)}
        </span>
      )}
    </AutoTransition>
  );
}
