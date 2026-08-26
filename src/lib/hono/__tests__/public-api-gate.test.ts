// @vitest-environment node

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  checkFetchMetadata,
  checkOriginOrReferer,
  getTargetOrigin,
  isBadSimpleUA,
  isBotByIsbot,
  publicApiGate,
} from "@/lib/hono/middleware/public-api-gate";
import type { AppEnv } from "@/lib/hono/types";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://example.com${path}`, init);
}

function createApp(options?: Parameters<typeof publicApiGate>[0]) {
  const app = new Hono<AppEnv>();
  app.use("/api/public/*", publicApiGate(options));
  app.all("/api/public/*", () => new Response("ok"));
  return app;
}

function browserHeaders(extra?: HeadersInit): Headers {
  return new Headers({
    "user-agent": CHROME_UA,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...extra,
  });
}

describe("publicApiGate", () => {
  it("reads provenance headers in the test runtime", () => {
    const req = request("/api/public/share/demo/overview", {
      headers: browserHeaders(),
    });

    expect(getTargetOrigin(req)).toBe("https://example.com");
    expect(isBadSimpleUA(req)).toBe(false);
    expect(checkFetchMetadata(req)).toBe("pass");
    expect(checkOriginOrReferer(req)).toBe(false);
  });

  it("covers malformed provenance and simple UA branches", () => {
    const malformedUrl = { url: "::", headers: new Headers() } as Request;
    const malformedReferer = request("/api/public/share/demo/overview", {
      headers: {
        "user-agent": CHROME_UA,
        referer: "::",
      },
    });
    const sameOrigin = request("/api/public/share/demo/overview", {
      headers: {
        "user-agent": CHROME_UA,
        origin: "https://example.com",
      },
    });
    const crossOrigin = request("/api/public/share/demo/overview", {
      headers: {
        "user-agent": CHROME_UA,
        origin: "https://evil.example",
      },
    });
    const longUa = request("/api/public/share/demo/overview", {
      headers: { "user-agent": "a".repeat(513) },
    });
    const emptyUa = request("/api/public/share/demo/overview");

    expect(getTargetOrigin(malformedUrl)).toBeNull();
    expect(checkOriginOrReferer(malformedUrl)).toBe(false);
    expect(checkOriginOrReferer(malformedReferer)).toBe(false);
    expect(checkOriginOrReferer(sameOrigin)).toBe(true);
    expect(checkOriginOrReferer(crossOrigin)).toBe(false);
    expect(isBadSimpleUA(longUa)).toBe(true);
    expect(isBadSimpleUA(emptyUa)).toBe(true);
  });

  it("covers fetch metadata optional mode and destination branches", () => {
    const noModeOrDest = request("/api/public/share/demo/overview", {
      headers: {
        "user-agent": CHROME_UA,
        "sec-fetch-site": "same-origin",
      },
    });
    const badDest = request("/api/public/share/demo/overview", {
      headers: browserHeaders({ "sec-fetch-dest": "document" }),
    });
    const badMode = request("/api/public/share/demo/overview", {
      headers: browserHeaders({ "sec-fetch-mode": "navigate" }),
    });
    const imageWithoutResourceAllowance = request(
      "/api/public/resources/world-countries",
      {
        headers: browserHeaders({
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": "image",
        }),
      },
    );

    expect(checkFetchMetadata(noModeOrDest)).toBe("pass");
    expect(checkFetchMetadata(badDest)).toBe("fail");
    expect(checkFetchMetadata(badMode)).toBe("fail");
    expect(checkFetchMetadata(imageWithoutResourceAllowance)).toBe("fail");
  });

  it("covers isbot helper boundary branches", () => {
    expect(isBotByIsbot(request("/api/public/share/demo/overview"))).toBe(true);
    expect(
      isBotByIsbot(
        request("/api/public/share/demo/overview", {
          headers: { "user-agent": "a".repeat(513) },
        }),
      ),
    ).toBe(true);
    expect(
      isBotByIsbot(
        request("/api/public/share/demo/overview", {
          headers: { "user-agent": CHROME_UA },
        }),
      ),
    ).toBe(false);
  });

  it("allows configured public methods", async () => {
    const app = createApp({ methods: ["GET", "HEAD"] });

    const response = await app.fetch(
      request("/api/public/share/demo/overview", {
        method: "HEAD",
        headers: browserHeaders(),
      }),
    );

    expect(response.status).toBe(200);
  });

  it("allows modern same-origin browser fetch requests", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/public/share/demo/overview", {
        headers: browserHeaders(),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("rejects cross-site and same-site fetch metadata", async () => {
    const app = createApp();

    const crossSite = await app.fetch(
      request("/api/public/share/demo/overview", {
        headers: browserHeaders({ "sec-fetch-site": "cross-site" }),
      }),
    );
    const sameSite = await app.fetch(
      request("/api/public/share/demo/overview", {
        headers: browserHeaders({ "sec-fetch-site": "same-site" }),
      }),
    );

    expect(crossSite.status).toBe(403);
    expect(sameSite.status).toBe(403);
  });

  it("falls back to same-origin referer when fetch metadata is missing", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/public/share/demo/overview", {
        headers: {
          "user-agent": CHROME_UA,
          referer: "https://example.com/share/demo",
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("rejects missing fetch metadata with cross-origin or absent provenance", async () => {
    const app = createApp();

    const crossReferer = await app.fetch(
      request("/api/public/share/demo/overview", {
        headers: {
          "user-agent": CHROME_UA,
          referer: "https://evil.example/share/demo",
        },
      }),
    );
    const missing = await app.fetch(
      request("/api/public/share/demo/overview", {
        headers: { "user-agent": CHROME_UA },
      }),
    );

    expect(crossReferer.status).toBe(403);
    expect(missing.status).toBe(403);
  });

  it("rejects obvious non-browser and bot user agents", async () => {
    const app = createApp();

    const curl = await app.fetch(
      request("/api/public/share/demo/overview", {
        headers: {
          "user-agent": "curl/8.0",
          referer: "https://example.com/share/demo",
        },
      }),
    );
    const bot = await app.fetch(
      request("/api/public/share/demo/overview", {
        headers: {
          "user-agent": "Googlebot/2.1",
          referer: "https://example.com/share/demo",
        },
      }),
    );

    expect(curl.status).toBe(403);
    expect(bot.status).toBe(403);
  });

  it("handles OPTIONS only for same-origin preflight", async () => {
    const app = createApp();

    const denied = await app.fetch(
      request("/api/public/share/demo/overview", {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.example",
          "access-control-request-method": "GET",
        },
      }),
    );
    const allowed = await app.fetch(
      request("/api/public/share/demo/overview", {
        method: "OPTIONS",
        headers: {
          origin: "https://example.com",
          "access-control-request-method": "GET",
        },
      }),
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
  });

  it("rejects public mutations before handlers run", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/public/share/demo/overview", {
        method: "POST",
        headers: browserHeaders(),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("allows browser image requests when configured for public resources", async () => {
    const app = createApp({ allowImageDest: true });

    const response = await app.fetch(
      request("/api/public/resources/world-countries", {
        headers: browserHeaders({
          "sec-fetch-mode": "no-cors",
          "sec-fetch-dest": "image",
        }),
      }),
    );

    expect(response.status).toBe(200);
  });
});
