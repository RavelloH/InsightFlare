// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checker = fileURLToPath(
  new URL("./check-repository-policy.mjs", import.meta.url),
);
let repository: string;

/**
 * Git exports GIT_DIR/GIT_WORK_TREE to hooks. If inherited here, the
 * temporary test commands can accidentally mutate the invoking repository
 * instead of the fixture. Always isolate the subprocess Git environment.
 */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
  );
}

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
    {
      cwd: repository,
      env: isolatedGitEnv(),
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

function stage(file: string, contents = "Document\n"): void {
  const absolute = path.join(repository, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  git("add", "--", file);
}

function check(cwd = repository, args: string[] = [], input?: string) {
  return spawnSync(process.execPath, [checker, ...args], {
    input,
    cwd,
    env: isolatedGitEnv(),
    encoding: "utf8",
    windowsHide: true,
  });
}

beforeEach(() => {
  repository = mkdtempSync(
    path.join(os.tmpdir(), "insightflare-repository-policy-"),
  );
  git("init", "--quiet");
});

afterEach(() => {
  rmSync(repository, { recursive: true, force: true });
});

describe("public repository file policy", { timeout: 20000 }, () => {
  it.each([
    "new-document.md",
    "docs/new-document.MD",
    "docs/new-document.markdown",
    "docs/new-document.mdx",
    "docs/.github/new-document.md",
    ".github/engineering/audit.md",
    ".github/ENGINEERING/audit.md",
    ".github/readme/guide.md",
    ".github/readme/unapproved.svg",
    ".github/releases/i18n/ja/audit.md",
    "changelog/observability-core.md",
    "changelog/v1.md",
    "src/lib/i18n/generated/messages.ts",
    "src/report.txt",
    "src/report.json",
    "src/report.html",
    "src/audit/report.ts",
    "src/Reports/report.ts",
    "output/report.json",
    ".playwright-cli/snapshot.ts",
    "public/images/report.pdf",
    "public/widgets/other.js",
    "docs/新增 document.md",
  ])("rejects unapproved staged paths: %s", (file) => {
    stage(file);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(JSON.stringify(file));
    expect(result.stderr).toContain("private workspace outside the repository");
  });

  it("allows approved public files and source code", () => {
    for (const file of [
      "README.md",
      ".github/readme/README.zh.md",
      ".github/readme/events.svg",
      ".github/readme/license.svg",
      ".github/readme/script.svg",
      ".github/ISSUE_TEMPLATE/bug_report.md",
      "changelog/v1.2.3.md",
      ".github/releases/i18n/ja/v1.2.3.md",
      "src/example.ts",
      "src/i18n/zh.yaml",
      "scripts/example.mjs",
      "packages/ui/src/index.ts",
      "packages/product-ui/README.md",
      "docs/openapi.json",
      "migrations/0001_initial.sql",
      "public/images/browser/chrome.svg",
      "public/widgets/embed.js",
      ".github/screenshot/001.webp",
      ".github/workflows/ci.yml",
      ".husky/pre-commit",
    ])
      stage(file);
    expect(check().status).toBe(0);
  });

  it("allows deleting prohibited files but not modifying them", () => {
    stage("README.md");
    stage(".github/engineering/old.md");
    git("commit", "--quiet", "-m", "fixture");
    stage(".github/engineering/old.md", "Updated\n");
    expect(check().status).toBe(1);
    git("rm", "-f", "--quiet", ".github/engineering/old.md");
    stage("README.md", "Updated\n");
    expect(check().status).toBe(0);
  });

  it("checks only staged files, including initial commits", () => {
    writeFileSync(path.join(repository, "untracked.md"), "Untracked\n");
    stage("src/example.ts");
    expect(check().status).toBe(0);
  });

  it("rejects moving an approved document to a prohibited path", () => {
    stage("changelog/v1.0.0.md");
    git("commit", "--quiet", "-m", "fixture");
    mkdirSync(path.join(repository, "docs"));
    git("mv", "changelog/v1.0.0.md", "docs/guide.md");
    expect(check().status).toBe(1);
  });

  it("uses repository-root paths even with relative diff configured", () => {
    stage("docs/blocked.md");
    git("config", "diff.relative", "true");
    expect(check(path.join(repository, "docs")).status).toBe(1);
  });

  it("fails closed when Git cannot inspect staged files", () => {
    git("config", "core.repositoryformatversion", "999");
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Inspection failed");
  });

  it("audits the entire committed tree and an individual commit", () => {
    stage("README.md");
    git("commit", "--quiet", "-m", "base");
    stage("src/report.json");
    git("commit", "--quiet", "-m", "blocked");
    expect(check(repository, ["--tree"]).status).toBe(1);
    expect(check(repository, ["--commit", "HEAD"]).status).toBe(1);
  });

  it("rejects intermediate leaked files even if removed before push", () => {
    stage("README.md");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    stage("docs/audit.md");
    git("commit", "--quiet", "-m", "leak");
    git("rm", "--quiet", "docs/audit.md");
    git("commit", "--quiet", "-m", "remove leak");
    const head = git("rev-parse", "HEAD").trim();
    expect(check(repository, ["--tree"]).status).toBe(0);
    expect(check(repository, ["--range", base, head]).status).toBe(1);
    const input = "refs/heads/main " + head + " refs/heads/main " + base + "\n";
    expect(
      check(repository, ["--pre-push", "origin", "unused"], input).status,
    ).toBe(1);
  });

  it("allows cleanup commits on a historical baseline", () => {
    stage(".github/engineering/old.md");
    git("commit", "--quiet", "-m", "historical leak");
    const base = git("rev-parse", "HEAD").trim();
    git("rm", "--quiet", ".github/engineering/old.md");
    git("commit", "--quiet", "-m", "cleanup");
    const head = git("rev-parse", "HEAD").trim();
    expect(check(repository, ["--range", base, head]).status).toBe(0);
    expect(
      check(
        repository,
        ["--pre-push", "origin", "unused"],
        "refs/heads/main " + head + " refs/heads/main " + base + "\n",
      ).status,
    ).toBe(0);
  });

  it("uses actual remote refs for new branches and rejects unpublished leaks", () => {
    stage(".github/engineering/old.md");
    git("commit", "--quiet", "-m", "historical leak");
    const remote = path.join(repository, ".remote");
    git("init", "--bare", "--quiet", remote);
    git("push", "--quiet", remote, "HEAD:refs/heads/main");
    stage("src/example.ts");
    git("commit", "--quiet", "-m", "safe");
    const prePush = () =>
      check(
        repository,
        ["--pre-push", "origin", remote],
        "refs/heads/feature " +
          git("rev-parse", "HEAD").trim() +
          " refs/heads/feature " +
          "0".repeat(40) +
          "\n",
      );
    expect(prePush().status).toBe(0);
    stage("output/report.html");
    git("commit", "--quiet", "-m", "leak");
    expect(prePush().status).toBe(1);
  });

  it("rejects prohibited changes from a merge parent", () => {
    stage("README.md");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    git("checkout", "--quiet", "-b", "feature");
    stage("docs/merge-report.md");
    git("commit", "--quiet", "-m", "leak");
    git("checkout", "--quiet", "--detach", base);
    stage("src/example.ts");
    git("commit", "--quiet", "-m", "safe");
    git("merge", "--quiet", "--no-ff", "feature", "-m", "merge");
    expect(check(repository, ["--commit", "HEAD"]).status).toBe(1);
  });

  it("allows remote deletions and rejects malformed push records", () => {
    const zeros = "0".repeat(40);
    expect(
      check(
        repository,
        ["--pre-push", "origin", "unused"],
        "(delete) " + zeros + " refs/heads/old " + "a".repeat(40) + "\n",
      ).status,
    ).toBe(0);
    expect(
      check(repository, ["--pre-push", "origin", "unused"], "invalid\n").status,
    ).toBe(1);
  });
});
