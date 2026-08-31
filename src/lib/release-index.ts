const DEFAULT_GITHUB_RELEASES_RAW_BASE =
  "https://raw.githubusercontent.com/RavelloH/InsightFlare/main";
const RELEASE_INDEX_PATH = ".github/releases/version.json";

const GITHUB_RELEASES_RAW_BASE = (
  import.meta.env.VITE_GITHUB_RELEASES_RAW_BASE ||
  DEFAULT_GITHUB_RELEASES_RAW_BASE
).replace(/\/+$/, "");

export type ReleaseIndexEntry = {
  tagName: string;
  name: string;
  htmlUrl: string;
  changelogPath: string;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  targetCommitish: string;
  authorLogin: string | null;
  draft: boolean;
  prerelease: boolean;
};

export type ReleaseIndex = ReleaseIndexEntry[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReleaseIndexEntry(value: unknown): value is ReleaseIndexEntry {
  if (!isRecord(value)) return false;

  return (
    typeof value.tagName === "string" &&
    typeof value.name === "string" &&
    typeof value.htmlUrl === "string" &&
    typeof value.changelogPath === "string" &&
    typeof value.publishedAt === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.targetCommitish === "string" &&
    (typeof value.authorLogin === "string" || value.authorLogin === null) &&
    typeof value.draft === "boolean" &&
    typeof value.prerelease === "boolean"
  );
}

function releaseIndexUrl(): string {
  return `${GITHUB_RELEASES_RAW_BASE}/${RELEASE_INDEX_PATH}`;
}

function rawFileUrl(path: string): string {
  return `${GITHUB_RELEASES_RAW_BASE}/${path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function fetchRawFile(path: string, signal?: AbortSignal): Promise<Response> {
  const url = rawFileUrl(path);
  return signal ? fetch(url, { signal }) : fetch(url);
}

function assertSuccessfulResponse(response: Response, resource: string): void {
  if (!response.ok) {
    throw new Error(`${resource} request failed: HTTP ${response.status}`);
  }
}

export async function fetchReleaseIndex(
  signal?: AbortSignal,
): Promise<ReleaseIndex> {
  const response = signal
    ? await fetch(releaseIndexUrl(), { signal })
    : await fetch(releaseIndexUrl());
  assertSuccessfulResponse(response, "Release index");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("Release index returned invalid JSON.", { cause: error });
  }

  if (!Array.isArray(payload) || !payload.every(isReleaseIndexEntry)) {
    throw new Error("Release index returned an unexpected payload.");
  }

  return payload;
}

export async function fetchReleaseChangelog(
  release: ReleaseIndexEntry,
  locale: string,
  signal?: AbortSignal,
): Promise<string> {
  const localizedPath =
    locale === "en"
      ? release.changelogPath
      : `.github/releases/i18n/${locale}/${release.tagName}.md`;
  const response = await fetchRawFile(localizedPath, signal);

  if (response.ok) return response.text();

  if (locale !== "en" && response.status === 404) {
    const fallbackResponse = await fetchRawFile(release.changelogPath, signal);
    assertSuccessfulResponse(fallbackResponse, "English changelog");
    return fallbackResponse.text();
  }

  throw new Error(`Release changelog request failed: HTTP ${response.status}`);
}
