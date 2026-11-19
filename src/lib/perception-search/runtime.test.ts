import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  capturePerceptionGuard,
  clearPerceptionSession,
  currentPerceptionScope,
  localPerceptionSearch,
  observeLoadedDimension,
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
};
beforeEach(() => vi.stubGlobal("indexedDB", undefined));
afterEach(() => {
  clearPerceptionSession();
  vi.unstubAllGlobals();
});
describe("perception runtime authority and request guards", () => {
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
      href: "/zh/app/team-a/site-a/pages?pagePath=%2Fpublic",
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
});
