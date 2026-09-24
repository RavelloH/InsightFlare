import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleReleasesCompareRequest } from "@/lib/edge/admin/system/releases-compare";
import { requireSession } from "@/lib/edge/auth/session-auth";
import { fetchGithubCompare } from "@/lib/github-releases";

vi.mock("@/lib/github-releases", () => ({
  fetchGithubCompare: vi.fn(),
}));

vi.mock("@/lib/edge/auth/session-auth", () => ({
  requireSession: vi.fn(),
}));

const fetchGithubCompareMock = vi.mocked(fetchGithubCompare);
const requireSessionMock = vi.mocked(requireSession);

function mockRuntime(pathname: string, params?: Record<string, string>) {
  const url = new URL(`https://app.test${pathname}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const request = new Request(url.toString());
  return request;
}

describe("GET /api/private/releases/compare", () => {
  beforeEach(() => {
    fetchGithubCompareMock.mockReset();
    requireSessionMock.mockReset();
  });

  it("returns 401 when session is not authenticated", async () => {
    requireSessionMock.mockResolvedValueOnce(null);
    const request = mockRuntime("/api/private/releases/compare", {
      head: "v2.0.0",
    });

    const response = await handleReleasesCompareRequest(request, {} as any);
    expect(response.status).toBe(401);
  });

  it("returns 400 when head ref is missing", async () => {
    requireSessionMock.mockResolvedValueOnce({ userId: "u1" } as any);
    const request = mockRuntime("/api/private/releases/compare");

    const response = await handleReleasesCompareRequest(request, {} as any);
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe("invalid_head_ref");
  });

  it("returns 400 when head ref contains invalid characters", async () => {
    requireSessionMock.mockResolvedValueOnce({ userId: "u1" } as any);
    const request = mockRuntime("/api/private/releases/compare", {
      head: "v1.0.0<script>",
    });

    const response = await handleReleasesCompareRequest(request, {} as any);
    expect(response.status).toBe(400);
  });

  it("returns initial status when base ref is missing", async () => {
    requireSessionMock.mockResolvedValueOnce({ userId: "u1" } as any);
    const request = mockRuntime("/api/private/releases/compare", {
      head: "v2.0.0",
    });

    const response = await handleReleasesCompareRequest(request, {} as any);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("initial");
    expect(body.data.totalCommits).toBe(0);
    expect(fetchGithubCompareMock).not.toHaveBeenCalled();
  });

  it("returns initial status when base ref contains invalid characters", async () => {
    requireSessionMock.mockResolvedValueOnce({ userId: "u1" } as any);
    const request = mockRuntime("/api/private/releases/compare", {
      head: "v2.0.0",
      base: "bad ref!",
    });

    const response = await handleReleasesCompareRequest(request, {} as any);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.data.status).toBe("initial");
    expect(fetchGithubCompareMock).not.toHaveBeenCalled();
  });

  it("returns comparison data for valid refs", async () => {
    requireSessionMock.mockResolvedValueOnce({ userId: "u1" } as any);
    fetchGithubCompareMock.mockResolvedValueOnce({
      htmlUrl: "https://github.com/RavelloH/InsightFlare/compare/v1...v2",
      status: "ahead",
      totalCommits: 5,
      commits: [
        {
          sha: "abc123",
          shortSha: "abc123",
          htmlUrl: "",
          message: "Fix",
          title: "Fix",
          authorName: "user",
          authorLogin: "user",
          authorUrl: null,
          authoredAt: null,
        },
      ],
    });
    const request = mockRuntime("/api/private/releases/compare", {
      head: "v2.0.0",
      base: "v1.0.0",
    });

    const response = await handleReleasesCompareRequest(request, {} as any);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ahead");
    expect(body.data.totalCommits).toBe(5);
    expect(fetchGithubCompareMock).toHaveBeenCalledWith(
      "RavelloH",
      "InsightFlare",
      "v1.0.0",
      "v2.0.0",
    );
  });

  it("returns 502 when fetchGithubCompare throws", async () => {
    requireSessionMock.mockResolvedValueOnce({ userId: "u1" } as any);
    fetchGithubCompareMock.mockRejectedValueOnce(
      new Error("GitHub Compare API failed: HTTP 500"),
    );
    const request = mockRuntime("/api/private/releases/compare", {
      head: "v2.0.0",
      base: "v1.0.0",
    });

    const response = await handleReleasesCompareRequest(request, {} as any);
    expect(response.status).toBe(502);
    const body = (await response.json()) as any;
    expect(body.error.code).toBe("compare_failed");
  });

  it("returns 502 with generic message for non-Error throws", async () => {
    requireSessionMock.mockResolvedValueOnce({ userId: "u1" } as any);
    fetchGithubCompareMock.mockRejectedValueOnce("string error");
    const request = mockRuntime("/api/private/releases/compare", {
      head: "v2.0.0",
      base: "v1.0.0",
    });

    const response = await handleReleasesCompareRequest(request, {} as any);
    expect(response.status).toBe(502);
  });

  it("trims whitespace from ref parameters", async () => {
    requireSessionMock.mockResolvedValueOnce({ userId: "u1" } as any);
    fetchGithubCompareMock.mockResolvedValueOnce({
      htmlUrl: "",
      status: "identical",
      totalCommits: 0,
      commits: [],
    });
    const request = mockRuntime("/api/private/releases/compare", {
      head: "  v2.0.0  ",
      base: "  v1.0.0  ",
    });

    await handleReleasesCompareRequest(request, {} as any);
    expect(fetchGithubCompareMock).toHaveBeenCalledWith(
      "RavelloH",
      "InsightFlare",
      "v1.0.0",
      "v2.0.0",
    );
  });
});
