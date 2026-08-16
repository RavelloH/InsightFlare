import { RiExternalLinkLine, RiLinksLine } from "@remixicon/react";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PageHeading } from "@/components/dashboard/page-heading";
import { PublicLinkCopyButton } from "@/components/dashboard/public-link-copy-button";
import { PublicLinkSettingsButton } from "@/components/dashboard/public-link-settings-button";
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
import { canManageTeam } from "@/lib/dashboard/permissions";
import { loadRequestOrigin } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
import Link from "@/lib/router";

export const Route = createFileRoute("/$locale/app/$teamSlug/public-links")({
  beforeLoad: ({ context }) => {
    if (
      !canManageTeam(
        context.teamContext.activeTeam.membershipRole,
        context.teamContext.user.systemRole,
      )
    ) {
      throw notFound();
    }
  },
  loader: () => loadRequestOrigin(),
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.publicLinks.title,
          match.context,
        ),
      },
    ],
  }),
  component: PublicLinksPage,
});

function PublicLinksPage() {
  const { locale, messages, teamContext } = Route.useRouteContext();
  const origin = Route.useLoaderData();
  const copy = messages.teamManagement.publicLinks;

  return (
    <div className="space-y-4">
      <PageHeading title={copy.title} subtitle={copy.subtitle} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <RiLinksLine className="size-4" />
            {copy.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {teamContext.sites.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
              <RiLinksLine className="size-8 text-muted-foreground/70" />
              <p>{copy.noSites}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.columns.site}</TableHead>
                  <TableHead>{copy.columns.domain}</TableHead>
                  <TableHead>{copy.columns.publicUrl}</TableHead>
                  <TableHead>{copy.columns.status}</TableHead>
                  <TableHead className="text-right">
                    {copy.columns.action}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teamContext.sites.map((site) => {
                  const enabled = Boolean(
                    site.publicEnabled && site.publicSlug,
                  );
                  const publicUrl = enabled
                    ? `${origin}/share/${encodeURIComponent(site.publicSlug || "")}`
                    : "";
                  const settingsHref = `/${locale}/app/${teamContext.activeTeam.slug}/${site.slug}/settings`;
                  return (
                    <TableRow key={site.id}>
                      <TableCell>
                        <div className="font-medium">{site.name}</div>
                        <div className="font-mono text-muted-foreground">
                          {site.slug}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-56 truncate">
                        {site.domain}
                      </TableCell>
                      <TableCell className="max-w-[34rem]">
                        {enabled ? (
                          <div className="flex min-w-0 items-center gap-2">
                            <Link
                              href={publicUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="min-w-0 truncate font-mono text-xs text-primary underline-offset-4 hover:underline"
                            >
                              {publicUrl}
                            </Link>
                            <RiExternalLinkLine className="size-4 shrink-0 text-muted-foreground" />
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {copy.disabledHint}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={enabled ? "default" : "secondary"}>
                          {enabled ? copy.enabled : copy.disabled}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          {enabled ? (
                            <PublicLinkCopyButton
                              value={publicUrl}
                              label={copy.copyLink}
                              copiedLabel={copy.linkCopied}
                            />
                          ) : null}
                          <PublicLinkSettingsButton
                            href={settingsHref}
                            label={copy.viewSettings}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
