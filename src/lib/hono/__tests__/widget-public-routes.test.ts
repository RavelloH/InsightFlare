import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withDashboardCache } from "@/lib/edge/analytics/composition/dashboard-cache";
import type * as WidgetQueryModule from "@/lib/edge/analytics/interfaces/dashboard/widget-query";
import { queryWidgetData } from "@/lib/edge/analytics/interfaces/dashboard/widget-query";
import { readSiteTrackingConfig } from "@/lib/edge/sites/settings-store";
import {
  publicWidgetDataRoutes,
  widgetPageRoutes,
} from "@/lib/hono/routes/public/widgets";
import type { AppEnv } from "@/lib/hono/types";
import { widgetConfigSchema, type WidgetRecord } from "@/lib/widgets/contract";
import { clearWidgetOwnershipMemo } from "@/lib/widgets/ownership-cache";
import { readWidget, widgetSiteBelongsToTeam } from "@/lib/widgets/store";

vi.mock("@/lib/widgets/store");
vi.mock("@/lib/edge/sites/settings-store");
vi.mock(
  "@/lib/edge/analytics/interfaces/dashboard/widget-query",
  async (load) => ({
    ...(await load<typeof WidgetQueryModule>()),
    queryWidgetData: vi.fn(),
  }),
);
vi.mock("@/lib/edge/analytics/composition/dashboard-cache", () => ({
  withDashboardCache: vi.fn(
    (_context: ExecutionContext, _url: URL, load: () => Promise<Response>) =>
      load(),
  ),
}));

const widget: WidgetRecord = {
  schemaVersion: 1,
  uuid: "3dcee5b5-e44f-4ca7-b4f7-ba693182883e",
  teamId: "team",
  siteId: "site",
  draft: widgetConfigSchema.parse({
    type: "metric",
    title: "Site traffic",
    metric: "views",
    range: "7d",
    timeZone: "Asia/Shanghai",
    locale: "en",
    theme: "auto",
    embedMode: "restricted",
    allowedOrigins: ["https://site.test"],
    comparison: true,
    dimension: "page.path",
    limit: 5,
  }),
  published: null,
  status: "published",
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
};
widget.published = widget.draft;

const app = new Hono<AppEnv>()
  .route("/widget", widgetPageRoutes)
  .route("/en/widget", widgetPageRoutes)
  .route("/zh/widget", widgetPageRoutes)
  .route("/zh-tw/widget", widgetPageRoutes)
  .route("/ja/widget", widgetPageRoutes)
  .route("/api/public/widgets", publicWidgetDataRoutes);

const request = (path: string, headers?: HeadersInit) =>
  app.request(
    path,
    { headers },
    {},
    {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    },
  );

const documentPath = `/en/widget/${widget.uuid}`;
const dataPath = `/api/public/widgets/${widget.uuid}/data`;

describe("published widgets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readWidget).mockResolvedValue(widget);
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(true);
    clearWidgetOwnershipMemo();
    vi.mocked(readSiteTrackingConfig).mockResolvedValue({
      siteId: "site",
      siteDomain: "site.test",
    } as Awaited<ReturnType<typeof readSiteTrackingConfig>>);
    vi.mocked(queryWidgetData).mockResolvedValue({
      type: "metric",
      metric: "views",
      value: 5,
      change: null,
      from: 1,
      to: 2,
      timeZone: widget.draft.timeZone,
      updatedAt: 2,
    });
  });

  it("redirects legacy unprefixed links to the shared locale preference and preserves query strings", async () => {
    const location = `/widget/${widget.uuid}?theme=dark`;
    const response = await request(location, {
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    });
    expect(response.status).toBe(307);
    const target = new URL(response.headers.get("location")!);
    expect(target.pathname).toBe(`/zh/widget/${widget.uuid}`);
    expect(target.search).toBe("?theme=dark");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toContain("Accept-Language");

    const hk = await request(`/widget/${widget.uuid}`, {
      "accept-language": "zh-HK,zh;q=0.9",
    });
    expect(new URL(hk.headers.get("location")!).pathname).toBe(
      `/zh-tw/widget/${widget.uuid}`,
    );
    const cookie = await request(`/widget/${widget.uuid}`, {
      cookie: "if_locale=ja",
    });
    expect(new URL(cookie.headers.get("location")!).pathname).toBe(
      `/ja/widget/${widget.uuid}`,
    );
  });

  it("honors explicit locale path over browser language and keeps public CSP", async () => {
    const response = await request(`/zh/widget/${widget.uuid}`, {
      "accept-language": "en-US,en;q=0.9",
      "sec-fetch-dest": "iframe",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://site.test",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    const html = await response.text();
    expect(html).toMatch(
      /<link rel="stylesheet" href="\/api\/public\/widgets\/assets\/widget\.[0-9a-f]{16}\.css">/,
    );
    expect(html).toMatch(
      /<script src="\/api\/public\/widgets\/assets\/widget-base\.[0-9a-f]{16}\.js"><\/script>/,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain('<html lang="zh"');
    expect(html).toContain('data-locale="zh"');
    expect(html).toContain("最近 7 天");
    const ja = await request(`/ja/widget/${widget.uuid}`);
    expect(ja.status).toBe(200);
    expect(await ja.text()).toContain('data-locale="ja"');
  });

  it("uses the verified site domain for opt-in public page links only", async () => {
    const custom = {
      ...widget,
      published: {
        ...widget.draft,
        type: "ranking" as const,
        pageLinksEnabled: true,
        dimension: "page.path" as const,
        title: "",
      },
    };
    vi.mocked(readWidget).mockResolvedValueOnce(custom);
    const linked = await request(documentPath);
    expect(linked.status).toBe(200);
    const html = await linked.text();
    expect(html).toContain('data-page-links-enabled="true"');
    expect(html).toContain('data-site-origin="https://site.test"');
    expect(html).not.toContain('class="widget__title"');
    expect(readSiteTrackingConfig).toHaveBeenCalledWith(
      expect.anything(),
      "site",
    );

    vi.mocked(readSiteTrackingConfig).mockClear();
    const disabled = await request(documentPath);
    expect(disabled.status).toBe(200);
    expect(await disabled.text()).toContain('data-site-origin=""');
    expect(readSiteTrackingConfig).not.toHaveBeenCalled();
  });

  it("uses frame-ancestors even when an iframe omits its referrer", async () => {
    const allowed = await request(documentPath, { "sec-fetch-dest": "iframe" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://site.test",
    );
    expect(allowed.headers.get("x-frame-options")).toBeNull();
    expect(await allowed.text()).toContain(widget.draft.title);

    const denied = await request(documentPath, {
      "sec-fetch-dest": "iframe",
      referer: "https://unauthorized.test/page",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-security-policy")).toContain(
      "frame-ancestors *",
    );
    expect(await denied.text()).not.toContain(widget.draft.title);
    expect(queryWidgetData).not.toHaveBeenCalled();
  });

  it("keeps a stale iframe revision and deleted site out of the data cache", async () => {
    expect((await request(`${dataPath}?revision=1`)).status).toBe(409);
    expect(withDashboardCache).not.toHaveBeenCalled();
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(false);
    // The public path reuses a short-lived ownership result.
    clearWidgetOwnershipMemo();
    expect((await request(dataPath)).status).toBe(404);
    expect((await request(documentPath)).status).toBe(404);
    expect(withDashboardCache).not.toHaveBeenCalled();
  });

  it("checks publication state for both entry points before returning aggregates", async () => {
    vi.mocked(readWidget).mockResolvedValueOnce({
      ...widget,
      status: "unpublished",
    });
    expect((await request(documentPath)).status).toBe(410);
    vi.mocked(readWidget).mockResolvedValueOnce({
      ...widget,
      status: "draft",
      published: null,
    });
    expect((await request(dataPath)).status).toBe(404);
    const response = await request(
      `${dataPath}?siteId=unrelated&metric=sessions&revision=2`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      data: { metric: "views", value: 5 },
    });
    expect(queryWidgetData).toHaveBeenCalledWith(
      expect.anything(),
      widget.siteId,
      widget.published,
      expect.anything(),
    );
  });
});

describe("public widget resilience, cache isolation and unsafe input handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readWidget).mockResolvedValue(widget);
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(true);
    clearWidgetOwnershipMemo();
    vi.mocked(readSiteTrackingConfig).mockResolvedValue({
      siteId: "site",
      siteDomain: "site.test",
    } as Awaited<ReturnType<typeof readSiteTrackingConfig>>);
    vi.mocked(queryWidgetData).mockResolvedValue({
      type: "metric",
      metric: "views",
      value: 3,
      change: null,
      from: 1,
      to: 2,
      timeZone: "UTC",
      updatedAt: 2,
    });
    vi.mocked(withDashboardCache).mockImplementation((_ctx, _url, load) =>
      load(),
    );
  });

  it("returns neutral 404 pages for unrecognized URLs or malformed UUIDs", async () => {
    expect((await request("/en/widget/not-a-uuid")).status).toBe(404);
    expect((await request("/en/widget/")).status).toBe(404);
    expect((await request("/api/public/widgets/not-a-uuid/data")).status).toBe(
      404,
    );
    expect(readWidget).not.toHaveBeenCalled();
  });

  it("does not leak storage errors in published HTML or public JSON", async () => {
    vi.mocked(readWidget).mockRejectedValueOnce(new Error("KV SECRET FAILURE"));
    const page = await request(documentPath);
    expect(page.status).toBe(503);
    expect(await page.text()).not.toContain("KV SECRET FAILURE");
    vi.mocked(readWidget).mockRejectedValueOnce(new Error("KV SECRET FAILURE"));
    const json = await request(dataPath);
    expect(json.status).toBe(503);
    expect(await json.json()).toEqual({ error: "unavailable" });
    expect(queryWidgetData).not.toHaveBeenCalled();
  });

  it("does not disclose draft widgets through the public HTML page", async () => {
    vi.mocked(readWidget).mockResolvedValueOnce({
      ...widget,
      status: "draft",
      published: null,
    });
    expect((await request(documentPath)).status).toBe(404);
  });

  it("does not disclose unpublished widget datasets", async () => {
    vi.mocked(readWidget).mockResolvedValueOnce({
      ...widget,
      status: "unpublished",
    });
    const response = await request(dataPath);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "unpublished" });
    expect(withDashboardCache).not.toHaveBeenCalled();
  });

  it("returns a 503 JSON response when an analytics query fails without leaking its error", async () => {
    vi.mocked(queryWidgetData).mockRejectedValueOnce(
      new Error("internal SQL details"),
    );
    const response = await request(dataPath);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("internal SQL details");
    expect(body).toContain("unavailable");
  });

  it("enforces allowed iframe origins even when referer contains a path", async () => {
    const allowed = await request(documentPath, {
      "sec-fetch-dest": "iframe",
      referer: "https://site.test/path?x=1",
    });
    expect(allowed.status).toBe(200);
    const denied = await request(documentPath, {
      "sec-fetch-dest": "iframe",
      referer: "https://attacker.test/",
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(widget.draft.title);
  });

  it("emits an unrestricted ancestor policy only for explicitly public embedding", async () => {
    vi.mocked(readWidget).mockResolvedValueOnce({
      ...widget,
      published: { ...widget.draft, embedMode: "any" },
    });
    const response = await request(documentPath, {
      "sec-fetch-dest": "iframe",
      referer: "https://arbitrary.test/somewhere",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors *",
    );
  });

  it("does not use untrusted page origins if the site has no verified domain", async () => {
    vi.mocked(readWidget).mockResolvedValue({
      ...widget,
      published: { ...widget.draft, pageLinksEnabled: true },
    });
    vi.mocked(readSiteTrackingConfig).mockResolvedValue(null);
    const response = await request(documentPath);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-site-origin=""');
  });

  it("rejects an invalid or throwing site origin without emitting an arbitrary link", async () => {
    vi.mocked(readWidget).mockResolvedValue({
      ...widget,
      published: { ...widget.draft, pageLinksEnabled: true },
    });
    vi.mocked(readSiteTrackingConfig).mockResolvedValueOnce({
      siteDomain: "https://evil.test/long/path",
    } as Awaited<ReturnType<typeof readSiteTrackingConfig>>);
    expect(await (await request(documentPath)).text()).toContain(
      'data-site-origin=""',
    );
    vi.mocked(readSiteTrackingConfig).mockRejectedValueOnce(
      new Error("secret API"),
    );
    expect(await (await request(documentPath)).text()).toContain(
      'data-site-origin=""',
    );
  });

  it("normalizes historical cache keys by time window and ignores arbitrary URL parameters", async () => {
    const response = await request(
      dataPath + "?metric=events&filters=private&revision=2",
    );
    expect(response.status).toBe(200);
    expect(withDashboardCache).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(URL),
      expect.any(Function),
      expect.objectContaining({
        cacheName: "insightflare-widget-data",
        ttlSeconds: 60,
      }),
    );
    const url = vi.mocked(withDashboardCache).mock.calls.at(-1)?.[1];
    expect(url?.searchParams.has("filters")).toBe(false);
    expect(url?.searchParams.has("metric")).toBe(false);
    expect(url?.searchParams.get("revision")).toBe("2");
  });

  it("normalizes realtime requests into 15-second cache buckets", async () => {
    vi.mocked(readWidget).mockResolvedValueOnce({
      ...widget,
      published: {
        ...widget.draft,
        type: "realtime",
        metric: "visitors",
        realtimeLayout: "badge",
      },
    });
    const response = await request(dataPath);
    expect(response.status).toBe(200);
    const args = vi.mocked(withDashboardCache).mock.calls.at(-1);
    expect(args?.[3]).toMatchObject({
      ttlSeconds: 15,
      identity: {
        scope: "public",
        tenantId: "site",
        route: `widget:${widget.uuid}`,
      },
    });
    const cacheUrl = args?.[1];
    expect(cacheUrl?.searchParams.has("bucket")).toBe(true);
    expect(cacheUrl?.searchParams.has("from")).toBe(false);
  });

  it("uses explicit themes only for allowed light and dark values", async () => {
    const allowed = await request(documentPath + "?theme=dark");
    expect(await allowed.text()).toContain('data-theme="dark"');
    const denied = await request(documentPath + "?theme=../../secret");
    expect(await denied.text()).not.toContain('data-theme="../../secret"');
  });
});

describe("widget static assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readWidget).mockResolvedValue(widget);
    vi.mocked(widgetSiteBelongsToTeam).mockResolvedValue(true);
    clearWidgetOwnershipMemo();
  });

  async function assetPaths() {
    const html = await (await request(documentPath)).text();
    const stylesheet = /href="([^"]+\.css)"/.exec(html)?.[1];
    const script = /<script src="([^"]+\.js)"/.exec(html)?.[1];
    expect(stylesheet).toBeTruthy();
    expect(script).toBeTruthy();
    return { stylesheet: stylesheet!, script: script! };
  }

  it("serves the referenced content-hashed files as immutable", async () => {
    const { stylesheet, script } = await assetPaths();
    const css = await request(stylesheet);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(css.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await css.text()).toContain("@font-face");
    const js = await request(script);
    expect(js.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(await js.text()).toContain("renderers[data.type]");
    // Asset routes never touch widget storage.
    expect(readWidget).toHaveBeenCalledTimes(1);
  });

  it("picks the script variant from the widget type", async () => {
    vi.mocked(readWidget).mockResolvedValue({
      ...widget,
      published: { ...widget.draft, type: "geo", metric: "visitors" },
    });
    const { script } = await assetPaths();
    expect(script).toMatch(/widget-geo\.[0-9a-f]{16}\.js$/);
    expect(await (await request(script)).text()).toContain("var geoLand");
  });

  it("serves a different deployment's hash uncached and rejects unknown names", async () => {
    const mismatch = await request(
      "/api/public/widgets/assets/widget-base.0000000000000000.js",
    );
    expect(mismatch.status).toBe(200);
    expect(mismatch.headers.get("cache-control")).toBe("no-store");
    for (const file of [
      "widget-evil.0000000000000000.js",
      "widget.css",
      "..%2Fsecret.0000000000000000.js",
    ]) {
      const response = await request(`/api/public/widgets/assets/${file}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves the host-page auto-height loader at a stable URL", async () => {
    const response = await request("/api/public/widgets/embed.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toContain("max-age=3600");
    expect(await response.text()).toContain("iframe[data-insightflare-widget]");
    expect(readWidget).not.toHaveBeenCalled();
  });

  it("styles placeholders through the same-origin stylesheet", async () => {
    vi.mocked(readWidget).mockResolvedValue(null);
    const response = await request(documentPath);
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('<link rel="stylesheet"');
    expect(html).not.toContain("<style>");
  });
});
