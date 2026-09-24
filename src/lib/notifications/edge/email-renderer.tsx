import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Locale } from "@/lib/i18n/config";
import {
  buildNotificationContent,
  type NotificationContent,
} from "@/lib/notifications/content";
import { renderNotificationPlainText } from "@/lib/notifications/email-text";
import type { NotificationMessage } from "@/lib/notifications/message";

export interface RenderNotificationEmailInput {
  message: NotificationMessage;
  locale: Locale;
  timeZone?: string | null;
}

export interface RenderedNotificationEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildNotificationContentForMessage(input: {
  message: NotificationMessage;
  locale: Locale;
}): NotificationContent {
  return buildNotificationContent({
    type: input.message.type,
    severity: input.message.severity,
    data: input.message.data,
    fallbackTitle: input.message.title,
    fallbackSummary: input.message.summary,
    fallbackBodyText: input.message.bodyText,
    locale: input.locale,
  });
}

export async function renderNotificationEmail({
  message,
  locale,
  timeZone,
}: RenderNotificationEmailInput): Promise<RenderedNotificationEmail> {
  const content = buildNotificationContentForMessage({ message, locale });
  const text = renderNotificationPlainText({
    content,
    message,
    locale,
    timeZone,
  });
  const { NotificationEmail } =
    await import("@/components/email/notification-email");
  const html = `<!doctype html>${renderToStaticMarkup(
    createElement(NotificationEmail, {
      locale,
      content,
      message,
      timeZone,
    }),
  )}`;
  return {
    subject: content.subject,
    html,
    text,
  };
}
