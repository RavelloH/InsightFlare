import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability-logger";
import { fetchGithubCompare, fetchGithubReleases } from "@/lib/github-releases";

describe("github-releases", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchGithubReleases", () => {
    it("records the direct request in an active Worker invocation", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("[]", { status: 200 }));
      const logger = createInvocationLogger({
        source: "worker",
        trigger: "request",
      });

      await runWithInvocationLogger(logger, () =>
        fetchGithubReleases("owner", "repo"),
      );

      expect(logger.build()).toMatchObject({
        performance: {
          externalFetches: 1,
          operations: {
            "external_fetch.github_releases": { count: 1, failed: 0 },
          },
        },
      });
    });

    it("returns normalized releases sorted by timestamp descending", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 1,
              tag_name: "v1.0.0",
              name: "First Release",
              html_url: "https://github.com/test/1",
              body: "body 1",
              draft: false,
              prerelease: false,
              published_at: "2026-01-01T00:00:00Z",
              created_at: "2025-12-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              target_commitish: "main",
              author: { login: "user1" },
            },
            {
              id: 2,
              tag_name: "v2.0.0",
              name: null,
              html_url: "https://github.com/test/2",
              body: null,
              draft: true,
              prerelease: true,
              published_at: "2026-06-01T00:00:00Z",
              created_at: "2026-05-01T00:00:00Z",
              updated_at: "2026-06-01T00:00:00Z",
              target_commitish: "develop",
              author: null,
            },
          ]),
          { status: 200 },
        ),
      );

      const releases = await fetchGithubReleases("owner", "repo");

      expect(releases).toHaveLength(2);
      expect(releases[0].tagName).toBe("v2.0.0");
      expect(releases[1].tagName).toBe("v1.0.0");
      expect(releases[0].name).toBe("v2.0.0");
      expect(releases[0].authorLogin).toBeNull();
      expect(releases[1].authorLogin).toBe("user1");
    });

    it("throws on non-OK HTTP response", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Not Found", { status: 404 }),
      );

      await expect(fetchGithubReleases("owner", "repo")).rejects.toThrow(
        "GitHub Releases API failed: HTTP 404",
      );
    });

    it("throws when payload is not an array", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 200,
        }),
      );

      await expect(fetchGithubReleases("owner", "repo")).rejects.toThrow(
        "unexpected payload",
      );
    });

    it("falls back to tag_name when name is empty", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 1,
              tag_name: "v3.0.0",
              name: "  ",
              html_url: "https://github.com/test/1",
              body: null,
              draft: false,
              prerelease: false,
              published_at: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              target_commitish: "main",
              author: null,
            },
          ]),
          { status: 200 },
        ),
      );

      const releases = await fetchGithubReleases("owner", "repo");
      expect(releases[0].name).toBe("v3.0.0");
    });

    it("sorts by createdAt when publishedAt is null", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 1,
              tag_name: "v1.0.0",
              name: "A",
              html_url: "",
              body: null,
              draft: false,
              prerelease: false,
              published_at: null,
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "",
              target_commitish: "main",
              author: null,
            },
            {
              id: 2,
              tag_name: "v2.0.0",
              name: "B",
              html_url: "",
              body: null,
              draft: false,
              prerelease: false,
              published_at: "2026-01-01T00:00:00Z",
              created_at: "2025-12-01T00:00:00Z",
              updated_at: "",
              target_commitish: "main",
              author: null,
            },
          ]),
          { status: 200 },
        ),
      );

      const releases = await fetchGithubReleases("owner", "repo");
      expect(releases[0].tagName).toBe("v1.0.0");
      expect(releases[1].tagName).toBe("v2.0.0");
    });
  });

  describe("fetchGithubCompare", () => {
    it("returns normalized comparison result", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            html_url: "https://github.com/test/compare/v1...v2",
            status: "ahead",
            total_commits: 3,
            commits: [
              {
                sha: "abc123def456789012345678901234567890abcd",
                html_url: "https://github.com/test/commit/abc123",
                commit: {
                  message: "Fix bug\n\nDetailed description",
                  author: {
                    name: "Author Name",
                    date: "2026-06-01T12:00:00Z",
                  },
                },
                author: {
                  login: "user1",
                  html_url: "https://github.com/user1",
                },
              },
              {
                sha: "def789abc0123456789012345678901234567890",
                html_url: "https://github.com/test/commit/def789",
                commit: {
                  message: "Add feature",
                  author: {
                    name: "Other Author",
                    date: "2026-06-02T12:00:00Z",
                  },
                },
                author: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const logger = createInvocationLogger({
        source: "worker",
        trigger: "request",
      });
      const result = await runWithInvocationLogger(logger, () =>
        fetchGithubCompare("owner", "repo", "v1", "v2"),
      );

      expect(result.htmlUrl).toBe("https://github.com/test/compare/v1...v2");
      expect(result.status).toBe("ahead");
      expect(result.totalCommits).toBe(3);
      expect(result.commits).toHaveLength(2);

      expect(result.commits[0].title).toBe("Fix bug");
      expect(result.commits[0].authorLogin).toBe("user1");
      expect(result.commits[0].authorUrl).toBe("https://github.com/user1");
      expect(result.commits[0].authoredAt).toBe("2026-06-01T12:00:00Z");

      expect(result.commits[1].title).toBe("Add feature");
      expect(result.commits[1].authorName).toBe("Other Author");
      expect(result.commits[1].authorLogin).toBeNull();
      expect(result.commits[1].authorUrl).toBeNull();
      expect(logger.build().performance).toMatchObject({
        externalFetches: 1,
        operations: {
          "external_fetch.github_compare": { count: 1, failed: 0 },
        },
      });
    });

    it("throws on non-OK HTTP response", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Server Error", { status: 500 }),
      );

      await expect(
        fetchGithubCompare("owner", "repo", "v1", "v2"),
      ).rejects.toThrow("GitHub Compare API failed: HTTP 500");
    });

    it("throws when commits is not an array", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ html_url: "", status: "", total_commits: 0 }),
          { status: 200 },
        ),
      );

      await expect(
        fetchGithubCompare("owner", "repo", "v1", "v2"),
      ).rejects.toThrow("unexpected payload");
    });

    it("uses commit.author.name when author.login is absent", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            html_url: "",
            status: "identical",
            total_commits: 0,
            commits: [
              {
                sha: "aaa",
                html_url: "",
                commit: {
                  message: "msg",
                  author: { name: "Fallback Name", date: null },
                },
                author: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await fetchGithubCompare("o", "r", "a", "b");
      expect(result.commits[0].authorName).toBe("Fallback Name");
    });

    it("uses sha as title when message is empty", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            html_url: "",
            status: "identical",
            total_commits: 0,
            commits: [
              {
                sha: "abc123",
                html_url: "",
                commit: {
                  message: "  ",
                  author: { name: "A", date: null },
                },
                author: null,
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await fetchGithubCompare("o", "r", "a", "b");
      expect(result.commits[0].title).toBe("abc123");
    });
  });
});
