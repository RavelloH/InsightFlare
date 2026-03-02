import Link from "next/link";
import { redirect } from "next/navigation";
import { Copy, Globe2, Shield, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { CreateSiteDialog } from "@/components/teams/create-site-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import {
  fetchAdminMembers,
  fetchAdminSites,
  fetchAdminTeams,
} from "@/lib/edge-client";

export default async function TeamHomePage({
  params,
}: {
  params: Promise<{ locale: string; teamId: string }>;
}) {
  const { locale: rawLocale, teamId } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;

  const teams = await fetchAdminTeams();
  const team = teams.find((tm) => tm.id === teamId);

  if (!team) {
    redirect(`/${locale}/app`);
  }

  const sites = await fetchAdminSites(teamId);
  const members = await fetchAdminMembers(teamId);
  const edgeBase =
    process.env.INSIGHTFLARE_EDGE_URL || "http://127.0.0.1:8787";

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{team.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("teams.description")}
          </p>
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
          <CreateSiteDialog
            teamId={teamId}
            labels={{
              createSite: t("teams.createSite"),
              siteName: t("teams.siteName"),
              domain: t("teams.domain"),
              publicSlug: t("teams.publicSlug"),
              enablePublic: t("teams.enablePublic"),
              create: t("common.create"),
            }}
          />
        </div>
      </div>

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
              <p className="text-sm text-muted-foreground">
                {t("teams.noSites")}
              </p>
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
                        <Link
                          className="font-medium text-primary hover:underline"
                          href={`/${locale}/app/${teamId}/${site.id}`}
                        >
                          {site.name}
                        </Link>
                      </TableCell>
                      <TableCell>{site.domain}</TableCell>
                      <TableCell>
                        {Number(site.publicEnabled) === 1 ? (
                          <Badge>
                            {site.publicSlug || t("teams.enabled")}
                          </Badge>
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
              <p className="text-sm text-muted-foreground">
                {t("teams.noSnippets")}
              </p>
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
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <span className="bg-def-200 rounded-lg p-1 inline-flex">
                <Shield className="h-4 w-4" />
              </span>
              {t("teams.teamMembers")}
            </CardTitle>
            <Link
              href={`/${locale}/app/${teamId}/members`}
              className="text-sm text-primary hover:underline"
            >
              {t("teams.viewAllMembers") ?? "View all"}
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("teams.noMembers")}
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {members.length} {t("teams.teamMembers").toLowerCase()}
              </p>
              <div className="flex flex-wrap gap-2">
                {members.slice(0, 5).map((member) => (
                  <Badge key={member.userId} variant="outline">
                    <Users className="mr-1 h-3 w-3" />
                    {member.name || member.username}
                    {member.role === "owner" && (
                      <span className="ml-1 text-xs opacity-60">
                        ({t("teams.owner")})
                      </span>
                    )}
                  </Badge>
                ))}
                {members.length > 5 && (
                  <Badge variant="outline">
                    +{members.length - 5}
                  </Badge>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
