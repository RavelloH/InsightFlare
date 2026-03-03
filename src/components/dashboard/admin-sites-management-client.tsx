"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RiLineChartLine } from "@remixicon/react";
import type { SiteData, TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { shortDateTime } from "@/lib/dashboard/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Clickable } from "@/components/ui/clickable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { navigateWithTransition } from "@/lib/page-transition";

interface AdminSitesManagementClientProps {
  locale: Locale;
  messages: AppMessages;
  teams: TeamData[];
  defaultTeamId: string;
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
  const primary = String(site.publicSlug || "").trim();
  const domain = String(site.domain || "").trim();
  const name = String(site.name || "").trim();
  const candidate = safeSlug(primary || domain || name);
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}

async function fetchSites(teamId: string): Promise<SiteData[]> {
  const response = await fetch(`/api/private/admin/sites?teamId=${encodeURIComponent(teamId)}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  const payload = (await response.json()) as ApiResponse<SiteData[]>;
  if (!response.ok || !payload.ok || !Array.isArray(payload.data)) {
    throw new Error(payload.message || payload.error || "load_sites_failed");
  }
  return payload.data;
}

export function AdminSitesManagementClient({
  locale,
  messages,
  teams,
  defaultTeamId,
}: AdminSitesManagementClientProps) {
  const router = useRouter();
  const t = messages.adminSites;
  const [selectedTeamId, setSelectedTeamId] = useState(defaultTeamId);
  const [sites, setSites] = useState<SiteData[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [publicSlug, setPublicSlug] = useState("");

  const selectedTeam = useMemo(
    () => teams.find((team) => team.id === selectedTeamId) || teams[0],
    [teams, selectedTeamId],
  );

  useEffect(() => {
    if (!selectedTeam?.id) return;
    let active = true;
    setLoading(true);
    fetchSites(selectedTeam.id)
      .then((data) => {
        if (!active) return;
        setSites(data);
      })
      .catch((error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : t.loadFailed;
        toast.error(message || t.loadFailed);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedTeam?.id, t.loadFailed]);

  async function refreshSites() {
    if (!selectedTeam?.id) return;
    const data = await fetchSites(selectedTeam.id);
    setSites(data);
  }

  async function handleCreateSite() {
    if (!selectedTeam?.id) return;
    if (name.trim().length < 2 || domain.trim().length < 3) {
      toast.error(t.invalidInput);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/site", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          teamId: selectedTeam.id,
          name: name.trim(),
          domain: domain.trim(),
          publicSlug: publicSlug.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as ApiResponse<SiteData>;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || payload.error || t.createFailed);
      }
      setName("");
      setDomain("");
      setPublicSlug("");
      await refreshSites();
      toast.success(t.createSuccess);
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
          <CardTitle>{t.createTitle}</CardTitle>
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
              <Select
                value={selectedTeam?.id || ""}
                onValueChange={(value) => setSelectedTeamId(value)}
              >
                <SelectTrigger id="admin-site-team" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <Button type="submit" disabled={submitting || !selectedTeam}>
                <AutoTransition className="inline-flex items-center gap-2">
                  {submitting ? (
                    <span key="creating" className="inline-flex items-center gap-2">
                      <Spinner className="size-4" />
                      {t.creating}
                    </span>
                  ) : (
                    <span key="create">{t.create}</span>
                  )}
                </AutoTransition>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.listTitle}</CardTitle>
          <CardDescription>{t.listSubtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={loading}
            hasContent={sites.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={5}
            header={(
              <TableRow>
                <TableHead>{t.columns.name}</TableHead>
                <TableHead>{t.columns.domain}</TableHead>
                <TableHead>{t.columns.slug}</TableHead>
                <TableHead>{t.columns.created}</TableHead>
                <TableHead className="text-right">{t.columns.action}</TableHead>
              </TableRow>
            )}
            rows={sites.map((site) => (
              <TableRow key={site.id}>
                <TableCell className="font-medium">{site.name}</TableCell>
                <TableCell className="font-mono">{site.domain}</TableCell>
                <TableCell className="font-mono">{siteSlug(site)}</TableCell>
                <TableCell>{shortDateTime(locale, site.createdAt)}</TableCell>
                <TableCell className="text-right">
                  {selectedTeam ? (
                    <Clickable
                      onClick={() => {
                        navigateWithTransition(
                          router,
                          `/${locale}/app/${selectedTeam.slug}/${siteSlug(site)}`,
                        );
                      }}
                      className="size-6 text-muted-foreground hover:text-foreground"
                      aria-label={t.open}
                      title={t.open}
                    >
                      <RiLineChartLine className="size-4" />
                    </Clickable>
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
