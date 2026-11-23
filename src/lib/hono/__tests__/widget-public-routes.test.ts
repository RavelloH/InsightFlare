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
    const html = await response.text();
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
