"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RiArrowRightLine, RiSettings3Line } from "@remixicon/react";
import type { TeamData } from "@/lib/edge-client";
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
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { navigateWithTransition } from "@/lib/page-transition";

interface AdminTeamsManagementClientProps {
  locale: Locale;
  messages: AppMessages;
}

interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

async function fetchTeams(): Promise<TeamData[]> {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    const { handleDemoRequest } = await import("@/lib/realtime/mock");
    const result = handleDemoRequest({
      path: "/api/private/admin/teams",
    }) as ApiResponse<TeamData[]>;
    return Array.isArray(result.data) ? result.data : [];
  }
  const response = await fetch("/api/private/admin/teams", {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  const payload = (await response.json()) as ApiResponse<TeamData[]>;
  if (!response.ok || !payload.ok || !Array.isArray(payload.data)) {
    throw new Error(payload.message || payload.error || "load_teams_failed");
  }
  return payload.data;
}

export function AdminTeamsManagementClient({
  locale,
  messages,
}: AdminTeamsManagementClientProps) {
  const router = useRouter();
  const t = messages.adminTeams;
  const [teams, setTeams] = useState<TeamData[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchTeams()
      .then((data) => {
        if (!active) return;
        setTeams(data);
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
  }, [t.loadFailed]);

  async function refreshTeams() {
    const data = await fetchTeams();
    setTeams(data);
  }

  async function handleCreateTeam() {
    if (name.trim().length < 2) {
      toast.error(t.invalidInput);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/team", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as ApiResponse<TeamData>;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || payload.error || t.createFailed);
      }
      setName("");
      setSlug("");
      await refreshTeams();
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
              void handleCreateTeam();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="admin-team-name">{t.name}</Label>
              <Input
                id="admin-team-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-team-slug">{t.slug}</Label>
              <Input
                id="admin-team-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={submitting}>
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
            hasContent={teams.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={6}
            header={(
              <TableRow>
                <TableHead>{t.columns.name}</TableHead>
                <TableHead>{t.columns.slug}</TableHead>
                <TableHead className="text-right">{t.columns.sites}</TableHead>
                <TableHead className="text-right">{t.columns.members}</TableHead>
                <TableHead>{t.columns.created}</TableHead>
                <TableHead className="text-right">{t.columns.action}</TableHead>
              </TableRow>
            )}
            rows={teams.map((team) => (
              <TableRow key={team.id}>
                <TableCell className="font-medium">{team.name}</TableCell>
                <TableCell className="font-mono">{team.slug}</TableCell>
                <TableCell className="text-right">{team.siteCount}</TableCell>
                <TableCell className="text-right">{team.memberCount}</TableCell>
                <TableCell>{shortDateTime(locale, team.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex items-center justify-end gap-2">
                    <Clickable
                      onClick={() => {
                        navigateWithTransition(router, `/${locale}/app/${team.slug}`);
                      }}
                      className="size-6 text-muted-foreground hover:text-foreground"
                      aria-label={t.open}
                      title={t.open}
                    >
                      <RiArrowRightLine className="size-4" />
                    </Clickable>
                    <Clickable
                      onClick={() => {
                        navigateWithTransition(
                          router,
                          `/${locale}/app/${team.slug}/settings`,
                        );
                      }}
                      className="size-6 text-muted-foreground hover:text-foreground"
                      aria-label={t.settings}
                      title={t.settings}
                    >
                      <RiSettings3Line className="size-4" />
                    </Clickable>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
