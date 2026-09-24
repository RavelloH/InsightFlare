import type {
  ApiKeyData,
  ApiKeyScope,
} from "@/lib/dashboard-api/contract/types/admin";
import {
  DEMO_SITE_PROFILES,
  DEMO_TEAMS,
  demoSitePublicSlug,
} from "@/lib/demo/data/site-profiles";
import { fnv1a, mulberry32, sInt } from "@/lib/demo/generators/utils";
// ---------------------------------------------------------------------------
//  Admin data generators (fixed structure)
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 3600 * 1000;
const DEMO_USERS = [
  {
    id: "demo-user-001",
    username: "demo",
    email: "demo@insightflare.net",
    name: "Demo User",
    systemRole: "admin" as const,
    timeZone: "",
    teamCount: 1,
    ownedTeamCount: 1,
    createdDaysAgo: 180,
    updatedDaysAgo: 2,
  },
  {
    id: "demo-user-002",
    username: "mia",
    email: "mia@example.test",
    name: "Mia Chen",
    systemRole: "user" as const,
    timeZone: "Asia/Shanghai",
    teamCount: 1,
    ownedTeamCount: 0,
    createdDaysAgo: 90,
    updatedDaysAgo: 4,
  },
  {
    id: "demo-user-003",
    username: "alex",
    email: "alex@example.test",
    name: "Alex Rivera",
    systemRole: "user" as const,
    timeZone: "America/Los_Angeles",
    teamCount: 1,
    ownedTeamCount: 0,
    createdDaysAgo: 42,
    updatedDaysAgo: 1,
  },
  {
    id: "demo-user-004",
    username: "ops-admin",
    email: "ops@example.test",
    name: "Ops Admin",
    systemRole: "admin" as const,
    timeZone: "UTC",
    teamCount: 1,
    ownedTeamCount: 0,
    createdDaysAgo: 24,
    updatedDaysAgo: 3,
  },
] as const;
export function getDemoUsers() {
  const now = Date.now();
  return DEMO_USERS.map((user) => ({
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    systemRole: user.systemRole,
    timeZone: user.timeZone,
    preferredLocale: "" as const,
    createdAt: now - user.createdDaysAgo * DAY_MS,
    updatedAt: now - user.updatedDaysAgo * DAY_MS,
    teamCount: user.teamCount,
    ownedTeamCount: user.ownedTeamCount,
  }));
}
export function getDemoUser() {
  const user = getDemoUsers()[0];
  return {
    ...user,
  };
}
export function getDemoTeams() {
  const now = Date.now();
  return DEMO_TEAMS.map((t) => {
    const teamSites = DEMO_SITE_PROFILES.filter((s) => s.teamId === t.id);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      ownerUserId: t.ownerUserId,
      createdAt: now - 180 * DAY_MS,
      updatedAt: now - sInt(mulberry32(fnv1a(t.id)), 1, 30) * DAY_MS,
      siteCount: teamSites.length,
      memberCount: getDemoUsers().length,
      membershipRole: "owner",
    };
  });
}
export function getDemoSites(teamId: string) {
  const now = Date.now();
  return DEMO_SITE_PROFILES.filter((s) => s.teamId === teamId).map((s) => ({
    id: s.id,
    teamId: s.teamId,
    name: s.name,
    domain: s.domain,
    iconPath: s.iconPath,
    publicEnabled: true,
    publicSlug: demoSitePublicSlug(s),
    createdAt: now - 180 * DAY_MS,
    updatedAt: now - sInt(mulberry32(fnv1a(s.id)), 1, 14) * DAY_MS,
  }));
}
export function getDemoMembers(teamId: string) {
  const sites = getDemoSites(teamId);
  return getDemoUsers().map((user, index) => ({
    teamId,
    userId: user.id,
    role:
      index === 0
        ? ("owner" as const)
        : index === 3
          ? ("admin" as const)
          : ("member" as const),
    siteIds: index === 2 ? sites.slice(0, 2).map((site) => site.id) : [],
    joinedAt: user.createdAt,
    username: user.username,
    email: user.email,
    name: user.name,
  }));
}
export function generateDemoTeamInvites(teamId: string) {
  const now = nowSeconds();
  const tid = teamId || getDemoTeams()[0].id;
  return [
    {
      id: "demo-team-invite-product",
      type: "team_invite",
      teamId: tid,
      userId: "",
      email: "product@example.test",
      payload: { teamRole: "admin", siteIds: [] },
      code: "demo_product_admin_token",
      url: "https://demo.insightflare.net/invite#token=demo_product_admin_token",
      createdByUserId: getDemoUser().id,
      createdAt: now - 2 * 24 * 60 * 60,
      expiresAt: now + 5 * 24 * 60 * 60,
      usedAt: null,
      usedByUserId: "",
      revokedAt: null,
      status: "active" as const,
    },
    {
      id: "demo-team-invite-analyst",
      type: "team_invite",
      teamId: tid,
      userId: "",
      email: "",
      payload: { teamRole: "member", siteIds: [] },
      code: "demo_open_member_token",
      url: "https://demo.insightflare.net/invite#token=demo_open_member_token",
      createdByUserId: getDemoUser().id,
      createdAt: now - 6 * 60 * 60,
      expiresAt: now + 72 * 60 * 60,
      usedAt: null,
      usedByUserId: "",
      revokedAt: null,
      status: "active" as const,
    },
    {
      id: "demo-team-invite-used",
      type: "team_invite",
      teamId: tid,
      userId: "",
      email: "mia@example.test",
      payload: {
        teamRole: "member",
        siteIds: getDemoSites(tid)
          .slice(0, 1)
          .map((site) => site.id),
      },
      code: "demo_used_member_token",
      url: "https://demo.insightflare.net/invite#token=demo_used_member_token",
      createdByUserId: getDemoUser().id,
      createdAt: now - 21 * 24 * 60 * 60,
      expiresAt: now + 9 * 24 * 60 * 60,
      usedAt: now - 20 * 24 * 60 * 60,
      usedByUserId: "demo-user-002",
      revokedAt: null,
      status: "used" as const,
    },
  ];
}
export function getDemoSiteConfig() {
  return {
    trackingStrength: "smart" as const,
    trackQueryParams: true,
    trackHash: true,
    domainWhitelist: [] as string[],
    pathBlacklist: [] as string[],
    ignoreDoNotTrack: true,
    performanceSampleRate: 100,
  };
}
export function getDemoScriptSnippet(siteId: string) {
  const edgeBase =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://localhost:3000";
  const src = `${edgeBase.replace(/\/$/, "")}/script.js?siteId=${encodeURIComponent(siteId)}`;
  return {
    siteId,
    src,
    snippet: `<script defer src="${src}"></script>`,
  };
}
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
export function nextHourSeconds(now: number): number {
  return Math.floor(now / 3600) * 3600 + 3600;
}
const DEMO_API_KEY_SCOPES: ApiKeyScope[][] = [
  ["analytics:read", "site:read"],
  ["analytics:read", "site_config:read"],
  ["site:read", "site:write", "site_config:read"],
];
export function generateDemoApiKeys(teamId: string): ApiKeyData[] {
  const now = nowSeconds();
  const tid = teamId || getDemoTeams()[0].id;
  const sites = getDemoSites(tid);
  return [
    {
      id: "demo-api-key-reporting",
      teamId: tid,
      name: "Dashboard reporting",
      prefix: "if_demo_01_4f8c2a",
      scopes: DEMO_API_KEY_SCOPES[0] ?? ["analytics:read"],
      siteIds: [],
      createdByUserId: getDemoUser().id,
      expiresAt: now + 180 * 24 * 60 * 60,
      revokedAt: null,
      revokedByUserId: "",
      rotatedFromKeyId: "",
      lastUsedAt: now - 18 * 60,
      createdAt: now - 21 * 24 * 60 * 60,
      updatedAt: now - 18 * 60,
      status: "active",
    },
    {
      id: "demo-api-key-config",
      teamId: tid,
      name: "Site config automation",
      prefix: "if_demo_02_91bd73",
      scopes: DEMO_API_KEY_SCOPES[1] ?? ["site_config:read"],
      siteIds: sites.slice(0, 2).map((site) => site.id),
      createdByUserId: getDemoUser().id,
      expiresAt: now + 365 * 24 * 60 * 60,
      revokedAt: null,
      revokedByUserId: "",
      rotatedFromKeyId: "",
      lastUsedAt: now - 6 * 60 * 60,
      createdAt: now - 45 * 24 * 60 * 60,
      updatedAt: now - 6 * 60 * 60,
      status: "active",
    },
    {
      id: "demo-api-key-legacy",
      teamId: tid,
      name: "Legacy importer",
      prefix: "if_demo_03_c0ffee",
      scopes: DEMO_API_KEY_SCOPES[2] ?? ["site:read"],
      siteIds: sites.slice(0, 1).map((site) => site.id),
      createdByUserId: getDemoUser().id,
      expiresAt: null,
      revokedAt: now - 2 * 24 * 60 * 60,
      revokedByUserId: getDemoUser().id,
      rotatedFromKeyId: "",
      lastUsedAt: null,
      createdAt: now - 90 * 24 * 60 * 60,
      updatedAt: now - 2 * 24 * 60 * 60,
      status: "revoked",
    },
  ];
}
