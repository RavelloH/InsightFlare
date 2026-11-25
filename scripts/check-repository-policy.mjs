import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Public repository admission policy. Do not broaden this policy to publish
// development artifacts; store them in a private workspace outside the working tree.
const exact = new Set([
  ".dev.vars.example",
  ".gitignore",
  ".hintrc",
  ".prettierignore",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "components.json",
  "eslint.config.js",
  "package.json",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches/vaul@1.1.2.patch",
  "postcss.config.mjs",
  "prettier.config.js",
  "tsconfig.base.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "vitest.tracker.config.ts",
  "wrangler.demo.toml",
  "wrangler.dev.toml",
  "wrangler.toml",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/readme/deploy-insightflare.svg",
  ".github/releases/version.json",
  ".husky/pre-commit",
  ".husky/pre-push",
  "docs/openapi.json",
  "docs/openapi.yaml",
  "docs/schema.sql",
  "docs/skills.json",
  "scripts/skills-template.json",
  "public/site.webmanifest",
  "public/favicon.ico",
  "public/android-chrome-192x192.png",
  "public/android-chrome-512x512.png",
  "public/apple-touch-icon.png",
  "public/favicon-16x16.png",
  "public/favicon-32x32.png",
  "public/icon-1024.png",
]);
const allowed = [
  /^\.github\/readme\/README\.(?:en|ja|zh|zh-tw)\.md$/,
  /^changelog\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.md$/,
  /^\.github\/releases\/i18n\/(?:ja|zh|zh-tw)\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.md$/,
  /^\.github\/screenshot\/\d+\.webp$/,
  /^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/,
  /^packages\/(?:ui|product-ui)\/(?:README\.md|LICENSE|\.npmignore|package\.json|tsconfig(?:\.build)?\.json|build\.mjs|styles\.css)$/,
  /^packages\/(?:ui|product-ui)\/(?:src|styles|tests)\/.+\.(?:ts|tsx|js|jsx|mjs|cjs|css|svg)$/,
  /^src\/.+\.(?:ts|tsx|js|jsx|mjs|cjs|css)$/,
  /^src\/i18n\/[a-z]{2}(?:-[a-z]{2})?\.yaml$/,
  /^(?:scripts|tests|e2e)\/.+\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /^migrations\/\d+_[a-z0-9_]+\.sql$/,
  /^public\/images\/.+\.(?:svg|png|webp|ico|jpg|jpeg|avif)$/,
];
const internalDir =
  /^(?:plans?|\.agents?|reports?|audits?|evidence|output|\.output|\.playwright-cli|playwright-report|test-results|logs|\.tmp|\.cache|coverage|node_modules|dist|\.wrangler|\.tanstack)$/i;
function permitted(file) {
  if (/^src\/lib\/i18n\/generated(?:\/|$)/i.test(file)) return false;
  const segments = file.split("/");
  if (segments.slice(0, -1).some((part) => internalDir.test(part)))
    return false;
  if (/^\.github\/engineering(?:\/|$)/i.test(file)) return false;
  return exact.has(file) || allowed.some((pattern) => pattern.test(file));
}

function git(args, optional = false) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    throw new Error(
      "Unable to inspect Git data: git " +
        args[0] +
        ". " +
        (result.error?.message || result.stderr.trim()),
    );
  }
  return result.stdout;
}
const names = (value) => value.split("\0").filter(Boolean);
const lines = (value) => value.trim().split(/\r?\n/).filter(Boolean);
const diffArgs = [
  "--name-only",
  "--diff-filter=ACMRTUXB",
  "--no-renames",
  "--no-relative",
  "-z",
];
const blocked = new Map();

function inspect(files, source) {
  for (const file of files) {
    if (!permitted(file)) {
      if (!blocked.has(file)) blocked.set(file, new Set());
      blocked.get(file).add(source);
    }
  }
}
function commit(ref) {
  return git([
    "rev-parse",
    "--verify",
    "--end-of-options",
    ref + "^{commit}",
  ]).trim();
}
function inspectCommit(ref) {
  const sha = commit(ref);
  // Inspect every parent of merge commits and include initial commits.
  inspect(
    names(
      git([
        "diff-tree",
        "--root",
        "-m",
        "-r",
        "--no-commit-id",
        ...diffArgs,
        sha,
      ]),
    ),
    sha.slice(0, 12),
  );
}
function inspectRange(head, bases, seen = new Set()) {
  const commits = lines(
    git(["rev-list", commit(head), ...bases.map((base) => "^" + base), "--"]),
  );
  for (const sha of commits) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    inspectCommit(sha);
  }
}
const zero = (sha) => /^0+$/.test(sha);
const oid = (sha) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha);
function prePush(remoteUrl) {
  if (!remoteUrl) throw new Error("Missing pre-push remote URL.");
  const records = lines(readFileSync(0, "utf8"));
  const seen = new Set();
  let remoteBases;
  for (const record of records) {
    const fields = record.split(/\s+/);
    if (fields.length !== 4 || !oid(fields[1]) || !oid(fields[3])) {
      throw new Error("Invalid pre-push ref record.");
    }
    const [, local, , remote] = fields;
    if (zero(local)) continue; // A deletion publishes no objects.
    if (!zero(remote)) {
      inspectRange(local, [commit(remote)], seen);
      continue;
    }
    // New remote refs: exclude only objects actually advertised by the remote,
    // never arbitrary local branches or potentially stale remote-tracking refs.
    if (!remoteBases) {
      remoteBases = lines(git(["ls-remote", "--refs", "--", remoteUrl]))
        .map((line) => line.split(/\s+/)[0])
        .filter(oid)
        .map((sha) =>
          git(
            ["rev-parse", "--verify", "--end-of-options", sha + "^{commit}"],
            true,
          )?.trim(),
        )
        .filter(Boolean);
    }
    inspectRange(local, [...new Set(remoteBases)], seen);
  }
}

try {
  // Normalize paths even when invoked in a subdirectory or linked worktree.
  process.chdir(git(["rev-parse", "--show-toplevel"]).trim());
  const [mode = "--staged", first, second] = process.argv.slice(2);
  switch (mode) {
    case "--staged":
      inspect(names(git(["diff", "--cached", ...diffArgs])), "staged");
      break;
    case "--commit":
      if (!first) throw new Error("Usage: --commit <commit>");
      inspectCommit(first);
      break;
    case "--range":
      if (!first || !second) throw new Error("Usage: --range <base> <head>");
      inspectRange(second, [commit(first)]);
      break;
    case "--tree":
      inspect(
        names(
          git(["ls-tree", "-r", "--name-only", "-z", commit(first || "HEAD")]),
        ),
        "tree",
      );
      break;
    case "--pre-push":
      prePush(second);
      break;
    default:
      throw new Error("Unknown repository policy mode: " + mode);
  }
  if (blocked.size) {
    console.error(
      "[Repository Policy] Rejected non-public or unapproved paths:",
    );
    for (const [file, sources] of blocked) {
      console.error(
        "  " + JSON.stringify(file) + " (" + [...sources].join(", ") + ")",
      );
    }
    console.error(
      "Store internal plans, audits, verification results and handoffs in a private workspace outside the repository. " +
        "Keep temporary artifacts outside the repository. Do not rename, relocate, " +
        "embed or convert prohibited artifacts to bypass this policy. " +
        "Do not disable or modify this policy to complete a commit. " +
        "Ask the maintainer for explicit approval of a genuinely new public file type or path.",
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    "[Repository Policy] Inspection failed; refusing the operation. " +
      error.message,
  );
  process.exitCode = 1;
}
