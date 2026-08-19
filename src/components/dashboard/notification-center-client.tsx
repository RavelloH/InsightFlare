import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  type RemixiconComponentType,
  RiAlertLine,
  RiCheckDoubleLine,
  RiCheckLine,
  RiFileList3Line,
  RiFilterOffLine,
  RiInboxLine,
  RiMailUnreadLine,
  RiNotification3Line,
  RiRefreshLine,
} from "@remixicon/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeading } from "@/components/dashboard/page-heading";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { requestAdminService } from "@/lib/admin-service-client";
import { shortDateTime } from "@/lib/dashboard/format";
import { type NotificationMessageData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { usePathname, useRouter, useSearchParams } from "@/lib/router";

interface NotificationCenterClientProps {
  locale: Locale;
  messages: AppMessages;
  teamId?: string;
}

type NotificationTab = "all" | "unread" | "attention" | "report";
type NotificationCenterCopy = AppMessages["notificationCenter"];

const NOTIFICATION_TABS: readonly NotificationTab[] = [
  "all",
  "unread",
  "attention",
  "report",
];

const MESSAGE_TYPE_FILTERS = [
  "all",
  "report",
  "milestone",
  "threshold",
  "change",
  "health",
  "test",
] as const;
const SEVERITY_FILTERS = [
  "all",
  "info",
  "success",
  "warning",
  "critical",
] as const;

function severityVariant(
  severity: string,
): "default" | "secondary" | "destructive" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "secondary";
  return "default";
}

function dictionaryLabel<T extends Record<string, string>>(
  labels: T,
  value: string,
): string {
  if (value in labels) return labels[value as keyof T];
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function truncateMessage(value: string): string {
  return value.length > 96 ? `${value.slice(0, 95)}...` : value;
}

function isUnread(item: NotificationMessageData): boolean {
  return item.readAt === null;
}

function isReport(item: NotificationMessageData): boolean {
  return item.type === "report";
}

function countForTab(
  messagesList: NotificationMessageData[],
  tab: NotificationTab,
): number {
  if (tab === "all") return messagesList.length;
  if (tab === "unread") return messagesList.filter(isUnread).length;
  if (tab === "attention") {
    return messagesList.filter(
      (item) => item.requiresAttention && isUnread(item),
    ).length;
  }
  return messagesList.filter(isReport).length;
}

function tabIcon(tab: NotificationTab): RemixiconComponentType {
  if (tab === "unread") return RiMailUnreadLine;
  if (tab === "attention") return RiAlertLine;
  if (tab === "report") return RiFileList3Line;
  return RiInboxLine;
}

function NotificationMetricTab({
  active,
  description,
  icon: Icon,
  label,
  loading,
  value,
  onClick,
}: {
  active: boolean;
  description: string;
  icon: RemixiconComponentType;
  label: string;
  loading: boolean;
  value: number;
  onClick: () => void;
}) {
  const contentKey = loading ? "loading" : String(value);

  return (
    <button
      type="button"
      className="min-w-0 bg-card p-4 text-left"
      onClick={onClick}
      aria-pressed={active}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-[11px]" />
        </span>
        <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
          {label}
        </p>
      </div>
      <AutoResizer initial className="mt-3">
        <AutoTransition
          transitionKey={contentKey}
          initial={false}
          duration={0.2}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <div key="loading" className="flex h-7 items-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <p
              key={value}
              className="min-w-0 truncate font-mono text-xl leading-7 font-semibold text-foreground tabular-nums"
            >
              {value}
            </p>
          )}
        </AutoTransition>
      </AutoResizer>
      <p className="mt-3 min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground">
        {description}
      </p>
    </button>
  );
}

function NotificationSectionHeading({
  actions,
  subtitle,
  title,
}: {
  actions?: ReactNode;
  subtitle: string;
  title: string;
}) {
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0 space-y-1">
        <h2 className="break-words text-xl font-semibold tracking-tight">
          {title}
        </h2>
        <p className="max-w-prose break-words text-xs text-muted-foreground">
          {subtitle}
        </p>
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function NotificationMessageList({
  copy,
  empty,
  items,
  locale,
  onRead,
  updatingId,
}: {
  copy: NotificationCenterCopy;
  empty: string;
  items: NotificationMessageData[];
  locale: Locale;
  onRead: (messageId: string) => void;
  updatingId: string;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
          <RiNotification3Line className="size-8 text-muted-foreground/70" />
          <p>{empty}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const email = record(item.deliveryResults.email);
        const emailStatus = compactText(email?.status);
        const emailReason = compactText(email?.reason);
        const attempts = compactNumber(email?.attempts);
        const retryCount = compactNumber(email?.retryCount);
        const durationMs = compactNumber(email?.durationMs);
        const errorMessage = truncateMessage(compactText(email?.errorMessage));
        const inAppStatus =
          compactText(record(item.deliveryResults.inApp)?.status) || "sent";
        const reasonLabel = emailReason
          ? dictionaryLabel(copy.emailSkipReasons, emailReason)
          : "";
        return (
          <Card key={item.id}>
            <CardContent className="space-y-4 p-4 md:p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 space-y-2">
                  <h2 className="truncate text-sm font-semibold">
                    {item.title}
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                    <span>{shortDateTime(locale, item.createdAt * 1000)}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={severityVariant(item.severity)}>
                        {dictionaryLabel(copy.severities, item.severity)}
                      </Badge>
                      <Badge variant="outline">
                        {dictionaryLabel(copy.messageTypes, item.type)}
                      </Badge>
                      <Badge variant="outline">
                        {dictionaryLabel(
                          copy.deliveryStatuses,
                          item.deliveryStatus,
                        )}
                      </Badge>
                      {item.requiresAttention ? (
                        <Badge variant="secondary">{copy.attention}</Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] leading-5 text-muted-foreground">
                    <Badge variant="outline" className="font-normal">
                      {copy.channels.inApp}:{" "}
                      {dictionaryLabel(copy.channelStatuses, inAppStatus)}
                    </Badge>
                    {email ? (
                      <Badge variant="outline" className="font-normal">
                        {copy.channels.email}:{" "}
                        {dictionaryLabel(
                          copy.channelStatuses,
                          emailStatus || "skipped",
                        )}
                        {reasonLabel ? `, ${reasonLabel}` : ""}
                      </Badge>
                    ) : null}
                    {attempts !== null ? (
                      <span>
                        {formatI18nTemplate(copy.emailAttempts, {
                          count: attempts,
                        })}
                      </span>
                    ) : null}
                    {retryCount !== null && retryCount > 0 ? (
                      <span>
                        {formatI18nTemplate(copy.emailRetryCount, {
                          count: retryCount,
                        })}
                      </span>
                    ) : null}
                    {durationMs !== null ? (
                      <span>
                        {formatI18nTemplate(copy.emailDuration, {
                          duration: durationMs,
                        })}
                      </span>
                    ) : null}
                    {errorMessage ? <span>{errorMessage}</span> : null}
                  </div>
                </div>
                {item.readAt === null ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={updatingId === item.id}
                      onClick={() => onRead(item.id)}
                    >
                      {updatingId === item.id ? (
                        <Spinner className="size-4" />
                      ) : (
                        <RiCheckLine />
                      )}
                      <span>{copy.markRead}</span>
                    </Button>
                  </div>
                ) : null}
              </div>
              {item.summary || item.bodyText ? (
                <div className="space-y-4 border-t pt-4">
                  {item.summary ? (
                    <blockquote className="border-l-2 border-primary/55 bg-muted/35 px-4 py-3 text-sm leading-6 text-foreground/90">
                      <p className="whitespace-pre-wrap break-words">
                        {item.summary}
                      </p>
                    </blockquote>
                  ) : null}
                  {item.bodyText ? (
                    <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/85">
                      {item.bodyText}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function NotificationCenterClient({
  locale,
  messages,
  teamId,
}: NotificationCenterClientProps) {
  const copy = messages.notificationCenter;
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ruleIdFilter = searchParams.get("ruleId")?.trim() || "";
  const [activeTab, setActiveTab] = useState<NotificationTab>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [updatingId, setUpdatingId] = useState("");
  const [markingAll, setMarkingAll] = useState(false);
  const messagesQueryKey = useMemo(
    () =>
      [
        "dashboard",
        "notification-messages",
        teamId ?? "",
        ruleIdFilter,
        locale,
      ] as const,
    [locale, ruleIdFilter, teamId],
  );
  const messagesQuery = useQuery({
    queryKey: messagesQueryKey,
    queryFn: ({ signal }) =>
      requestAdminService<{
        messages: NotificationMessageData[];
        unreadAttentionCount: number;
      }>("notifications", {
        params: {
          teamId,
          ruleId: ruleIdFilter || undefined,
          locale,
          limit: 80,
        },
        signal,
      }),
    enabled: typeof window !== "undefined",
  });
  const messagesList = messagesQuery.data?.messages ?? [];
  const unreadAttentionCount = messagesQuery.data?.unreadAttentionCount ?? 0;
  const loading = messagesQuery.isPending;

  const filteredMessages = useMemo(() => {
    return messagesList.filter((item) => {
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      if (severityFilter !== "all" && item.severity !== severityFilter) {
        return false;
      }
      if (activeTab === "unread") return isUnread(item);
      if (activeTab === "attention") {
        return item.requiresAttention && isUnread(item);
      }
      if (activeTab === "report") return isReport(item);
      return true;
    });
  }, [activeTab, messagesList, severityFilter, typeFilter]);

  const importantMessages = useMemo(
    () => filteredMessages.filter((item) => !isReport(item)),
    [filteredMessages],
  );
  const reportMessages = useMemo(
    () => filteredMessages.filter(isReport),
    [filteredMessages],
  );
  const unreadCount = useMemo(
    () => messagesList.filter(isUnread).length,
    [messagesList],
  );

  const bodyState = loading
    ? "loading"
    : filteredMessages.length === 0
      ? `empty:${activeTab}`
      : `${activeTab}:${filteredMessages.map((item) => item.id).join(":")}`;

  useEffect(() => {
    if (messagesQuery.isError) toast.error(copy.loadFailed);
  }, [copy.loadFailed, messagesQuery.errorUpdatedAt, messagesQuery.isError]);

  function clearRuleFilter() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("ruleId");
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  async function handleRead(messageId: string) {
    const target = messagesList.find((item) => item.id === messageId);
    setUpdatingId(messageId);
    try {
      const updated = await requestAdminService<NotificationMessageData | null>(
        `notifications/${encodeURIComponent(messageId)}`,
        {
          method: "PATCH",
          body: { read: true, locale },
        },
      );
      queryClient.setQueryData(
        messagesQueryKey,
        (current: typeof messagesQuery.data) => {
          if (!current) return current;
          return {
            ...current,
            messages: current.messages.map((item) =>
              item.id === messageId && updated ? updated : item,
            ),
            unreadAttentionCount:
              target?.requiresAttention && target.readAt === null
                ? Math.max(0, current.unreadAttentionCount - 1)
                : current.unreadAttentionCount,
          };
        },
      );
    } catch {
      toast.error(copy.markReadFailed);
    } finally {
      setUpdatingId("");
    }
  }

  async function handleReadAll() {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      await requestAdminService<{ updated: number }>("notifications/read-all", {
        method: "PATCH",
        body: { teamId, read: true },
      });
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey });
      toast.success(copy.markAllReadSuccess);
    } catch {
      toast.error(copy.markAllReadFailed);
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeading
        title={copy.title}
        subtitle={copy.subtitle}
        actions={
          <>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-40">
                <SelectValue aria-label={copy.typeFilterLabel} />
              </SelectTrigger>
              <SelectContent>
                {MESSAGE_TYPE_FILTERS.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type === "all"
                      ? copy.allTypes
                      : dictionaryLabel(copy.messageTypes, type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={severityFilter} onValueChange={setSeverityFilter}>
              <SelectTrigger className="w-40">
                <SelectValue aria-label={copy.severityFilterLabel} />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_FILTERS.map((severity) => (
                  <SelectItem key={severity} value={severity}>
                    {severity === "all"
                      ? copy.allSeverities
                      : dictionaryLabel(copy.severities, severity)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              onClick={handleReadAll}
              disabled={markingAll || unreadCount === 0}
            >
              {markingAll ? (
                <Spinner className="size-4" />
              ) : (
                <RiCheckDoubleLine />
              )}
              <span>{copy.markAllRead}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => void messagesQuery.refetch()}
            >
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                {loading ? (
                  <Spinner className="size-4" />
                ) : (
                  <RiRefreshLine className="size-4" />
                )}
              </span>
              <AutoResizer
                initial
                animateWidth
                animateHeight={false}
                className="inline-flex shrink-0 items-center"
              >
                <AutoTransition
                  className="inline-block"
                  duration={0.2}
                  type="fade"
                  initial={false}
                  presenceMode="wait"
                  customVariants={{
                    initial: { opacity: 0 },
                    animate: { opacity: 1 },
                    exit: { opacity: 0 },
                  }}
                >
                  <span key={loading ? "loading" : "refresh"}>
                    {loading ? messages.common.loading : copy.refresh}
                  </span>
                </AutoTransition>
              </AutoResizer>
            </Button>
          </>
        }
      />

      <Card className="py-0">
        <CardContent className="p-0">
          <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
            {NOTIFICATION_TABS.map((tab) => (
              <NotificationMetricTab
                key={tab}
                active={activeTab === tab}
                description={copy.tabDescriptions[tab]}
                icon={tabIcon(tab)}
                label={copy.tabs[tab]}
                loading={loading}
                value={
                  tab === "attention"
                    ? unreadAttentionCount
                    : countForTab(messagesList, tab)
                }
                onClick={() => setActiveTab(tab)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {ruleIdFilter ? (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium">{copy.ruleFilterActive}</p>
              <p className="break-all text-xs text-muted-foreground">
                {ruleIdFilter}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearRuleFilter}
            >
              <RiFilterOffLine className="size-4" />
              <span>{copy.ruleFilterClear}</span>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <AutoResizer initial>
        <AutoTransition
          transitionKey={bodyState}
          initial={false}
          duration={0.18}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <Card key="loading">
              <CardContent className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                <Spinner className="mr-2 size-4" />
                {copy.loading}
              </CardContent>
            </Card>
          ) : filteredMessages.length === 0 ? (
            <Card key="empty">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
                <RiNotification3Line className="size-8 text-muted-foreground/70" />
                <p>{copy.empty}</p>
              </CardContent>
            </Card>
          ) : (
            <div key="messages" className="space-y-8">
              <section className="space-y-3">
                <NotificationSectionHeading
                  title={copy.sections.importantTitle}
                  subtitle={formatI18nTemplate(
                    copy.sections.importantDescription,
                    {
                      count: unreadAttentionCount,
                    },
                  )}
                />
                <NotificationMessageList
                  copy={copy}
                  empty={copy.sections.importantEmpty}
                  items={importantMessages}
                  locale={locale}
                  updatingId={updatingId}
                  onRead={(messageId) => void handleRead(messageId)}
                />
              </section>
              <section className="space-y-3">
                <NotificationSectionHeading
                  title={copy.sections.reportsTitle}
                  subtitle={copy.sections.reportsDescription}
                />
                <NotificationMessageList
                  copy={copy}
                  empty={copy.sections.reportsEmpty}
                  items={reportMessages}
                  locale={locale}
                  updatingId={updatingId}
                  onRead={(messageId) => void handleRead(messageId)}
                />
              </section>
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}
