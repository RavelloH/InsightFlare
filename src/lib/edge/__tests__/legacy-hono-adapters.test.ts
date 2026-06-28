import { beforeEach, describe, expect, it, vi } from "vitest";

import { handlePrivateAdmin } from "@/lib/edge/admin";
import { handleAuthLoginAdmin } from "@/lib/edge/admin-users";
import {
  handlePrivateArchiveFile,
  handlePrivateArchiveManifest,
} from "@/lib/edge/archive-query";
import {
  handleLegacyAdminMember,
  handleLegacyAdminProfile,
  handleLegacyAdminSite,
  handleLegacyAdminSiteConfig,
  handleLegacyAdminTeam,
  handleLegacyAdminUser,
} from "@/lib/edge/legacy-admin";
import {
  handleLegacyArchiveFile,
  handleLegacyArchiveManifest,
} from "@/lib/edge/legacy-archive";
import {
  handleLegacyAuthLogin,
  handleLegacyAuthLogout,
} from "@/lib/edge/legacy-auth";

vi.mock("@/lib/edge/admin", () => ({
  handlePrivateAdmin: vi.fn(),
}));

vi.mock("@/lib/edge/archive-query", () => ({
  handlePrivateArchiveFile: vi.fn(),
  handlePrivateArchiveManifest: vi.fn(),
}));

vi.mock("@/lib/edge/admin-users", () => ({
  handleAuthLoginAdmin: vi.fn(),
}));

const env = {
  MAIN_SECRET: "test-main-secret",
};

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
    },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("legacy Hono edge adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handlePrivateAdmin).mockImplementation(async (request) => {
      const body = await request.json().catch(() => ({}));
      return Response.json({
        ok: true,
        data: {
          method: request.method,
          pathname: new URL(request.url).pathname,
          body,
        },
      });
    });
    vi.mocked(handlePrivateArchiveManifest).mockResolvedValue(
      Response.json({
        ok: true,
        files: [{ archiveKey: "archive/site/hour.parquet" }],
      }),
    );
    vi.mocked(handlePrivateArchiveFile).mockResolvedValue(
      new Response("parquet"),
    );
    vi.mocked(handleAuthLoginAdmin).mockResolvedValue(
      Response.json({
        ok: true,
        data: {
          user: {
            id: "user-1",
            username: "admin",
            name: "Admin",
            systemRole: "admin",
          },
          teams: [],
        },
      }),
    );
  });

  it("logs in through the private auth handler and sets the legacy cookie", async () => {
    const response = await handleLegacyAuthLogin(
      jsonRequest("/api/auth/login", {
        username: "admin",
        password: "secret",
        next: "/app/team",
      }),
      env as any,
    );
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ next: "/app/team" });
    expect(response.headers.get("set-cookie")).toContain("if_session=");
    expect(handleAuthLoginAdmin).toHaveBeenCalledWith(expect.any(Request), env);
  });

  it("maps legacy auth validation, credential, and logout branches", async () => {
    const invalid = await handleLegacyAuthLogin(
      jsonRequest("/api/auth/login", { username: "a", password: "" }),
      env as any,
    );
    expect(invalid.status).toBe(400);

    vi.mocked(handleAuthLoginAdmin).mockResolvedValueOnce(
      Response.json({ ok: false }, { status: 401 }),
    );
    const denied = await handleLegacyAuthLogin(
      jsonRequest("/api/auth/login", {
        username: "admin",
        password: "wrong",
        next: "https://evil.test",
      }),
      env as any,
    );
    expect(denied.status).toBe(401);

    const logout = handleLegacyAuthLogout(
      new Request("https://app.test/api/auth/logout", { method: "POST" }),
    );
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("maps legacy auth upstream failures and malformed success payloads", async () => {
    vi.mocked(handleAuthLoginAdmin).mockResolvedValueOnce(
      new Response("service unavailable", { status: 503 }),
    );
    const unavailable = await handleLegacyAuthLogin(
      jsonRequest("/api/auth/login", {
        username: "admin",
        password: "secret",
      }),
      env as any,
    );
    expect(unavailable.status).toBe(503);

    vi.mocked(handleAuthLoginAdmin).mockResolvedValueOnce(
      new Response("not json", { status: 200 }),
    );
    const invalidJson = await handleLegacyAuthLogin(
      jsonRequest("/api/auth/login", {
        username: "admin",
        password: "secret",
      }),
      env as any,
    );
    expect(invalidJson.status).toBe(502);

    vi.mocked(handleAuthLoginAdmin).mockResolvedValueOnce(
      Response.json({ ok: true, data: {} }),
    );
    const missingUser = await handleLegacyAuthLogin(
      jsonRequest("/api/auth/login", {
        username: "admin",
        password: "secret",
      }),
      env as any,
    );
    expect(missingUser.status).toBe(502);
  });

  it("adapts legacy admin user, team, site, member, profile, and config forms", async () => {
    const calls = [
      handleLegacyAdminUser(
        jsonRequest("/api/admin/user", {
          username: "new-user",
          email: "u@example.test",
          password: "password123",
          systemRole: "admin",
        }),
        env as any,
      ),
      handleLegacyAdminTeam(
        jsonRequest("/api/admin/team", { name: "Team", slug: "team" }),
        env as any,
      ),
      handleLegacyAdminSite(
        jsonRequest("/api/admin/site", {
          teamId: "team-1",
          name: "Site",
          domain: "example.test",
          publicEnabled: "on",
        }),
        env as any,
      ),
      handleLegacyAdminMember(
        jsonRequest("/api/admin/member", {
          teamId: "team-1",
          identifier: "u@example.test",
          role: "admin",
        }),
        env as any,
      ),
      handleLegacyAdminProfile(
        jsonRequest("/api/admin/profile", {
          username: "admin",
          email: "admin@example.test",
          name: "",
          timeZone: "UTC",
        }),
        env as any,
      ),
      handleLegacyAdminSiteConfig(
        jsonRequest("/api/admin/site-config", {
          siteId: "site-1",
          maskQueryHashDetails: "false",
        }),
        env as any,
      ),
    ];

    const responses = await Promise.all(calls);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    expect(handlePrivateAdmin).toHaveBeenCalledTimes(6);
  });

  it("covers legacy admin mutation intents and validation failures", async () => {
    expect(
      (
        await handleLegacyAdminUser(
          jsonRequest("/api/admin/user", {
            intent: "update",
            userId: "user-1",
            username: "updated",
          }),
          env as any,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleLegacyAdminUser(
          jsonRequest("/api/admin/user", {
            intent: "delete",
            userId: "user-1",
          }),
          env as any,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleLegacyAdminTeam(
          jsonRequest("/api/admin/team", {
            intent: "transfer_owner",
            teamId: "team-1",
            newOwnerUserId: "user-2",
          }),
          env as any,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleLegacyAdminSite(
          jsonRequest("/api/admin/site", {
            intent: "update",
            siteId: "site-1",
            name: "Updated",
          }),
          env as any,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleLegacyAdminSite(
          jsonRequest("/api/admin/site", { intent: "remove", siteId: "" }),
          env as any,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleLegacyAdminMember(
          jsonRequest("/api/admin/member", {
            intent: "update_role",
            teamId: "team-1",
            userId: "user-1",
            role: "owner",
          }),
          env as any,
        )
      ).status,
    ).toBe(400);
  });

  it("rewrites legacy archive manifest URLs and streams file responses", async () => {
    const manifest = await handleLegacyArchiveManifest(
      new Request("https://app.test/api/archive/manifest?siteId=site-1", {
        headers: { authorization: "Bearer token" },
      }),
      env as any,
    );
    const manifestBody = await responseJson(manifest);
    expect(
      (manifestBody.files as Array<{ fetchUrl: string }>)[0].fetchUrl,
    ).toBe("/api/archive/file?key=archive%2Fsite%2Fhour.parquet");

    vi.mocked(handlePrivateArchiveFile).mockResolvedValueOnce(
      new Response("parquet", {
        status: 206,
        headers: {
          "content-type": "application/vnd.apache.parquet",
          "content-range": "bytes 0-6/7",
          "content-length": "7",
          etag: '"abc"',
        },
      }),
    );
    const file = await handleLegacyArchiveFile(
      new Request("https://app.test/api/archive/file?key=archive-key", {
        headers: { range: "bytes=0-6" },
      }),
      env as any,
    );
    expect(file.status).toBe(206);
    expect(file.headers.get("content-range")).toBe("bytes 0-6/7");
    expect(await file.text()).toBe("parquet");
  });

  it("covers legacy archive error and HEAD branches", async () => {
    const missingManifestSite = await handleLegacyArchiveManifest(
      new Request("https://app.test/api/archive/manifest"),
      env as any,
    );
    expect(missingManifestSite.status).toBe(400);

    vi.mocked(handlePrivateArchiveManifest).mockResolvedValueOnce(
      new Response("nope", { status: 403 }),
    );
    const manifestDenied = await handleLegacyArchiveManifest(
      new Request("https://app.test/api/archive/manifest?siteId=site-1"),
      env as any,
    );
    expect(manifestDenied.status).toBe(403);

    vi.mocked(handlePrivateArchiveManifest).mockResolvedValueOnce(
      new Response("not json", { status: 200 }),
    );
    const invalidManifest = await handleLegacyArchiveManifest(
      new Request("https://app.test/api/archive/manifest?siteId=site-1"),
      env as any,
    );
    expect(invalidManifest.status).toBe(502);

    const missingFileKey = await handleLegacyArchiveFile(
      new Request("https://app.test/api/archive/file"),
      env as any,
    );
    expect(missingFileKey.status).toBe(400);

    vi.mocked(handlePrivateArchiveFile).mockResolvedValueOnce(
      new Response("missing", { status: 404 }),
    );
    const fileMissing = await handleLegacyArchiveFile(
      new Request("https://app.test/api/archive/file?key=missing"),
      env as any,
    );
    expect(fileMissing.status).toBe(404);

    vi.mocked(handlePrivateArchiveFile).mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-length": "4" },
      }),
    );
    const head = await handleLegacyArchiveFile(
      new Request("https://app.test/api/archive/file?key=archive-key", {
        method: "HEAD",
      }),
      env as any,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-type")).toBe(
      "application/vnd.apache.parquet",
    );
  });
});
