import spec from "../../../../docs/skills.json";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=3600, s-maxage=3600",
  "access-control-allow-origin": "*",
};

function getBaseUrl(request: Request): string {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (!host) return new URL(request.url).origin;
  return `${proto}://${host}`;
}

export function GET(request: Request) {
  const baseUrl = getBaseUrl(request);
  const body = JSON.stringify(spec).replaceAll("${baseUrl}", baseUrl);
  return new Response(body, { status: 200, headers: HEADERS });
}

export function HEAD() {
  return new Response(null, { status: 200, headers: HEADERS });
}
