/** Ephemeral, synthetic Widgets data for the UI demo build. Never reads production KV/D1. */
import { resolveTimeWindow } from "@/lib/dashboard/query-state";
import { DEMO_SITE_PROFILES, DEMO_TEAMS } from "@/lib/demo/data/site-profiles";
import { checkOriginOrReferer } from "@/lib/hono/middleware/public-api-gate";
import {
  type WidgetConfig,
  widgetConfigSchema,
  type WidgetData,
  type WidgetRecord,
  widgetRecordSchema,
  widgetUuidSchema,
} from "@/lib/widgets/contract";
import { GEO_COUNTRY_ANCHORS } from "@/lib/widgets/geo-data";

const demoRecords = new Map<string, WidgetRecord>();
const demoTeam = DEMO_TEAMS[0]!;
const demoSite = DEMO_SITE_PROFILES.find(
  (site) => site.teamId === demoTeam.id,
)!;

function fixture(
  uuid: string,
  title: string,
  type: WidgetConfig["type"],
  metric: WidgetConfig["metric"],
  overrides: Partial<WidgetConfig> = {},
): WidgetRecord {
  const config = widgetConfigSchema.parse({
    title,
    type,
    metric,
    range: "7d",
    timeZone: "UTC",
    locale: "zh",
    theme: "auto",
    embedMode: "any",
    allowedOrigins: [],
    comparison: true,
    dimension: "page.path",
    limit: 5,
    ...overrides,
  });
  return widgetRecordSchema.parse({
    schemaVersion: 1,
    uuid,
    teamId: demoTeam.id,
    siteId: demoSite.id,
    draft: config,
    published: config,
    status: "published",
    revision: 1,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000,
  });
}

let initialized = false;
function ensureFixtures() {
  if (initialized) return;
  initialized = true;
  for (const record of [
    fixture(
      "11111111-1111-4111-8111-111111111111",
      "访问者",
      "metric",
      "visitors",
    ),
    fixture(
      "22222222-2222-4222-8222-222222222222",
      "浏览量趋势",
      "trend",
      "views",
    ),
    fixture(
      "33333333-3333-4333-8333-333333333333",
      "热门页面",
      "ranking",
      "views",
    ),
    fixture(
      "44444444-4444-4444-8444-444444444444",
      "热门页面 · 横向条形",
      "ranking",
      "views",
      { rankingStyle: "bars" },
    ),
    fixture(
      "55555555-5555-4555-8555-555555555555",
      "设备类型分布",
      "distribution",
      "visitors",
      { distributionDimension: "client.deviceType" },
    ),
    fixture(
      "66666666-6666-4666-8666-666666666666",
      "来源渠道分布",
      "distribution",
      "visitors",
      { distributionDimension: "utm.source" },
    ),
    fixture(
      "77777777-7777-4777-8777-777777777777",
      "跳出率",
      "metric",
      "bounceRate",
    ),
    fixture(
      "88888888-8888-4888-8888-888888888888",
      "多指标趋势对比",
      "trend",
      "visitors",
      { trendMetrics: ["visitors", "views", "sessions"] },
    ),
    fixture(
      "99999999-9999-4999-8999-999999999999",
      "注册事件次数",
      "conversion",
      "events",
      { conversionKind: "event", eventName: "sign_up" },
    ),
    fixture(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "注册目标转化",
      "conversion",
      "visitors",
      { conversionKind: "goal", goalId: "demo-goal-signup" },
    ),
    fixture(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "平均停留时长",
      "metric",
      "avgDurationMs",
    ),
    fixture(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "访客国家或地区",
      "ranking",
      "visitors",
      { dimension: "geo.country", rankingStyle: "bars" },
    ),
    fixture(
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "浏览器分布",
      "distribution",
      "sessions",
      { distributionDimension: "client.browser" },
    ),
    fixture(
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "流量来源排行",
      "ranking",
      "views",
      { dimension: "source.domain", rankingStyle: "list", limit: 10 },
    ),
    fixture(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "每次会话浏览量",
      "metric",
      "viewsPerSession",
    ),
    fixture(
      "01010101-0101-4101-8101-010101010101",
      "访客来源 · 地图",
      "geo",
      "visitors",
      { geoProjection: "flat" },
    ),
    fixture(
      "02020202-0202-4202-8202-020202020202",
      "访客来源 · 地球",
      "geo",
      "visitors",
      { geoProjection: "globe" },
    ),
    fixture(
      "03030303-0303-4303-8303-030303030303",
      "当前在线 · 徽章",
      "realtime",
      "visitors",
      { realtimeLayout: "badge" },
    ),
    fixture(
      "04040404-0404-4404-8404-040404040404",
      "实时活动 · 近 30 分钟",
      "realtime",
      "visitors",
      { realtimeLayout: "trend" },
    ),
    fixture(
      "05050505-0505-4505-8505-050505050505",
      "当前在线 · 地图",
      "realtime",
      "visitors",
      { realtimeLayout: "map", geoProjection: "flat" },
    ),
    fixture(
      "06060606-0606-4606-8606-060606060606",
      "当前在线 · 地球",
      "realtime",
      "visitors",
      { realtimeLayout: "map", geoProjection: "globe" },
    ),
    fixture(
      "07070707-0707-4707-8707-070707070707",
      "当前热门页面",
      "realtime",
      "visitors",
      { realtimeLayout: "pages" },
    ),
    fixture(
      "08080808-0808-4808-8808-080808080808",
      "设备分布 · 环形图",
      "distribution",
      "visitors",
      { distributionStyle: "donut" },
    ),
    fixture(
      "09090909-0909-4909-8909-090909090909",
      "流量占比 · 比例条",
      "distribution",
      "visitors",
      { distributionStyle: "ratio", distributionDimension: "utm.source" },
    ),
    fixture(
      "10101010-1010-4010-8010-101010101010",
      "访客趋势 · 面积图",
      "trend",
      "visitors",
      { trendStyle: "area" },
    ),
  ]) {
    demoRecords.set(record.uuid, record);
  }
}

function validTeam(teamId: string): boolean {
  return DEMO_TEAMS.some((team) => team.id === teamId);
}

function validSite(teamId: string, siteId: string): boolean {
  return DEMO_SITE_PROFILES.some(
    (site) => site.teamId === teamId && site.id === siteId,
  );
}

export function readDemoWidget(uuid: string): WidgetRecord | null {
  ensureFixtures();
  return demoRecords.get(uuid) ?? null;
}

export function demoWidgetSiteBelongsToTeam(teamId: string, siteId: string) {
  return validSite(teamId, siteId);
}

/** Deterministic, non-identifying sample aggregates for preview and public embeds. */
export function generateDemoWidgetData(
  siteId: string,
  config: WidgetConfig,
): WidgetData {
  const { from, to, timeZone } = resolveTimeWindow(config.range, Date.now(), {
    timeZone: config.timeZone,
    interval: "day",
  });
  const updatedAt = Date.now();
  const seed = [...siteId].reduce(
    (value, char) => value + char.charCodeAt(0),
    0,
  );
  const days = config.range === "7d" ? 7 : 30;
  const scale =
    config.metric === "views" ? 4 : config.metric === "sessions" ? 2 : 3;
  const base = { metric: config.metric, from, to, timeZone, updatedAt };
  if (config.type === "realtime") {
    const activeNow = 42 + (seed % 15);
    const minuteNow = Math.floor(updatedAt / 60_000);
    const bars =
      config.realtimeLayout === "trend"
        ? Array.from({ length: 30 }, (_, i) => ({
            minute: (minuteNow - 29 + i) * 60_000,
            visitors: 8 + Math.round(9 * Math.abs(Math.sin(i * 0.56 + seed))),
            views: 13 + Math.round(17 * Math.abs(Math.sin(i * 0.44 + seed))),
          }))
        : [];
    const countries = ["US", "DE", "JP", "GB", "CN", "SG", "CA", "AU"];
    const points =
      config.realtimeLayout === "map"
        ? countries.flatMap((country, index) => {
            const anchor = GEO_COUNTRY_ANCHORS[country];
            return anchor
              ? [
                  {
                    country,
                    lat: anchor[0],
                    lon: anchor[1],
                    value: Math.max(3, 16 - index * 2),
                  },
                ]
              : [];
          })
        : [];
    const rows =
      config.realtimeLayout === "pages"
        ? [
            "/",
            "/docs",
            "/pricing",
            "/blog",
            "/features",
            "/about",
            "/contact",
            "/login",
            "/dashboard",
            "/support",
          ]
            .slice(0, config.limit)
            .map((label, i) => ({ label, value: Math.max(3, 26 - 2 * i) }))
        : [];
    return { ...base, type: "realtime", activeNow, bars, points, rows };
  }
  if (config.type === "geo") {
    const countries = [
      "US",
      "CN",
      "JP",
      "DE",
      "GB",
      "CA",
      "FR",
      "AU",
      "KR",
      "SG",
      "IN",
      "BR",
      "ZA",
    ];
    const points = countries.flatMap((country, index) => {
      const anchor = GEO_COUNTRY_ANCHORS[country];
      return anchor
        ? [
            {
              country,
              lat: anchor[0],
              lon: anchor[1],
              value: Math.round((1350 / (index + 1) + (seed % 51)) * scale),
            },
          ]
        : [];
    });
    return { ...base, type: "geo", points, unmapped: 0 };
  }
  if (config.type === "conversion") {
    const points = Array.from({ length: days }, (_, i) => {
      const value = 12 + (seed % 8) + (i % 7) * 3;
      return {
        timestampMs: from + Math.floor(((i + 0.5) * (to - from)) / days),
        value,
        rate: config.conversionKind === "goal" ? value / (value * 5) : null,
      };
    });
    const value = points.reduce((sum, point) => sum + point.value, 0);
    const goal = config.conversionKind === "goal";
    return {
      ...base,
      type: "conversion",
      kind: config.conversionKind,
      label: goal ? "注册转化目标" : config.eventName,
      value,
      rate: goal ? 0.2 : null,
      total: goal ? value * 5 : null,
      points,
    };
  }
  if (config.type === "metric") {
    return {
      ...base,
      type: "metric",
      value:
        config.metric === "bounceRate"
          ? 0.38
          : config.metric === "avgDurationMs"
            ? 71_500
            : config.metric === "viewsPerSession"
              ? 2.45
              : (840 + (seed % 260)) * scale * days,
      change: config.comparison ? 0.085 : null,
    };
  }
  if (config.type === "trend") {
    const span = to - from;
    const pointsFor = (selectedMetric: string) =>
      Array.from({ length: days }, (_, i) => ({
        timestampMs: from + Math.floor(((i + 0.5) * span) / days),
        value: Math.round(
          (190 + (seed % 37) + i * 4 + (i % 5) * 18) *
            (selectedMetric === "views"
              ? 4
              : selectedMetric === "sessions"
                ? 2
                : 3),
        ),
      }));
    const selected =
      config.trendMetrics.length > 0
        ? config.trendMetrics
        : [config.metric as "visitors" | "views" | "sessions"];
    return {
      ...base,
      type: "trend",
      points: pointsFor(selected[0]!),
      ...(config.trendMetrics.length > 0
        ? {
            series: selected.map((metric) => ({
              metric,
              points: pointsFor(metric),
            })),
          }
        : {}),
    };
  }
  const labels =
    config.dimension === "geo.country"
      ? ["US", "CN", "JP", "DE", "GB", "CA", "FR", "AU", "SG", "KR"]
      : config.dimension === "source.domain"
        ? [
            "google.com",
            "bing.com",
            "github.com",
            "reddit.com",
            "duckduckgo.com",
            "yahoo.com",
            "baidu.com",
            "yandex.com",
            "youtube.com",
            "x.com",
          ]
        : [
            "/",
            "/dashboard",
            "/pricing",
            "/docs",
            "/about",
            "/blog",
            "/features",
            "/contact",
            "/login",
            "/settings",
          ];
  const distributionLabels =
    config.distributionDimension === "client.deviceType"
      ? ["Desktop", "Mobile", "Tablet", "Other"]
      : config.distributionDimension === "client.browser"
        ? ["Chrome", "Safari", "Firefox", "Edge", "Other"]
        : config.distributionDimension === "utm.source"
          ? ["google", "newsletter", "github", "direct", "social", "other"]
          : ["google.com", "bing.com", "github.com", "reddit.com", "other"];
  const chosenLabels =
    config.type === "distribution" ? distributionLabels : labels;
  const rows = chosenLabels.slice(0, config.limit).map((label, index) => ({
    label,
    value: Math.round((1200 / (index + 1) + (seed % 71)) * scale),
  }));
  if (config.type === "distribution") {
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    return {
      ...base,
      type: "distribution",
      rows: rows.map((row) => ({ ...row, percent: row.value / total })),
    };
  }
  return { ...base, type: "ranking", rows };
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function bad(message: string, status = 400) {
  return json(
    {
      ok: false,
      error: {
        code: status === 404 ? "not_found" : "invalid_widget_request",
        message,
      },
    },
    status,
  );
}

function updated(
  record: WidgetRecord,
  patch: Partial<WidgetRecord>,
): WidgetRecord {
  return widgetRecordSchema.parse({
    ...record,
    ...patch,
    updatedAt: Date.now(),
  });
}

export async function handleDemoWidgetApi(request: Request): Promise<Response> {
  ensureFixtures();
  const pathname = new URL(request.url).pathname;
  const match =
    /^\/api\/private\/widgets\/teams\/([^/]+)(?:\/([^/]+))?(?:\/(preview|publish|unpublish))?$/.exec(
      pathname,
    );
  if (!match) return bad("Widget route not found", 404);
  const teamId = decodeURIComponent(match[1]!);
  const id =
    match[2] && match[2] !== "preview" ? decodeURIComponent(match[2]) : null;
  const action = match[2] === "preview" ? "preview" : match[3];
  if (!validTeam(teamId)) return bad("Team not found", 404);

  if (request.method === "GET" && !id && !action) {
    return json({
      ok: true,
      data: [...demoRecords.values()]
        .filter((record) => record.teamId === teamId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      nextCursor: null,
    });
  }

  if (request.method !== "GET" && !checkOriginOrReferer(request)) {
    return json(
      {
        ok: false,
        error: {
          code: "same_origin_required",
          message: "Same-origin request required",
        },
      },
      403,
    );
  }

  if (request.method === "DELETE" && id && !action) {
    if (!demoRecords.has(id)) return bad("Widget not found", 404);
    demoRecords.delete(id);
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }

  let body: Record<string, unknown> = {};
  if (request.method === "POST" || request.method === "PUT") {
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return bad("JSON object required");
      body = parsed as Record<string, unknown>;
    } catch {
      return bad("JSON object required");
    }
  }

  if (request.method === "POST" && !id && action === "preview") {
    const config = widgetConfigSchema.safeParse(body.config);
    if (
      !config.success ||
      typeof body.siteId !== "string" ||
      !validSite(teamId, body.siteId)
    ) {
      return bad("Invalid site or widget config");
    }
    return json({
      ok: true,
      data: generateDemoWidgetData(body.siteId, config.data),
    });
  }

  if (request.method === "POST" && !id && !action) {
    const uuid = widgetUuidSchema.safeParse(body.uuid);
    const config = widgetConfigSchema.safeParse(body.config);
    if (
      !uuid.success ||
      !config.success ||
      typeof body.siteId !== "string" ||
      !validSite(teamId, body.siteId) ||
      (body.publish !== undefined && typeof body.publish !== "boolean")
    ) {
      return bad("Invalid site or widget config");
    }
    const existing = demoRecords.get(uuid.data);
    if (existing) {
      return existing.teamId === teamId && existing.siteId === body.siteId
        ? json({ ok: true, data: existing }, 201)
        : bad("Widget identifier conflict");
    }
    const now = Date.now();
    const record = widgetRecordSchema.parse({
      schemaVersion: 1,
      uuid: uuid.data,
      teamId,
      siteId: body.siteId,
      draft: config.data,
      published: body.publish ? config.data : null,
      status: body.publish ? "published" : "draft",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    demoRecords.set(record.uuid, record);
    return json({ ok: true, data: record }, 201);
  }

  if (!id || !widgetUuidSchema.safeParse(id).success)
    return bad("Widget not found", 404);
  const record = demoRecords.get(id);
  if (!record || record.teamId !== teamId || !validSite(teamId, record.siteId))
    return bad("Widget not found", 404);

  let next: WidgetRecord;
  if (request.method === "PUT" && !action) {
    const config = widgetConfigSchema.safeParse(body.config);
    if (!config.success) return bad("Invalid widget config");
    next = updated(record, { draft: config.data });
  } else if (request.method === "POST" && action === "publish") {
    const config = widgetConfigSchema.safeParse(body.config);
    if (!config.success) return bad("Invalid widget config");
    next = updated(record, {
      draft: config.data,
      published: config.data,
      status: "published",
      revision: Math.max(record.revision + 1, Date.now()),
    });
  } else if (request.method === "POST" && action === "unpublish") {
    next = updated(record, { status: "unpublished" });
  } else {
    return bad("Widget route not found", 404);
  }
  demoRecords.set(id, next);
  return json({ ok: true, data: next });
}
