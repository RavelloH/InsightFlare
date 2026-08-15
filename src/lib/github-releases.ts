import { measureCurrentExternalFetch } from "@/lib/edge/observability-logger";

const GITHUB_API_BASE =
  import.meta.env.VITE_GITHUB_API_BASE || "https://api.github.com";

type GithubReleaseApiItem = {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  target_commitish: string;
  author: {
    login: string;
  } | null;
};

export type GithubRelease = {
  id: number;
  tagName: string;
  name: string;
  htmlUrl: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  targetCommitish: string;
  authorLogin: string | null;
};

type GithubCompareApiCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    } | null;
  };
  author: {
    login: string;
    html_url: string;
  } | null;
};

type GithubCompareApiResponse = {
  html_url: string;
  status: string;
  total_commits: number;
  commits: GithubCompareApiCommit[];
};

export type GithubCompareCommit = {
  sha: string;
  shortSha: string;
  htmlUrl: string;
  message: string;
  title: string;
  authorName: string;
  authorLogin: string | null;
  authorUrl: string | null;
  authoredAt: string | null;
};

export type GithubCompareResult = {
  htmlUrl: string;
  status: string;
  totalCommits: number;
  commits: GithubCompareCommit[];
};

function normalizeRelease(item: GithubReleaseApiItem): GithubRelease {
  return {
    id: item.id,
    tagName: item.tag_name,
    name: item.name?.trim() || item.tag_name,
    htmlUrl: item.html_url,
    body: item.body,
    draft: item.draft,
    prerelease: item.prerelease,
    publishedAt: item.published_at,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    targetCommitish: item.target_commitish,
    authorLogin: item.author?.login ?? null,
  };
}

function releaseTimestamp(
  release: Pick<GithubRelease, "publishedAt" | "createdAt">,
): number {
  const timestamp = new Date(
    release.publishedAt ?? release.createdAt,
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function fetchGithubReleases(
  owner: string,
  repo: string,
): Promise<GithubRelease[]> {
  const response = await measureCurrentExternalFetch(
    "external_fetch.github_releases",
    () =>
      fetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases?per_page=50&page=1`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "InsightFlare",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          cache: "no-store",
        },
      ),
  );

  if (!response.ok) {
    throw new Error(`GitHub Releases API failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("GitHub Releases API returned an unexpected payload.");
  }

  return (payload as GithubReleaseApiItem[])
    .map(normalizeRelease)
    .sort((left, right) => releaseTimestamp(right) - releaseTimestamp(left));
}

function normalizeCompareCommit(
  commit: GithubCompareApiCommit,
): GithubCompareCommit {
  const message = commit.commit.message.trim();
  const title = message.split(/\r?\n/, 1)[0]?.trim() || commit.sha;

  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 12),
    htmlUrl: commit.html_url,
    message,
    title,
    authorName: commit.author?.login || commit.commit.author?.name || "-",
    authorLogin: commit.author?.login ?? null,
    authorUrl: commit.author?.html_url ?? null,
    authoredAt: commit.commit.author?.date ?? null,
  };
}

export async function fetchGithubCompare(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<GithubCompareResult> {
  const response = await measureCurrentExternalFetch(
    "external_fetch.github_compare",
    () =>
      fetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${encodeURIComponent(
          base,
        )}...${encodeURIComponent(head)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "InsightFlare",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          cache: "no-store",
        },
      ),
  );

  if (!response.ok) {
    throw new Error(`GitHub Compare API failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as GithubCompareApiResponse;
  if (!Array.isArray(payload.commits)) {
    throw new Error("GitHub Compare API returned an unexpected payload.");
  }

  return {
    htmlUrl: payload.html_url,
    status: payload.status,
    totalCommits: payload.total_commits,
    commits: payload.commits.map(normalizeCompareCommit),
  };
}
