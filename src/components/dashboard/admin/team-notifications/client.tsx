import { useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiCheckboxCircleLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiEyeLine,
  RiMailSendLine,
  RiNotification3Line,
  RiPauseCircleLine,
  RiPlayCircleLine,
  RiSave3Line,
} from "@remixicon/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { JsonTreePanel } from "@/components/dashboard/common/json-tree";
import { PageHeading } from "@/components/dashboard/common/page-heading";
import { TableActionButton } from "@/components/dashboard/common/table-action-button";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import {
  type MemberData,
  type NotificationRuleData,
  type NotificationRuleEvaluationData,
  type NotificationRuleRunData,
  type SiteData,
} from "@/lib/dashboard-api/client/edge";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type { PublicNotificationEmailConfig } from "@/lib/notifications/email-config";
import Link from "@/lib/router";

import {
  browserDefaultTimeZone,
  buildRulePayload,
  conditionLabel,
  defaultRecipientUserIds,
  EMPTY_FORM,
  formatRunAt,
  inferFormFromRule,
  isCoolingDown,
  nextRunLabel,
  previewSummary,
  recipientLabel,
  type RuleFormState,
  type RuleFormType,
  ruleTypeLabel,
  scheduleLabel,
  siteLabel,
  type TeamNotificationsClientProps,
} from "./model";
import { RuleFormFields } from "./rule-form";
export function TeamNotificationsClient({
  locale,
  messages,
  teamId,
  teamSlug,
  currentUserId,
  initialData = null,
}: TeamNotificationsClientProps) {
  const copy = messages.teamManagement.notifications;
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [previewingId, setPreviewingId] = useState("");
  const [runningId, setRunningId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [previewRule, setPreviewRule] = useState<NotificationRuleData | null>(
    null,
  );
  const [previewResult, setPreviewResult] =
    useState<NotificationRuleEvaluationData | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rulesQueryKey = [
    "dashboard",
    "team-notification-rules",
    teamId,
  ] as const;
  const rulesQuery = useQuery({
    queryKey: rulesQueryKey,
    queryFn: async ({ signal }) => {
      const [rules, sites, members, emailConfig] = await Promise.all([
        requestAdminService<NotificationRuleData[]>("notification-rules", {
          params: { teamId },
          signal,
        }),
        requestAdminService<SiteData[]>("sites", {
          params: { teamId },
          signal,
        }),
        requestAdminService<MemberData[]>("members", {
          params: { teamId },
          signal,
        }),
        requestAdminService<PublicNotificationEmailConfig>(
          "notification-email",
          { signal },
        ).catch(() => null),
      ]);
      return {
        rules,
        sites,
        members,
        emailConfigured:
          emailConfig?.enabled &&
          emailConfig.provider === "resend" &&
          Boolean(emailConfig.fromEmail) &&
          emailConfig.resend.configured,
      };
    },
    initialData: initialData
      ? {
          rules: initialData.rules,
          sites: initialData.sites,
          members: initialData.members,
          emailConfigured: initialData.emailConfigured,
        }
      : undefined,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const rules = rulesQuery.data?.rules ?? [];
  const sites = rulesQuery.data?.sites ?? [];
  const members = rulesQuery.data?.members ?? [];
  const emailConfigured = rulesQuery.data?.emailConfigured ?? false;
  const loading = rulesQuery.isPending;

  const siteById = useMemo(
    () => new Map(sites.map((site) => [site.id, site])),
    [sites],
  );
  const memberByUserId = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const enabledCount = useMemo(
    () => rules.filter((rule) => rule.enabled).length,
    [rules],
  );
  const canCreateRule = sites.length > 0;

  useEffect(() => {
    if (rulesQuery.isError) toast.error(copy.loadRulesFailed);
  }, [copy.loadRulesFailed, rulesQuery.errorUpdatedAt, rulesQuery.isError]);

  function openCreate(type: RuleFormType = "report") {
    if (!canCreateRule) return;
    const firstSite = sites[0];
    setForm({
      ...EMPTY_FORM,
      type,
      siteId: firstSite?.id ?? "",
      name: "",
      scheduleKind: type === "report" ? "daily" : "interval",
      timezone: browserDefaultTimeZone(),
      recipientUserIds: defaultRecipientUserIds(members, currentUserId),
    });
    setDialogOpen(true);
  }

  function openEdit(rule: NotificationRuleData) {
    setForm(inferFormFromRule(rule));
    setDialogOpen(true);
  }

  async function saveRule() {
    if (saving) return;
    if (!form.siteId) {
      toast.error(copy.pleaseChooseSite);
      return;
    }
    if (form.recipientKind === "custom" && form.recipientUserIds.length === 0) {
      toast.error(copy.pleaseChooseRecipients);
      return;
    }
    setSaving(true);
    try {
      const payload = buildRulePayload(copy, form, sites);
      await requestAdminService<NotificationRuleData>("notification-rules", {
        method: form.id ? "PATCH" : "POST",
        body: form.id
          ? { ruleId: form.id, teamId, ...payload }
          : { teamId, ...payload },
      });
      await queryClient.invalidateQueries({ queryKey: rulesQueryKey });
      setDialogOpen(false);
      toast.success(form.id ? copy.ruleUpdated : copy.ruleCreated);
    } catch {
      toast.error(form.id ? copy.updateRuleFailed : copy.createRuleFailed);
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(rule: NotificationRuleData) {
    try {
      await requestAdminService<NotificationRuleData>("notification-rules", {
        method: "PATCH",
        body: {
          ruleId: rule.id,
          enabled: !rule.enabled,
        },
      });
      await queryClient.invalidateQueries({ queryKey: rulesQueryKey });
    } catch {
      toast.error(copy.updateRuleFailed);
    }
  }

  async function removeRule(rule: NotificationRuleData) {
    if (
      !window.confirm(
        formatI18nTemplate(copy.deleteConfirm, { name: rule.name }),
      )
    )
      return;
    try {
      await requestAdminService<{ id: string; removed: boolean }>(
        "notification-rules",
        {
          method: "DELETE",
          params: { id: rule.id },
        },
      );
      await queryClient.invalidateQueries({ queryKey: rulesQueryKey });
      toast.success(copy.ruleDeleted);
    } catch {
      toast.error(copy.deleteRuleFailed);
    }
  }

  async function handleSendTest() {
    if (testing) return;
    setTesting(true);
    try {
      await requestAdminService("notification-test", {
        method: "POST",
        body: { teamId, userId: currentUserId },
      });
      toast.success(copy.testNotificationSent);
      setTestDialogOpen(false);
    } catch {
      toast.error(copy.sendTestNotificationFailed);
    } finally {
      setTesting(false);
    }
  }

  async function handlePreview(rule: NotificationRuleData) {
    if (previewingId) return;
    setPreviewRule(rule);
    setPreviewResult(null);
    setPreviewDialogOpen(true);
    setPreviewingId(rule.id);
    try {
      const result = await requestAdminService<NotificationRuleEvaluationData>(
        "notification-rules/preview",
        {
          method: "POST",
          body: { ruleId: rule.id },
        },
      );
      setPreviewResult(result);
    } catch {
      toast.error(copy.previewFailed);
    } finally {
      setPreviewingId("");
    }
  }

  async function handleRunNow(rule: NotificationRuleData) {
    if (runningId) return;
    setRunningId(rule.id);
    try {
      const result = await requestAdminService<NotificationRuleRunData>(
        "notification-rules/run",
        {
          method: "POST",
          body: { ruleId: rule.id },
        },
      );
      toast.success(
        formatI18nTemplate(copy.runResultToast, {
          messages: result.messageCount,
          sent: Number(result.summary.emailSent ?? 0),
          failed: Number(result.summary.emailFailed ?? 0),
        }),
      );
      await queryClient.invalidateQueries({ queryKey: rulesQueryKey });
    } catch {
      toast.error(copy.runFailed);
    } finally {
      setRunningId("");
    }
  }

  return (
    <div className="space-y-4">
      <PageHeading
        title={copy.title}
        subtitle={copy.subtitle}
        actions={
          <>
            <Button type="button" variant="outline" asChild>
              <Link
                href={`/${locale}/app/${teamSlug}/notifications/email-preview`}
              >
                <RiMailSendLine />
                <span>{copy.emailPreview}</span>
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTestDialogOpen(true)}
            >
              <RiMailSendLine />
              <span>{copy.sendTestNotification}</span>
            </Button>
            <Button
              type="button"
              onClick={() => openCreate()}
              disabled={!canCreateRule}
            >
              <RiAddLine />
              <span>{copy.createRule}</span>
            </Button>
          </>
        }
      />

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiNotification3Line className="size-4" />
              {copy.rulesTitle}
            </CardTitle>
            <CardDescription>
              {formatI18nTemplate(copy.enabledCount, {
                count: enabledCount,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AutoResizer initial>
              <AutoTransition
                transitionKey={
                  loading ? "loading" : rules.length === 0 ? "empty" : "data"
                }
                initial={false}
                duration={0.18}
                type="fade"
                presenceMode="wait"
              >
                {loading ? (
                  <div
                    key="loading"
                    className="flex h-40 items-center justify-center text-sm text-muted-foreground"
                  >
                    <Spinner className="mr-2 size-4" />
                    {copy.loadingRules}
                  </div>
                ) : rules.length === 0 ? (
                  <div
                    key="empty"
                    className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground"
                  >
                    <RiNotification3Line className="size-8 text-muted-foreground/70" />
                    <p>{copy.empty}</p>
                  </div>
                ) : (
                  <Table key="data">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{copy.columns.name}</TableHead>
                        <TableHead>{copy.columns.type}</TableHead>
                        <TableHead>{copy.columns.site}</TableHead>
                        <TableHead>{copy.columns.recipient}</TableHead>
                        <TableHead>{copy.columns.schedule}</TableHead>
                        <TableHead>{copy.lastChecked}</TableHead>
                        <TableHead>{copy.columns.nextRun}</TableHead>
                        <TableHead>{copy.columns.status}</TableHead>
                        <TableHead>{copy.actions}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rules.map((rule) => (
                        <TableRow key={rule.id}>
                          <TableCell className="font-medium">
                            {rule.name}
                          </TableCell>
                          <TableCell>
                            {ruleTypeLabel(copy, rule.type)}
                          </TableCell>
                          <TableCell>
                            {siteLabel(siteById, rule.siteId)}
                          </TableCell>
                          <TableCell>
                            {recipientLabel(
                              copy,
                              rule.recipient,
                              memberByUserId,
                            )}
                          </TableCell>
                          <TableCell>{scheduleLabel(copy, rule)}</TableCell>
                          <TableCell>
                            {formatRunAt(locale, rule.lastCheckedAt)}
                          </TableCell>
                          <TableCell>
                            {isCoolingDown(rule, nowSeconds) ? (
                              <span className="text-xs font-medium text-foreground/70">
                                {formatI18nTemplate(copy.coolingDownUntil, {
                                  time: formatRunAt(locale, rule.cooldownUntil),
                                })}
                              </span>
                            ) : (
                              <span>
                                {nextRunLabel(copy, locale, rule, nowSeconds)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={rule.enabled ? "default" : "secondary"}
                            >
                              {rule.enabled
                                ? copy.status.enabled
                                : copy.status.disabled}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-2">
                              <TableActionButton
                                label={`${copy.preview}: ${rule.name}`}
                                disabled={previewingId === rule.id}
                                onClick={() => void handlePreview(rule)}
                                transitionKey={
                                  previewingId === rule.id
                                    ? "previewing"
                                    : "preview"
                                }
                              >
                                {previewingId === rule.id ? (
                                  <Spinner className="size-3" />
                                ) : (
                                  <RiEyeLine className="size-4" />
                                )}
                              </TableActionButton>
                              <TableActionButton
                                label={`${copy.runNow}: ${rule.name}`}
                                disabled={runningId === rule.id}
                                onClick={() => void handleRunNow(rule)}
                                transitionKey={
                                  runningId === rule.id ? "running" : "run"
                                }
                              >
                                {runningId === rule.id ? (
                                  <Spinner className="size-3" />
                                ) : (
                                  <RiPlayCircleLine className="size-4" />
                                )}
                              </TableActionButton>
                              <TableActionButton
                                label={`${copy.edit}: ${rule.name}`}
                                onClick={() => openEdit(rule)}
                              >
                                <RiEditLine className="size-4" />
                              </TableActionButton>
                              <TableActionButton
                                label={`${
                                  rule.enabled ? copy.disable : copy.enable
                                }: ${rule.name}`}
                                onClick={() => void toggleRule(rule)}
                                transitionKey={
                                  rule.enabled ? "enabled" : "disabled"
                                }
                              >
                                {rule.enabled ? (
                                  <RiPauseCircleLine className="size-4" />
                                ) : (
                                  <RiPlayCircleLine className="size-4" />
                                )}
                              </TableActionButton>
                              <TableActionButton
                                label={`${copy.delete}: ${rule.name}`}
                                tone="destructive"
                                onClick={() => void removeRule(rule)}
                              >
                                <RiDeleteBinLine className="size-4" />
                              </TableActionButton>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </AutoTransition>
            </AutoResizer>
          </CardContent>
        </Card>
      </div>

      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle icon={RiMailSendLine}>
              {copy.deliveryTestTitle}
            </DialogTitle>
            <DialogDescription>
              {copy.deliveryTestDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2 text-foreground">
              <RiCheckboxCircleLine className="size-4 text-emerald-600" />
              {copy.inAppTestHint}
            </div>
            <div
              className={`flex items-center gap-2${emailConfigured ? " text-foreground" : ""}`}
            >
              <RiMailSendLine
                className={`size-4${emailConfigured ? " text-emerald-600" : ""}`}
              />
              {emailConfigured
                ? copy.emailTestConfiguredHint
                : copy.emailTestUnconfiguredHint}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTestDialogOpen(false)}
              disabled={testing}
            >
              <RiCloseLine className="size-4" />
              <span>{messages.teamSelect.cancel}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleSendTest}
              disabled={testing}
            >
              {testing ? <Spinner className="size-4" /> : <RiMailSendLine />}
              <span>{copy.sendTestNotification}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ResponsiveDialog
        open={previewDialogOpen}
        onOpenChange={setPreviewDialogOpen}
      >
        <ResponsiveDialogContent desktopClassName="max-h-[min(860px,calc(100vh-2rem))] max-w-5xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiEyeLine}>
              {copy.previewDialogTitle}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {copy.previewDialogDescription}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-5">
            {previewRule ? (
              <div className="grid gap-3 border bg-muted/20 p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.name}
                  </p>
                  <p className="mt-1 font-medium">{previewRule.name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.type}
                  </p>
                  <p className="mt-1">
                    {ruleTypeLabel(copy, previewRule.type)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.site}
                  </p>
                  <p className="mt-1">
                    {siteLabel(siteById, previewRule.siteId)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.schedule}
                  </p>
                  <p className="mt-1">{scheduleLabel(copy, previewRule)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.condition}
                  </p>
                  <p className="mt-1">
                    {conditionLabel(
                      copy,
                      messages.conditionDescription,
                      previewRule,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.recipient}
                  </p>
                  <p className="mt-1">
                    {recipientLabel(
                      copy,
                      previewRule.recipient,
                      memberByUserId,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.previewFields.createdAt}
                  </p>
                  <p className="mt-1">
                    {formatRunAt(locale, previewRule.createdAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.previewFields.updatedAt}
                  </p>
                  <p className="mt-1">
                    {formatRunAt(locale, previewRule.updatedAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.previewFields.status}
                  </p>
                  <Badge
                    className="mt-1"
                    variant={previewRule.enabled ? "default" : "secondary"}
                  >
                    {previewRule.enabled
                      ? copy.status.enabled
                      : copy.status.disabled}
                  </Badge>
                </div>
              </div>
            ) : null}

            <AutoResizer initial duration={0.2}>
              <AutoTransition
                transitionKey={
                  previewingId
                    ? "loading"
                    : previewResult
                      ? previewResult.status
                      : "empty"
                }
                duration={0.18}
                type="fade"
                initial={false}
                presenceMode="wait"
              >
                {previewingId ? (
                  <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
                    <Spinner className="mr-2 size-4" />
                    {copy.previewFields.loadingContent}
                  </div>
                ) : previewResult ? (
                  <div className="space-y-5 text-sm">
                    <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {copy.previewFields.status}
                        </p>
                        <Badge variant="outline">{previewResult.status}</Badge>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {copy.previewFields.summary}
                        </p>
                        <p className="break-words">
                          {previewSummary(previewResult)}
                        </p>
                      </div>
                    </div>

                    {previewResult.status === "triggered" ? (
                      <div className="space-y-5">
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            {copy.previewFields.title}
                          </p>
                          <p className="font-medium">
                            {previewResult.message.title}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground">
                            {copy.previewFields.htmlPreview}
                          </p>
                          {previewResult.message.bodyHtml ? (
                            <iframe
                              title={copy.previewFields.htmlPreview}
                              sandbox=""
                              srcDoc={previewResult.message.bodyHtml}
                              className="h-[520px] w-full border bg-white"
                            />
                          ) : (
                            <div className="flex h-32 items-center justify-center border bg-muted/20 text-xs text-muted-foreground">
                              {copy.previewFields.noHtmlPreview}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            {copy.previewFields.bodyText}
                          </p>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap bg-muted p-3 text-xs leading-5">
                            {previewResult.message.bodyText}
                          </pre>
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {copy.previewFields.data}
                      </p>
                      <JsonTreePanel
                        value={previewResult}
                        labels={{
                          expandField: messages.events.expandField,
                          collapseField: messages.events.collapseField,
                          copyJson: messages.events.copyJson,
                          copiedJson: messages.events.copiedJson,
                          copyJsonFailed: messages.events.copyJsonFailed,
                          copyValue: messages.events.copyValue,
                          copiedValue: messages.events.copiedValue,
                          copyValueFailed: messages.events.copyValueFailed,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="h-1" />
                )}
              </AutoTransition>
            </AutoResizer>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPreviewDialogOpen(false)}
            >
              <RiCloseLine className="size-4" />
              <span>{messages.teamSelect.cancel}</span>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <ResponsiveDialogContent
          className="flex flex-col overflow-hidden p-0"
          desktopClassName="max-h-[min(860px,calc(100vh-1rem))] max-w-6xl"
          drawerClassName="h-[80dvh] max-h-[80dvh]"
        >
          <div className="shrink-0 border-b p-4 sm:p-6">
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle icon={RiNotification3Line}>
                {form.id ? copy.editRule : copy.createRule}
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {copy.dialogDescription}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
          </div>
          <ResponsiveDialogBody className="flex-1 p-4 sm:p-6">
            <RuleFormFields
              copy={copy}
              terms={messages.conditionDescription}
              locale={locale}
              form={form}
              sites={sites}
              members={members}
              currentUserId={currentUserId}
              onChange={(patch) =>
                setForm((current) => ({
                  ...current,
                  ...patch,
                }))
              }
            />
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="border-t p-4 sm:p-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              <RiCloseLine className="size-4" />
              <span>{messages.teamSelect.cancel}</span>
            </Button>
            <Button
              type="button"
              onClick={() => void saveRule()}
              disabled={saving}
            >
              {saving ? <Spinner className="size-4" /> : <RiSave3Line />}
              <span>{form.id ? copy.saveRule : copy.createRule}</span>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}
