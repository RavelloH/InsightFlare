import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RiExternalLinkLine, RiLinksLine } from "@remixicon/react";

import { PageHeading } from "@/components/dashboard/page-heading";
import { PublicLinkCopyButton } from "@/components/dashboard/public-link-copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { getDashboardTeamContext } from "@/lib/dashboard/server";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface TeamPublicLinksPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
  }>;
}

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  if (!host) return "";
  const proto =
    h.get("x-forwarded-proto") ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  return `${proto}://${host}`;
}

export async function generateMetadata({ params }: TeamPublicLinksPageProps) {
  const { locale } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);

  return {
    title: messages.teamManagement.publicLinks.title,
  };
}

export default async function TeamPublicLinksPage({
  params,
}: TeamPublicLinksPageProps) {
  const { locale, teamSlug } = await params;
  const resolvedLocale = resolveLocale(locale);
  const messages = getMessages(resolvedLocale);
  const context = await getDashboardTeamContext(teamSlug);

  if (
    !context ||
    !canManageTeam(context.activeTeam.membershipRole, context.user.systemRole)
  ) {
    notFound();
  }

  const copy = messages.teamManagement.publicLinks;
  const origin = await requestOrigin();

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
          {context.sites.length === 0 ? (
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
                {context.sites.map((site) => {
                  const enabled = Boolean(
                    site.publicEnabled && site.publicSlug,
                  );
                  const publicUrl = enabled
                    ? `${origin}/${resolvedLocale}/share/${encodeURIComponent(
                        site.publicSlug || "",
                      )}`
                    : "";
                  const settingsHref = `/${resolvedLocale}/app/${context.activeTeam.slug}/${site.slug}/settings`;

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
                          <span className="text-sm text-muted-foreground">
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
                        <div className="flex justify-end gap-1">
                          {enabled ? (
                            <PublicLinkCopyButton
                              value={publicUrl}
                              label={copy.copyLink}
                              copiedLabel={copy.linkCopied}
                            />
                          ) : null}
                          <Button asChild variant="outline" size="sm">
                            <Link href={settingsHref}>{copy.viewSettings}</Link>
                          </Button>
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
