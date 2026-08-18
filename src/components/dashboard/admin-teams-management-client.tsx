import { useEffect, useState } from "react";
import {
  RiAddLine,
  RiArrowRightLine,
  RiFileList3Line,
  RiSettings3Line,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { PageHeading } from "@/components/dashboard/page-heading";
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
import type { TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";
import { extractErrorMessage } from "@/lib/response-envelope";
import { useRouter } from "@/lib/router";

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

async function fetchTeams(signal?: AbortSignal): Promise<TeamData[]> {
  if (import.meta.env.VITE_DEMO_MODE === "1") {
    const { demoRequest } = await import("@/lib/realtime/mock");
    const result = demoRequest({
      path: "/api/private/admin/teams",
    }) as ApiResponse<TeamData[]>;
    return Array.isArray(result.data) ? result.data : [];
  }
  const response = await fetch("/api/private/admin/teams", {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    signal,
  });
  const payload = (await response.json()) as ApiResponse<TeamData[]>;
  if (!response.ok || !payload.ok || !Array.isArray(payload.data)) {
    throw new Error(extractErrorMessage(payload, "load_teams_failed"));
  }
  return payload.data;
}

export function AdminTeamsManagementClient({
  locale,
  messages,
}: AdminTeamsManagementClientProps) {
  const { timeZone } = useDashboardQueryControls();
  const router = useRouter();
  const t = messages.adminTeams;
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const teamsQuery = useQuery({
    queryKey: ["dashboard", "admin-teams"],
    queryFn: ({ signal }) => fetchTeams(signal),
    enabled: typeof window !== "undefined",
  });
  const teams = teamsQuery.data ?? [];
  const loading = teamsQuery.isPending;

  useEffect(() => {
    if (!teamsQuery.isError) return;
    const message =
      teamsQuery.error instanceof Error
        ? teamsQuery.error.message
        : t.loadFailed;
    toast.error(message || t.loadFailed);
  }, [
    t.loadFailed,
    teamsQuery.error,
    teamsQuery.errorUpdatedAt,
    teamsQuery.isError,
  ]);

  async function refreshTeams() {
    await teamsQuery.refetch();
  }

  async function handleCreateTeam() {
    if (name.trim().length < 2) {
      toast.error(t.invalidInput);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/private/admin/teams", {
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
        throw new Error(extractErrorMessage(payload, t.createFailed));
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
      <PageHeading title={t.title} subtitle={t.subtitle} />

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
            hasContent={teams.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={6}
            header={
              <TableRow>
                <TableHead>{t.columns.name}</TableHead>
                <TableHead>{t.columns.slug}</TableHead>
                <TableHead className="text-right">{t.columns.sites}</TableHead>
                <TableHead className="text-right">
                  {t.columns.members}
                </TableHead>
                <TableHead>{t.columns.created}</TableHead>
                <TableHead className="text-right">{t.columns.action}</TableHead>
              </TableRow>
            }
            rows={teams.map((team) => (
              <TableRow key={team.id}>
                <TableCell className="font-medium">{team.name}</TableCell>
                <TableCell className="font-mono">{team.slug}</TableCell>
                <TableCell className="text-right">{team.siteCount}</TableCell>
                <TableCell className="text-right">{team.memberCount}</TableCell>
                <TableCell>
                  {shortDateTime(locale, team.createdAt, timeZone)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex items-center justify-end gap-2">
                    <TableActionButton
                      onClick={() => {
                        navigateWithTransition(
                          router,
                          `/${locale}/app/${team.slug}`,
                        );
                      }}
                      label={t.open}
                    >
                      <RiArrowRightLine className="size-4" />
                    </TableActionButton>
                    <TableActionButton
                      onClick={() => {
                        navigateWithTransition(
                          router,
                          `/${locale}/app/${team.slug}/settings`,
                        );
                      }}
                      label={t.settings}
                    >
                      <RiSettings3Line className="size-4" />
                    </TableActionButton>
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
