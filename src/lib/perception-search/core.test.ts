import { describe, expect, it, vi } from "vitest";

import {
  matchScore,
  mergeSearchResults,
  navigationProvider,
  resolveSearchAction,
  searchExplicit,
  searchLocal,
  type SearchProvider,
  type SearchRequest,
} from "./core";

const scope = { userId: "u1", teamId: "t1", siteId: "s1" };
const request: SearchRequest = {
  query: "chr",
  mode: "global",
  scope,
  locale: "zh",
};
const make = (label: string, field = "client.browser") => ({
  kind: "browser" as const,
  key: label,
  label,
  scope,
  source: "index",
  coverage: "local-observed-only" as const,
  action: { type: "apply-filter" as const, field, value: label },
});
describe("Search Core", () => {
  it("matches NFKC, CJK and token prefixes, not arbitrary substrings", () => {
    expect(matchScore("Google Chrome", "chr")).toBe(60);
    expect(matchScore("Chrome", "CHR")).toBe(80);
    expect(matchScore("分析页面", "分析")).toBe(80);
    expect(matchScore("Chrome", "rom")).toBe(0);
  });
  it("deduplicates by scope and canonical identity, not label", () => {
    const same = make("Chrome");
    const other = { ...same, key: "second" };
    expect(
      mergeSearchResults(request, [
        [same, same, other, { ...same, scope: { ...scope, siteId: "s2" } }],
      ]),
    ).toHaveLength(2);
  });
  it("keeps remote providers off the keyboard path", async () => {
    const remote = vi.fn(() => [make("Chrome")]);
    const providers: SearchProvider[] = [
      {
        id: "remote",
        modes: ["global", "explicit-fulltext"],
        cost: "remote",
        search: remote,
      },
      {
        id: "local",
        modes: ["global"],
        cost: "local",
        search: () => [make("Chrome")],
      },
    ];
    expect(searchLocal(request, providers)).toHaveLength(1);
    expect(remote).not.toHaveBeenCalled();
    expect(
      (
        await searchExplicit(
          { ...request, mode: "explicit-fulltext" },
          providers,
        )
      ).status,
    ).toBe("unavailable");
    expect(remote).not.toHaveBeenCalled();
    expect(
      (
        await searchExplicit(
          { ...request, mode: "explicit-fulltext", userInitiated: true },
          providers,
        )
      ).status,
    ).toBe("ok");
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it("rejects unauthorized, external and wrong-locale actions at execution", () => {
    const ctx = {
      userId: "u1",
      locale: "zh",
      allowedTeamIds: new Set(["t1"]),
      allowedSiteIds: new Set(["s1"]),
    };
    expect(resolveSearchAction(make("Chrome"), ctx)?.type).toBe("apply-filter");
    expect(
      resolveSearchAction(
        { ...make("Chrome"), scope: { ...scope, userId: "u2" } },
        ctx,
      ),
    ).toBeNull();
    expect(
      resolveSearchAction(
        { ...make("Chrome"), scope: { ...scope, siteId: "revoked" } },
        ctx,
      ),
    ).toBeNull();
    const nav = navigationProvider([
      { key: "overview", label: "概览", href: "/zh/app/t1/s1", scope },
    ]);
    expect(searchLocal({ ...request, query: "概览" }, [nav])).toHaveLength(1);
    expect(
      resolveSearchAction(
        {
          ...make("Chrome"),
          action: { type: "navigate", href: "//evil.test" },
        },
        ctx,
      ),
    ).toBeNull();
  });
  it("cancels stale results and limits value search to the selected field", () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      searchLocal({ ...request, signal: controller.signal }, [
        {
          id: "p",
          cost: "local",
          modes: ["global"],
          search: () => [make("Chrome")],
        },
      ]),
    ).toEqual([]);
    expect(
      mergeSearchResults({ ...request, mode: "value", field: "event.name" }, [
        [make("Chrome")],
      ]),
    ).toEqual([]);
  });
});
