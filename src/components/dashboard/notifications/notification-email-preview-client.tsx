import { useEffect, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { Field, FieldLabel } from "@insightflare/ui/field";
import { OverlayScrollbar } from "@insightflare/ui/overlay-scrollbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import { Spinner } from "@insightflare/ui/spinner";
import { RiMailSendLine, RiRefreshLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeading } from "@/components/dashboard/common/page-heading";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import {
  isValidLocale,
  type Locale,
  SUPPORTED_LOCALES,
} from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
type PreviewType =
  "test" | "report" | "milestone" | "threshold" | "change" | "health";
type PreviewFormat = "html" | "text" | "json";
type NotificationEmailPreview = {
  subject: string;
  html: string;
  text: string;
};
const PREVIEW_TYPES: PreviewType[] = [
  "test",
  "report",
  "milestone",
  "threshold",
  "change",
  "health",
];
const PREVIEW_FORMATS: PreviewFormat[] = ["html", "text", "json"];
function localeLabel(messages: AppMessages, locale: Locale): string {
  if (locale === "zh") return messages.actions.switchToChinese;
  if (locale === "ja") return messages.actions.switchToJapanese;
  return messages.actions.switchToEnglish;
}
export function NotificationEmailPreviewClient({
  locale,
  messages,
}: {
  locale: Locale;
  messages: AppMessages;
}) {
  const copy = messages.teamManagement.notifications;
  const page = copy.emailPreviewPage;
  const [type, setType] = useState<PreviewType>("report");
  const [previewLocale, setPreviewLocale] = useState<Locale>(locale);
  const [format, setFormat] = useState<PreviewFormat>("html");
  const previewQuery = useQuery({
    queryKey: [
      "dashboard",
      "notification-email-preview",
      type,
      previewLocale,
      format,
    ],
    queryFn: () =>
      requestAdminService<NotificationEmailPreview>(
        "notification-email-preview",
        {
          params: {
            type,
            locale: previewLocale,
            format: "json",
          },
        },
      ),
    enabled: typeof window !== "undefined",
  });
  const loading = previewQuery.isFetching;
  const subject = previewQuery.data?.subject || "";
  const payload =
    format === "html"
      ? previewQuery.data?.html || ""
      : format === "text"
        ? previewQuery.data?.text || ""
        : previewQuery.data
          ? JSON.stringify(previewQuery.data, null, 2)
          : "";

  useEffect(() => {
    if (previewQuery.isError) toast.error(page.loadFailed);
  }, [page.loadFailed, previewQuery.errorUpdatedAt, previewQuery.isError]);

  return (
    <div className="space-y-4">
      <PageHeading
        title={page.title}
        subtitle={page.subtitle}
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void previewQuery.refetch()}
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
                  {page.refresh}
                </span>
              </AutoTransition>
            </AutoResizer>
          </Button>
        }
      />

      <Card>
        <CardContent className="grid gap-4 p-4 md:grid-cols-3">
          <Field>
            <FieldLabel>{page.typeLabel}</FieldLabel>
            <Select
              value={type}
              onValueChange={(value) => {
                if (
                  value === "test" ||
                  value === "report" ||
                  value === "milestone" ||
                  value === "threshold" ||
                  value === "change" ||
                  value === "health"
                ) {
                  setType(value);
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PREVIEW_TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {copy.ruleTypes[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{page.localeLabel}</FieldLabel>
            <Select
              value={previewLocale}
              onValueChange={(value) => {
                if (isValidLocale(value)) setPreviewLocale(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_LOCALES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {localeLabel(messages, item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{page.formatLabel}</FieldLabel>
            <Select
              value={format}
              onValueChange={(value) => {
                if (value === "html" || value === "text" || value === "json") {
                  setFormat(value);
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PREVIEW_FORMATS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item === "html"
                      ? page.html
                      : item === "text"
                        ? page.text
                        : page.json}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2 text-base">
            <RiMailSendLine className="size-4" />
            {subject ? `${page.subject}: ${subject}` : page.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              <Spinner className="mr-2 size-4" />
              {page.loading}
            </div>
          ) : format === "html" ? (
            <iframe
              title={page.title}
              sandbox=""
              srcDoc={payload}
              className="h-[680px] w-full rounded-none border bg-white"
            />
          ) : (
            <OverlayScrollbar
              axis="vertical"
              className="max-h-[680px] rounded-md bg-muted"
            >
              <pre className="whitespace-pre-wrap p-4 text-xs leading-5">
                {payload}
              </pre>
            </OverlayScrollbar>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
