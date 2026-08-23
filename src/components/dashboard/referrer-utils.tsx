import { useEffect, useMemo, useState } from "react";

import {
  TRAFFIC_CHANNEL_IDS,
  type TrafficChannelId,
} from "@/lib/analytics/traffic-channel-rules";
import type { OverviewTabRows } from "@/lib/dashboard/client-data";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";

export type ReferrerTab = "domain" | "link" | "channel";

export interface ReferrerBreakdownRow {
  key: string;
  label: string;
  displayLabel?: string;
  filterValue: string;
  targetUrl: string | null;
  views: number;
  visitors: number;
  mono: boolean;
  isDirect: boolean;
  channelId?: TrafficChannelId;
}

export interface ReferrerRowsByTab {
  domain: ReferrerBreakdownRow[];
  link: ReferrerBreakdownRow[];
  channel: ReferrerBreakdownRow[];
}

export const DIRECT_REFERRER_FILTER_VALUE = "__direct__";

export const REFERRER_FILTER_CONTROL_BY_TAB: Record<
  ReferrerTab,
  "sourceDomain" | "sourceLink" | "channel"
> = {
  domain: "sourceDomain",
  link: "sourceLink",
  channel: "channel",
};

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;

export function sanitizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
    .replace(/\/+.*$/, "");
}

export function toAbsoluteHttpsUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  try {
    if (ABSOLUTE_URL_PATTERN.test(raw)) {
      return new URL(raw).toString();
    }
    if (raw.startsWith("//")) {
      return new URL(`https:${raw}`).toString();
    }
    return new URL(`https://${raw}`).toString();
  } catch {
    return null;
  }
}

function resolveFaviconUrlForLabel(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.startsWith("/")) return null;

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

function DomainOrUrlIcon({
  label,
  fallbackLabel,
  unknownLabel,
}: {
  label: string;
  fallbackLabel?: string;
  unknownLabel: string;
}) {
  const src = useMemo(() => {
    const normalized = label.trim();
    if (!normalized || normalized === unknownLabel) return null;
    return resolveFaviconUrlForLabel(normalized);
  }, [label, unknownLabel]);
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
  const fallbackDisplayLabel = fallbackLabel ?? label;
  const fallbackValue =
    fallbackDisplayLabel === unknownLabel ? "" : fallbackDisplayLabel;

  if (showFavicon) {
    return (
      <img
        src={src!}
        alt=""
        width={16}
        height={16}
        className="block size-4 shrink-0 object-contain"
      />
    );
  }

  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] bg-card text-[10px] leading-none font-medium text-muted-foreground">
      {leadingLabelLetter(fallbackValue)}
    </span>
  );
}

export function LabelWithOptionalIcon({
  label,
  iconLabel,
  showIcon,
  unknownLabel,
}: {
  label: string;
  iconLabel?: string;
  showIcon: boolean;
  unknownLabel: string;
}) {
  if (!showIcon) {
    return <span className="break-words">{label}</span>;
  }

  return (
    <span className="relative inline-block max-w-full break-words pl-6">
      <span className="pointer-events-none absolute inset-y-0 left-0 inline-flex w-4 items-center">
        <DomainOrUrlIcon
          label={iconLabel ?? label}
          fallbackLabel={label}
          unknownLabel={unknownLabel}
        />
      </span>
      <span className="break-words">{label}</span>
    </span>
  );
}

export function buildReferrerRowsByTab(
  rowsByTab: {
    domain: OverviewTabRows;
    link: OverviewTabRows;
    channel: OverviewTabRows;
  },
  directLabel: string,
  channelLabels: Record<TrafficChannelId, string>,
): ReferrerRowsByTab {
  return {
    domain: rowsByTab.domain.map((item, index) => {
      const raw = String(item.label ?? "").trim();
      const domain = raw ? sanitizeHostname(raw) : "";
      const filterValue = domain || DIRECT_REFERRER_FILTER_VALUE;
      return {
        key: `domain-${filterValue}-${index}`,
        label: domain || directLabel,
        displayLabel: domain || directLabel,
        filterValue,
        targetUrl: domain ? toAbsoluteHttpsUrl(domain) : null,
        views: Math.max(0, Number(item.views ?? 0)),
        visitors: Math.max(0, Number(item.visitors ?? 0)),
        mono: true,
        isDirect: filterValue === DIRECT_REFERRER_FILTER_VALUE,
      };
    }),
    link: rowsByTab.link.map((item, index) => {
      const raw = String(item.label ?? "").trim();
      const targetUrl = raw ? toAbsoluteHttpsUrl(raw) : null;
      const filterValue = raw || DIRECT_REFERRER_FILTER_VALUE;
      const label = raw ? (targetUrl ?? raw) : directLabel;
      return {
        key: `link-${filterValue}-${index}`,
        label,
        displayLabel: decodeUrlDisplayValue(label),
        filterValue,
        targetUrl,
        views: Math.max(0, Number(item.views ?? 0)),
        visitors: Math.max(0, Number(item.visitors ?? 0)),
        mono: true,
        isDirect: filterValue === DIRECT_REFERRER_FILTER_VALUE,
      };
    }),
    channel: rowsByTab.channel.map((item, index) => {
      const raw = String(item.label ?? "").trim();
      const channelId = TRAFFIC_CHANNEL_IDS.includes(raw as TrafficChannelId)
        ? (raw as TrafficChannelId)
        : "other";
      return {
        key: `channel-${channelId}-${index}`,
        label: channelLabels[channelId],
        displayLabel: channelLabels[channelId],
        filterValue: channelId,
        targetUrl: null,
        views: Math.max(0, Number(item.views ?? 0)),
        visitors: Math.max(0, Number(item.visitors ?? 0)),
        mono: false,
        isDirect: channelId === "direct",
        channelId,
      };
    }),
  };
}
