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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { PageHeading } from "@/components/dashboard/page-heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { cn } from "@/lib/utils";
import {
  DEFAULT_SITE_SCRIPT_SETTINGS,
  formatListInput,
  normalizeSiteScriptSettings,
  parseDomainWhitelist,
  parsePathBlacklist,
  type TrackingStrength,
} from "@/lib/site-settings";

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

interface SiteConfigPayload {
  ok: boolean;
  data?: Record<string, unknown>;
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveSiteSlug(
  site: Pick<SiteData, "id" | "name" | "domain" | "publicSlug">,
): string {
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
  const [persistedName, setPersistedName] = useState(site.name);
  const [persistedDomain, setPersistedDomain] = useState(site.domain);
  const [persistedPublicSlug, setPersistedPublicSlug] = useState(
    site.publicSlug || "",
  );
  const [saving, setSaving] = useState(false);
  const [savingTrackingStrength, setSavingTrackingStrength] = useState(false);
  const [savingQueryHash, setSavingQueryHash] = useState(false);
  const [savingDomainWhitelist, setSavingDomainWhitelist] = useState(false);
  const [savingPathBlacklist, setSavingPathBlacklist] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [currentSiteSlug, setCurrentSiteSlug] = useState(siteSlug);
  const [transferTeamId, setTransferTeamId] = useState(activeTeamId);
  const [scriptSnippet, setScriptSnippet] = useState("");
  const [loadingScript, setLoadingScript] = useState(true);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [trackingStrength, setTrackingStrength] = useState<TrackingStrength>(
    DEFAULT_SITE_SCRIPT_SETTINGS.trackingStrength,
  );
  const [trackQueryParams, setTrackQueryParams] = useState(
    DEFAULT_SITE_SCRIPT_SETTINGS.trackQueryParams,
  );
  const [trackHash, setTrackHash] = useState(
    DEFAULT_SITE_SCRIPT_SETTINGS.trackHash,
  );
  const [ignoreDoNotTrack, setIgnoreDoNotTrack] = useState(
    DEFAULT_SITE_SCRIPT_SETTINGS.ignoreDoNotTrack,
  );
  const [domainWhitelistInput, setDomainWhitelistInput] = useState(
    formatListInput(DEFAULT_SITE_SCRIPT_SETTINGS.domainWhitelist),
  );
  const [pathBlacklistInput, setPathBlacklistInput] = useState(
    formatListInput(DEFAULT_SITE_SCRIPT_SETTINGS.pathBlacklist),
  );
  const [persistedSettings, setPersistedSettings] = useState(
    DEFAULT_SITE_SCRIPT_SETTINGS,
  );

  const trackingSaving =
    savingTrackingStrength ||
    savingQueryHash ||
    savingDomainWhitelist ||
    savingPathBlacklist;

  function equalStringArray(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  const hasSiteInfoChanges =
    name.trim() !== persistedName.trim() ||
    domain.trim() !== persistedDomain.trim() ||
    publicSlug.trim() !== persistedPublicSlug.trim();

  const hasTrackingStrengthChanges =
    trackingStrength !== persistedSettings.trackingStrength;

  const hasQueryHashChanges =
    trackQueryParams !== persistedSettings.trackQueryParams ||
    trackHash !== persistedSettings.trackHash ||
    ignoreDoNotTrack !== persistedSettings.ignoreDoNotTrack;

  const hasDomainWhitelistChanges = !equalStringArray(
    parseDomainWhitelist(domainWhitelistInput),
    persistedSettings.domainWhitelist,
  );

  const hasPathBlacklistChanges = !equalStringArray(
    parsePathBlacklist(pathBlacklistInput),
    persistedSettings.pathBlacklist,
  );

  function applyTrackerSettings(raw: unknown) {
    const normalized = normalizeSiteScriptSettings(raw);
    setPersistedSettings(normalized);
    setTrackingStrength(normalized.trackingStrength);
    setTrackQueryParams(normalized.trackQueryParams);
    setTrackHash(normalized.trackHash);
    setIgnoreDoNotTrack(normalized.ignoreDoNotTrack);
    setDomainWhitelistInput(formatListInput(normalized.domainWhitelist));
    setPathBlacklistInput(formatListInput(normalized.pathBlacklist));
  }

  useEffect(() => {
    let active = true;
    setLoadingSettings(true);

    fetch(
      `/api/private/admin/site-config?siteId=${encodeURIComponent(site.id)}`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("load_site_config_failed");
        }
        const payload = (await response.json()) as SiteConfigPayload;
        if (!payload.ok) {
          throw new Error("load_site_config_failed");
        }
        if (!active) return;
        applyTrackerSettings(payload.data ?? DEFAULT_SITE_SCRIPT_SETTINGS);
      })
      .catch(() => {
        if (!active) return;
        applyTrackerSettings(DEFAULT_SITE_SCRIPT_SETTINGS);
        toast.error(copy.toasts.settingsLoadFailed);
      })
      .finally(() => {
        if (!active) return;
        setLoadingSettings(false);
      });

    return () => {
      active = false;
    };
  }, [copy.toasts.settingsLoadFailed, site.id]);

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
    if (!hasSiteInfoChanges) {
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
      setPersistedName(updated.name);
      setPersistedDomain(updated.domain);
      setPersistedPublicSlug(updated.publicSlug || "");
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
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function persistTrackingSettings(input: Record<string, unknown>) {
    const normalizedSettings = normalizeSiteScriptSettings({
      ...persistedSettings,
      ...input,
    });
    const savedSettings = await postJson<Record<string, unknown>>(
      "/api/admin/site-config",
      {
        siteId: site.id,
        config: normalizedSettings,
      },
    );
    applyTrackerSettings(savedSettings);
    toast.success(
      `${copy.toasts.saved} ${copy.toasts.settingsPropagationHint}`,
    );
  }

  async function handleSaveTrackingStrength() {
    if (!hasTrackingStrengthChanges) return;
    setSavingTrackingStrength(true);
    try {
      await persistTrackingSettings({
        trackingStrength,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingTrackingStrength(false);
    }
  }

  async function handleSaveQueryHash() {
    if (!hasQueryHashChanges) return;
    setSavingQueryHash(true);
    try {
      await persistTrackingSettings({
        trackQueryParams,
        trackHash,
        ignoreDoNotTrack,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingQueryHash(false);
    }
  }

  async function handleSaveDomainWhitelist() {
    if (!hasDomainWhitelistChanges) return;
    setSavingDomainWhitelist(true);
    try {
      await persistTrackingSettings({
        domainWhitelist: domainWhitelistInput,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingDomainWhitelist(false);
    }
  }

  async function handleSavePathBlacklist() {
    if (!hasPathBlacklistChanges) return;
    setSavingPathBlacklist(true);
    try {
      await persistTrackingSettings({
        pathBlacklist: pathBlacklistInput,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingPathBlacklist(false);
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
      <PageHeading title={copy.title} subtitle={copy.subtitle} />

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
                  disabled={
                    saving ||
                    trackingSaving ||
                    transferring ||
                    deleting ||
                    loadingSettings
                  }
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
                  disabled={
                    saving ||
                    trackingSaving ||
                    transferring ||
                    deleting ||
                    loadingSettings
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="site-settings-public-slug">
                  {copy.publicSlugLabel}
                </Label>
                <Input
                  id="site-settings-public-slug"
                  value={publicSlug}
                  onChange={(event) => setPublicSlug(event.target.value)}
                  disabled={
                    saving ||
                    trackingSaving ||
                    transferring ||
                    deleting ||
                    loadingSettings
                  }
                />
              </div>

              <Button
                type="submit"
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings ||
                  !hasSiteInfoChanges
                }
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {saving ? (
                    <span
                      key="saving"
                      className="inline-flex items-center gap-2"
                    >
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
                <div className="overflow-x-auto text-xs leading-relaxed text-foreground">
                  <code className="font-mono">{scriptSnippet || copy.scriptUnavailable}</code>
                </div>
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

        <Card className="h-full order-3">
          <CardHeader>
            <CardTitle>{copy.trackingStrengthGroupTitle}</CardTitle>
            <CardDescription>
              {copy.trackingStrengthDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingSettings ? (
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-4" />
                {copy.loadingSettings}
              </div>
            ) : null}
            <RadioGroup
              aria-label={copy.trackingStrengthLabel}
              value={trackingStrength}
              onValueChange={(value) => {
                setTrackingStrength(value as TrackingStrength);
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings
              }
              className="gap-2"
            >
              {[
                {
                  value: "strong" as const,
                  label: copy.trackingStrengthStrong,
                  description: copy.trackingStrengthStrongDescription,
                },
                {
                  value: "smart" as const,
                  label: copy.trackingStrengthSmart,
                  description: copy.trackingStrengthSmartDescription,
                },
                {
                  value: "weak" as const,
                  label: copy.trackingStrengthWeak,
                  description: copy.trackingStrengthWeakDescription,
                },
              ].map((item) => {
                const id = `site-settings-tracking-strength-${item.value}`;
                return (
                  <FieldLabel
                    key={item.value}
                    htmlFor={id}
                    className="cursor-pointer"
                  >
                    <Field
                      orientation="horizontal"
                      className={cn(
                        trackingStrength === item.value
                          ? "border-foreground/30 bg-muted/30"
                          : "border-border hover:bg-muted/20",
                      )}
                    >
                      <FieldContent>
                        <FieldTitle>{item.label}</FieldTitle>
                        <FieldDescription>{item.description}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem
                        id={id}
                        value={item.value}
                        className="mt-0.5"
                      />
                    </Field>
                  </FieldLabel>
                );
              })}
            </RadioGroup>
            <Button
              type="button"
              onClick={() => {
                void handleSaveTrackingStrength();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasTrackingStrengthChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingTrackingStrength ? (
                  <span
                    key="saving-strength"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span key="save-strength">{copy.saveTracking}</span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full order-4">
          <CardHeader>
            <CardTitle>{copy.queryHashGroupTitle}</CardTitle>
            <CardDescription>{copy.queryHashGroupDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="site-settings-track-query">
                {copy.trackQueryParamsLabel}
              </Label>
              <Select
                value={trackQueryParams ? "true" : "false"}
                onValueChange={(value) => {
                  setTrackQueryParams(value === "true");
                }}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              >
                <SelectTrigger
                  id="site-settings-track-query"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-settings-track-hash">
                {copy.trackHashLabel}
              </Label>
              <Select
                value={trackHash ? "true" : "false"}
                onValueChange={(value) => {
                  setTrackHash(value === "true");
                }}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              >
                <SelectTrigger id="site-settings-track-hash" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-settings-ignore-dnt">
                {copy.ignoreDoNotTrackLabel}
              </Label>
              <Select
                value={ignoreDoNotTrack ? "true" : "false"}
                onValueChange={(value) => {
                  setIgnoreDoNotTrack(value === "true");
                }}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              >
                <SelectTrigger id="site-settings-ignore-dnt" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              onClick={() => {
                void handleSaveQueryHash();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasQueryHashChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingQueryHash ? (
                  <span
                    key="saving-query-hash"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span key="save-query-hash">{copy.saveTracking}</span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full order-5">
          <CardHeader>
            <CardTitle>{copy.domainWhitelistTitle}</CardTitle>
            <CardDescription>{copy.domainWhitelistDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="site-settings-domain-whitelist">
                {copy.domainWhitelistLabel}
              </Label>
              <textarea
                id="site-settings-domain-whitelist"
                value={domainWhitelistInput}
                onChange={(event) =>
                  setDomainWhitelistInput(event.target.value)
                }
                placeholder={copy.domainWhitelistPlaceholder}
                rows={4}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
                className="min-h-24 w-full rounded-none border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:bg-input/30 dark:disabled:bg-input/80"
              />
              <p className="text-xs text-muted-foreground">
                {copy.domainWhitelistHint}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => {
                void handleSaveDomainWhitelist();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasDomainWhitelistChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingDomainWhitelist ? (
                  <span
                    key="saving-domain-whitelist"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span key="save-domain-whitelist">{copy.saveTracking}</span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full order-6">
          <CardHeader>
            <CardTitle>{copy.pathBlacklistTitle}</CardTitle>
            <CardDescription>{copy.pathBlacklistDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="site-settings-path-blacklist">
                {copy.pathBlacklistLabel}
              </Label>
              <textarea
                id="site-settings-path-blacklist"
                value={pathBlacklistInput}
                onChange={(event) => setPathBlacklistInput(event.target.value)}
                placeholder={copy.pathBlacklistPlaceholder}
                rows={4}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
                className="min-h-24 w-full rounded-none border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:bg-input/30 dark:disabled:bg-input/80"
              />
              <p className="text-xs text-muted-foreground">
                {copy.pathBlacklistHint}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => {
                void handleSavePathBlacklist();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasPathBlacklistChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingPathBlacklist ? (
                  <span
                    key="saving-path-blacklist"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span key="save-path-blacklist">{copy.saveTracking}</span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full order-7">
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
                <Select
                  value={transferTeamId}
                  onValueChange={setTransferTeamId}
                >
                  <SelectTrigger
                    id="site-settings-transfer-team"
                    className="w-full"
                  >
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
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  transferTeamId === activeTeamId
                }
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {transferring ? (
                    <span
                      key="transferring"
                      className="inline-flex items-center gap-2"
                    >
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

        <AlertDialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            if (deleting) return;
            setDeleteDialogOpen(open);
          }}
        >
          <Card className="h-full border-destructive/40 order-8">
            <CardHeader>
              <CardTitle>{copy.deleteTitle}</CardTitle>
              <CardDescription>{copy.deleteSubtitle}</CardDescription>
            </CardHeader>
            <CardContent className="flex h-full items-end">
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={
                    saving || trackingSaving || transferring || deleting
                  }
                >
                  <AutoTransition className="inline-flex items-center gap-2">
                    {deleting ? (
                      <span
                        key="deleting"
                        className="inline-flex items-center gap-2"
                      >
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
              <AlertDialogDescription>
                {copy.deleteConfirm}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={trackingSaving || transferring || deleting}
              >
                {messages.teamSelect.cancel}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={trackingSaving || transferring || deleting}
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
