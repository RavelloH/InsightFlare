import type { Locale } from "@/lib/i18n/config";

import { buildNotificationContent } from "./content";
import { renderNotificationPlainText } from "./email-text";
import type { NotificationMessage, NotificationMessageDraft } from "./message";

export interface BuildLocalizedNotificationMessageInput {
  draft: NotificationMessageDraft;
  locale: Locale;
  timeZone?: string | null;
}

export interface LocalizedNotificationMessageFields {
  locale: Locale;
  title: string;
  summary: string;
  bodyText: string;
}

function draftMessage(
  draft: NotificationMessageDraft,
  localized: { title: string; summary: string; bodyText: string },
): NotificationMessage {
  return {
    id: "",
    teamId: "",
    siteId: null,
    userId: "",
    ruleId: null,
    runId: null,
    batchId: null,
    type: draft.type,
    severity: draft.severity,
    requiresAttention: draft.requiresAttention,
    title: localized.title,
    summary: localized.summary,
    bodyText: localized.bodyText,
    bodyHtml: "",
    data: draft.data ?? {},
    channels: {},
    deliveryStatus: "created",
    deliveryResults: {},
    errorMessage: "",
    readAt: null,
    dismissedAt: null,
    archivedAt: null,
    triggeredAt: null,
    createdAt: 0,
    updatedAt: 0,
    sentAt: null,
    failedAt: null,
    expiresAt: null,
  };
}

export function buildLocalizedNotificationMessageFields({
  draft,
  locale,
  timeZone,
}: BuildLocalizedNotificationMessageInput): LocalizedNotificationMessageFields {
  try {
    const content = buildNotificationContent({
      type: draft.type,
      severity: draft.severity,
      data: draft.data ?? {},
      fallbackTitle: draft.title,
      fallbackSummary: draft.summary,
      fallbackBodyText: draft.bodyText,
      locale,
    });
    const bodyText = renderNotificationPlainText({
      content,
      locale,
      timeZone,
      message: draftMessage(draft, content),
    });
    return {
      locale,
      title: content.title,
      summary: content.summary,
      bodyText,
    };
  } catch {
    return {
      locale,
      title: draft.title,
      summary: draft.summary,
      bodyText: draft.bodyText,
    };
  }
}
