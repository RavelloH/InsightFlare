import {
  getInvocationLogger,
  measureExternalFetch,
} from "@/lib/edge/observability-bindings";
import type { InvocationLogger } from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";
import { requireSameOrigin } from "@/lib/edge/utils";

const COUNTRIES_GEOJSON_UPSTREAMS = [
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson",
  "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson",
] as const;

function isFeatureCollection(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as { type?: unknown; features?: unknown };
  return (
    candidate.type === "FeatureCollection" && Array.isArray(candidate.features)
  );
}

async function proxyCountriesGeoJson(
  logger?: InvocationLogger,
): Promise<Response> {
  let lastStatus = 502;

  for (const upstreamUrl of COUNTRIES_GEOJSON_UPSTREAMS) {
    try {
      const upstreamResponse = await measureExternalFetch(
        logger,
        "external_fetch.world_countries",
        () =>
          fetch(upstreamUrl, {
            headers: {
              accept: "application/geo+json,application/json;q=0.9,*/*;q=0.8",
            },
          }),
      );
      if (!upstreamResponse.ok) {
        lastStatus = upstreamResponse.status;
        continue;
      }

      const payload = await upstreamResponse.json();
      if (!isFeatureCollection(payload)) {
        lastStatus = 502;
        continue;
      }

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "content-type": "application/geo+json; charset=utf-8",
          "cache-control":
            "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800",
        },
      });
    } catch {
      lastStatus = 502;
    }
  }

  return new Response("Countries GeoJSON upstream unavailable", {
    status: lastStatus,
  });
}

export async function handleWorldCountriesRequest(
  request: Request,
  env?: Env,
): Promise<Response> {
  const sameOriginError = requireSameOrigin(request);
  if (sameOriginError) return sameOriginError;

  return proxyCountriesGeoJson(env ? getInvocationLogger(env) : undefined);
}
