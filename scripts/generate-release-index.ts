#!/usr/bin/env tsx

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
export const DEFAULT_REPOSITORY_URL =
  "https://github.com/RavelloH/InsightFlare";
export const DEFAULT_OUTPUT_PATH = join(
  REPOSITORY_ROOT,
  ".github",
  "releases",
  "version.json",
);

const CHANGELOG_FILENAME = /^v(\d+)\.(\d+)\.(\d+)\.md$/;
const GIT_LOG_FORMAT = "%H%x00%aI%x00%cI%x00%an%x00%ae";

export interface ParsedReleaseVersion {
  tagName: string;
  major: number;
  minor: number;
  patch: number;
}

export interface GitMetadata {
  commit: string;
  authorDate: string;
  commitDate: string;
  authorName: string;
  authorEmail: string;
  authorLogin: string | null;
}

export interface ReleaseIndexEntry {
  tagName: string;
  name: string;
  htmlUrl: string;
  changelogPath: string;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  targetCommitish: string;
  authorLogin: string | null;
  draft: false;
  prerelease: false;
}

export type GitRunner = (args: readonly string[], cwd: string) => string;
export type GitMetadataReader = (changelogPath: string) => GitMetadata;

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function assertRepositoryRelativePath(path: string): string {
  const normalizedPath = normalizeRepositoryPath(path);
  if (
    !normalizedPath ||
    normalizedPath.startsWith("/") ||
    normalizedPath === "." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../")
  ) {
    throw new Error(`Expected a repository-relative path, received: ${path}`);
  }
  return normalizedPath;
}

export function parseReleaseVersion(path: string): ParsedReleaseVersion | null {
  const fileName = normalizeRepositoryPath(path).split("/").at(-1) ?? "";
  const match = CHANGELOG_FILENAME.exec(fileName);
  if (!match) return null;

  return {
    tagName: fileName.slice(0, -3),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareReleaseVersions(
  left: ParsedReleaseVersion,
  right: ParsedReleaseVersion,
): number {
  return (
    right.major - left.major ||
    right.minor - left.minor ||
    right.patch - left.patch ||
    left.tagName.localeCompare(right.tagName)
  );
}

export function sortChangelogPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => {
    const leftVersion = parseReleaseVersion(left);
    const rightVersion = parseReleaseVersion(right);
    if (!leftVersion && !rightVersion) return left.localeCompare(right);
    if (!leftVersion) return 1;
    if (!rightVersion) return -1;
    return compareReleaseVersions(leftVersion, rightVersion);
  });
}

export function scanChangelogFiles(repositoryRoot: string): string[] {
  const changelogDirectory = join(repositoryRoot, "changelog");
  let entries;
  try {
    entries = readdirSync(changelogDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Unable to scan changelog directory: ${changelogDirectory}`,
      { cause: error },
    );
  }

  const changelogPaths = entries
    .filter((entry) => entry.isFile() && parseReleaseVersion(entry.name))
    .map((entry) => `changelog/${entry.name}`);

  return sortChangelogPaths(changelogPaths);
}

function parseGithubLogin(email: string): string | null {
  const match = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(
    email.trim(),
  );
  return match?.[1] || null;
}

export function parseGitLogMetadata(
  output: string,
  changelogPath: string,
): GitMetadata {
  const fields = output.trimEnd().split("\0");
  if (fields.length !== 5 || fields.some((field) => !field.trim())) {
    throw new Error(
      `Git metadata for ${changelogPath} is incomplete. Expected a commit, author date, commit date, author name, and author email from git log.`,
    );
  }

  const [commit, authorDate, commitDate, authorName, authorEmail] = fields;
  if (!commit || !authorDate || !commitDate || !authorName || !authorEmail) {
    throw new Error(`Git metadata for ${changelogPath} is incomplete.`);
  }

  if (
    !Number.isFinite(Date.parse(authorDate)) ||
    !Number.isFinite(Date.parse(commitDate))
  ) {
    throw new Error(
      `Git metadata for ${changelogPath} contains an invalid author or commit date.`,
    );
  }

  return {
    commit,
    authorDate,
    commitDate,
    authorName,
    authorEmail,
    authorLogin: parseGithubLogin(authorEmail),
  };
}

export function readGitMetadata(
  repositoryRoot: string,
  changelogPath: string,
  gitRunner: GitRunner = runGit,
): GitMetadata {
  const relativePath = assertRepositoryRelativePath(changelogPath);
  try {
    const output = gitRunner(
      ["log", "-1", `--format=${GIT_LOG_FORMAT}`, "--", relativePath],
      repositoryRoot,
    );
    if (!output.trim()) {
      throw new Error("git log returned no commit for the file");
    }
    return parseGitLogMetadata(output, relativePath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Git metadata")) {
      throw error;
    }
    throw new Error(
      `Unable to read Git metadata for ${relativePath}. Run this generator from a complete Git checkout where the changelog file is tracked.`,
      { cause: error },
    );
  }
}

function normalizeRepositoryUrl(repositoryUrl: string): string {
  return repositoryUrl.replace(/\/+$/, "");
}

export function buildReleaseEntry(
  changelogPath: string,
  metadata: GitMetadata,
  repositoryUrl = DEFAULT_REPOSITORY_URL,
): ReleaseIndexEntry {
  const relativePath = assertRepositoryRelativePath(changelogPath);
  const version = parseReleaseVersion(relativePath);
  if (!version) {
    throw new Error(
      `Cannot build a release index entry for a non-version changelog: ${changelogPath}`,
    );
  }

  return {
    tagName: version.tagName,
    name: `Release ${version.tagName}`,
    htmlUrl: `${normalizeRepositoryUrl(repositoryUrl)}/releases/tag/${version.tagName}`,
    changelogPath: relativePath,
    publishedAt: metadata.commitDate,
    createdAt: metadata.commitDate,
    updatedAt: metadata.commitDate,
    targetCommitish: metadata.commit,
    authorLogin: metadata.authorLogin,
    draft: false,
    prerelease: false,
  };
}

export function buildReleaseIndex(
  changelogPaths: readonly string[],
  metadataReader: GitMetadataReader,
  repositoryUrl = DEFAULT_REPOSITORY_URL,
): ReleaseIndexEntry[] {
  return sortChangelogPaths(changelogPaths).map((changelogPath) =>
    buildReleaseEntry(
      changelogPath,
      metadataReader(changelogPath),
      repositoryUrl,
    ),
  );
}

export interface GenerateReleaseIndexOptions {
  outputPath?: string;
  repositoryUrl?: string;
  gitRunner?: GitRunner;
}

export function createReleaseIndex(
  repositoryRoot: string,
  options: Pick<
    GenerateReleaseIndexOptions,
    "repositoryUrl" | "gitRunner"
  > = {},
): ReleaseIndexEntry[] {
  const gitMetadataReader = (changelogPath: string) =>
    readGitMetadata(repositoryRoot, changelogPath, options.gitRunner);
  return buildReleaseIndex(
    scanChangelogFiles(repositoryRoot),
    gitMetadataReader,
    options.repositoryUrl,
  );
}

export function serializeReleaseIndex(
  entries: readonly ReleaseIndexEntry[],
): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

export function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write or rename error.
    }
    throw error;
  }
}

export function generateReleaseIndex(
  repositoryRoot = REPOSITORY_ROOT,
  options: GenerateReleaseIndexOptions = {},
): ReleaseIndexEntry[] {
  const entries = createReleaseIndex(repositoryRoot, options);
  const outputPath =
    options.outputPath ??
    (repositoryRoot === REPOSITORY_ROOT
      ? DEFAULT_OUTPUT_PATH
      : join(repositoryRoot, ".github", "releases", "version.json"));
  writeAtomically(outputPath, serializeReleaseIndex(entries));
  return entries;
}

function main(): void {
  const entries = generateReleaseIndex();
  console.log(`Generated ${DEFAULT_OUTPUT_PATH} (${entries.length} releases).`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main();
}
