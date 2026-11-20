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
