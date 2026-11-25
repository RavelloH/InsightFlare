import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const root = git("rev-parse", "--show-toplevel").trim();
process.chdir(root);
const args = process.argv.slice(2);
const fix = args.includes("--fix");
const base = args.find((arg) => !arg.startsWith("--")) ?? "origin/main";
if (args.some((arg) => arg.startsWith("--") && arg !== "--fix")) {
  throw new Error("Usage: pnpm check [base] [--fix]");
}
const mergeBase = git("merge-base", "HEAD", base).trim();
const list = (value) => value.split("\0").filter(Boolean);
const files = [
  ...new Set([
    ...list(
      git(
        "diff",
        "--name-only",
        "--diff-filter=ACMRTUXB",
        "-z",
        mergeBase,
        "--",
      ),
    ),
    ...list(
      git(
        "diff",
        "--cached",
        "--name-only",
        "--diff-filter=ACMRTUXB",
        "-z",
        "--",
      ),
    ),
    ...list(git("ls-files", "--others", "--exclude-standard", "-z")),
  ]),
].filter((file) => existsSync(file));
const lint = files.filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file));
const format = files.filter((file) =>
  /\.(?:[cm]?[jt]s|[jt]sx|css)$/u.test(file),
);

function run(cli, flags, selected) {
  for (let i = 0; i < selected.length; i += 40) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules", cli),
        ...flags,
        "--",
        ...selected.slice(i, i + 40).map((file) => "./" + file),
      ],
      { cwd: root, stdio: "inherit", windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log(
  "Incremental check against " + base + ": " + files.length + " changed files.",
);
run(
  "eslint/bin/eslint.js",
  [
    "--config",
    "scripts/eslint-fast.config.mjs",
    "--max-warnings",
    "0",
    "--no-warn-ignored",
    ...(fix ? ["--fix"] : []),
  ],
  lint,
);
run(
  "prettier/bin/prettier.cjs",
  [fix ? "--write" : "--check", "--log-level", "warn"],
  format,
);
console.log("Incremental check passed. Full validation runs in PR CI.");
