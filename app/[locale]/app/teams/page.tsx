import { Copy, Globe2, Shield, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { CreateSiteDialog } from "@/components/teams/create-site-dialog";
import { AddMemberDialog } from "@/components/teams/add-member-dialog";
import { MemberTable } from "@/components/teams/member-table";
import { TeamSiteSelector } from "@/components/dashboard/team-site-selector";
import { EmptyState } from "@/components/shared/empty-state";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { fetchAdminMembers, fetchAdminSites, fetchAdminTeams } from "@/lib/edge-client";

interface TeamsSearchParams {
  teamId?: string;
  siteId?: string;
}

export default async function TeamsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<TeamsSearchParams>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;

  const teams = await fetchAdminTeams();
  const selectedTeamId =
    (sp.teamId && teams.some((team) => team.id === sp.teamId) ? sp.teamId : undefined) || teams[0]?.id || "";
  const sites = selectedTeamId ? await fetchAdminSites(selectedTeamId) : [];
  const members = selectedTeamId ? await fetchAdminMembers(selectedTeamId) : [];
  const edgeBase = process.env.INSIGHTFLARE_EDGE_URL || "http://127.0.0.1:8787";

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t("teams.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("teams.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CreateTeamDialog
            locale={locale}
            labels={{
              createTeam: t("teams.createTeam"),
              teamName: t("teams.teamName"),
              slug: t("teams.slug"),
              create: t("common.create"),
              cancel: t("common.cancel"),
            }}
          />
          {selectedTeamId && (
            <>
              <CreateSiteDialog
                teamId={selectedTeamId}
                labels={{
                  createSite: t("teams.createSite"),
                  siteName: t("teams.siteName"),
                  domain: t("teams.domain"),
                  publicSlug: t("teams.publicSlug"),
                  enablePublic: t("teams.enablePublic"),
                  create: t("common.create"),
                }}
              />
              <AddMemberDialog
                teamId={selectedTeamId}
                labels={{
                  addMember: t("teams.addMember"),
                  userIdentifier: t("teams.userIdentifier"),
                  identifierPlaceholder: t("teams.identifierPlaceholder"),
                  create: t("common.create"),
                }}
              />
            </>
          )}
        </div>
      </div>

      {teams.length > 0 && (
        <div>
          <TeamSiteSelector
            teams={teams}
            sites={sites}
            currentTeamId={selectedTeamId}
            currentSiteId={sp.siteId || sites[0]?.id || ""}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="bg-def-200 rounded-lg p-1 inline-flex">
                <Globe2 className="h-4 w-4" />
              </span>
              {t("teams.sites")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sites.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("teams.noSites")}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("teams.name")}</TableHead>
                    <TableHead>{t("teams.domain")}</TableHead>
                    <TableHead>{t("teams.public")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.map((site) => (
                    <TableRow key={site.id}>
                      <TableCell>
                        <a className="font-medium text-primary hover:underline" href={`/${locale}/app/settings?teamId=${selectedTeamId}&siteId=${site.id}`}>
                          {site.name}
                        </a>
                      </TableCell>
                      <TableCell>{site.domain}</TableCell>
                      <TableCell>
                        {Number(site.publicEnabled) === 1 ? (
                          <Badge>{site.publicSlug || t("teams.enabled")}</Badge>
                        ) : (
                          <Badge variant="outline">{t("teams.off")}</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="bg-def-200 rounded-lg p-1 inline-flex">
                <Copy className="h-4 w-4" />
              </span>
              {t("teams.installSnippets")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sites.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("teams.noSnippets")}</p>
            ) : (
              sites.map((site) => {
                const snippet = `<script defer src="${edgeBase}/script.js?siteId=${site.id}"></script>`;
                return (
                  <div key={site.id} className="rounded-lg border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="font-medium">{site.name}</p>
                      <Badge variant="outline">{site.domain}</Badge>
                    </div>
                    <code className="block overflow-x-auto rounded-md bg-def-100 p-3 text-xs font-mono">
                      {snippet}
                    </code>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="bg-def-200 rounded-lg p-1 inline-flex">
              <Shield className="h-4 w-4" />
            </span>
            {t("teams.teamMembers")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("teams.noMembers")}</p>
          ) : (
            <MemberTable
              members={members}
              teamId={selectedTeamId}
              labels={{
                username: t("teams.username"),
                email: t("teams.email"),
                name: t("teams.name"),
                role: t("teams.role"),
                action: t("teams.action"),
                owner: t("teams.owner"),
                remove: t("common.remove"),
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
