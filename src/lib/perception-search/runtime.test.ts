import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSearchAction, type SiteSearchSection } from "./core";
import { perceptionIndex } from "./index";
import {
  capturePerceptionGuard,
  clearPerceptionSession,
  currentPerceptionScope,
  getPerceptionAuthorization,
  localPerceptionNavigation,
  localPerceptionSearch,
  lookupPerception,
  observeLoadedDimension,
  revokePerceptionSite,
  setPerceptionAuthorization,
} from "./runtime";

const base = {
  userId: "user-a",
  locale: "zh",
  activeTeamId: "team-a",
  activeSiteId: "site-a",
  activeSiteBase: "/zh/app/team-a/site-a",
  allowedTeamIds: new Set(["team-a"]),
  allowedSiteIds: new Set(["site-a"]),
  teamRoutes: new Map([["team-a", "/zh/app/team-a"]]),
  siteRoutes: new Map([
    [
      "site-a",
      {
        teamId: "team-a",
        baseHref: "/zh/app/team-a/site-a",
        sections: new Set<SiteSearchSection>(["overview", "pages", "events"]),
      },
    ],
  ]),
};
beforeEach(() => vi.stubGlobal("indexedDB", undefined));
afterEach(async () => {
  await clearPerceptionSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("perception runtime authority and request guards", () => {
  it("looks up a bare UUID in exactly two site-scoped detail readers and preserves partial hits", async () => {
    setPerceptionAuthorization(base, []);
    const value = "f2b07f9c-8a13-4c26-9f98-3f5bc63aee9c";
    const scope = currentPerceptionScope("site-a")!;
    const window = {
      preset: "custom",
      interval: "day",
      timeZone: "UTC",
      from: 100,
      to: 200,
    } as const;
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input, "https://example.test");
        urls.push(url);
        if (url.pathname.endsWith("/visitor-detail")) {
          return Response.json({
            ok: true,
            data: { visitor: { visitorId: value } },
          });
        }
        return new Response(null, { status: 503 });
      }),
    );

    await expect(
      lookupPerception({
        kind: "id",
        value,
        scope,
        window,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      hits: [{ kind: "visitor", value }],
      failed: true,
      revoked: false,
    });
    expect(urls.map(({ pathname }) => pathname)).toEqual([
      "/api/private/visitor-detail",
      "/api/private/event-record-detail",
    ]);
    expect(
      urls.every((url) => url.searchParams.get("siteId") === scope.siteId),
    ).toBe(true);
    expect(urls[1]?.searchParams.get("from")).toBe(String(window.from));
    expect(urls[1]?.searchParams.get("to")).toBe(String(window.to));
  });

  it("discards an in-flight explicit result after navigating to another site", async () => {
    setPerceptionAuthorization(base, []);
    const scope = currentPerceptionScope("site-a")!;
    let finish!: (response: Response) => void;
    const fetchDetail = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchDetail);
    const lookup = lookupPerception({
      kind: "visitor",
      value: "visitor-a",
      scope,
      window: {
        preset: "custom",
        interval: "day",
        timeZone: "UTC",
        from: 100,
        to: 200,
      },
      signal: new AbortController().signal,
    });
    expect(fetchDetail).toHaveBeenCalledOnce();
    setPerceptionAuthorization({ ...base, activeSiteId: undefined }, []);
    finish(
      Response.json({
        ok: true,
        data: { visitor: { visitorId: "visitor-a" } },
      }),
    );
    await expect(lookup).resolves.toEqual({
      hits: [],
      failed: false,
      revoked: false,
    });
  });

  it("distinguishes a rejected site grant from an unavailable detail endpoint", async () => {
    setPerceptionAuthorization(base, []);
    const scope = currentPerceptionScope("site-a")!;
    const lookup = {
      kind: "visitor",
      value: "visitor-a",
      scope,
      window: {
        preset: "custom",
        interval: "day",
        timeZone: "UTC",
        from: 100,
        to: 200,
      },
      signal: new AbortController().signal,
    } as const;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: "Site not found" }, { status: 404 }),
        )
        .mockResolvedValueOnce(
          Response.json({ error: "Not found" }, { status: 404 }),
        ),
    );
    await expect(lookupPerception(lookup)).resolves.toMatchObject({
      revoked: true,
    });
    await expect(lookupPerception(lookup)).resolves.toMatchObject({
      revoked: false,
      failed: true,
    });
  });

  it("shows only authorized navigation on an empty query, not observed values", () => {
    const request = {
      query: "",
      mode: "global" as const,
      locale: "zh",
      scope: { userId: "user-a", teamId: "team-a", siteId: "site-a" },
    };
    setPerceptionAuthorization(base, [
      {
        key: "events",
        label: "Events",
        scope: request.scope,
        target: {
          kind: "site",
          teamId: "team-a",
          siteId: "site-a",
          section: "events",
        },
      },
    ]);
    observeLoadedDimension(
      "site-a",
      "event.name",
      ["ObservedOnly"],
      capturePerceptionGuard("site-a"),
    );
    expect(
      localPerceptionSearch(request).map((result) => result.label),
    ).toContain("ObservedOnly");
    expect(
      localPerceptionNavigation(request).map((result) => result.label),
    ).toEqual(["Events"]);
    revokePerceptionSite("site-a");
    expect(localPerceptionNavigation(request)).toEqual([]);
  });
  it("rejects stale in-flight Analytics results after a site switch", () => {
    setPerceptionAuthorization(base, []);
    const pending = capturePerceptionGuard("site-a");
    expect(pending).not.toBeNull();
    setPerceptionAuthorization(
      {
        ...base,
        activeSiteId: "site-b",
        activeSiteBase: "/zh/app/team-a/site-b",
        allowedSiteIds: new Set(["site-a", "site-b"]),
        siteRoutes: new Map([
          [
            "site-b",
            {
              teamId: "team-a",
              baseHref: "/zh/app/team-a/site-b",
              sections: new Set<SiteSearchSection>([
                "overview",
                "pages",
                "events",
              ]),
            },
          ],
        ]),
      },
      [],
    );
    observeLoadedDimension("site-a", "event.name", ["Stale"], pending);
    expect(currentPerceptionScope("site-a")).toBeNull();
    const active = capturePerceptionGuard("site-b");
    observeLoadedDimension("site-b", "event.name", ["Current"], active);
    expect(
      localPerceptionSearch({
        query: "Current",
        mode: "global",
        locale: "zh",
        scope: { userId: "user-a", teamId: "team-a", siteId: "site-b" },
      }).map((r) => r.label),
    ).toEqual(["Current"]);
    expect(
      localPerceptionSearch({
        query: "Stale",
        mode: "global",
        locale: "zh",
        scope: { userId: "user-a", teamId: "team-a", siteId: "site-b" },
      }),
    ).toEqual([]);
  });
  it("does not accept observations after account switch or permissions revoke", () => {
    setPerceptionAuthorization(base, []);
    const guard = capturePerceptionGuard("site-a");
    setPerceptionAuthorization(
      {
        ...base,
        userId: "user-b",
        allowedSiteIds: new Set(["site-a"]),
      },
      [],
    );
    observeLoadedDimension("site-a", "event.name", ["WrongAccount"], guard);
    expect(
      localPerceptionSearch({
        query: "WrongAccount",
        mode: "global",
        locale: "zh",
        scope: { userId: "user-b", teamId: "team-a", siteId: "site-a" },
      }),
    ).toEqual([]);
    setPerceptionAuthorization(
      {
        ...base,
        userId: "user-b",
        allowedSiteIds: new Set(),
      },
      [],
    );
    expect(capturePerceptionGuard("site-a")).toBeNull();
    expect(
      localPerceptionSearch({
        query: "x",
        mode: "global",
        locale: "zh",
        scope: { userId: "user-b", teamId: "team-a", siteId: "site-a" },
      }),
    ).toEqual([]);
  });
  it("rejects unguarded or non-current site observations and clears on logout", () => {
    setPerceptionAuthorization(base, []);
    observeLoadedDimension("site-a", "page.path", ["/private"], null);
    const guard = capturePerceptionGuard("site-a");
    observeLoadedDimension("site-b", "page.path", ["/private"], guard);
    const req = {
      query: "private",
      mode: "global" as const,
      locale: "zh",
      scope: { userId: "user-a", teamId: "team-a", siteId: "site-a" },
    };
    expect(localPerceptionSearch(req)).toEqual([]);
    observeLoadedDimension("site-a", "page.path", ["/public"], guard);
    const found = localPerceptionSearch({ ...req, query: "public" });
    expect(found).toHaveLength(1);
    expect(found[0].action).toEqual({
      type: "navigate",
      target: {
        kind: "site",
        teamId: "team-a",
        siteId: "site-a",
        section: "pages",
        pagePath: "/public",
      },
    });
    const value = localPerceptionSearch({
      ...req,
      mode: "value",
      field: "page.path",
      query: "pub",
    });
    expect(value[0]?.action).toEqual({
      type: "apply-filter",
      field: "page.path",
      value: "/public",
    });
    expect(
      localPerceptionSearch({
        ...req,
        mode: "value",
        field: "event.name",
        query: "pub",
      }),
    ).toEqual([]);
    clearPerceptionSession();
    expect(localPerceptionSearch({ ...req, query: "public" })).toEqual([]);
  });
  it("F1: blocks stale guards, navigation, values and Resolver before IDB cleanup completes", () => {
    const navigation = [
      {
        key: "events",
        label: "Events",
        scope: { userId: "user-a", teamId: "team-a", siteId: "site-a" },
        target: {
          kind: "site" as const,
          teamId: "team-a",
          siteId: "site-a",
          section: "events" as const,
        },
      },
    ];
    setPerceptionAuthorization(base, navigation);
    const guard = capturePerceptionGuard("site-a");
    observeLoadedDimension("site-a", "event.name", ["BeforeRevoke"], guard);
    const request = {
      query: "Before",
      mode: "value" as const,
      field: "event.name",
      locale: "zh",
      scope: { userId: "user-a", teamId: "team-a", siteId: "site-a" },
    };
    const previous = localPerceptionSearch(request)[0];
    expect(previous?.action.type).toBe("apply-filter");
    // Even if persistence deletion never settles, permission checks must fail closed.
    vi.spyOn(perceptionIndex, "clearScope").mockImplementation(
      () => new Promise<void>(() => {}),
    );
    revokePerceptionSite("site-a");
    expect(getPerceptionAuthorization()?.allowedSiteIds.has("site-a")).toBe(
      false,
    );
    expect(capturePerceptionGuard("site-a")).toBeNull();
    expect(localPerceptionSearch(request)).toEqual([]);
    expect(
      resolveSearchAction(previous, getPerceptionAuthorization()!),
    ).toBeNull();
    observeLoadedDimension("site-a", "event.name", ["AfterRevoke"], guard);
    expect(localPerceptionSearch({ ...request, query: "After" })).toEqual([]);
    expect(
      localPerceptionSearch({ ...request, mode: "global", query: "Events" }),
    ).toEqual([]);
    // React may re-publish old props, but must not re-authorize the revoked scope.
    setPerceptionAuthorization(base, navigation);
    expect(capturePerceptionGuard("site-a")).toBeNull();
    expect(localPerceptionSearch({ ...request, query: "Before" })).toEqual([]);
  });
  it("F1: cross-tab scope invalidation rejects old in-flight response without reloading", async () => {
    setPerceptionAuthorization(base, []);
    const guard = capturePerceptionGuard("site-a");
    observeLoadedDimension("site-a", "event.name", ["BeforeRevoke"], guard);
    const peer = new BroadcastChannel("insightflare-perception-v1");
    try {
      peer.postMessage({
        type: "scope-clear",
        userId: "user-a",
        teamId: "team-a",
        siteId: "site-a",
      });
      await vi.waitFor(() =>
        expect(currentPerceptionScope("site-a")).toBeNull(),
      );
      observeLoadedDimension("site-a", "event.name", ["AfterRevoke"], guard);
      expect(
        localPerceptionSearch({
          query: "After",
          mode: "global",
          locale: "zh",
          scope: { userId: "user-a", teamId: "team-a", siteId: "site-a" },
        }),
      ).toEqual([]);
      expect(getPerceptionAuthorization()?.siteRoutes.has("site-a")).toBe(
        false,
      );
      setPerceptionAuthorization(base, []);
      expect(capturePerceptionGuard("site-a")).toBeNull();
    } finally {
      peer.close();
    }
  });
});
