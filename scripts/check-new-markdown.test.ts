// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checker = fileURLToPath(
  new URL("./check-new-markdown.mjs", import.meta.url),
);
let repository: string;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Markdown hook test",
      "-c",
      "user.email=markdown-hook@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      `core.hooksPath=${path.join(repository, ".empty-hooks")}`,
      ...args,
    ],
    { cwd: repository, encoding: "utf8", windowsHide: true },
  );
}

function stage(file: string, contents = "Document\n"): void {
  const absolute = path.join(repository, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  git("add", "--", file);
}

function check(cwd = repository) {
  return spawnSync(process.execPath, [checker], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

beforeEach(() => {
  repository = mkdtempSync(
    path.join(os.tmpdir(), "insightflare-markdown-hook-"),
  );
  git("init", "--quiet");
});

afterEach(() => {
  rmSync(repository, { recursive: true, force: true });
});

describe("new Markdown commit policy", () => {
  it.each([
    "new-document.md",
    "docs/new-document.MD",
    "docs/new-document.markdown",
    "docs/new-document.mdx",
    "docs/.github/new-document.md",
    "docs/changelog/new-document.md",
    "changelog-other/new-document.md",
    ".github-other/new-document.md",
    "docs/新增 document.md",
  ])(
    "rejects a staged addition outside the allowed directories: %s",
    (file) => {
      stage(file);
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(JSON.stringify(file));
      expect(result.stderr).toContain("changelog/ and .github/");
    },
  );

  it("allows additions anywhere under the two root directories", () => {
    stage("changelog/v1.md");
    stage("changelog/i18n/zh/release.MD");
    stage(".github/ISSUE_TEMPLATE/request.markdown");
    stage(".github/readme/guide.mdx");
    expect(check().status).toBe(0);
  });

  it("allows editing or deleting existing Markdown and adding other files", () => {
    stage("README.md");
    stage("docs/existing.md");
    git("commit", "--quiet", "-m", "fixture");
    stage("README.md", "Updated document\n");
    git("rm", "--quiet", "docs/existing.md");
    stage("src/example.ts", "export const example = true;\n");
    expect(check().status).toBe(0);
  });

  it("checks only staged files, including on an initial commit", () => {
    writeFileSync(path.join(repository, "untracked.md"), "Untracked\n");
    stage("src/example.ts");
    expect(check().status).toBe(0);
  });

  it("rejects renaming a permitted document into a prohibited directory", () => {
    stage(".github/guide.md");
    git("commit", "--quiet", "-m", "fixture");
    mkdirSync(path.join(repository, "docs"));
    git("mv", ".github/guide.md", "docs/guide.md");
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/guide.md");
  });

  it("uses repository-root paths even with relative diff configured", () => {
    stage("docs/blocked.md");
    git("config", "diff.relative", "true");
    const result = check(path.join(repository, "docs"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/blocked.md");
  });

  it("fails closed when Git cannot inspect staged files", () => {
    git("config", "core.repositoryformatversion", "999");
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unable to inspect staged files");
  });
});
