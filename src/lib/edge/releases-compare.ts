import { requireSession } from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";
import { fetchGithubCompare } from "@/lib/github-releases";
import { bad, errorResponse, jsonResponseFor } from "@/lib/response";

import { getInvocationLogger } from "./observability-bindings";

const REPO_OWNER = "RavelloH";
const REPO_NAME = "InsightFlare";
const REF_PATTERN = /^[0-9A-Za-z._/-]+$/;

function readRef(url: URL, key: string): string {
  return (url.searchParams.get(key) || "").trim();
}

export async function handleReleasesCompareRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const session = await requireSession(request, env);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const base = readRef(url, "base");
  const head = readRef(url, "head");

  if (!head || !REF_PATTERN.test(head)) {
    return bad("Missing or invalid head ref", "invalid_head_ref", request);
  }

  if (!base || !REF_PATTERN.test(base)) {
    return jsonResponseFor(request, {
      ok: true,
      data: {
        htmlUrl: null,
        status: "initial",
        totalCommits: 0,
        commits: [],
      },
    });
  }

  try {
    const logger = getInvocationLogger(env);
    let data;
    if (logger) {
      logger.increment("externalFetches");
      try {
        data = await logger.measure("external_fetch.github_compare", () =>
          fetchGithubCompare(REPO_OWNER, REPO_NAME, base, head),
        );
      } catch (error) {
        logger.increment("failedExternalFetches");
        throw error;
      }
    } else {
      data = await fetchGithubCompare(REPO_OWNER, REPO_NAME, base, head);
    }
    return jsonResponseFor(request, { ok: true, data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to compare releases.";
    return errorResponse(request, 502, "compare_failed", message);
  }
}
