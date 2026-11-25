import { WIDGET_EMBED_LOADER } from "@/lib/widgets/client/embed-loader";
import {
  WIDGET_SCRIPT_VARIANTS,
  widgetClientScript,
  type WidgetScriptVariant,
  widgetScriptVariant,
} from "@/lib/widgets/client/scripts";
import type { WidgetConfig } from "@/lib/widgets/contract";
import type { WidgetDocumentAssets } from "@/lib/widgets/embed";
import { widgetStylesheet } from "@/lib/widgets/embed-style";

/**
 * Public widget documents are `no-store`, but their stylesheet and scripts
 * are immutable, content-addressed files so browsers and the edge reuse them
 * across embeds and page views. Hashes are computed lazily, once per isolate,
 * with the native WebCrypto digest; nothing is hashed at module load.
 */
export const WIDGET_ASSET_PREFIX = "/api/public/widgets/assets/";
export const WIDGET_EMBED_LOADER_PATH = "/api/public/widgets/embed.js";

interface WidgetAsset {
  file: string;
  body: string;
  contentType: string;
}

interface WidgetAssetManifest {
  stylesheet: WidgetAsset;
  scripts: Record<WidgetScriptVariant, WidgetAsset>;
  byFile: Map<string, WidgetAsset>;
  /** Stable logical name (without hash) → current asset. */
  byName: Map<string, WidgetAsset>;
}

const HASHED_FILE = /^(widget(?:-[a-z]+)?)\.([0-9a-f]{16})\.(js|css)$/;

async function contentHash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function asset(
  name: string,
  extension: "js" | "css",
  body: string,
): Promise<WidgetAsset> {
  return {
    file: `${name}.${await contentHash(body)}.${extension}`,
    body,
    contentType:
      extension === "js"
        ? "text/javascript; charset=utf-8"
        : "text/css; charset=utf-8",
  };
}

let manifest: Promise<WidgetAssetManifest> | null = null;

function widgetAssetManifest(): Promise<WidgetAssetManifest> {
  manifest ??= (async () => {
    const stylesheet = await asset(
      "widget",
      "css",
      widgetStylesheet({ webfont: true }),
    );
    const entries = await Promise.all(
      WIDGET_SCRIPT_VARIANTS.map(
        async (variant) =>
          [
            variant,
            await asset(`widget-${variant}`, "js", widgetClientScript(variant)),
          ] as const,
      ),
    );
    const scripts = Object.fromEntries(entries) as Record<
      WidgetScriptVariant,
      WidgetAsset
    >;
    const all = [stylesheet, ...entries.map(([, script]) => script)];
    return {
      stylesheet,
      scripts,
      byFile: new Map(all.map((item) => [item.file, item])),
      byName: new Map(
        all.map((item) => [item.file.replace(HASHED_FILE, "$1.$3"), item]),
      ),
    };
  })().catch((error: unknown) => {
    manifest = null;
    throw error;
  });
  return manifest;
}

export async function widgetDocumentAssets(
  type: WidgetConfig["type"] | null,
): Promise<WidgetDocumentAssets> {
  const current = await widgetAssetManifest();
  return {
    stylesheet: WIDGET_ASSET_PREFIX + current.stylesheet.file,
    script:
      WIDGET_ASSET_PREFIX +
      current.scripts[type ? widgetScriptVariant(type) : "base"].file,
  };
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
} as const;

/**
 * Serves `widget[-variant].<hash>.(js|css)`. A hash from another deployment
 * (HTML rendered by an older or newer isolate during a rollout) still gets the
 * current file, but uncached, so a mismatched body is never stored under it.
 */
export async function widgetAssetResponse(
  file: string,
): Promise<Response | null> {
  const match = HASHED_FILE.exec(file);
  if (!match) return null;
  const current = await widgetAssetManifest();
  const exact = current.byFile.get(file);
  const served = exact ?? current.byName.get(`${match[1]}.${match[3]}`);
  if (!served) return null;
  return new Response(served.body, {
    headers: {
      ...SECURITY_HEADERS,
      "content-type": served.contentType,
      "cache-control": exact
        ? "public, max-age=31536000, immutable"
        : "no-store",
    },
  });
}

export function widgetEmbedLoaderResponse(): Response {
  return new Response(WIDGET_EMBED_LOADER, {
    headers: {
      "x-content-type-options": "nosniff",
      "content-type": "text/javascript; charset=utf-8",
      // Stable URL embedded in third-party pages: keep it revalidating.
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
    },
  });
}
