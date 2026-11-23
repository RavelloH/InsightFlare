import { z } from "zod";

import { isValidTimeZone, normalizeTimeZone } from "@/lib/analytics/time-zone";
import { SUPPORTED_LOCALES } from "@/lib/i18n/config";

export const widgetUuidSchema = z
  .uuidv4()
  .transform((uuid) => uuid.toLowerCase());

export function normalizeWidgetOrigin(value: string): string | null {
  const source = value.trim();
  if (!/^https?:\/\/[^/\\?#\s]+\/?$/i.test(source) || /[*%;]/.test(source)) {
    return null;
  }
  try {
    const url = new URL(source);
    if (
      url.username ||
      url.password ||
      !/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/i.test(url.hostname)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

const widgetOrigin = z
  .string()
  .max(512)
  .transform((source, context) => {
    const normalized = normalizeWidgetOrigin(source);
    if (normalized !== null) return normalized;
    context.addIssue({ code: "custom", message: "Invalid embed origin" });
    return z.NEVER;
  });

export const widgetCountMetric = z.enum(["visitors", "views", "sessions"]);
const widgetType = z.enum([
  "metric",
  "trend",
  "ranking",
  "distribution",
  "conversion",
  "geo",
  "realtime",
]);
const widgetMetric = z.enum([
  "visitors",
  "views",
  "sessions",
  "bounces",
  "bounceRate",
  "avgDurationMs",
  "viewsPerSession",
  "events",
]);

export const widgetConfigSchema = z
  .strictObject({
    title: z.string().trim().max(120),
    type: widgetType,
    metric: widgetMetric,
    range: z.enum(["7d", "30d"]),
    timeZone: z
      .string()
      .max(120)
      .refine(isValidTimeZone)
      .transform((value) => normalizeTimeZone(value) ?? value),
    locale: z.enum(SUPPORTED_LOCALES),
    theme: z.enum(["auto", "light", "dark"]),
    embedMode: z.enum(["restricted", "any"]),
    allowedOrigins: z
      .array(widgetOrigin)
      .max(30)
      .transform((origins) => [...new Set(origins)]),
    comparison: z.boolean(),
    dimension: z.enum(["page.path", "source.domain", "geo.country"]),
    limit: z.union([z.literal(5), z.literal(10)]),
    // Defaults keep existing persisted widget schemaVersion=1 records readable.
    rankingStyle: z.enum(["list", "bars"]).default("list"),
    pageLinksEnabled: z.boolean().default(false),
    distributionStyle: z.enum(["bars", "donut", "ratio"]).default("bars"),
    trendStyle: z.enum(["line", "area"]).default("line"),
    distributionDimension: z
      .enum([
        "client.deviceType",
        "client.browser",
        "source.domain",
        "utm.source",
      ])
      .default("client.deviceType"),
    trendMetrics: z
      .array(widgetCountMetric)
      .max(3)
      .refine((metrics) => new Set(metrics).size === metrics.length)
      .default([]),
    conversionKind: z.enum(["event", "goal"]).default("event"),
    eventName: z.string().trim().max(120).default(""),
    goalId: z.string().trim().max(120).default(""),
    geoProjection: z.enum(["flat", "globe"]).default("flat"),
    realtimeLayout: z.enum(["badge", "trend", "map", "pages"]).default("badge"),
  })
  .refine(
    (config) =>
      config.embedMode !== "restricted" || config.allowedOrigins.length > 0,
    { path: ["allowedOrigins"], message: "Add an allowed embed origin" },
  )
  .refine(
    (config) =>
      config.type === "metric" ||
      config.type === "conversion" ||
      config.type === "realtime" ||
      widgetCountMetric.safeParse(config.metric).success,
    { path: ["metric"], message: "This widget requires a count metric" },
  )
  .refine(
    (config) =>
      config.type !== "trend" ||
      config.trendStyle !== "area" ||
      config.trendMetrics.length <= 1,
    { path: ["trendMetrics"], message: "Area chart displays a single metric" },
  )
  .refine(
    (config) => config.type !== "realtime" || config.metric === "visitors",
    {
      path: ["metric"],
      message: "Realtime Widgets use the active visitor metric",
    },
  )
  .refine(
    (config) =>
      config.type !== "conversion" ||
      (config.conversionKind === "event"
        ? config.eventName.length > 0
        : config.goalId.length > 0),
    { path: ["conversionKind"], message: "Select an event or goal" },
  );

export const widgetRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    uuid: widgetUuidSchema,
    teamId: z.string().min(1).max(120),
    siteId: z.string().min(1).max(120),
    draft: widgetConfigSchema,
    published: widgetConfigSchema.nullable(),
    status: z.enum(["draft", "published", "unpublished"]),
    revision: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .refine(
    (record) => (record.status === "draft") === (record.published === null),
    {
      path: ["published"],
      message: "Publication status and configuration do not agree",
    },
  );

export type WidgetConfig = z.infer<typeof widgetConfigSchema>;
export type WidgetRecord = z.infer<typeof widgetRecordSchema>;

interface WidgetDataBase {
  metric: WidgetConfig["metric"];
  from: number;
  to: number;
  timeZone: string;
  updatedAt: number;
}

export type WidgetData = WidgetDataBase &
  (
    | { type: "metric"; value: number; change: number | null }
    | {
        type: "realtime";
        activeNow: number;
        bars: { minute: number; visitors: number; views: number }[];
        points: { country: string; lat: number; lon: number; value: number }[];
        rows: { label: string; value: number }[];
      }
    | {
        type: "trend";
        points: { timestampMs: number; value: number }[];
        series?: {
          metric: z.infer<typeof widgetCountMetric>;
          points: { timestampMs: number; value: number }[];
        }[];
      }
    | { type: "ranking"; rows: { label: string; value: number }[] }
    | {
        type: "geo";
        points: { country: string; lat: number; lon: number; value: number }[];
        /** Countries without a reliable label coordinate remain in the total. */
        unmapped: number;
      }
    | {
        type: "distribution";
        rows: { label: string; value: number; percent: number }[];
      }
    | {
        type: "conversion";
        kind: "event" | "goal";
        label: string;
        value: number;
        rate: number | null;
        total: number | null;
        points: { timestampMs: number; value: number; rate?: number | null }[];
      }
  );

export function suggestedWidgetHeight(
  config: Pick<WidgetConfig, "type" | "limit"> &
    Partial<
      Pick<
        WidgetConfig,
        "geoProjection" | "realtimeLayout" | "distributionStyle"
      >
    >,
): number {
  if (config.type === "metric") return 160;
  if (config.type === "realtime") {
    if (config.realtimeLayout === "badge") return 54;
    if (config.realtimeLayout === "map")
      return config.geoProjection === "globe" ? 295 : 270;
    if (config.realtimeLayout === "pages")
      return config.limit === 10 ? 380 : 240;
    return 260;
  }
  if (config.type === "geo")
    return config.geoProjection === "globe" ? 275 : 250;
  if (config.type === "trend" || config.type === "conversion") return 320;
  if (config.type === "distribution") {
    if (config.distributionStyle === "donut") return 310;
    if (config.distributionStyle === "ratio") return 240;
    return config.limit === 10 ? 420 : 280;
  }
  return config.limit === 10 ? 460 : 300;
}
