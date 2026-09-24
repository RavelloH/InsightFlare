import type { Locale } from "@/lib/i18n/config";

import type { NotificationContent } from "./content";
import { notificationMetricLabel, notificationWindowLabel } from "./content";
import {
  formatNotificationDateTime,
  formatNotificationNumber,
} from "./email-format";
import { NOTIFICATION_EMAIL_MESSAGES } from "./email-i18n";
import type { NotificationMessage } from "./message";

interface RenderNotificationEmailTextInput {
  content: NotificationContent;
  message: NotificationMessage;
  locale: Locale;
  timeZone?: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatLastSeen(
  value: unknown,
  locale: Locale,
  timeZone?: string | null,
): string {
  const messages = NOTIFICATION_EMAIL_MESSAGES[locale];
  return (
    formatNotificationDateTime(value, locale, timeZone) || messages.common.never
  );
}

function usesFullwidthPunctuation(locale: Locale): boolean {
  return locale === "zh" || locale === "ja";
}

function renderReportText(input: RenderNotificationEmailTextInput): string {
  const messages = NOTIFICATION_EMAIL_MESSAGES[input.locale];
  const data = input.message.data;
  const range = record(data.range);
  const metrics = record(data.metrics);
  const topPages = rows(data.topPages);
  const topReferrers = rows(data.topReferrers);
  const date = textValue(range.label);
  const pageLines =
    topPages.length > 0
      ? topPages.map((page, index) => {
          const path = textValue(page.path, "/");
          const views = formatNotificationNumber(page.views, input.locale);
          return `${index + 1}. ${path} - ${views} ${messages.common.viewsUnit}`;
        })
      : [messages.common.noPageData];
  const referrerLines =
    topReferrers.length > 0
      ? topReferrers.map((referrer, index) => {
          const name = textValue(referrer.referrer, messages.common.direct);
          const visits = formatNotificationNumber(
            referrer.visits,
            input.locale,
          );
          return `${index + 1}. ${name} - ${visits} ${messages.common.visits}`;
        })
      : [messages.common.noReferrerData];
  const colon = usesFullwidthPunctuation(input.locale) ? "：" : ":";

  return [
    input.content.title,
    "",
    `${messages.common.date}${colon} ${date}`,
    "",
    `${messages.common.coreMetrics}${colon}`,
    `- ${messages.common.views}${colon} ${formatNotificationNumber(metrics.views, input.locale)}`,
    `- ${messages.common.visitors}${colon} ${formatNotificationNumber(metrics.visitors, input.locale)}`,
    `- ${messages.common.sessions}${colon} ${formatNotificationNumber(metrics.sessions, input.locale)}`,
    "",
    `${messages.common.topPages}${colon}`,
    ...pageLines,
    "",
    `${messages.common.topReferrers}${colon}`,
    ...referrerLines,
  ].join("\n");
}

function renderThresholdText(input: RenderNotificationEmailTextInput): string {
  const messages = NOTIFICATION_EMAIL_MESSAGES[input.locale];
  const data = input.message.data;
  const colon = usesFullwidthPunctuation(input.locale) ? "：" : ":";
  const separator = usesFullwidthPunctuation(input.locale) ? "" : " ";
  const operator = textValue(data.operator, ">=");
  return [
    input.content.title,
    "",
    `${messages.common.metric}${colon}${separator}${notificationMetricLabel(input.locale, data.metric)}`,
    `${messages.common.window}${colon}${separator}${notificationWindowLabel(input.locale, data.window)}`,
    `${messages.common.currentValue}${colon}${separator}${formatNotificationNumber(data.value, input.locale)}`,
    `${messages.common.threshold}${colon}${separator}${operator} ${formatNotificationNumber(data.target, input.locale)}`,
  ].join("\n");
}

function renderMilestoneText(input: RenderNotificationEmailTextInput): string {
  const messages = NOTIFICATION_EMAIL_MESSAGES[input.locale];
  const data = input.message.data;
  const colon = usesFullwidthPunctuation(input.locale) ? "：" : ":";
  const separator = usesFullwidthPunctuation(input.locale) ? "" : " ";
  return [
    input.content.title,
    "",
    input.content.summary,
    "",
    `${messages.common.metric}${colon}${separator}${notificationMetricLabel(input.locale, data.metric)}`,
    `${messages.common.milestone}${colon}${separator}${formatNotificationNumber(data.bucket, input.locale)}`,
    `${messages.common.currentValue}${colon}${separator}${formatNotificationNumber(data.value, input.locale)}`,
  ].join("\n");
}

function renderChangeText(input: RenderNotificationEmailTextInput): string {
  const messages = NOTIFICATION_EMAIL_MESSAGES[input.locale];
  const data = input.message.data;
  const colon = usesFullwidthPunctuation(input.locale) ? "：" : ":";
  const separator = usesFullwidthPunctuation(input.locale) ? "" : " ";
  const suffix = data.mode === "percent" ? "%" : "";
  const mode =
    data.mode === "percent"
      ? "percent"
      : data.mode === "absolute"
        ? "absolute"
        : String(data.mode || "absolute");
  return [
    input.content.title,
    "",
    input.content.summary,
    "",
    `${messages.common.metric}${colon}${separator}${notificationMetricLabel(input.locale, data.metric)}`,
    `${messages.common.window}${colon}${separator}${notificationWindowLabel(input.locale, data.window)}`,
    `${messages.common.previousValue}${colon}${separator}${formatNotificationNumber(data.previous, input.locale)}`,
    `${messages.common.currentValue}${colon}${separator}${formatNotificationNumber(data.current, input.locale)}`,
    `${messages.common.change}${colon}${separator}${formatNotificationNumber(data.change, input.locale)}${suffix}`,
    `${messages.common.mode}${colon}${separator}${mode}`,
  ].join("\n");
}

function renderHealthText(input: RenderNotificationEmailTextInput): string {
  const messages = NOTIFICATION_EMAIL_MESSAGES[input.locale];
  const colon = usesFullwidthPunctuation(input.locale) ? "：" : ":";
  const separator = usesFullwidthPunctuation(input.locale) ? "" : " ";
  return [
    input.content.title,
    "",
    input.content.summary,
    "",
    `${messages.common.lastSeen}${colon}${separator}${formatLastSeen(
      input.message.data.lastSeenAt,
      input.locale,
      input.timeZone,
    )}`,
  ].join("\n");
}

export function renderNotificationPlainText(
  input: RenderNotificationEmailTextInput,
): string {
  if (input.message.type === "report") return renderReportText(input);
  if (input.message.type === "milestone") return renderMilestoneText(input);
  if (input.message.type === "threshold") return renderThresholdText(input);
  if (input.message.type === "change") return renderChangeText(input);
  if (input.message.type === "health") return renderHealthText(input);
  return [input.content.title, "", input.content.bodyText].join("\n").trim();
}

export const renderNotificationEmailText = renderNotificationPlainText;
