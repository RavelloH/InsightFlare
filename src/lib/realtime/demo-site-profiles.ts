// ---------------------------------------------------------------------------
//  Demo site profiles
// ---------------------------------------------------------------------------

import { DEMO_SITE_PROFILES_PART_1 } from "./demo-site-profiles-part-1";
import { DEMO_SITE_PROFILES_PART_2 } from "./demo-site-profiles-part-2";
import { DEMO_SITE_PROFILES_PART_3 } from "./demo-site-profiles-part-3";
import type { DemoSiteProfile } from "./demo-site-profiles-types";

export type {
  DemoSiteHourProfile,
  DemoSiteProfile,
} from "./demo-site-profiles-types";

export const DEMO_TEAMS = [
  {
    id: "demo-team-001",
    name: "XEOOS Team",
    slug: "xeoos-team",
    ownerUserId: "demo-user-001",
  },
] as const;

export const DEMO_SITE_PROFILES: DemoSiteProfile[] = [
  ...DEMO_SITE_PROFILES_PART_1,
  ...DEMO_SITE_PROFILES_PART_2,
  ...DEMO_SITE_PROFILES_PART_3,
];

function safeDemoSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function demoSitePublicSlug(profile: DemoSiteProfile): string {
  return (
    safeDemoSlug(profile.domain || profile.name || profile.id) ||
    profile.id.slice(0, 8)
  );
}

export function findSiteProfile(siteId: string): DemoSiteProfile {
  return (
    DEMO_SITE_PROFILES.find((s) => s.id === siteId) ?? DEMO_SITE_PROFILES[0]
  );
}

export function findSiteProfileByPublicSlug(
  slug: string,
): DemoSiteProfile | null {
  const normalized = safeDemoSlug(decodeURIComponent(slug));
  return (
    DEMO_SITE_PROFILES.find(
      (profile) =>
        demoSitePublicSlug(profile) === normalized ||
        safeDemoSlug(profile.id) === normalized,
    ) ?? null
  );
}
