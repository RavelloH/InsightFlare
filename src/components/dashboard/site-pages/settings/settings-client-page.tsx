import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiArrowRightLine,
  RiBarChartBoxLine,
  RiCloseLine,
  RiCodeLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiGlobalLine,
  RiLinksLine,
  RiRouteLine,
  RiSave3Line,
  RiSettings3Line,
  RiShareForwardLine,
  RiSpeedUpLine,
  RiTestTubeLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeading } from "@/components/dashboard/common/page-heading";
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
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
  BLOCKING_FIELD_IDS,
  type BlockingFieldId,
  type BlockingRuleSyntaxError,
  validateBlockingRules,
} from "@/lib/blocking";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import type { SiteData } from "@/lib/dashboard-api/client/edge";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";
import {
  DEFAULT_SITE_SCRIPT_SETTINGS,
  normalizeSiteScriptSettings,
  type SiteSettingsConfig,
  type TrackingStrength,
} from "@/lib/site-settings";
import { cn } from "@/lib/utils";

import { BlockingRuleEditorCard } from "./blocking-rule-controls";
import {
  BLOCKING_RULE_FIELD_DEFINITIONS,
  blockingEditorLines,
  type BlockingEditorValues,
  blockingEditorValues,
  blockingRuleErrorMessage,
  formatSampleRateValue,
  postJson,
  randomPublicSlug,
  resolveSiteSlug,
  type SiteSettingsClientPageProps,
} from "./settings-model";
function SettingsSection({
  id,
  title,
  description,
  children,
  danger = false,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "space-y-4",
        danger && "border border-destructive/20 bg-destructive/[0.02] p-4",
      )}
    >
      <div className="space-y-1 border-b pb-3">
        <h2
          id={id}
          className={cn(
            "text-base font-semibold",
            danger && "text-destructive",
          )}
        >
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}
export function SettingsClientPage({
  locale,
  messages,
  teamSlug,
  activeTeamId,
  siteSlug,
  teams,
  site,
  initialData = null,
}: SiteSettingsClientPageProps) {
  const router = useRouter();
  const copy = messages.siteSettings;
  const initialTrackerSettings = normalizeSiteScriptSettings(
    initialData?.config,
  );
  const [name, setName] = useState(site.name);
  const [domain, setDomain] = useState(site.domain);
  const [publicEnabled, setPublicEnabled] = useState(
    Boolean(site.publicEnabled),
  );
  const [publicSlug, setPublicSlug] = useState(site.publicSlug || "");
  const [persistedName, setPersistedName] = useState(site.name);
  const [persistedDomain, setPersistedDomain] = useState(site.domain);
  const [persistedPublicEnabled, setPersistedPublicEnabled] = useState(
    Boolean(site.publicEnabled),
  );
  const [persistedPublicSlug, setPersistedPublicSlug] = useState(
    site.publicSlug || "",
  );
  const [saving, setSaving] = useState(false);
  const [savingPublicSharing, setSavingPublicSharing] = useState(false);
  const [savingTrackingStrength, setSavingTrackingStrength] = useState(false);
  const [savingBotProtection, setSavingBotProtection] = useState(false);
  const [savingHostingProxyBlocking, setSavingHostingProxyBlocking] =
    useState(false);
  const [savingQueryHash, setSavingQueryHash] = useState(false);
  const [savingPerformanceTracking, setSavingPerformanceTracking] =
    useState(false);
  const [savingBlockingField, setSavingBlockingField] =
    useState<BlockingFieldId | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [currentSiteSlug, setCurrentSiteSlug] = useState(siteSlug);
  const [transferTeamId, setTransferTeamId] = useState(activeTeamId);
  const [trackingStrength, setTrackingStrength] = useState<TrackingStrength>(
    initialTrackerSettings.trackingStrength,
  );
  const [botProtectionEnabled, setBotProtectionEnabled] = useState(
    initialTrackerSettings.botProtectionEnabled,
  );
  const [hostingProxyBlockingEnabled, setHostingProxyBlockingEnabled] =
    useState(initialTrackerSettings.hostingProxyBlockingEnabled);
  const [trackQueryParams, setTrackQueryParams] = useState(
    initialTrackerSettings.trackQueryParams,
  );
  const [trackHash, setTrackHash] = useState(initialTrackerSettings.trackHash);
  const [ignoreDoNotTrack, setIgnoreDoNotTrack] = useState(
    initialTrackerSettings.ignoreDoNotTrack,
  );
  const [autoTrackOutboundLinks, setAutoTrackOutboundLinks] = useState(
    initialTrackerSettings.autoTrackOutboundLinks,
  );
  const [savingAutoTracking, setSavingAutoTracking] = useState(false);
  const [performanceSampleRate, setPerformanceSampleRate] = useState(
    initialTrackerSettings.performanceSampleRate,
  );
  const [blockingInputs, setBlockingInputs] = useState<BlockingEditorValues>(
    () => blockingEditorValues(initialData?.config),
  );
  const [persistedBlockingInputs, setPersistedBlockingInputs] =
    useState<BlockingEditorValues>(() =>
      blockingEditorValues(initialData?.config),
    );
  const [persistedSettings, setPersistedSettings] = useState(
    initialTrackerSettings,
  );
  const [origin, setOrigin] = useState(initialData?.origin ?? "");
  const appliedConfigSiteIdRef = useRef<string | null>(null);
  const appliedSnippetSiteIdRef = useRef<string | null>(null);

  const hasAutoTrackingChanges =
    autoTrackOutboundLinks !== persistedSettings.autoTrackOutboundLinks;

  const trackingSaving =
    savingTrackingStrength ||
    savingBotProtection ||
    savingHostingProxyBlocking ||
    savingQueryHash ||
    savingPerformanceTracking ||
    savingBlockingField !== null ||
    savingAutoTracking;

  const hasSiteInfoChanges =
    name.trim() !== persistedName.trim() ||
    domain.trim() !== persistedDomain.trim();

  const hasPublicSharingChanges =
    publicEnabled !== persistedPublicEnabled ||
    publicSlug.trim() !== persistedPublicSlug.trim();

  const hasTrackingStrengthChanges =
    trackingStrength !== persistedSettings.trackingStrength;

  const hasBotProtectionChanges =
    botProtectionEnabled !== persistedSettings.botProtectionEnabled;

  const hasHostingProxyBlockingChanges =
    hostingProxyBlockingEnabled !==
    persistedSettings.hostingProxyBlockingEnabled;

  const hasQueryHashChanges =
    trackQueryParams !== persistedSettings.trackQueryParams ||
    trackHash !== persistedSettings.trackHash ||
    ignoreDoNotTrack !== persistedSettings.ignoreDoNotTrack;

  const normalizedPerformanceSampleRate = normalizeSiteScriptSettings({
    performanceSampleRate,
  }).performanceSampleRate;

  const hasPerformanceTrackingChanges =
    normalizedPerformanceSampleRate !== persistedSettings.performanceSampleRate;

  const blockingValidation = useMemo(
    () =>
      Object.fromEntries(
        BLOCKING_FIELD_IDS.map((field) => {
          const errors = validateBlockingRules({
            blockingRules: [
              {
                version: 2,
                data: { [field]: blockingEditorLines(blockingInputs[field]) },
              },
            ],
          }).filter((error) => error.field === field);
          return [field, errors];
        }),
      ) as unknown as Record<
        BlockingFieldId,
        readonly BlockingRuleSyntaxError[]
      >,
    [blockingInputs],
  );

  function applyTrackerSettings(raw: unknown) {
    const normalized = normalizeSiteScriptSettings(raw);
    setPersistedSettings(normalized);
    setTrackingStrength(normalized.trackingStrength);
    setBotProtectionEnabled(normalized.botProtectionEnabled);
    setHostingProxyBlockingEnabled(normalized.hostingProxyBlockingEnabled);
    setTrackQueryParams(normalized.trackQueryParams);
    setTrackHash(normalized.trackHash);
    setIgnoreDoNotTrack(normalized.ignoreDoNotTrack);
    setAutoTrackOutboundLinks(normalized.autoTrackOutboundLinks);
    setPerformanceSampleRate(normalized.performanceSampleRate);
    const nextBlockingInputs = blockingEditorValues(raw);
    setBlockingInputs(nextBlockingInputs);
    setPersistedBlockingInputs(nextBlockingInputs);
  }

  const siteConfigQuery = useQuery({
    queryKey: ["dashboard", "site-config", site.id],
    queryFn: ({ signal }) =>
      requestAdminService<SiteSettingsConfig>("site-config", {
        params: { siteId: site.id },
        signal,
      }),
    initialData: initialData?.config,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const scriptSnippetQuery = useQuery({
    queryKey: ["dashboard", "site-script-snippet", site.id],
    queryFn: async ({ signal }) => {
      const data = await requestAdminService<{
        siteId: string;
        src: string;
        snippet: string;
      }>("script-snippet", {
        params: { siteId: site.id },
        signal,
      });
      return data.snippet;
    },
    initialData: initialData?.scriptSnippet,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const loadingSettings = siteConfigQuery.isPending;
  const loadingScript = scriptSnippetQuery.isPending;
  const scriptSnippet = scriptSnippetQuery.data ?? "";

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (
      siteConfigQuery.isPending ||
      appliedConfigSiteIdRef.current === site.id
    ) {
      return;
    }
    applyTrackerSettings(siteConfigQuery.data ?? DEFAULT_SITE_SCRIPT_SETTINGS);
    appliedConfigSiteIdRef.current = site.id;
    if (siteConfigQuery.isError) toast.error(copy.toasts.settingsLoadFailed);
  }, [
    copy.toasts.settingsLoadFailed,
    site.id,
    siteConfigQuery.data,
    siteConfigQuery.isError,
    siteConfigQuery.isPending,
  ]);

  useEffect(() => {
    if (
      scriptSnippetQuery.isPending ||
      appliedSnippetSiteIdRef.current === site.id
    ) {
      return;
    }
    appliedSnippetSiteIdRef.current = site.id;
    if (scriptSnippetQuery.isError) toast.error(copy.toasts.scriptLoadFailed);
  }, [
    copy.toasts.scriptLoadFailed,
    scriptSnippetQuery.isError,
    scriptSnippetQuery.isPending,
    site.id,
  ]);

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
      const updated = await postJson<SiteData>(
        "sites",
        {
          intent: "update",
          siteId: site.id,
          name: name.trim(),
          domain: domain.trim(),
        },
        "PATCH",
      );

      setName(updated.name);
      setDomain(updated.domain);
      setPersistedName(updated.name);
      setPersistedDomain(updated.domain);
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

  async function handleSavePublicSharing() {
    if (!hasPublicSharingChanges) return;

    setSavingPublicSharing(true);
    try {
      const nextPublicSlug = publicEnabled
        ? publicSlug.trim() || randomPublicSlug()
        : publicSlug.trim();
      const updated = await postJson<SiteData>(
        "sites",
        {
          intent: "update",
          siteId: site.id,
          publicEnabled,
          publicSlug: nextPublicSlug || undefined,
        },
        "PATCH",
      );

      const updatedPublicEnabled = Boolean(updated.publicEnabled);
      const updatedPublicSlug = updated.publicSlug || "";
      setPublicEnabled(updatedPublicEnabled);
      setPublicSlug(updatedPublicSlug);
      setPersistedPublicEnabled(updatedPublicEnabled);
      setPersistedPublicSlug(updatedPublicSlug);
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
      setSavingPublicSharing(false);
    }
  }

  async function persistTrackingSettings(input: Record<string, unknown>) {
    const savedSettings = await postJson<SiteSettingsConfig>("site-config", {
      siteId: site.id,
      config: input,
    });
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

  async function handleSaveBotProtection() {
    if (!hasBotProtectionChanges) return;
    const pendingHostingProxyBlocking = hostingProxyBlockingEnabled;
    setSavingBotProtection(true);
    try {
      await persistTrackingSettings({
        botProtectionEnabled,
      });
      setHostingProxyBlockingEnabled(pendingHostingProxyBlocking);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingBotProtection(false);
    }
  }

  async function handleSaveHostingProxyBlocking() {
    if (!hasHostingProxyBlockingChanges) return;
    const pendingBotProtection = botProtectionEnabled;
    setSavingHostingProxyBlocking(true);
    try {
      await persistTrackingSettings({
        hostingProxyBlockingEnabled,
      });
      setBotProtectionEnabled(pendingBotProtection);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingHostingProxyBlocking(false);
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

  async function handleSaveAutoTracking() {
    if (!hasAutoTrackingChanges) return;
    setSavingAutoTracking(true);
    try {
      await persistTrackingSettings({
        autoTrackOutboundLinks,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingAutoTracking(false);
    }
  }

  async function handleSavePerformanceTracking() {
    if (!hasPerformanceTrackingChanges) return;
    setSavingPerformanceTracking(true);
    try {
      await persistTrackingSettings({
        performanceSampleRate: normalizedPerformanceSampleRate,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingPerformanceTracking(false);
    }
  }

  async function handleSaveBlockingField(field: BlockingFieldId) {
    if (blockingInputs[field] === persistedBlockingInputs[field]) return;
    const errors = blockingValidation[field];
    if (errors.length > 0) {
      toast.error(
        blockingRuleErrorMessage(
          errors[0],
          copy.blockingRulesFields[field],
          copy.blockingRulesDialogs,
        ),
      );
      return;
    }
    setSavingBlockingField(field);
    try {
      const savedSettings = await postJson<SiteSettingsConfig>("site-config", {
        siteId: site.id,
        config: {},
        blockingPatch: {
          [field]: blockingEditorLines(blockingInputs[field]),
        },
      });
      applyTrackerSettings(savedSettings);
      toast.success(
        `${copy.toasts.saved} ${copy.toasts.settingsPropagationHint}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingBlockingField(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await postJson<{ siteId: string; teamId: string; removed: boolean }>(
        "sites",
        {
          intent: "remove",
          siteId: site.id,
        },
        "PATCH",
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
      const updated = await postJson<SiteData>(
        "sites",
        {
          intent: "update",
          siteId: site.id,
          teamId: targetTeam.id,
        },
        "PATCH",
      );
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

  async function handleCopyPublicLink() {
    const link = publicLink;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success(copy.copiedLink);
    } catch {
      toast.error(copy.toasts.saveFailed);
    }
  }

  const publicLink =
    publicEnabled && publicSlug.trim() && origin
      ? `${origin}/share/${encodeURIComponent(publicSlug.trim())}`
      : "";

  return (
    <div className="space-y-6">
      <PageHeading title={copy.title} subtitle={copy.subtitle} />

      <SettingsSection
        id="site-settings-basic-info"
        title={copy.sections.basic.title}
        description={copy.sections.basic.description}
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiSettings3Line className="size-4" />
              {copy.editTitle}
            </CardTitle>
            <CardDescription>{copy.editSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-4"
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

              <Button
                type="submit"
                className="mt-auto self-start"
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
                    <span key="save" className="inline-flex items-center gap-2">
                      <RiSave3Line className="size-4" />
                      {copy.save}
                    </span>
                  )}
                </AutoTransition>
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiShareForwardLine className="size-4" />
              {copy.publicSharingTitle}
            </CardTitle>
            <CardDescription>{copy.publicSharingSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="site-settings-public-enabled">
                {copy.publicEnabledLabel}
              </Label>
              <Select
                value={publicEnabled ? "true" : "false"}
                onValueChange={(value) => {
                  const enabled = value === "true";
                  setPublicEnabled(enabled);
                  if (enabled && !publicSlug.trim()) {
                    setPublicSlug(randomPublicSlug());
                  }
                }}
                disabled={
                  saving ||
                  savingPublicSharing ||
                  trackingSaving ||
                  transferring ||
                  deleting
                }
              >
                <SelectTrigger
                  id="site-settings-public-enabled"
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
              <Label htmlFor="site-settings-public-slug">
                {copy.publicSlugLabel}
              </Label>
              <Input
                id="site-settings-public-slug"
                value={publicSlug}
                placeholder={copy.publicSlugPlaceholder}
                onChange={(event) => setPublicSlug(event.target.value)}
                disabled={
                  saving ||
                  savingPublicSharing ||
                  trackingSaving ||
                  transferring ||
                  deleting
                }
              />
              <p className="text-xs text-muted-foreground">
                {copy.publicSlugHint}
              </p>
            </div>

            <AutoResizer initial duration={0.24} ease={[0.22, 1, 0.36, 1]}>
              <AutoTransition
                initial={false}
                duration={0.18}
                type="fade"
                presenceMode="wait"
                transitionKey={publicEnabled ? "enabled" : "disabled"}
              >
                <div
                  key={publicEnabled ? "enabled" : "disabled"}
                  className="space-y-2"
                >
                  <Label htmlFor="site-settings-public-link">
                    {copy.publicLinkLabel}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="site-settings-public-link"
                      value={publicLink}
                      placeholder={
                        publicEnabled
                          ? copy.publicLinkHint
                          : copy.publicDisabledHint
                      }
                      readOnly
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        void handleCopyPublicLink();
                      }}
                      disabled={!publicLink}
                    >
                      <RiFileCopyLine className="size-4" />
                      <span>
                        {messages.teamManagement.publicLinks.copyLink}
                      </span>
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {publicEnabled
                      ? copy.publicLinkHint
                      : copy.publicDisabledHint}
                  </p>
                </div>
              </AutoTransition>
            </AutoResizer>

            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSavePublicSharing();
              }}
              disabled={
                saving ||
                savingPublicSharing ||
                trackingSaving ||
                transferring ||
                deleting ||
                !hasPublicSharingChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingPublicSharing ? (
                  <span
                    key="saving-public-sharing"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.saving}
                  </span>
                ) : (
                  <span
                    key="save-public-sharing"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.save}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full lg:col-span-2">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiCodeLine className="size-4" />
              {copy.scriptTitle}
            </CardTitle>
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
                  <code className="font-mono">
                    {scriptSnippet || copy.scriptUnavailable}
                  </code>
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
              <RiFileCopyLine className="size-4" />
              <span>{copy.copyScript}</span>
            </Button>
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection
        id="site-settings-tracking"
        title={copy.sections.tracking.title}
        description={copy.sections.tracking.description}
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiBarChartBoxLine className="size-4" />
              {copy.trackingStrengthGroupTitle}
            </CardTitle>
            <CardDescription>
              {copy.trackingStrengthDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
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
              className="mt-auto self-start"
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
                  <span
                    key="save-strength"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiLinksLine className="size-4" />
              {copy.queryHashGroupTitle}
            </CardTitle>
            <CardDescription>{copy.queryHashGroupDescription}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
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
              className="mt-auto self-start"
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
                  <span
                    key="save-query-hash"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiRouteLine className="size-4" />
              {copy.autoTrackGroupTitle}
            </CardTitle>
            <CardDescription>{copy.autoTrackGroupDescription}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="site-settings-auto-track-outbound">
                {copy.autoTrackOutboundLinksLabel}
              </Label>
              <Select
                value={autoTrackOutboundLinks ? "true" : "false"}
                onValueChange={(value) => {
                  setAutoTrackOutboundLinks(value === "true");
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
                  id="site-settings-auto-track-outbound"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {copy.autoTrackOutboundLinksHint}
              </p>
            </div>
            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSaveAutoTracking();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasAutoTrackingChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingAutoTracking ? (
                  <span
                    key="saving-auto-tracking"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span
                    key="save-auto-tracking"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiSpeedUpLine className="size-4" />
              {copy.performanceGroupTitle}
            </CardTitle>
            <CardDescription>
              {copy.performanceGroupDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="site-settings-performance-sample-rate">
                  {copy.performanceSampleRateLabel}
                </Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatSampleRateValue(normalizedPerformanceSampleRate)}
                </span>
              </div>
              <Slider
                id="site-settings-performance-sample-rate"
                min={0}
                max={100}
                step={1}
                value={[normalizedPerformanceSampleRate]}
                onValueChange={(value) => {
                  setPerformanceSampleRate(value[0] ?? 0);
                }}
                aria-label={copy.performanceSampleRateLabel}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>0%</span>
                <span>100%</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {copy.performanceSampleRateHint}
              </p>
            </div>
            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSavePerformanceTracking();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasPerformanceTrackingChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingPerformanceTracking ? (
                  <span
                    key="saving-performance"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span
                    key="save-performance"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection
        id="site-settings-blocking"
        title={copy.sections.blocking.title}
        description={copy.sections.blocking.description}
      >
        {BLOCKING_RULE_FIELD_DEFINITIONS.map(({ field, icon }) => (
          <BlockingRuleEditorCard
            key={field}
            field={field}
            icon={icon}
            locale={locale}
            copy={copy.blockingRulesFields[field]}
            dialogCopy={copy.blockingRulesDialogs}
            value={blockingInputs[field]}
            errors={blockingValidation[field]}
            disabled={
              saving ||
              trackingSaving ||
              transferring ||
              deleting ||
              loadingSettings
            }
            saving={savingBlockingField === field}
            changed={blockingInputs[field] !== persistedBlockingInputs[field]}
            onChange={(value) => {
              setBlockingInputs((current) => ({ ...current, [field]: value }));
            }}
            onSave={() => {
              void handleSaveBlockingField(field);
            }}
            saveLabel={copy.blockingRulesSave}
            savingLabel={copy.blockingRulesSaving}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        id="site-settings-protection"
        title={copy.sections.protection.title}
        description={copy.sections.protection.description}
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiTestTubeLine className="size-4" />
              {copy.botProtectionEnabledLabel}
            </CardTitle>
            <CardDescription>{copy.botProtectionEnabledHint}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            {loadingSettings ? (
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-4" />
                {copy.loadingSettings}
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="site-settings-bot-protection">
                {copy.botProtectionEnabledLabel}
              </Label>
              <Select
                value={botProtectionEnabled ? "true" : "false"}
                onValueChange={(value) => {
                  setBotProtectionEnabled(value === "true");
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
                  id="site-settings-bot-protection"
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
            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSaveBotProtection();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasBotProtectionChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingBotProtection ? (
                  <span
                    key="saving-bot-protection"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span
                    key="save-bot-protection"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiGlobalLine className="size-4" />
              {copy.hostingProxyBlockingEnabledLabel}
            </CardTitle>
            <CardDescription>
              {copy.hostingProxyBlockingEnabledHint}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            {loadingSettings ? (
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-4" />
                {copy.loadingSettings}
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="site-settings-hosting-proxy-blocking">
                {copy.hostingProxyBlockingEnabledLabel}
              </Label>
              <Select
                value={hostingProxyBlockingEnabled ? "true" : "false"}
                onValueChange={(value) => {
                  setHostingProxyBlockingEnabled(value === "true");
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
                  id="site-settings-hosting-proxy-blocking"
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
            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSaveHostingProxyBlocking();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasHostingProxyBlockingChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingHostingProxyBlocking ? (
                  <span
                    key="saving-hosting-proxy-blocking"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span
                    key="save-hosting-proxy-blocking"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection
        id="site-settings-danger"
        title={copy.sections.danger.title}
        description={copy.sections.danger.description}
        danger
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiArrowRightLine className="size-4" />
              {copy.transferTitle}
            </CardTitle>
            <CardDescription>{copy.transferSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-4"
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
                className="mt-auto self-start"
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
                    <span
                      key="transfer"
                      className="inline-flex items-center gap-2"
                    >
                      <RiArrowRightLine className="size-4" />
                      {copy.transfer}
                    </span>
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
          <Card className="h-full border-destructive/40">
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <RiDeleteBinLine className="size-4" />
                {copy.deleteTitle}
              </CardTitle>
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
                      <span
                        key="delete"
                        className="inline-flex items-center gap-2"
                      >
                        <RiDeleteBinLine className="size-4" />
                        {copy.delete}
                      </span>
                    )}
                  </AutoTransition>
                </Button>
              </AlertDialogTrigger>
            </CardContent>
          </Card>

          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle icon={RiDeleteBinLine}>
                {copy.deleteTitle}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {copy.deleteConfirm}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={trackingSaving || transferring || deleting}
              >
                <RiCloseLine className="size-4" />
                <span>{messages.teamSelect.cancel}</span>
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
                    <span
                      key="confirm-delete"
                      className="inline-flex items-center gap-2"
                    >
                      <RiDeleteBinLine className="size-4" />
                      {copy.delete}
                    </span>
                  )}
                </AutoTransition>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingsSection>
    </div>
  );
}
