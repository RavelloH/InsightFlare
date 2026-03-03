"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeading } from "@/components/dashboard/page-heading";
import { shortDateTime } from "@/lib/dashboard/format";
import type { MemberData, SiteData, TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";

type TeamTab = "sites" | "settings" | "members";

interface TeamManagementClientProps {
  locale: Locale;
  activeTeam: TeamData;
  activeTab: TeamTab;
  settingsReturnTo: string;
  membersReturnTo: string;
  hasError: boolean;
  errorMessage?: string;
  showSaved: boolean;
}

interface TeamPageCopy {
  title: string;
  subtitle: string;
  stats: {
    sites: string;
    members: string;
  };
  alerts: {
    saved: string;
    saveFailed: string;
    saveFailedFallback: string;
  };
  sites: {
    title: string;
    subtitle: string;
    noSites: string;
    openAnalytics: string;
    columns: {
      name: string;
      domain: string;
      slug: string;
      createdAt: string;
      action: string;
    };
  };
  settings: {
    title: string;
    subtitle: string;
    nameLabel: string;
    slugLabel: string;
    save: string;
  };
  members: {
    title: string;
    subtitle: string;
    identifierLabel: string;
    identifierPlaceholder: string;
    add: string;
    remove: string;
    noMembers: string;
    columns: {
      name: string;
      username: string;
      email: string;
      role: string;
      joinedAt: string;
      action: string;
    };
  };
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getSiteSlug(site: SiteData): string {
  const primary = String(site.publicSlug || "").trim();
  const domain = String(site.domain || "").trim();
  const name = String(site.name || "").trim();
  const candidate = safeSlug(primary || domain || name);
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}

function withSiteSlug(site: SiteData): SiteData & { slug: string } {
  return {
    ...site,
    slug: getSiteSlug(site),
  };
}

function buildSitePath(locale: Locale, teamSlug: string, siteSlug: string): string {
  return `/${locale}/app/${teamSlug}/${siteSlug}`;
}

function getTeamPageCopy(locale: Locale): TeamPageCopy {
  if (locale === "zh") {
    return {
      title: "团队管理",
      subtitle: "管理该团队下的站点、基础设置和成员权限。",
      stats: {
        sites: "站点",
        members: "成员",
      },
      alerts: {
        saved: "团队设置已保存。",
        saveFailed: "保存失败",
        saveFailedFallback: "请求未完成，请稍后重试。",
      },
      sites: {
        title: "站点列表",
        subtitle: "查看这个团队下的全部站点，并进入对应分析页面。",
        noSites: "当前团队还没有站点。",
        openAnalytics: "查看分析",
        columns: {
          name: "显示名",
          domain: "域名",
          slug: "Slug",
          createdAt: "创建时间",
          action: "操作",
        },
      },
      settings: {
        title: "团队设置",
        subtitle: "更新团队显示名和 slug。",
        nameLabel: "团队显示名",
        slugLabel: "团队 Slug",
        save: "保存设置",
      },
      members: {
        title: "成员管理",
        subtitle: "添加成员或移除成员。",
        identifierLabel: "用户名或邮箱",
        identifierPlaceholder: "例如：alice 或 alice@example.com",
        add: "添加成员",
        remove: "移除",
        noMembers: "当前团队暂无成员。",
        columns: {
          name: "名称",
          username: "用户名",
          email: "邮箱",
          role: "角色",
          joinedAt: "加入时间",
          action: "操作",
        },
      },
    };
  }

  return {
    title: "Team Management",
    subtitle: "Manage sites, base settings, and member access for this team.",
    stats: {
      sites: "Sites",
      members: "Members",
    },
    alerts: {
      saved: "Team settings saved.",
      saveFailed: "Save failed",
      saveFailedFallback: "Request did not complete. Please try again.",
    },
    sites: {
      title: "Sites",
      subtitle: "View every site under this team and open each analytics dashboard.",
      noSites: "No site is available under this team.",
      openAnalytics: "Open analytics",
      columns: {
        name: "Display Name",
        domain: "Domain",
        slug: "Slug",
        createdAt: "Created",
        action: "Action",
      },
    },
    settings: {
      title: "Settings",
      subtitle: "Update this team's display name and slug.",
      nameLabel: "Team Display Name",
      slugLabel: "Team Slug",
      save: "Save settings",
    },
    members: {
      title: "Members",
      subtitle: "Add members or remove existing members.",
      identifierLabel: "Username or Email",
      identifierPlaceholder: "For example: alice or alice@example.com",
      add: "Add member",
      remove: "Remove",
      noMembers: "No members found for this team.",
      columns: {
        name: "Name",
        username: "Username",
        email: "Email",
        role: "Role",
        joinedAt: "Joined",
        action: "Action",
      },
    },
  };
}

async function fetchTeamSites(teamId: string): Promise<Array<SiteData & { slug: string }>> {
  const url = `/api/private/admin/sites?teamId=${encodeURIComponent(teamId)}`;
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("fetch_team_sites_failed");
  const payload = (await response.json()) as { ok: boolean; data?: SiteData[] };
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.map(withSiteSlug);
}

async function fetchTeamMembers(teamId: string): Promise<MemberData[]> {
  const url = `/api/private/admin/members?teamId=${encodeURIComponent(teamId)}`;
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("fetch_team_members_failed");
  const payload = (await response.json()) as { ok: boolean; data?: MemberData[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

export function TeamManagementClient({
  locale,
  activeTeam,
  activeTab,
  settingsReturnTo,
  membersReturnTo,
  hasError,
  errorMessage,
  showSaved,
}: TeamManagementClientProps) {
  const copy = getTeamPageCopy(locale);
  const [sites, setSites] = useState<Array<SiteData & { slug: string }>>([]);
  const [members, setMembers] = useState<MemberData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      fetchTeamSites(activeTeam.id).catch(() => []),
      activeTab === "members"
        ? fetchTeamMembers(activeTeam.id).catch(() => [])
        : Promise.resolve([]),
    ])
      .then(([nextSites, nextMembers]) => {
        if (!active) return;
        setSites(nextSites);
        setMembers(nextMembers);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeTeam.id, activeTab]);

  const memberCount = useMemo(
    () => (activeTab === "members" ? members.length : activeTeam.memberCount),
    [activeTab, members.length, activeTeam.memberCount],
  );

  const panelTitle =
    activeTab === "sites"
      ? copy.sites.title
      : activeTab === "settings"
        ? copy.settings.title
        : copy.members.title;
  const panelSubtitle =
    activeTab === "sites"
      ? copy.sites.subtitle
      : activeTab === "settings"
        ? copy.settings.subtitle
        : copy.members.subtitle;

  const tableEmptyText = loading ? (locale === "zh" ? "加载中" : "Loading") : copy.sites.noSites;
  const membersEmptyText = loading ? (locale === "zh" ? "加载中" : "Loading") : copy.members.noMembers;

  return (
    <div className="space-y-6">
      <PageHeading
        title={`${copy.title} · ${activeTeam.name}`}
        subtitle={copy.subtitle}
        actions={(
          <>
            <Badge variant="outline">
              {copy.stats.sites}: {sites.length}
            </Badge>
            <Badge variant="outline">
              {copy.stats.members}: {memberCount}
            </Badge>
          </>
        )}
      />

      {hasError ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.alerts.saveFailed}</AlertTitle>
          <AlertDescription>{errorMessage || copy.alerts.saveFailedFallback}</AlertDescription>
        </Alert>
      ) : null}

      {showSaved ? (
        <Alert>
          <AlertTitle>{copy.alerts.saved}</AlertTitle>
        </Alert>
      ) : null}

      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight">{panelTitle}</h2>
          <p className="text-sm text-muted-foreground">{panelSubtitle}</p>
        </div>

        {activeTab === "sites" ? (
          <Card>
            <CardHeader>
              <CardTitle>{copy.sites.title}</CardTitle>
              <CardDescription>{copy.sites.subtitle}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.sites.columns.name}</TableHead>
                    <TableHead>{copy.sites.columns.domain}</TableHead>
                    <TableHead>{copy.sites.columns.slug}</TableHead>
                    <TableHead>{copy.sites.columns.createdAt}</TableHead>
                    <TableHead className="text-right">{copy.sites.columns.action}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        {tableEmptyText}
                      </TableCell>
                    </TableRow>
                  ) : (
                    sites.map((site) => (
                      <TableRow key={site.id}>
                        <TableCell className="font-medium">{site.name}</TableCell>
                        <TableCell className="font-mono">{site.domain}</TableCell>
                        <TableCell className="font-mono">{site.slug}</TableCell>
                        <TableCell>{shortDateTime(locale, site.createdAt)}</TableCell>
                        <TableCell className="text-right">
                          <Button asChild size="xs">
                            <Link href={buildSitePath(locale, activeTeam.slug, site.slug)}>
                              {copy.sites.openAnalytics}
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : null}

        {activeTab === "settings" ? (
          <Card className="max-w-2xl">
            <CardHeader>
              <CardTitle>{copy.settings.title}</CardTitle>
              <CardDescription>{copy.settings.subtitle}</CardDescription>
            </CardHeader>
            <CardContent>
              <form action="/api/admin/team" method="post" className="space-y-4">
                <input type="hidden" name="returnTo" value={settingsReturnTo} />
                <input type="hidden" name="teamId" value={activeTeam.id} />

                <div className="space-y-2">
                  <Label htmlFor="team-name">{copy.settings.nameLabel}</Label>
                  <Input id="team-name" name="name" defaultValue={activeTeam.name} minLength={2} required />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="team-slug">{copy.settings.slugLabel}</Label>
                  <Input id="team-slug" name="slug" defaultValue={activeTeam.slug} />
                </div>

                <Button type="submit">{copy.settings.save}</Button>
              </form>
            </CardContent>
          </Card>
        ) : null}

        {activeTab === "members" ? (
          <div className="space-y-4">
            <Card className="max-w-2xl">
              <CardHeader>
                <CardTitle>{copy.members.title}</CardTitle>
                <CardDescription>{copy.members.subtitle}</CardDescription>
              </CardHeader>
              <CardContent>
                <form action="/api/admin/member" method="post" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <input type="hidden" name="returnTo" value={membersReturnTo} />
                  <input type="hidden" name="teamId" value={activeTeam.id} />
                  <div className="space-y-2">
                    <Label htmlFor="member-identifier">{copy.members.identifierLabel}</Label>
                    <Input
                      id="member-identifier"
                      name="identifier"
                      placeholder={copy.members.identifierPlaceholder}
                      minLength={2}
                      required
                    />
                  </div>
                  <Button type="submit">{copy.members.add}</Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{copy.members.columns.name}</TableHead>
                      <TableHead>{copy.members.columns.username}</TableHead>
                      <TableHead>{copy.members.columns.email}</TableHead>
                      <TableHead>{copy.members.columns.role}</TableHead>
                      <TableHead>{copy.members.columns.joinedAt}</TableHead>
                      <TableHead className="text-right">{copy.members.columns.action}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">
                          {membersEmptyText}
                        </TableCell>
                      </TableRow>
                    ) : (
                      members.map((member) => (
                        <TableRow key={member.userId}>
                          <TableCell className="font-medium">{member.name || member.username}</TableCell>
                          <TableCell>{member.username}</TableCell>
                          <TableCell>{member.email}</TableCell>
                          <TableCell>{member.role}</TableCell>
                          <TableCell>{shortDateTime(locale, member.joinedAt)}</TableCell>
                          <TableCell className="text-right">
                            <form action="/api/admin/member" method="post" className="inline-flex">
                              <input type="hidden" name="intent" value="remove" />
                              <input type="hidden" name="returnTo" value={membersReturnTo} />
                              <input type="hidden" name="teamId" value={activeTeam.id} />
                              <input type="hidden" name="userId" value={member.userId} />
                              <Button type="submit" variant="destructive" size="xs">
                                {copy.members.remove}
                              </Button>
                            </form>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
