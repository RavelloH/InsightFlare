const LIGHT_TILE_UPSTREAMS = [
  "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
  "https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png",
  "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
] as const;

const DARK_TILE_UPSTREAMS = [
  "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
  "https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
] as const;

type TileTheme = "light" | "dark";

function parseIntStrict(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const next = Number.parseInt(value, 10);
  return Number.isFinite(next) ? next : null;
}

function resolveY(raw: string): number | null {
  const normalized = raw.endsWith(".png") ? raw.slice(0, -4) : raw;
  return parseIntStrict(normalized);
}

function validateTileCoordinate(z: number, x: number, y: number): boolean {
  if (z < 0 || z > 20) return false;
  const max = 2 ** z;
  return y >= 0 && y < max && Number.isFinite(x);
}

function normalizeTileX(x: number, z: number): number {
  const max = 2 ** z;
  return ((x % max) + max) % max;
}

function buildUpstreamUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

function resolveTileTheme(request: Request): TileTheme {
  const url = new URL(request.url);
  return url.searchParams.get("theme") === "dark" ? "dark" : "light";
}

function resolveTileUpstreams(theme: TileTheme): readonly string[] {
  if (theme === "dark") {
    return [...DARK_TILE_UPSTREAMS, ...LIGHT_TILE_UPSTREAMS];
  }
  return LIGHT_TILE_UPSTREAMS;
}

export async function GET(
  request: Request,
  context: {
    params: Promise<{ z: string; x: string; y: string }>;
  },
): Promise<Response> {
  const { z: rawZ, x: rawX, y: rawY } = await context.params;
  const z = parseIntStrict(rawZ);
  const x = parseIntStrict(rawX);
  const y = resolveY(rawY);

  if (
    z === null ||
    x === null ||
    y === null ||
    !validateTileCoordinate(z, x, y)
  ) {
    return new Response("Invalid tile coordinate", { status: 400 });
  }

  const normalizedX = normalizeTileX(x, z);
  const theme = resolveTileTheme(request);
  const upstreams = resolveTileUpstreams(theme);

  let lastStatus = 502;

  for (const template of upstreams) {
    const upstreamUrl = buildUpstreamUrl(template, z, normalizedX, y);
    try {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: {
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        // Deck.gl already caches tiles on client side; this enables edge cache.
        cf: {
          cacheEverything: true,
          cacheTtl: 60 * 60 * 24 * 30,
        },
      });

      if (!upstreamRes.ok) {
        lastStatus = upstreamRes.status;
        continue;
      }

      const body = await upstreamRes.arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: {
          "content-type":
            upstreamRes.headers.get("content-type") || "image/png",
          "cache-control":
            "public, max-age=2592000, s-maxage=2592000, stale-while-revalidate=2592000",
          "access-control-allow-origin": "*",
          vary: "Accept",
          "x-map-theme": theme,
        },
      });
    } catch {
      lastStatus = 502;
    }
  }

  return new Response("Tile upstream unavailable", { status: lastStatus });
}
