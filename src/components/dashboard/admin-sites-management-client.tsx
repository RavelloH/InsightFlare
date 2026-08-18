import { useEffect, useState } from "react";
import { RiAddLine, RiFileList3Line, RiLineChartLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { TableActionButton } from "@/components/dashboard/table-action-button";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { shortDateTime } from "@/lib/dashboard/format";
import type { SiteData, TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";
import { extractErrorMessage } from "@/lib/response-envelope";
import { useRouter } from "@/lib/router";

interface AdminSitesManagementClientProps {
  locale: Locale;
  messages: AppMessages;
  activeTeam: TeamData;
}

interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function siteSlug(site: SiteData): string {
  const domain = String(site.domain || "").trim();
  const candidate = safeSlug(domain);
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}

async function fetchSites(
  teamId: string,
  signal?: AbortSignal,
): Promise<SiteData[]> {
  if (import.meta.env.VITE_DEMO_MODE === "1") {
    const { demoRequest } = await import("@/lib/realtime/mock");
    const result = demoRequest({
      path: "/api/private/admin/sites",
      params: { teamId },
    }) as ApiResponse<SiteData[]>;
    return Array.isArray(result.data) ? result.data : [];
  }
  const response = await fetch(
    `/api/private/admin/sites?teamId=${encodeURIComponent(teamId)}`,
    {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal,
    },
  );
  const payload = (await response.json()) as ApiResponse<SiteData[]>;
  if (!response.ok || !payload.ok || !Array.isArray(payload.data)) {
    throw new Error(extractErrorMessage(payload, "load_sites_failed"));
  }
  return payload.data;
}

export function AdminSitesManagementClient({
  locale,
  messages,
  activeTeam,
}: AdminSitesManagementClientProps) {
  const { timeZone } = useDashboardQueryControls();
  const router = useRouter();
  const t = messages.adminSites;
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [publicSlug, setPublicSlug] = useState("");
  const sitesQuery = useQuery({
    queryKey: ["dashboard", "admin-sites", activeTeam.id],
    queryFn: ({ signal }) => fetchSites(activeTeam.id, signal),
    enabled: typeof window !== "undefined" && Boolean(activeTeam.id),
  });
  const sites = sitesQuery.data ?? [];
  const loading = sitesQuery.isPending;

  useEffect(() => {
    if (!sitesQuery.isError) return;
    const message =
      sitesQuery.error instanceof Error
        ? sitesQuery.error.message
        : t.loadFailed;
    toast.error(message || t.loadFailed);
  }, [
    sitesQuery.error,
    sitesQuery.errorUpdatedAt,
    sitesQuery.isError,
    t.loadFailed,
  ]);

  async function handleCreateSite() {
    const team = activeTeam;
    if (!team?.id) return;
    if (name.trim().length < 2 || domain.trim().length < 3) {
      toast.error(t.invalidInput);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/private/admin/sites", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          teamId: team.id,
          name: name.trim(),
          domain: domain.trim(),
          publicSlug: publicSlug.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as ApiResponse<SiteData>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(extractErrorMessage(payload, t.createFailed));
      }
      setName("");
      setDomain("");
      setPublicSlug("");
      toast.success(t.createSuccess);
      navigateWithTransition(
        router,
        `/${locale}/app/${team.slug}/${siteSlug(payload.data)}/settings`,
      );
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : t.createFailed;
      toast.error(message || t.createFailed);
    } finally {
      setSubmitting(false);
    }
  }

  const noDataText = t.noData;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{t.title}</h2>
        <p className="text-sm text-muted-foreground">{t.subtitle}</p>
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiAddLine className="size-4" />
            {t.createTitle}
          </CardTitle>
          <CardDescription>{t.createSubtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateSite();
            }}
          >
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="admin-site-team">{t.team}</Label>
              <Input id="admin-site-team" value={activeTeam.name} readOnly />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-site-name">{t.name}</Label>
              <Input
                id="admin-site-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-site-domain">{t.domain}</Label>
              <Input
                id="admin-site-domain"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="admin-site-public-slug">{t.publicSlug}</Label>
              <Input
                id="admin-site-public-slug"
                value={publicSlug}
                onChange={(event) => setPublicSlug(event.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={submitting}>
                <AutoTransition className="inline-flex items-center gap-2">
                  {submitting ? (
                    <span
                      key="creating"
                      className="inline-flex items-center gap-2"
                    >
                      <Spinner className="size-4" />
                      {t.creating}
                    </span>
                  ) : (
                    <span
                      key="create"
                      className="inline-flex items-center gap-2"
                    >
                      <RiAddLine className="size-4" />
                      {t.create}
                    </span>
                  )}
                </AutoTransition>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiFileList3Line className="size-4" />
            {t.listTitle}
          </CardTitle>
          <CardDescription>{t.listSubtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={loading}
            hasContent={sites.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={5}
            header={
              <TableRow>
                <TableHead>{t.columns.name}</TableHead>
                <TableHead>{t.columns.domain}</TableHead>
                <TableHead>{t.columns.slug}</TableHead>
                <TableHead>{t.columns.created}</TableHead>
                <TableHead className="text-right">{t.columns.action}</TableHead>
              </TableRow>
            }
            rows={sites.map((site) => (
              <TableRow key={site.id}>
                <TableCell className="font-medium">{site.name}</TableCell>
                <TableCell className="font-mono">{site.domain}</TableCell>
                <TableCell className="font-mono">{siteSlug(site)}</TableCell>
                <TableCell>
                  {shortDateTime(locale, site.createdAt, timeZone)}
                </TableCell>
                <TableCell className="text-right">
                  {activeTeam ? (
                    <TableActionButton
                      onClick={() => {
                        navigateWithTransition(
                          router,
                          `/${locale}/app/${activeTeam.slug}/${siteSlug(site)}`,
                        );
                      }}
                      label={t.open}
                    >
                      <RiLineChartLine className="size-4" />
                    </TableActionButton>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
