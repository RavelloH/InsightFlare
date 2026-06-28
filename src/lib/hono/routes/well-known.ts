import { Hono } from "hono";

import type { AppEnv } from "@/lib/hono/types";

import openapiSpec from "../../../../docs/openapi.json";
import skillsSpec from "../../../../docs/skills.json";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=3600, s-maxage=3600",
  "access-control-allow-origin": "*",
};

const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "public, max-age=3600, s-maxage=3600",
  "access-control-allow-origin": "*",
};

const SECURITY_TXT = `Contact: mailto:contact@insightflare.net
Expires: 2027-06-25T00:00:00.000Z
Preferred-Languages: en, zh
Acknowledgments: https://github.com/RavelloH/InsightFlare
Policy: https://github.com/RavelloH/InsightFlare/blob/main/SECURITY.md
`;

function getBaseUrl(request: Request): string {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (!host) return new URL(request.url).origin;
  return `${proto}://${host}`;
}

export const wellKnownRoutes = new Hono<AppEnv>();

wellKnownRoutes.get("/.well-known/openapi.json", (c) => {
  const baseUrl = getBaseUrl(c.req.raw);
  const dynamicSpec = {
    ...openapiSpec,
    servers: openapiSpec.servers.map(
      (server: { url: string; description: string }) => ({
        ...server,
        url: baseUrl,
      }),
    ),
  };
  return new Response(JSON.stringify(dynamicSpec), {
    status: 200,
    headers: JSON_HEADERS,
  });
});

wellKnownRoutes.on(
  "HEAD",
  "/.well-known/openapi.json",
  () => new Response(null, { status: 200, headers: JSON_HEADERS }),
);

wellKnownRoutes.get("/.well-known/skills.json", (c) => {
  const body = JSON.stringify(skillsSpec).replaceAll(
    "${baseUrl}",
    getBaseUrl(c.req.raw),
  );
  return new Response(body, { status: 200, headers: JSON_HEADERS });
});

wellKnownRoutes.on(
  "HEAD",
  "/.well-known/skills.json",
  () => new Response(null, { status: 200, headers: JSON_HEADERS }),
);

wellKnownRoutes.get(
  "/.well-known/security.txt",
  () => new Response(SECURITY_TXT, { status: 200, headers: TEXT_HEADERS }),
);

wellKnownRoutes.on(
  "HEAD",
  "/.well-known/security.txt",
  () => new Response(null, { status: 200, headers: TEXT_HEADERS }),
);

wellKnownRoutes.get("/.well-known/change-password", (c) =>
  Response.redirect(`${getBaseUrl(c.req.raw)}/app`, 302),
);

wellKnownRoutes.on(
  "HEAD",
  "/.well-known/change-password",
  () => new Response(null, { status: 200 }),
);

wellKnownRoutes.get("/.well-known/health", (c) =>
  Response.redirect(`${getBaseUrl(c.req.raw)}/healthz`, 302),
);

wellKnownRoutes.on(
  "HEAD",
  "/.well-known/health",
  () => new Response(null, { status: 200 }),
);
