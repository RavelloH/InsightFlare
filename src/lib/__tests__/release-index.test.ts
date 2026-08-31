import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchReleaseChangelog,
  fetchReleaseIndex,
  type ReleaseIndexEntry,
} from "@/lib/release-index";

const release: ReleaseIndexEntry = {
  tagName: "v1.2.3",
  name: "Release v1.2.3",
  htmlUrl: "https://github.com/RavelloH/InsightFlare/releases/tag/v1.2.3",
  changelogPath: "changelog/v1.2.3.md",
  publishedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  targetCommitish: "main",
  authorLogin: "RavelloH",
  draft: false,
  prerelease: false,
};

describe("release-index", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchReleaseIndex", () => {
    it("requests and validates the release index", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify([release]), { status: 200 }),
      );

      await expect(fetchReleaseIndex()).resolves.toEqual([release]);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://raw.githubusercontent.com/RavelloH/InsightFlare/main/.github/releases/version.json",
      );
    });

    it("rejects malformed index payloads", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify([{ ...release, draft: "false" }]), {
          status: 200,
        }),
      );

      await expect(fetchReleaseIndex()).rejects.toThrow(
        "Release index returned an unexpected payload",
      );
    });

    it("throws when the index request fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Not Found", { status: 404 }),
      );

      await expect(fetchReleaseIndex()).rejects.toThrow(
        "Release index request failed: HTTP 404",
      );
    });
  });

  describe("fetchReleaseChangelog", () => {
    it("requests English and localized changelog paths", async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response("English", { status: 200 }))
        .mockResolvedValueOnce(new Response("中文", { status: 200 }));

      await expect(fetchReleaseChangelog(release, "en")).resolves.toBe(
        "English",
      );
      await expect(fetchReleaseChangelog(release, "zh")).resolves.toBe("中文");

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "https://raw.githubusercontent.com/RavelloH/InsightFlare/main/changelog/v1.2.3.md",
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "https://raw.githubusercontent.com/RavelloH/InsightFlare/main/.github/releases/i18n/zh/v1.2.3.md",
      );
    });

    it("falls back to English when a non-English changelog is missing", async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
        .mockResolvedValueOnce(new Response("English", { status: 200 }));

      await expect(fetchReleaseChangelog(release, "ja")).resolves.toBe(
        "English",
      );
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "https://raw.githubusercontent.com/RavelloH/InsightFlare/main/changelog/v1.2.3.md",
      );
    });

    it("does not fall back for non-404 localized errors", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Server Error", { status: 500 }),
      );

      await expect(fetchReleaseChangelog(release, "zh")).rejects.toThrow(
        "Release changelog request failed: HTTP 500",
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
