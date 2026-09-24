import { describe, expect, it } from "vitest";

import {
  DEMO_SITE_PROFILES,
  findSiteProfile,
} from "@/lib/demo/data/site-profiles";
describe("demo site profiles", () => {
  it("returns the requested profile by id", () => {
    const profile = DEMO_SITE_PROFILES[1] ?? DEMO_SITE_PROFILES[0];

    expect(findSiteProfile(profile.id)).toBe(profile);
  });

  it("falls back to the first profile for unknown ids", () => {
    expect(findSiteProfile("missing-site")).toBe(DEMO_SITE_PROFILES[0]);
  });

  it("includes a long-tail page set for demo pagination", () => {
    const newsPortal = findSiteProfile("demo-site-003");

    expect(newsPortal.paths.length).toBeGreaterThan(25);
    expect(newsPortal.titles).toHaveLength(newsPortal.paths.length);
  });
});
