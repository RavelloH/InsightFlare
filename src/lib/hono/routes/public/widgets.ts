import { Hono } from "hono";

import { withDashboardCache } from "@/lib/edge/analytics/composition/dashboard-cache";
import {
  queryWidgetData,
  widgetTimeWindow,
} from "@/lib/edge/analytics/interfaces/dashboard/widget-query";
import { errorLogData } from "@/lib/edge/observability/logger";
import { readSiteTrackingConfig } from "@/lib/edge/sites/settings-store";
import type { Env } from "@/lib/edge/types";
import type { AppEnv } from "@/lib/hono/types";
import { executionContext } from "@/lib/hono/utils/context";
import { isValidLocale, type Locale } from "@/lib/i18n/config";
import {
  widgetAssetResponse,
  widgetDocumentAssets,
} from "@/lib/widgets/assets";
import {
  normalizeWidgetOrigin,
  widgetUuidSchema,
} from "@/lib/widgets/contract";
import {
  renderWidgetDocument,
  renderWidgetPlaceholder,
  widgetDocumentCsp,
} from "@/lib/widgets/embed";
import { cachedWidgetSiteBelongsToTeam } from "@/lib/widgets/ownership-cache";
import { readWidget } from "@/lib/widgets/store";
import { localeCookie, requestLocale } from "@/middleware";

const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

export const widgetPageRoutes = new Hono<AppEnv>();
export const publicWidgetDataRoutes = new Hono<AppEnv>();

publicWidgetDataRoutes.onError((error, c) => {
  c.get("observabilityLogger")?.error(
    "widget.data.unavailable",
    errorLogData(error),
  );
  return c.json({ error: "unavailable" }, 503, { "cache-control": "no-store" });
});

async function resolveWidget(
  env: Env,
  identifier: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  const uuid = widgetUuidSchema.safeParse(identifier);
  if (!uuid.success) return { status: "not-found" } as const;
  const widget = isDemoBuild
    ? (await import("@/lib/demo/widgets")).readDemoWidget(uuid.data)
    : await readWidget(env, uuid.data);
  if (!widget?.published || widget.status === "draft") {
    return { status: "not-found" } as const;
  }
  if (
    !(isDemoBuild
      ? (await import("@/lib/demo/widgets")).demoWidgetSiteBelongsToTeam(
          widget.teamId,
          widget.siteId,
        )
      : await cachedWidgetSiteBelongsToTeam(
          env,
          widget.teamId,
          widget.siteId,
          ctx,
        ))
  ) {
    return { status: "not-found" } as const;
  }
  if (widget.status === "unpublished") {
    return { status: "unpublished", locale: widget.published.locale } as const;
  }
  return { status: "published", widget, config: widget.published } as const;
}

async function widgetNavigationOrigin(
  env: Env,
  siteId: string,
): Promise<string | null> {
  // The destination is derived from the server-trusted site domain, never
  // from a URL supplied by the public viewer or analytics row.
  try {
    const domain = isDemoBuild
      ? (await import("@/lib/demo/data/site-profiles")).DEMO_SITE_PROFILES.find(
          (site) => site.id === siteId,
        )?.domain
      : (await readSiteTrackingConfig(env, siteId))?.siteDomain;
    if (!domain) return null;
    const candidate = /^https?:\/\//i.test(domain)
      ? domain
      : `https://${domain}`;
    return normalizeWidgetOrigin(candidate);
  } catch {
    return null;
  }
}

function embeddingOrigin(request: Request): string | null {
  if (request.headers.get("sec-fetch-dest") !== "iframe") return null;
  const referrer = request.headers.get("referer");
  if (!referrer) return null;
  try {
    return new URL(referrer).origin;
  } catch {
    return null;
  }
}

function widgetHtml(body: string, status: number, ancestorPolicy = "*") {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": widgetDocumentCsp(ancestorPolicy),
      "referrer-policy": "same-origin",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), payment=()",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

async function placeholderHtml(
  status: Parameters<typeof renderWidgetPlaceholder>[0],
  httpStatus: number,
  locale?: Locale,
) {
  return widgetHtml(
    renderWidgetPlaceholder(status, locale, await widgetDocumentAssets(null)),
    httpStatus,
  );
}

widgetPageRoutes.get("/:uuid", async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const segment = pathname.split("/")[1];
  const locale = isValidLocale(segment) ? segment : null;
  if (!locale) {
    const preferredLocale = requestLocale(c.req.raw);
    const target = new URL(c.req.url);
    target.pathname = `/${preferredLocale}/widget/${encodeURIComponent(c.req.param("uuid"))}`;
    return new Response(null, {
      status: 307,
      headers: {
        location: target.toString(),
        "cache-control": "private, no-store",
        vary: "Accept-Language, Cookie",
        "set-cookie": localeCookie(preferredLocale),
      },
    });
  }
  const resolved = await resolveWidget(
    c.env,
    c.req.param("uuid"),
    executionContext(c),
  ).catch((error: unknown) => {
    c.get("observabilityLogger")?.error(
      "widget.page.unavailable",
      errorLogData(error),
    );
    return null;
  });
  if (!resolved) return placeholderHtml("unavailable", 503, locale);
  if (resolved.status === "not-found") {
    return placeholderHtml("not-found", 404, locale);
  }
  if (resolved.status === "unpublished") {
    return placeholderHtml("unpublished", 410, locale);
  }
  const { widget, config } = resolved;
  let ancestors = "*";
  if (config.embedMode === "restricted") {
    const source = embeddingOrigin(c.req.raw);
    if (source && !config.allowedOrigins.includes(source)) {
      return placeholderHtml("domain-denied", 403, locale);
    }
    ancestors = config.allowedOrigins.join(" ");
  }
  const theme = c.req.query("theme");
  const themeOverride =
    theme === "light" || theme === "dark" ? theme : undefined;
  return widgetHtml(
    renderWidgetDocument({
      uuid: widget.uuid,
      config,
      localeOverride: locale,
      siteOrigin: config.pageLinksEnabled
        ? await widgetNavigationOrigin(c.env, widget.siteId)
        : null,
      themeOverride,
      revision: widget.revision,
      assets: await widgetDocumentAssets(config.type),
    }),
    200,
    ancestors,
  );
});

widgetPageRoutes.get("*", () => placeholderHtml("not-found", 404));

// Registered before "/:uuid/data" so asset names never reach the widget lookup.
publicWidgetDataRoutes.get("/assets/:file", async (c) => {
  const response = await widgetAssetResponse(c.req.param("file"));
  return (
    response ??
    new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  );
});

publicWidgetDataRoutes.get("/:uuid/data", async (c) => {
  const resolved = await resolveWidget(
    c.env,
    c.req.param("uuid"),
    executionContext(c),
  );
  if (resolved.status !== "published") {
    return c.json(
      { error: resolved.status },
      resolved.status === "unpublished" ? 410 : 404,
      {
        "cache-control": "no-store",
      },
    );
  }
  const { widget, config } = resolved;
  const requestedRevision = c.req.query("revision");
  if (
    requestedRevision !== undefined &&
    requestedRevision !== String(widget.revision)
  ) {
    return c.json({ error: "widget-updated" }, 409, {
      "cache-control": "no-store",
    });
  }

  if (isDemoBuild) {
    const { generateDemoWidgetData } = await import("@/lib/demo/widgets");
    return c.json(
      { data: generateDemoWidgetData(widget.siteId, config) },
      200,
      {
        "cache-control": "no-store",
      },
    );
  }

  const realtime = config.type === "realtime";
  const window = realtime ? undefined : widgetTimeWindow(config);
  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = realtime
    ? new URLSearchParams({
        revision: String(widget.revision),
        bucket: String(Math.floor(Date.now() / 15_000)),
      }).toString()
    : new URLSearchParams({
        revision: String(widget.revision),
        from: String(window!.startMs),
        to: String(window!.endExclusiveMs),
      }).toString();
  const response = await withDashboardCache(
    executionContext(c),
    cacheUrl,
    async () =>
      Response.json({
        data: await queryWidgetData(c.env, widget.siteId, config, window),
      }),
    {
      cacheName: "insightflare-widget-data",
      ttlSeconds: realtime ? 15 : 60,
      identity: {
        scope: "public",
        tenantId: widget.siteId,
        route: `widget:${widget.uuid}`,
      },
    },
  );
  response.headers.set("cache-control", "no-store");
  return response;
});
