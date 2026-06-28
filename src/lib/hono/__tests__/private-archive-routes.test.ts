import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handlePrivateArchiveFile,
  handlePrivateArchiveManifest,
} from "@/lib/edge/archive-query";
import { privateArchiveRoutes } from "@/lib/hono/routes/private/archive";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/archive-query", () => ({
  handlePrivateArchiveFile: vi.fn(),
  handlePrivateArchiveManifest: vi.fn(),
}));

const env = { DB: {}, ARCHIVE_BUCKET: {} };
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/private/archive", privateArchiveRoutes);
  return app;
}

describe("Hono private archive routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handlePrivateArchiveManifest).mockResolvedValue(
      new Response("manifest"),
    );
    vi.mocked(handlePrivateArchiveFile).mockResolvedValue(new Response("file"));
  });

  it("routes archive manifest directly to its handler", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/archive/manifest?siteId=site-1"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("manifest");
    expect(handlePrivateArchiveManifest).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/private/archive/manifest?siteId=site-1"),
    );
  });

  it("routes archive file GET and HEAD directly to its handler", async () => {
    const app = createApp();

    const getResponse = await app.fetch(
      request("/api/private/archive/file?key=a"),
      env as never,
      ctx,
    );
    const headResponse = await app.fetch(
      request("/api/private/archive/file?key=a", { method: "HEAD" }),
      env as never,
      ctx,
    );

    expect(getResponse.status).toBe(200);
    expect(headResponse.status).toBe(200);
    expect(handlePrivateArchiveFile).toHaveBeenCalledTimes(2);
  });

  it("returns not found for unknown archive paths", async () => {
    const app = createApp();

    const response = await app.fetch(
      request("/api/private/archive/unknown"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(handlePrivateArchiveManifest).not.toHaveBeenCalled();
    expect(handlePrivateArchiveFile).not.toHaveBeenCalled();
  });
});
