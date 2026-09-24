import type { TeamInviteData } from "@/lib/dashboard/management-data";
import {
  type AdminServiceHttpMethod,
  requestAdminService,
} from "@/lib/dashboard-api/client/admin-service";
import type { MemberData, SiteData } from "@/lib/dashboard-api/client/edge";
import type { AdminServiceRoute } from "@/lib/dashboard-api/contract/admin-service";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import type { SiteMetricChangeRates } from "./types";
export function emptyOverviewMetrics() {
  return {
    views: 0,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    bounceRate: 0,
    approximateVisitors: false,
  };
}
export function emptySiteMetricChangeRates(): SiteMetricChangeRates {
  return {
    views: null,
    visitors: null,
    sessions: null,
    bounceRate: null,
    avgDurationMs: null,
    pagesPerSession: null,
  };
}
export function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
export function changeRateClass(
  value: number | null,
  lowerIsBetter = false,
): string {
  if (value === null) return "text-muted-foreground";
  const isImprovement = lowerIsBetter ? value <= 0 : value >= 0;
  return isImprovement ? "text-emerald-600" : "text-rose-600";
}
export function epochSecondsToMs(value: number): number {
  return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
}
export function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function getSiteSlug(site: SiteData): string {
  const domain = String(site.domain || "").trim();
  const candidate = safeSlug(domain);
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}
export function withSiteSlug<T extends SiteData>(
  site: T,
): T & { slug: string } {
  return {
    ...site,
    slug: getSiteSlug(site),
  };
}
export function sortSitesForInitialOrder<
  T extends {
    id: string;
    name: string;
    overview?: { views: number; visitors: number } | null;
  },
>(sites: T[]): T[] {
  return [...sites].sort((left, right) => {
    const leftViews = left.overview?.views ?? 0;
    const rightViews = right.overview?.views ?? 0;
    const byViews = rightViews - leftViews;
    if (byViews !== 0) return byViews;

    const leftVisitors = left.overview?.visitors ?? 0;
    const rightVisitors = right.overview?.visitors ?? 0;
    const byVisitors = rightVisitors - leftVisitors;
    if (byVisitors !== 0) return byVisitors;

    const byName = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (byName !== 0) return byName;
    return left.id.localeCompare(right.id);
  });
}
export function buildSitePath(
  locale: Locale,
  teamSlug: string,
  siteSlug: string,
): string {
  return `/${locale}/app/${teamSlug}/${siteSlug}`;
}
export const SITE_CARD_MAX_TREND_POINTS = 120;
export function normalizeSiteIds(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const value of raw) {
    const siteId = String(value || "").trim();
    if (!siteId || out.includes(siteId)) continue;
    out.push(siteId);
  }
  return out;
}
export function formatCountTemplate(template: string, count: number): string {
  return template.replace("{count}", String(count));
}
export function siteAccessSummary(
  siteIds: string[],
  sites: Array<Pick<SiteData, "id" | "name" | "domain">>,
  copy: AppMessages["teamManagement"]["members"],
): string {
  if (siteIds.length === 0) return copy.siteAccessAll;
  const knownIds = new Set(sites.map((site) => site.id));
  const selectedCount =
    knownIds.size === 0
      ? siteIds.length
      : siteIds.filter((siteId) => knownIds.has(siteId)).length;
  return formatCountTemplate(
    copy.siteAccessSelected,
    Math.max(selectedCount, siteIds.length),
  );
}
export async function fetchTeamMembers(
  teamId: string,
  signal?: AbortSignal,
): Promise<MemberData[]> {
  return requestAdminService<MemberData[]>("members", {
    params: { teamId },
    signal,
  });
}
export async function fetchTeamSites(
  teamId: string,
  signal?: AbortSignal,
): Promise<SiteData[]> {
  return requestAdminService<SiteData[]>("sites", {
    params: { teamId },
    signal,
  });
}
export async function fetchTeamInvites(
  teamId: string,
  signal?: AbortSignal,
): Promise<TeamInviteData[]> {
  return requestAdminService<TeamInviteData[]>("team-invites", {
    params: { teamId },
    signal,
  });
}
export async function postJson<T>(
  route: AdminServiceRoute,
  body: Record<string, unknown>,
  method: AdminServiceHttpMethod = "POST",
): Promise<T> {
  return requestAdminService<T>(route, { method, body });
}
