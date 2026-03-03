"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { PageHeading } from "@/components/dashboard/page-heading";
import { shortDateTime } from "@/lib/dashboard/format";
import type { MemberData, SiteData, TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";

type TeamTab = "sites" | "settings" | "members";

interface TeamManagementClientProps {
  locale: Locale;
  messages: AppMessages;
  activeTeam: TeamData;
  activeTab: TeamTab;
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

function buildSitePath(
  locale: Locale,
  teamSlug: string,
  siteSlug: string,
): string {
  return `/${locale}/app/${teamSlug}/${siteSlug}`;
}

async function fetchTeamSites(
  teamId: string,
): Promise<Array<SiteData & { slug: string }>> {
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
  const payload = (await response.json()) as {
    ok: boolean;
    data?: MemberData[];
  };
  return Array.isArray(payload.data) ? payload.data : [];
}

interface ActionResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ActionResponse<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.message || payload.error || "request_failed");
  }
  return payload.data;
}

export function TeamManagementClient({
  locale,
  messages,
  activeTeam,
  activeTab,
}: TeamManagementClientProps) {
  const router = useRouter();
  const copy = messages.teamManagement;
  const [sites, setSites] = useState<Array<SiteData & { slug: string }>>([]);
  const [members, setMembers] = useState<MemberData[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentTeamName, setCurrentTeamName] = useState(activeTeam.name);
  const [teamName, setTeamName] = useState(activeTeam.name);
  const [teamSlug, setTeamSlug] = useState(activeTeam.slug);
  const [memberIdentifier, setMemberIdentifier] = useState("");
  const [savingTeam, setSavingTeam] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

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

  useEffect(() => {
    setCurrentTeamName(activeTeam.name);
    setTeamName(activeTeam.name);
    setTeamSlug(activeTeam.slug);
    setMemberIdentifier("");
  }, [activeTeam.id, activeTeam.name, activeTeam.slug]);

  async function refreshMembers() {
    const nextMembers = await fetchTeamMembers(activeTeam.id);
    setMembers(nextMembers);
  }

  async function handleSaveTeamSettings() {
    const name = teamName.trim();
    const slug = teamSlug.trim();
    if (name.length < 2) {
      toast.error(copy.toasts.invalidTeamName);
      return;
    }

    setSavingTeam(true);
    try {
      const updated = await postJson<TeamData>("/api/admin/team", {
        teamId: activeTeam.id,
        name,
        slug: slug || undefined,
      });
      setCurrentTeamName(updated.name);
      setTeamName(updated.name);
      setTeamSlug(updated.slug);
      toast.success(copy.toasts.teamSaved);

      if (updated.slug !== activeTeam.slug) {
        navigateWithTransition(router, `/${locale}/app/${updated.slug}`);
      } else {
        router.refresh();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.teamSaveFailed;
      toast.error(message || copy.toasts.teamSaveFailed);
    } finally {
      setSavingTeam(false);
    }
  }

  async function handleAddMember() {
    const identifier = memberIdentifier.trim();
    if (identifier.length < 2) {
      toast.error(copy.toasts.invalidMemberIdentifier);
      return;
    }

    setAddingMember(true);
    try {
      await postJson("/api/admin/member", {
        teamId: activeTeam.id,
        identifier,
      });
      setMemberIdentifier("");
      await refreshMembers();
      toast.success(copy.toasts.memberAdded);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.memberAddFailed;
      toast.error(message || copy.toasts.memberAddFailed);
    } finally {
      setAddingMember(false);
    }
  }

  async function handleRemoveMember(userId: string) {
    setRemovingMemberId(userId);
    try {
      await postJson("/api/admin/member", {
        intent: "remove",
        teamId: activeTeam.id,
        userId,
      });
      await refreshMembers();
      toast.success(copy.toasts.memberRemoved);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.memberRemoveFailed;
      toast.error(message || copy.toasts.memberRemoveFailed);
    } finally {
      setRemovingMemberId(null);
    }
  }

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

  return (
    <div className="space-y-6">
      <PageHeading
        title={`${copy.title} · ${currentTeamName}`}
        subtitle={copy.subtitle}
        actions={
          <>
            <Badge variant="outline">
              <span className="inline-flex items-center gap-1.5">
                {copy.stats.sites}:
                <AutoTransition initial className="inline-flex items-center">
                  {loading ? (
                    <span key="sites-loading" className="inline-flex items-center">
                      <Spinner className="size-3.5" />
                    </span>
                  ) : (
                    <span key="sites-value">{sites.length}</span>
                  )}
                </AutoTransition>
              </span>
            </Badge>
            <Badge variant="outline">
              <span className="inline-flex items-center gap-1.5">
                {copy.stats.members}:
                <AutoTransition initial className="inline-flex items-center">
                  {loading ? (
                    <span key="members-loading" className="inline-flex items-center">
                      <Spinner className="size-3.5" />
                    </span>
                  ) : (
                    <span key="members-value">{memberCount}</span>
                  )}
                </AutoTransition>
              </span>
            </Badge>
          </>
        }
      />

      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight">
            {panelTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{panelSubtitle}</p>
        </div>

        {activeTab === "sites" ? (
          <Card>
            <CardHeader>
              <CardTitle>{copy.sites.title}</CardTitle>
              <CardDescription>{copy.sites.subtitle}</CardDescription>
            </CardHeader>
            <CardContent>
              <DataTableSwitch
                loading={loading}
                hasContent={sites.length > 0}
                loadingLabel={messages.common.loading}
                emptyLabel={copy.sites.noSites}
                colSpan={5}
                header={(
                  <TableRow>
                    <TableHead>{copy.sites.columns.name}</TableHead>
                    <TableHead>{copy.sites.columns.domain}</TableHead>
                    <TableHead>{copy.sites.columns.slug}</TableHead>
                    <TableHead>{copy.sites.columns.createdAt}</TableHead>
                    <TableHead className="text-right">
                      {copy.sites.columns.action}
                    </TableHead>
                  </TableRow>
                )}
                rows={sites.map((site) => (
                  <TableRow key={site.id}>
                    <TableCell className="font-medium">
                      {site.name}
                    </TableCell>
                    <TableCell className="font-mono">
                      {site.domain}
                    </TableCell>
                    <TableCell className="font-mono">{site.slug}</TableCell>
                    <TableCell>
                      {shortDateTime(locale, site.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="xs">
                        <Link
                          href={buildSitePath(
                            locale,
                            activeTeam.slug,
                            site.slug,
                          )}
                        >
                          {copy.sites.openAnalytics}
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              />
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
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSaveTeamSettings();
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="team-name">{copy.settings.nameLabel}</Label>
                  <Input
                    id="team-name"
                    value={teamName}
                    onChange={(event) => setTeamName(event.target.value)}
                    minLength={2}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="team-slug">{copy.settings.slugLabel}</Label>
                  <Input
                    id="team-slug"
                    value={teamSlug}
                    onChange={(event) => setTeamSlug(event.target.value)}
                  />
                </div>

                <Button type="submit" disabled={savingTeam}>
                  <AutoTransition className="inline-flex items-center gap-2">
                    {savingTeam ? (
                      <span key="saving" className="inline-flex items-center gap-2">
                        <Spinner className="size-4" />
                        {copy.settings.saving}
                      </span>
                    ) : (
                      <span key="save">{copy.settings.save}</span>
                    )}
                  </AutoTransition>
                </Button>
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
                <form
                  className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleAddMember();
                  }}
                >
                  <div className="space-y-2">
                    <Label htmlFor="member-identifier">
                      {copy.members.identifierLabel}
                    </Label>
                    <Input
                      id="member-identifier"
                      value={memberIdentifier}
                      onChange={(event) =>
                        setMemberIdentifier(event.target.value)
                      }
                      placeholder={copy.members.identifierPlaceholder}
                      minLength={2}
                      required
                    />
                  </div>
                  <Button type="submit" disabled={addingMember}>
                    <AutoTransition className="inline-flex items-center gap-2">
                      {addingMember ? (
                        <span key="adding" className="inline-flex items-center gap-2">
                          <Spinner className="size-4" />
                          {copy.members.adding}
                        </span>
                      ) : (
                        <span key="add">{copy.members.add}</span>
                      )}
                    </AutoTransition>
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <DataTableSwitch
                  loading={loading}
                  hasContent={members.length > 0}
                  loadingLabel={messages.common.loading}
                  emptyLabel={copy.members.noMembers}
                  colSpan={6}
                  header={(
                    <TableRow>
                      <TableHead>{copy.members.columns.name}</TableHead>
                      <TableHead>{copy.members.columns.username}</TableHead>
                      <TableHead>{copy.members.columns.email}</TableHead>
                      <TableHead>{copy.members.columns.role}</TableHead>
                      <TableHead>{copy.members.columns.joinedAt}</TableHead>
                      <TableHead className="text-right">
                        {copy.members.columns.action}
                      </TableHead>
                    </TableRow>
                  )}
                  rows={members.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell className="font-medium">
                        {member.name || member.username}
                      </TableCell>
                      <TableCell>{member.username}</TableCell>
                      <TableCell>{member.email}</TableCell>
                      <TableCell>{member.role}</TableCell>
                      <TableCell>
                        {shortDateTime(locale, member.joinedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="destructive"
                          size="xs"
                          onClick={() => {
                            void handleRemoveMember(member.userId);
                          }}
                          disabled={removingMemberId === member.userId}
                        >
                          <AutoTransition className="inline-flex items-center gap-2">
                            {removingMemberId === member.userId ? (
                              <span key="removing" className="inline-flex items-center gap-2">
                                <Spinner className="size-4" />
                                {copy.members.removing}
                              </span>
                            ) : (
                              <span key="remove">{copy.members.remove}</span>
                            )}
                          </AutoTransition>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
