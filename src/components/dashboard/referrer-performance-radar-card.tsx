import { useEffect, useMemo, useState } from "react";
import { RiShareForwardLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
} from "recharts";

import { ContentSwitch } from "@/components/dashboard/content-switch";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import { fetchReferrerRadar } from "@/lib/dashboard/client-data";
import {
  durationFormat,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import type { ReferrerRadarItem } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
] as const;

type RadarMetricKey =
  | "duration"
  | "engagement"
  | "depth"
  | "loyalty"
  | "frequency"
  | "traffic";

const METRIC_KEYS: RadarMetricKey[] = [
  "duration",
  "engagement",
  "depth",
  "loyalty",
  "frequency",
  "traffic",
];

interface ReferrerMetadata {
  finalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  h1?: string;
  description?: string;
  firstParagraph?: string;
  icon?: string;
  siteName?: string;
  author?: string;
  language?: string;
  keywords?: string;
  publishedTime?: string;
  modifiedTime?: string;
}

const referrerMetadataCache = new Map<string, ReferrerMetadata | null>();
const referrerMetadataPromiseCache = new Map<
  string,
  Promise<ReferrerMetadata | null>
>();

function formatRawMetric(
  locale: Locale,
  metricKey: RadarMetricKey,
  value: number,
): string {
  switch (metricKey) {
    case "duration":
      return durationFormat(locale, value);
    case "engagement":
    case "loyalty":
    case "traffic":
      return percentFormat(locale, value);
    case "depth":
    case "frequency":
      return numberFormat(locale, Number(value.toFixed(1)));
  }
}

function normalizeReferrerLabel(value: string, directLabel: string): string {
  const raw = value.trim();
  if (!raw) return directLabel;
  return raw.replace(/^[a-z][a-z\d+\-.]*:\/\//i, "").replace(/\/+.*$/, "");
}

function buildReferrerRequestUrl(referrer: string): string | null {
  const normalized = normalizeReferrerLabel(referrer, "").trim();
  if (!normalized) return null;
  try {
    return new URL(`https://${normalized}`).toString();
  } catch {
    return null;
  }
}

function sanitizeMetadata(
  payload: Record<string, unknown>,
): ReferrerMetadata | null {
  const title = String(payload.title ?? "").trim();
  const h1 = String(payload.h1 ?? "").trim();
  const description = String(payload.description ?? "").trim();
  const firstParagraph = String(payload.firstParagraph ?? "").trim();
  const canonicalUrl = String(payload.canonicalUrl ?? "").trim();
  const finalUrl = String(payload.finalUrl ?? "").trim();
  const icon = String(payload.icon ?? "").trim();
  const siteName = String(payload.siteName ?? "").trim();
  const author = String(payload.author ?? "").trim();
  const language = String(payload.language ?? "").trim();
  const keywords = String(payload.keywords ?? "").trim();
  const publishedTime = String(payload.publishedTime ?? "").trim();
  const modifiedTime = String(payload.modifiedTime ?? "").trim();

  if (
    !title &&
    !h1 &&
    !description &&
    !firstParagraph &&
    !canonicalUrl &&
    !finalUrl &&
    !siteName
  ) {
    return null;
  }

  return {
    ...(title ? { title } : {}),
    ...(h1 ? { h1 } : {}),
    ...(description ? { description } : {}),
    ...(firstParagraph ? { firstParagraph } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(finalUrl ? { finalUrl } : {}),
    ...(icon ? { icon } : {}),
    ...(siteName ? { siteName } : {}),
    ...(author ? { author } : {}),
    ...(language ? { language } : {}),
    ...(keywords ? { keywords } : {}),
    ...(publishedTime ? { publishedTime } : {}),
    ...(modifiedTime ? { modifiedTime } : {}),
  };
}

async function fetchReferrerMetadata(
  referrer: string,
): Promise<ReferrerMetadata | null> {
  const normalized = normalizeReferrerLabel(referrer, "").trim();
  if (!normalized) return null;
  if (referrerMetadataCache.has(normalized)) {
    return referrerMetadataCache.get(normalized) ?? null;
  }
  const pending = referrerMetadataPromiseCache.get(normalized);
  if (pending) return pending;

  const targetUrl = buildReferrerRequestUrl(normalized);
  if (!targetUrl) {
    referrerMetadataCache.set(normalized, null);
    return null;
  }

  const promise = fetch(
    `https://meta.ravelloh.com/?url=${encodeURIComponent(targetUrl)}`,
    { cache: "force-cache" },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as Record<string, unknown>;
      const metadata = sanitizeMetadata(payload);
      referrerMetadataCache.set(normalized, metadata);
      return metadata;
    })
    .catch(() => {
      referrerMetadataCache.set(normalized, null);
      return null;
    })
    .finally(() => {
      referrerMetadataPromiseCache.delete(normalized);
    });

  referrerMetadataPromiseCache.set(normalized, promise);
  return promise;
}

function domainMonogram(label: string): string {
  const normalized = label.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}

function formatMetadataDate(
  locale: Locale,
  value: string | undefined,
): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

interface SingleRadarPoint {
  metric: string;
  metricKey: RadarMetricKey;
  value: number;
}

function buildNormalizedPoints(
  item: ReferrerRadarItem,
  maxByMetric: Record<RadarMetricKey, number>,
  metricLabels: Record<RadarMetricKey, string>,
): SingleRadarPoint[] {
  return METRIC_KEYS.map((key) => {
    const max = maxByMetric[key];
    return {
      metric: metricLabels[key],
      metricKey: key,
      value: max > 0 ? Math.round((item.metrics[key] / max) * 100) : 0,
    };
  });
}

function SingleReferrerRadar({
  item,
  label,
  points,
  color,
  locale,
  chartConfig,
}: {
  item: ReferrerRadarItem;
  label: string;
  points: SingleRadarPoint[];
  color: string;
  locale: Locale;
  chartConfig: ChartConfig;
}) {
  return (
    <div className="flex items-center justify-center">
      <ChartContainer
        config={chartConfig}
        className="aspect-square w-full max-w-[220px]"
      >
        <RadarChart data={points} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid />
          <PolarAngleAxis dataKey="metric" tick={{ fontSize: 10 }} />
          <PolarRadiusAxis
            angle={30}
            domain={[0, 100]}
            tick={false}
            axisLine={false}
          />
          <Radar
            name={label}
            dataKey="value"
            stroke={color}
            fill={color}
            fillOpacity={0.15}
          />
          <ChartTooltip
            content={({ active, label: activeLabel, payload }) => {
              if (!active || !payload?.length) return null;
              const point = points.find(
                (entry) => entry.metric === activeLabel,
              );
              if (!point) return null;
              const raw = item.metrics[point.metricKey];

              return (
                <div className="grid min-w-[8rem] gap-0.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                  <div className="font-medium">{activeLabel}</div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatRawMetric(locale, point.metricKey, raw)}
                    </span>
                  </div>
                </div>
              );
            }}
          />
        </RadarChart>
      </ChartContainer>
    </div>
  );
}

function ReferrerMetadataPanel({
  label,
  metadata,
  loading,
  direct,
  locale,
  messages,
}: {
  label: string;
  metadata: ReferrerMetadata | null | undefined;
  loading: boolean;
  direct: boolean;
  locale: Locale;
  messages: AppMessages;
}) {
  const title = direct
    ? messages.overview.direct
    : metadata?.title || metadata?.h1 || decodeUrlDisplayValue(label);
  const description = direct
    ? messages.referrers.directSourceNote
    : metadata?.description || metadata?.firstParagraph || null;
  const author = direct ? null : String(metadata?.author ?? "").trim() || null;
  const language = direct
    ? null
    : String(metadata?.language ?? "").trim() || null;
  const keywords = direct
    ? null
    : String(metadata?.keywords ?? "").trim() || null;
  const publishedLabel = direct
    ? null
    : formatMetadataDate(
        locale,
        metadata?.publishedTime || metadata?.modifiedTime,
      );
  const urlTarget = direct ? null : buildReferrerRequestUrl(label);
  const displayLabel = direct
    ? messages.overview.direct
    : decodeUrlDisplayValue(label);
  const transitionKey = [
    label,
    loading ? "loading" : "ready",
    title,
    description,
    author,
    language,
    keywords,
    publishedLabel,
  ].join("|");

  return (
    <AutoTransition
      className="h-full"
      initial={false}
      duration={0.2}
      type="fade"
      presenceMode="sync"
    >
      <div key={transitionKey} className="flex h-full min-w-0 flex-col">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {metadata?.icon ? (
              <img
                src={metadata.icon}
                alt=""
                width={28}
                height={28}
                className="size-7 shrink-0 rounded-[4px] border border-border/60 object-contain"
              />
            ) : (
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[4px] border border-border/60 bg-muted/20 text-[11px] font-semibold text-muted-foreground">
                {domainMonogram(label)}
              </span>
            )}

            <div className="min-w-0">
              {urlTarget ? (
                <a
                  href={urlTarget}
                  target="_blank"
                  rel="noreferrer"
                  className="block break-all text-sm font-semibold tracking-tight transition-colors hover:text-foreground"
                >
                  {displayLabel}
                </a>
              ) : (
                <p className="break-all text-sm font-semibold tracking-tight">
                  {displayLabel}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium leading-snug">
              {loading ? messages.common.loading : title}
            </p>
            <p className="text-xs/relaxed text-muted-foreground">
              {loading
                ? messages.common.loading
                : description || messages.common.noData}
            </p>
          </div>
        </div>

        <div className="mt-auto pt-4">
          {author || language || keywords || publishedLabel ? (
            <div className="flex flex-wrap gap-2">
              {author ? (
                <span className="rounded-[3px] border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {author}
                </span>
              ) : null}
              {language ? (
                <span className="rounded-[3px] border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  {language}
                </span>
              ) : null}
              {keywords ? (
                <span className="rounded-[3px] border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground break-all">
                  {keywords}
                </span>
              ) : null}
              {publishedLabel ? (
                <span className="rounded-[3px] border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {publishedLabel}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </AutoTransition>
  );
}

interface ReferrerPerformanceRadarCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

export function ReferrerPerformanceRadarCard({
  locale,
  messages,
  siteId,
  window: tw,
  filters,
}: ReferrerPerformanceRadarCardProps) {
  const [metadataByReferrer, setMetadataByReferrer] = useState<
    Record<string, ReferrerMetadata | null | undefined>
  >({});
  const radarQuery = useQuery({
    queryKey: [
      "dashboard",
      "referrer-performance-radar",
      siteId,
      tw.from,
      tw.to,
      tw.timeZone,
      filters,
    ],
    queryFn: async ({ signal }) => {
      try {
        const response = await fetchReferrerRadar(siteId, tw, filters, {
          limit: 24,
          signal,
        });
        return Array.isArray(response.data) ? response.data.slice(0, 24) : [];
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return [] as ReferrerRadarItem[];
      }
    },
    enabled: typeof window !== "undefined",
  });
  const data = radarQuery.data ?? [];
  const loading = radarQuery.isPending;

  useEffect(() => {
    let active = true;
    const nextMetadataState: Record<
      string,
      ReferrerMetadata | null | undefined
    > = {};

    for (const item of data) {
      const normalized = normalizeReferrerLabel(item.referrer, "").trim();
      if (!normalized) {
        nextMetadataState[item.referrer] = null;
        continue;
      }
      nextMetadataState[item.referrer] = referrerMetadataCache.has(normalized)
        ? referrerMetadataCache.get(normalized)
        : undefined;
    }

    setMetadataByReferrer(nextMetadataState);

    for (const item of data) {
      const normalized = normalizeReferrerLabel(item.referrer, "").trim();
      if (!normalized || referrerMetadataCache.has(normalized)) continue;
      void fetchReferrerMetadata(item.referrer).then((metadata) => {
        if (!active) return;
        setMetadataByReferrer((current) => {
          if (!(item.referrer in current)) return current;
          return {
            ...current,
            [item.referrer]: metadata,
          };
        });
      });
    }

    return () => {
      active = false;
    };
  }, [data]);

  const metricLabels = useMemo(
    () => ({
      duration: messages.referrers.radarDuration,
      engagement: messages.referrers.radarEngagement,
      depth: messages.referrers.radarDepth,
      loyalty: messages.referrers.radarLoyalty,
      frequency: messages.referrers.radarFrequency,
      traffic: messages.referrers.radarTraffic,
    }),
    [messages],
  );

  const maxByMetric = useMemo(() => {
    const result = {} as Record<RadarMetricKey, number>;
    for (const key of METRIC_KEYS) {
      result[key] = Math.max(...data.map((item) => item.metrics[key]), 0);
    }
    return result;
  }, [data]);

  const hasContent = data.length > 0;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <CardTitle className="inline-flex items-center gap-2">
          <RiShareForwardLine className="size-4" />
          {messages.referrers.radarTitle}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {messages.referrers.radarSubtitle}
        </p>
      </div>

      <ContentSwitch
        loading={loading}
        hasContent={hasContent}
        loadingLabel={messages.common.loading}
        emptyContent={<p>{messages.common.noData}</p>}
        minHeightClassName="min-h-[320px]"
      >
        <div className="grid gap-4 md:grid-cols-2">
          {data.map((item, index) => {
            const color = CHART_COLORS[index % CHART_COLORS.length];
            const label = normalizeReferrerLabel(
              item.referrer,
              messages.overview.direct,
            );
            const points = buildNormalizedPoints(
              item,
              maxByMetric,
              metricLabels,
            );
            const config: ChartConfig = {
              value: { label, color },
            };
            const metadata = metadataByReferrer[item.referrer];
            const metadataLoading =
              item.referrer.trim().length > 0 && metadata === undefined;

            return (
              <Card
                key={`${item.referrer || "__direct__"}-${index}`}
                size="sm"
                className="h-full"
              >
                <AutoResizer className="w-full" initial={false} duration={0.22}>
                  <CardContent className="grid grid-cols-[minmax(0,1fr)_152px] items-start gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
                    <ReferrerMetadataPanel
                      label={label}
                      metadata={metadata}
                      loading={metadataLoading}
                      direct={item.referrer.trim().length === 0}
                      locale={locale}
                      messages={messages}
                    />
                    <SingleReferrerRadar
                      item={item}
                      label={label}
                      points={points}
                      color={color}
                      locale={locale}
                      chartConfig={config}
                    />
                  </CardContent>
                </AutoResizer>
              </Card>
            );
          })}
        </div>
      </ContentSwitch>
    </section>
  );
}
