import {
  RiBarChartLine,
  RiGlobeLine,
  RiLineChartLine,
  RiNumbersLine,
  RiPieChartLine,
  RiPulseLine,
} from "@remixicon/react";

import { getSessionToken } from "@/lib/auth";
import { readReportingTimeZoneFromCookie } from "@/lib/dashboard/query-preferences";
import { type Locale } from "@/lib/i18n/config";
import type { WidgetConfig, WidgetRecord } from "@/lib/widgets/contract";
import {
  normalizeWidgetOrigin,
  suggestedWidgetHeight,
} from "@/lib/widgets/contract";

import type { widgetLabels } from "./labels";

export interface WidgetSite {
  id: string;
  name: string;
  domain: string;
}

export type WidgetType = WidgetConfig["type"];

export const widgetTypeIcons = {
  metric: RiNumbersLine,
  trend: RiLineChartLine,
  ranking: RiBarChartLine,
  distribution: RiPieChartLine,
  conversion: RiPulseLine,
  geo: RiGlobeLine,
  realtime: RiPulseLine,
} satisfies Record<WidgetType, typeof RiNumbersLine>;
export type PreviewSize = "compact" | "regular" | "wide";
export type ConfirmAction = "publish" | "unpublish" | "delete" | null;

export interface ApiResult<T> {
  data: T;
  nextCursor?: string | null;
}

export const textareaClassName =
  "flex min-h-24 w-full rounded-none border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

export function defaultTimeZone(): string {
  try {
    return readReportingTimeZoneFromCookie(
      typeof document === "undefined" ? null : document.cookie,
    );
  } catch {
    return "UTC";
  }
}

export function defaultAllowedOrigin(domain: string): string[] {
  const host = domain.trim();
  if (!host) return [];
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(host)
    ? host
    : `https://${host}`;
  const origin = normalizeWidgetOrigin(candidate);
  return origin ? [origin] : [];
}

export function defaultConfig(locale: Locale, domain: string): WidgetConfig {
  return {
    title: "",
    type: "metric",
    metric: "visitors",
    range: "30d",
    timeZone: defaultTimeZone(),
    locale,
    theme: "auto",
    embedMode: "restricted",
    allowedOrigins: defaultAllowedOrigin(domain),
    comparison: true,
    dimension: "page.path",
    limit: 5,
    rankingStyle: "list",
    pageLinksEnabled: false,
    distributionStyle: "bars",
    trendStyle: "line",
    distributionDimension: "client.deviceType",
    trendMetrics: [],
    conversionKind: "event",
    eventName: "",
    goalId: "",
    geoProjection: "flat",
    realtimeLayout: "badge",
  };
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function widgetRequest<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const token = await getSessionToken();
  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (method !== "GET" && method !== "DELETE") {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    method,
    headers,
    body:
      method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : `Widget request failed (${response.status})`;
    throw new Error(error);
  }
  return payload as T;
}

export function htmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

interface WidgetEmbedInput {
  origin: string;
  path: string;
  config: WidgetConfig;
  title: string;
}

/**
 * The two parts of an embed: the iframe that renders the widget (required,
 * works on its own at the suggested height) and the optional host-page
 * loader that resizes marked iframes to their content.
 */
export function widgetEmbedParts(input: WidgetEmbedInput): {
  iframe: string;
  script: string;
} {
  const src = `${input.origin}${input.path}`;
  // Static asset (public/widgets/embed.js) at a stable, unversioned URL.
  const loader = `${input.origin}/widgets/embed.js`;
  return {
    iframe: `<iframe src="${htmlAttribute(src)}" title="${htmlAttribute(input.title)}" width="100%" height="${suggestedWidgetHeight(input.config)}" loading="lazy" style="border:0" data-insightflare-widget></iframe>`,
    script: `<script src="${htmlAttribute(loader)}" async></script>`,
  };
}

export function widgetEmbedSnippet(input: WidgetEmbedInput): string {
  const parts = widgetEmbedParts(input);
  return `${parts.iframe}\n${parts.script}`;
}

export function displayType(
  type: WidgetType,
  copy: ReturnType<typeof widgetLabels>,
) {
  if (type === "trend") return copy.trendType;
  if (type === "ranking") return copy.rankingType;
  if (type === "distribution") return copy.distributionType;
  if (type === "conversion") return copy.conversionType;
  if (type === "geo") return copy.geoType;
  if (type === "realtime") return copy.realtimeType;
  return copy.metricType;
}

export function statusLabel(
  status: WidgetRecord["status"],
  copy: ReturnType<typeof widgetLabels>,
) {
  if (status === "published") return copy.statusPublished;
  if (status === "unpublished") return copy.statusUnpublished;
  return copy.statusDraft;
}

export function metricLabel(
  metric: WidgetConfig["metric"],
  copy: ReturnType<typeof widgetLabels>,
) {
  if (metric === "views") return copy.views;
  if (metric === "sessions") return copy.sessions;
  if (metric === "bounces") return copy.bounces;
  if (metric === "bounceRate") return copy.bounceRate;
  if (metric === "avgDurationMs") return copy.avgDurationMs;
  if (metric === "viewsPerSession") return copy.viewsPerSession;
  if (metric === "events") return copy.events;
  return copy.visitors;
}

export function widgetParameters(
  config: WidgetConfig,
  copy: ReturnType<typeof widgetLabels>,
): string {
  if (config.type === "realtime") {
    return [
      copy.realtimeType,
      config.realtimeLayout === "badge"
        ? copy.realtimeBadge
        : config.realtimeLayout === "trend"
          ? copy.realtimeTrend
          : config.realtimeLayout === "map"
            ? config.geoProjection === "globe"
              ? copy.geoGlobe
              : copy.geoFlat
            : copy.realtimePages,
      "30s",
    ].join(" · ");
  }
  const parameters = [
    displayType(config.type, copy),
    metricLabel(config.metric, copy),
    config.range === "7d" ? copy.sevenDays : copy.thirtyDays,
  ];
  if (config.type === "ranking") {
    parameters.push(
      config.dimension === "page.path"
        ? copy.pagePath
        : config.dimension === "source.domain"
          ? copy.sourceDomain
          : copy.country,
      copy.limit + ": " + config.limit,
    );
  }
  if (config.type === "ranking" && config.rankingStyle === "bars")
    parameters.push(copy.rankingBars);
  if (config.type === "distribution") {
    parameters.push(
      config.distributionStyle === "donut"
        ? copy.distributionDonut
        : config.distributionStyle === "ratio"
          ? copy.distributionRatio
          : copy.distributionBars,
    );
    parameters.push(
      config.distributionDimension === "client.deviceType"
        ? copy.deviceType
        : config.distributionDimension === "client.browser"
          ? copy.browser
          : config.distributionDimension === "utm.source"
            ? copy.utmSource
            : copy.sourceDomain,
    );
  }
  if (config.type === "geo")
    parameters.push(
      config.geoProjection === "globe" ? copy.geoGlobe : copy.geoFlat,
    );
  if (config.type === "trend")
    parameters.push(
      config.trendStyle === "area" ? copy.trendArea : copy.trendLine,
    );
  if (config.type === "trend" && config.trendMetrics.length > 0) {
    parameters.push(
      config.trendMetrics
        .map((metric) => metricLabel(metric, copy))
        .join(" / "),
    );
  }
  if (config.type === "conversion") {
    parameters.push(
      config.conversionKind === "event"
        ? `${copy.eventConversion}: ${config.eventName}`
        : copy.goalConversion,
    );
  }
  if (config.type === "metric" && config.comparison)
    parameters.push(copy.comparison);
  return parameters.join(" · ");
}
