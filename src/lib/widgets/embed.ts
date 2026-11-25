import type { Locale } from "@/lib/i18n/config";
import {
  widgetClientScript,
  widgetScriptVariant,
} from "@/lib/widgets/client/scripts";
import type { WidgetConfig, WidgetData } from "@/lib/widgets/contract";
import {
  type EmbedMessages,
  WIDGET_EMBED_MESSAGES,
} from "@/lib/widgets/embed-messages";
import { widgetStylesheet } from "@/lib/widgets/embed-style";

/**
 * Public embeds reference cacheable, same-origin assets (see
 * `lib/widgets/assets.ts`) under a `'self'` CSP. srcDoc previews have an
 * opaque origin and keep the identical stylesheet and script inline.
 */
export interface WidgetDocumentAssets {
  stylesheet: string;
  script: string;
}

interface RenderWidgetDocumentInput {
  uuid: string;
  config: WidgetConfig;
  themeOverride?: "light" | "dark";
  localeOverride?: Locale;
  /** Trusted, normalized origin of the selected site, for optional page links. */
  siteOrigin?: string | null;
  previewData?: WidgetData | null;
  preview?: boolean;
  /** Report the preview's actual rendered height to its parent iframe. */
  autoHeight?: boolean;
  revision?: number;
  /** Required for public documents; previews always inline their assets. */
  assets?: WidgetDocumentAssets;
}

type WidgetPlaceholderStatus =
  "not-found" | "unpublished" | "domain-denied" | "unavailable";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function inlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function htmlDocument(
  content: string,
  lang: string,
  options: {
    theme?: string;
    autoHeight?: boolean;
    script?: string | null;
    assets?: WidgetDocumentAssets;
  },
): string {
  const { assets } = options;
  const style = assets
    ? `<link rel="stylesheet" href="${escapeHtml(assets.stylesheet)}">`
    : `<style>${widgetStylesheet({ webfont: false })}</style>`;
  const script = options.script
    ? assets
      ? `<script src="${escapeHtml(assets.script)}"></script>`
      : `<script>${inlineScript(options.script)}</script>`
    : "";
  const autoHeight = options.autoHeight ? ` data-auto-height="true"` : "";
  return `<!doctype html><html lang="${escapeHtml(lang)}" data-theme="${escapeHtml(options.theme ?? "auto")}"${autoHeight}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>InsightFlare</title>${style}</head><body>${content}${script}</body></html>`;
}

function localeForConfig(config: WidgetConfig): Locale {
  return config.locale;
}

function themeForDocument(
  config: WidgetConfig,
  override?: "light" | "dark",
): string {
  return escapeHtml(
    override ?? (config.theme === "auto" ? "auto" : config.theme),
  );
}

function periodLabel(config: WidgetConfig, messages: EmbedMessages): string {
  if (config.type === "realtime")
    return config.realtimeLayout === "trend" ? messages.last30m : messages.now;
  return config.range === "7d" ? messages.period7d : messages.period30d;
}

function initialWidgetMarkup(
  input: RenderWidgetDocumentInput,
  locale: Locale,
  messages: EmbedMessages,
): string {
  const { config, uuid } = input;
  const title = config.title.trim();
  const preview = input.preview === true;
  const attributes = [
    `id="widget"`,
    `class="widget"`,
    `data-widget-type="${escapeHtml(config.type)}"`,
    `data-metric="${escapeHtml(config.metric)}"`,
    `data-dimension="${escapeHtml(config.dimension)}"`,
    `data-distribution-dimension="${escapeHtml(config.distributionDimension)}"`,
    `data-distribution-style="${escapeHtml(config.distributionStyle)}"`,
    `data-trend-style="${escapeHtml(config.trendStyle)}"`,
    `data-ranking-style="${escapeHtml(config.rankingStyle)}"`,
    `data-page-links-enabled="${config.pageLinksEnabled}"`,
    `data-site-origin="${escapeHtml(config.pageLinksEnabled ? (input.siteOrigin ?? "") : "")}"`,
    `data-geo-projection="${escapeHtml(config.geoProjection)}"`,
    `data-realtime-layout="${escapeHtml(config.realtimeLayout)}"`,
    `data-locale="${escapeHtml(locale)}"`,
    `data-time-zone="${escapeHtml(config.timeZone)}"`,
    `data-uuid="${escapeHtml(uuid)}"`,
    `data-limit="${config.limit}"`,
    `data-comparison="${config.comparison}"`,
    `data-preview="${preview ? "true" : "false"}"`,
  ];
  if (preview && input.autoHeight === true) {
    attributes.push(`data-auto-height="true"`);
  }
  if (!preview && typeof input.revision === "number") {
    attributes.push(`data-revision="${input.revision}"`);
  }

  const previewData =
    preview && input.previewData != null
      ? `<script type="application/json" id="widget-preview-data">${jsonForHtml(input.previewData)}</script>`
      : "";
  const messagesData = `<script type="application/json" id="widget-messages">${jsonForHtml(messages)}</script>`;
  return `<main ${attributes.join(" ")}><div class="widget__inner"><header class="widget__header">${title ? `<h1 class="widget__title">${escapeHtml(title)}</h1>` : ""}<span class="widget__period">${escapeHtml(periodLabel(config, messages))}</span></header><section class="widget__content" id="widget-content" aria-live="polite"></section><div class="widget__status" id="widget-status" role="status">${escapeHtml(preview ? messages.previewDataUnavailable : messages.loading)}</div></div></main>${messagesData}${previewData}`;
}

export function renderWidgetDocument(input: RenderWidgetDocumentInput): string {
  const locale = input.localeOverride ?? localeForConfig(input.config);
  const preview = input.preview === true;
  const content = initialWidgetMarkup(
    input,
    locale,
    WIDGET_EMBED_MESSAGES[locale],
  );
  return htmlDocument(content, locale, {
    theme: themeForDocument(input.config, input.themeOverride),
    autoHeight: preview && input.autoHeight === true,
    script: widgetClientScript(widgetScriptVariant(input.config.type)),
    assets: preview ? undefined : input.assets,
  });
}

export function renderWidgetPlaceholder(
  status: WidgetPlaceholderStatus,
  localeInput: Locale = "en",
  assets?: WidgetDocumentAssets,
): string {
  const locale = localeInput;
  const messages = WIDGET_EMBED_MESSAGES[locale];
  const heading =
    status === "domain-denied"
      ? messages.domainDeniedTitle
      : status === "unavailable"
        ? messages.unavailableTitle
        : status === "unpublished"
          ? messages.unpublishedTitle
          : messages.notFoundTitle;
  const description =
    status === "domain-denied"
      ? messages.domainDeniedDescription
      : status === "unavailable"
        ? messages.unavailableDescription
        : status === "unpublished"
          ? messages.unpublishedDescription
          : messages.notFoundDescription;
  const content = `<main class="placeholder"><section class="placeholder__card" role="status"><span class="placeholder__mark" aria-hidden="true">${status === "domain-denied" ? "↗" : "·"}</span><h1 class="placeholder__title">${escapeHtml(heading)}</h1><p class="placeholder__description">${escapeHtml(description)}</p></section></main>`;
  return htmlDocument(content, locale, { assets });
}

function normalizeFrameAncestor(source: string): string | null {
  if (source === "*") return "*";
  if (source === "'self'" || source === "'none'") return source;
  try {
    const url = new URL(source);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.origin !== source ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function widgetDocumentCsp(frameAncestors: string): string {
  const sources = frameAncestors
    .trim()
    .split(/\s+/)
    .map(normalizeFrameAncestor)
    .filter((source): source is string => source !== null);
  const ancestors = sources.includes("*")
    ? "*"
    : sources.includes("'none'")
      ? "'none'"
      : Array.from(
          new Set(sources.filter((source) => source !== "'none'")),
        ).join(" ") || "'none'";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}
