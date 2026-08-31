import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildReleaseIndex,
  parseGitLogMetadata,
  parseReleaseVersion,
  readGitMetadata,
  scanChangelogFiles,
  serializeReleaseIndex,
  sortChangelogPaths,
  writeAtomically,
} from "../generate-release-index";

describe("generate-release-index", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const temporaryRoot of temporaryRoots.splice(0)) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("scans only direct version changelog files and sorts semantic versions descending", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "release-index-"));
    temporaryRoots.push(repositoryRoot);
    mkdirSync(join(repositoryRoot, "changelog", "nested"), { recursive: true });
    for (const path of [
      "v1.2.3.md",
      "v1.10.0.md",
      "v2.0.0.md",
      "notes.md",
      "v3.0.0.txt",
    ]) {
      writeFileSync(join(repositoryRoot, "changelog", path), "# changelog\n");
    }
    writeFileSync(
      join(repositoryRoot, "changelog", "nested", "v9.9.9.md"),
      "# nested\n",
    );

    expect(scanChangelogFiles(repositoryRoot)).toEqual([
      "changelog/v2.0.0.md",
      "changelog/v1.10.0.md",
      "changelog/v1.2.3.md",
    ]);
    expect(
      sortChangelogPaths(["changelog/v1.2.3.md", "changelog/v1.10.0.md"]),
    ).toEqual(["changelog/v1.10.0.md", "changelog/v1.2.3.md"]);
    expect(parseReleaseVersion("changelog/v1.10.0.md")).toMatchObject({
      tagName: "v1.10.0",
      major: 1,
      minor: 10,
      patch: 0,
    });
    expect(parseReleaseVersion("changelog/not-a-version.md")).toBeNull();
  });

  it("builds stable release entries without changelog body content", () => {
    const metadata = {
      commit: "commit-v2",
      authorDate: "2026-08-01T01:02:03Z",
      commitDate: "2026-08-01T04:05:06Z",
      authorName: "Alice",
      authorEmail: "123+alice@users.noreply.github.com",
      authorLogin: "alice",
    };

    const entries = buildReleaseIndex(
      ["changelog/v1.2.3.md", "changelog/v2.0.0.md"],
      (changelogPath) => ({ ...metadata, commit: changelogPath }),
      "https://github.com/example/project/",
    );

    expect(entries).toEqual([
      {
        tagName: "v2.0.0",
        name: "Release v2.0.0",
        htmlUrl: "https://github.com/example/project/releases/tag/v2.0.0",
        changelogPath: "changelog/v2.0.0.md",
        publishedAt: "2026-08-01T04:05:06Z",
        createdAt: "2026-08-01T04:05:06Z",
        updatedAt: "2026-08-01T04:05:06Z",
        targetCommitish: "changelog/v2.0.0.md",
        authorLogin: "alice",
        draft: false,
        prerelease: false,
      },
      {
        tagName: "v1.2.3",
        name: "Release v1.2.3",
        htmlUrl: "https://github.com/example/project/releases/tag/v1.2.3",
        changelogPath: "changelog/v1.2.3.md",
        publishedAt: "2026-08-01T04:05:06Z",
        createdAt: "2026-08-01T04:05:06Z",
        updatedAt: "2026-08-01T04:05:06Z",
        targetCommitish: "changelog/v1.2.3.md",
        authorLogin: "alice",
        draft: false,
        prerelease: false,
      },
    ]);
    expect(entries[0]).not.toHaveProperty("body");
  });

  it("parses Git metadata and resolves GitHub noreply author logins", () => {
    const metadata = parseGitLogMetadata(
      "abc123\u00002026-08-01T01:02:03+00:00\u00002026-08-01T04:05:06+00:00\u0000Alice\u0000123+alice@users.noreply.github.com\n",
      "changelog/v1.2.3.md",
    );
    expect(metadata).toMatchObject({
      commit: "abc123",
      authorDate: "2026-08-01T01:02:03+00:00",
      commitDate: "2026-08-01T04:05:06+00:00",
      authorLogin: "alice",
    });

    const nonGithubMetadata = parseGitLogMetadata(
      "abc123\u00002026-08-01T01:02:03+00:00\u00002026-08-01T04:05:06+00:00\u0000Alice\u0000alice@example.com",
      "changelog/v1.2.3.md",
    );
    expect(nonGithubMetadata.authorLogin).toBeNull();
    expect(() =>
      parseGitLogMetadata("abc123\u0000missing", "changelog/v1.2.3.md"),
    ).toThrow("Git metadata for changelog/v1.2.3.md is incomplete");
  });

  it("uses the requested repository-relative path for git metadata and fails clearly when unavailable", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "release-index-"));
    temporaryRoots.push(repositoryRoot);
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const metadata = readGitMetadata(
      repositoryRoot,
      "changelog/v1.2.3.md",
      (args, cwd) => {
        calls.push({ args, cwd });
        return "abc123\u00002026-08-01T01:02:03Z\u00002026-08-01T04:05:06Z\u0000Alice\u0000alice@example.com";
      },
    );
    expect(metadata.commit).toBe("abc123");
    expect(calls[0]).toMatchObject({ cwd: repositoryRoot });
    expect(calls[0]?.args.at(-1)).toBe("changelog/v1.2.3.md");

    expect(() =>
      readGitMetadata(repositoryRoot, "changelog/v1.2.3.md", () => {
        throw new Error("not a git checkout");
      }),
    ).toThrow(
      "Unable to read Git metadata for changelog/v1.2.3.md. Run this generator from a complete Git checkout",
    );
  });

  it("serializes formatted JSON and writes it through a temporary sibling file", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "release-index-"));
    temporaryRoots.push(repositoryRoot);
    const outputPath = join(
      repositoryRoot,
      ".github",
      "releases",
      "version.json",
    );
    const entries = [
      {
        tagName: "v1.0.0",
        name: "Release v1.0.0",
        htmlUrl: "https://github.com/example/project/releases/tag/v1.0.0",
        changelogPath: "changelog/v1.0.0.md",
        publishedAt: "2026-08-01T04:05:06Z",
        createdAt: "2026-08-01T04:05:06Z",
        updatedAt: "2026-08-01T04:05:06Z",
        targetCommitish: "abc123",
        authorLogin: null,
        draft: false as const,
        prerelease: false as const,
      },
    ];
    writeAtomically(outputPath, serializeReleaseIndex(entries));

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(entries);
    expect(readFileSync(outputPath, "utf8")).toBe(
      `${JSON.stringify(entries, null, 2)}\n`,
    );
  });
});
