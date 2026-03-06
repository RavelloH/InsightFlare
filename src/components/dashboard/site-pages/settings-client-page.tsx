"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { SiteData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
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
import { AutoTransition } from "@/components/ui/auto-transition";
import { PageHeading } from "@/components/dashboard/page-heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { navigateWithTransition } from "@/lib/page-transition";

interface SiteSettingsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  teamSlug: string;
  activeTeamId: string;
  siteSlug: string;
  teams: Array<{
    id: string;
    slug: string;
    name: string;
  }>;
  site: Pick<SiteData, "id" | "name" | "domain" | "publicSlug">;
}

interface ActionResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface ScriptSnippetPayload {
  ok: boolean;
  data?: {
    siteId: string;
    src: string;
    snippet: string;
  };
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveSiteSlug(site: Pick<SiteData, "id" | "name" | "domain" | "publicSlug">): string {
  const candidate = safeSlug(
    String(site.publicSlug || "").trim() ||
      String(site.domain || "").trim() ||
      String(site.name || "").trim(),
  );
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
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

export function SettingsClientPage({
  locale,
  messages,
  teamSlug,
  activeTeamId,
  siteSlug,
  teams,
  site,
}: SiteSettingsClientPageProps) {
  const router = useRouter();
  const copy = messages.siteSettings;
  const [name, setName] = useState(site.name);
  const [domain, setDomain] = useState(site.domain);
  const [publicSlug, setPublicSlug] = useState(site.publicSlug || "");
  const [saving, setSaving] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [currentSiteSlug, setCurrentSiteSlug] = useState(siteSlug);
  const [transferTeamId, setTransferTeamId] = useState(activeTeamId);
  const [scriptSnippet, setScriptSnippet] = useState("");
  const [loadingScript, setLoadingScript] = useState(true);

  useEffect(() => {
    let active = true;
    setLoadingScript(true);
    setScriptSnippet("");

    fetch(
      `/api/private/admin/script-snippet?siteId=${encodeURIComponent(site.id)}`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("load_script_snippet_failed");
        }
        const payload = (await response.json()) as ScriptSnippetPayload;
        if (!payload.ok || !payload.data?.snippet) {
          throw new Error("load_script_snippet_failed");
        }
        if (!active) return;
        setScriptSnippet(payload.data.snippet);
      })
      .catch(() => {
        if (!active) return;
        setScriptSnippet("");
        toast.error(copy.toasts.scriptLoadFailed);
      })
      .finally(() => {
        if (!active) return;
        setLoadingScript(false);
      });

    return () => {
      active = false;
    };
  }, [copy.toasts.scriptLoadFailed, site.id]);

  async function handleSave() {
    if (name.trim().length < 2 || domain.trim().length < 3) {
      toast.error(copy.toasts.invalidInput);
      return;
    }

    setSaving(true);
    try {
      const updated = await postJson<SiteData>("/api/admin/site", {
        intent: "update",
        siteId: site.id,
        name: name.trim(),
        domain: domain.trim(),
        publicSlug: publicSlug.trim() || undefined,
      });

      setName(updated.name);
      setDomain(updated.domain);
      setPublicSlug(updated.publicSlug || "");
      toast.success(copy.toasts.saved);

      const nextSlug = resolveSiteSlug(updated);
      if (nextSlug !== currentSiteSlug) {
        setCurrentSiteSlug(nextSlug);
        navigateWithTransition(
          router,
          `/${locale}/app/${teamSlug}/${nextSlug}/settings`,
        );
      } else {
        router.refresh();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await postJson<{ siteId: string; teamId: string; removed: boolean }>(
        "/api/admin/site",
        {
          intent: "remove",
          siteId: site.id,
        },
      );
      toast.success(copy.toasts.deleted);
      setDeleteDialogOpen(false);
      navigateWithTransition(router, `/${locale}/app/${teamSlug}`);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.deleteFailed;
      toast.error(message || copy.toasts.deleteFailed);
    } finally {
      setDeleting(false);
    }
  }

  async function handleTransfer() {
    if (!transferTeamId || transferTeamId === activeTeamId) return;

    const targetTeam = teams.find((team) => team.id === transferTeamId);
    if (!targetTeam) {
      toast.error(copy.toasts.transferFailed);
      return;
    }

    setTransferring(true);
    try {
      const updated = await postJson<SiteData>("/api/admin/site", {
        intent: "update",
        siteId: site.id,
        teamId: targetTeam.id,
      });
      toast.success(copy.toasts.transferred);
      const nextSlug = resolveSiteSlug(updated);
      navigateWithTransition(
        router,
        `/${locale}/app/${targetTeam.slug}/${nextSlug}`,
      );
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.transferFailed;
      toast.error(message || copy.toasts.transferFailed);
    } finally {
      setTransferring(false);
    }
  }

  async function handleCopyScript() {
    if (!scriptSnippet) return;
    try {
      await navigator.clipboard.writeText(scriptSnippet);
      toast.success(copy.copiedScript);
    } catch {
      toast.error(copy.toasts.scriptLoadFailed);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeading
        title={copy.title}
        subtitle={copy.subtitle}
      />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="h-full order-1">
          <CardHeader>
            <CardTitle>{copy.editTitle}</CardTitle>
            <CardDescription>{copy.editSubtitle}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="site-settings-name">{copy.nameLabel}</Label>
                <Input
                  id="site-settings-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  minLength={2}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="site-settings-domain">{copy.domainLabel}</Label>
                <Input
                  id="site-settings-domain"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  minLength={3}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="site-settings-public-slug">{copy.publicSlugLabel}</Label>
                <Input
                  id="site-settings-public-slug"
                  value={publicSlug}
                  onChange={(event) => setPublicSlug(event.target.value)}
                />
              </div>

              <Button type="submit" disabled={saving || transferring || deleting}>
                <AutoTransition className="inline-flex items-center gap-2">
                  {saving ? (
                    <span key="saving" className="inline-flex items-center gap-2">
                      <Spinner className="size-4" />
                      {copy.saving}
                    </span>
                  ) : (
                    <span key="save">{copy.save}</span>
                  )}
                </AutoTransition>
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full order-3">
          <CardHeader>
            <CardTitle>{copy.transferTitle}</CardTitle>
            <CardDescription>{copy.transferSubtitle}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleTransfer();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="site-settings-transfer-team">
                  {copy.transferTeamLabel}
                </Label>
                <Select value={transferTeamId} onValueChange={setTransferTeamId}>
                  <SelectTrigger id="site-settings-transfer-team" className="w-full">
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

              <Button
                type="submit"
                disabled={
                  saving ||
                  transferring ||
                  deleting ||
                  transferTeamId === activeTeamId
                }
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {transferring ? (
                    <span key="transferring" className="inline-flex items-center gap-2">
                      <Spinner className="size-4" />
                      {copy.transferring}
                    </span>
                  ) : (
                    <span key="transfer">{copy.transfer}</span>
                  )}
                </AutoTransition>
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full order-2">
          <CardHeader>
            <CardTitle>{copy.scriptTitle}</CardTitle>
            <CardDescription>{copy.scriptSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-3">
            <p className="text-xs text-muted-foreground">{copy.scriptHint}</p>
            <div className="border bg-muted/30 p-3">
              {loadingScript ? (
                <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-4" />
                  {copy.loadingScript}
                </div>
              ) : (
                <pre className="overflow-x-auto text-xs leading-relaxed text-foreground">
                  <code>{scriptSnippet || copy.scriptUnavailable}</code>
                </pre>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              className="mt-auto self-start"
              onClick={() => {
                void handleCopyScript();
              }}
              disabled={loadingScript || !scriptSnippet}
            >
              {copy.copyScript}
            </Button>
          </CardContent>
        </Card>

        <AlertDialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            if (deleting) return;
            setDeleteDialogOpen(open);
          }}
        >
          <Card className="h-full border-destructive/40 order-4">
            <CardHeader>
              <CardTitle>{copy.deleteTitle}</CardTitle>
              <CardDescription>{copy.deleteSubtitle}</CardDescription>
            </CardHeader>
            <CardContent className="flex h-full items-end">
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={saving || transferring || deleting}
                >
                  <AutoTransition className="inline-flex items-center gap-2">
                    {deleting ? (
                      <span key="deleting" className="inline-flex items-center gap-2">
                        <Spinner className="size-4" />
                        {copy.deleting}
                      </span>
                    ) : (
                      <span key="delete">{copy.delete}</span>
                    )}
                  </AutoTransition>
                </Button>
              </AlertDialogTrigger>
            </CardContent>
          </Card>

          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
              <AlertDialogDescription>{copy.deleteConfirm}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={transferring || deleting}>
                {messages.teamSelect.cancel}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={transferring || deleting}
                onClick={(event) => {
                  event.preventDefault();
                  void handleDelete();
                }}
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {deleting ? (
                    <span
                      key="deleting-dialog"
                      className="inline-flex items-center gap-2"
                    >
                      <Spinner className="size-4" />
                      {copy.deleting}
                    </span>
                  ) : (
                    <span key="confirm-delete">{copy.delete}</span>
                  )}
                </AutoTransition>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </div>
  );
}
