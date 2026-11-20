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
  type SearchResolutionContext,
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
  it("matches typed navigation commands by metric keys and site domain aliases", () => {
    const provider = navigationProvider([
      {
        key: "metric:s1:bounceRate",
        label: "跳出率",
        keywords: ["bounceRate", "bounce rate"],
        group: "metric",
        target: {
          kind: "site",
          teamId: "t1",
          siteId: "s1",
          section: "overview",
          metric: "bounceRate",
        },
        scope,
      },
      {
        key: "site:s1",
        label: "我的站点",
        keywords: ["analytics.example.test"],
        group: "site",
        target: {
          kind: "site",
          teamId: "t1",
          siteId: "s1",
          section: "overview",
        },
        scope,
      },
    ]);
    const metric = searchLocal({ ...request, query: "bounce rate" }, [
      provider,
    ]);
    expect(metric.map((result) => [result.key, result.group])).toEqual([
      ["metric:s1:bounceRate", "metric"],
    ]);
    expect(
      searchLocal({ ...request, query: "analytics.example" }, [provider]).map(
        (result) => result.key,
      ),
    ).toEqual(["site:s1"]);
    expect(searchLocal({ ...request, query: "unrelated" }, [provider])).toEqual(
      [],
    );
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
    const ctx: SearchResolutionContext = {
      userId: "u1",
      locale: "zh",
      allowedTeamIds: new Set(["t1"]),
      allowedSiteIds: new Set(["s1"]),
      teamRoutes: new Map([["t1", "/zh/app/team-a"]]),
      siteRoutes: new Map([
        [
          "s1",
          {
            teamId: "t1",
            baseHref: "/zh/app/team-a/site-a",
            sections: new Set(["overview", "pages", "events"]),
          },
        ],
      ]),
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
      {
        key: "overview",
        label: "概览",
        target: {
          kind: "site",
          teamId: "t1",
          siteId: "s1",
          section: "overview",
        },
        scope,
      },
    ]);
    expect(searchLocal({ ...request, query: "概览" }, [nav])).toHaveLength(1);
    expect(
      resolveSearchAction(
        {
          ...make("Chrome"),
          action: {
            type: "navigate",
            target: {
              kind: "site",
              teamId: "t2",
              siteId: "s2",
              section: "pages",
            },
          },
        },
        ctx,
      ),
    ).toBeNull();
    // A provider cannot smuggle a destination for team/site B under scope A.
    const forged = {
      ...make("Chrome"),
      action: {
        type: "navigate" as const,
        target: {
          kind: "site" as const,
          teamId: "t1",
          siteId: "s2",
          section: "pages" as const,
        },
      },
    };
    expect(resolveSearchAction(forged, ctx)).toBeNull();
    const valid = {
      ...make("Chrome"),
      action: {
        type: "navigate" as const,
        target: {
          kind: "site" as const,
          teamId: "t1",
          siteId: "s1",
          section: "pages" as const,
          pagePath: "/product",
        },
      },
    };
    expect(resolveSearchAction(valid, ctx)).toEqual({
      type: "navigate",
      href: "/zh/app/team-a/site-a/pages?pagePath=%2Fproduct",
    });
    const metricAction = {
      ...valid,
      action: {
        type: "navigate" as const,
        target: {
          kind: "site" as const,
          teamId: "t1",
          siteId: "s1",
          section: "overview" as const,
          metric: "bounceRate" as const,
        },
      },
    };
    expect(resolveSearchAction(metricAction, ctx)).toEqual({
      type: "navigate",
      href: "/zh/app/team-a/site-a#overview-metric-bounceRate",
    });
    expect(
      resolveSearchAction(
        {
          ...metricAction,
          action: {
            ...metricAction.action,
            target: {
              ...metricAction.action.target,
              section: "pages" as const,
            },
          },
        },
        ctx,
      ),
    ).toBeNull();
    expect(
      resolveSearchAction(
        {
          ...metricAction,
          action: {
            ...metricAction.action,
            target: {
              ...metricAction.action.target,
              metric: "invalid" as "bounceRate",
            },
          },
        },
        ctx,
      ),
    ).toBeNull();
    expect(
      resolveSearchAction(
        { ...metricAction, scope: { ...scope, siteId: "s2" } },
        ctx,
      ),
    ).toBeNull();
    expect(
      resolveSearchAction(
        {
          ...valid,
          action: {
            type: "navigate",
            target: {
              ...valid.action.target,
              pagePath: "/product?password=secret",
            },
          },
        },
        ctx,
      ),
    ).toBeNull();
  });
  it("does not dispatch pre-aborted requests, or leak remote errors", async () => {
    const remote = vi.fn(() => Promise.resolve([make("Chrome")]));
    const providers: SearchProvider[] = [
      {
        id: "full-text",
        modes: ["explicit-fulltext"],
        cost: "remote",
        search: remote,
      },
    ];
    const controller = new AbortController();
    controller.abort();
    expect(
      await searchExplicit(
        {
          ...request,
          mode: "explicit-fulltext",
          userInitiated: true,
          signal: controller.signal,
        },
        providers,
      ),
    ).toEqual({ status: "cancelled", results: [] });
    expect(remote).not.toHaveBeenCalled();
    let reject!: (error: Error) => void;
    const pending = new Promise<readonly ReturnType<typeof make>[]>(
      (_, rejectFn) => {
        reject = rejectFn;
      },
    );
    const inFlight = searchExplicit(
      {
        ...request,
        mode: "explicit-fulltext",
        userInitiated: true,
        signal: new AbortController().signal,
      },
      [{ ...providers[0], search: () => pending }],
    );
    reject(new Error("not available"));
    expect(await inFlight).toEqual({ status: "error", results: [] });
    const during = new AbortController();
    const active = searchExplicit(
      {
        ...request,
        mode: "explicit-fulltext",
        userInitiated: true,
        signal: during.signal,
      },
      [{ ...providers[0], search: () => pending }],
    );
    during.abort();
    expect(await active).toEqual({ status: "cancelled", results: [] });
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
