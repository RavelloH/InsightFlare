import { useState } from "react";
import { Button } from "@insightflare/ui/button";
import { Field, FieldLabel } from "@insightflare/ui/field";
import { OverlayScrollbar } from "@insightflare/ui/overlay-scrollbar";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@insightflare/ui/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import {
  RiCodeLine,
  RiExternalLinkLine,
  RiFileCopyLine,
} from "@remixicon/react";
import { toast } from "sonner";

import { HighlightedCode } from "@/components/code/highlighted-code";
import { type Locale, SUPPORTED_LOCALES } from "@/lib/i18n/config";
import { nativeLocaleName } from "@/lib/i18n/native-locale-names";
import type { WidgetRecord } from "@/lib/widgets/contract";
import { suggestedWidgetHeight } from "@/lib/widgets/contract";

import type { widgetLabels } from "./labels";
import { displayType, widgetEmbedSnippet } from "./widget-manager-model";

export function WidgetEmbedDialog({
  copy,
  record: embedRecord,
  onClose,
}: {
  copy: ReturnType<typeof widgetLabels>;
  record: WidgetRecord | null;
  onClose: () => void;
}) {
  const [embedLanguage, setEmbedLanguage] = useState<"auto" | Locale>("auto");
  // Each newly opened record starts from the visitor's automatic language.
  const [shownUuid, setShownUuid] = useState(embedRecord?.uuid);
  if (embedRecord?.uuid !== shownUuid) {
    setShownUuid(embedRecord?.uuid);
    if (embedRecord) setEmbedLanguage("auto");
  }

  function embedPath(record: WidgetRecord): string {
    const prefix = embedLanguage === "auto" ? "" : `/${embedLanguage}`;
    return `${prefix}/widget/${encodeURIComponent(record.uuid)}`;
  }

  function embedCode(record: WidgetRecord): string {
    const config = record.published ?? record.draft;
    return widgetEmbedSnippet({
      origin: window.location.origin,
      path: embedPath(record),
      config,
      title: config.title || displayType(config.type, copy),
    });
  }

  async function copyEmbed(record: WidgetRecord) {
    try {
      await navigator.clipboard.writeText(embedCode(record));
      toast.success(copy.copied);
    } catch {
      toast.error(copy.requestError);
    }
  }

  return (
    <ResponsiveDialog
      open={embedRecord !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ResponsiveDialogContent
        className="flex flex-col overflow-hidden p-0"
        desktopClassName="w-full max-w-2xl"
        drawerClassName="max-h-[85dvh]"
      >
        <div className="shrink-0 border-b p-4 sm:p-5">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiCodeLine}>
              {copy.embedCode}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {copy.embedSizeGuide}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
        </div>
        <ResponsiveDialogBody className="space-y-4 p-4 sm:p-5">
          {embedRecord ? (
            <>
              <Field className="min-w-0">
                <FieldLabel htmlFor="widget-embed-language">
                  {copy.language}
                </FieldLabel>
                <Select
                  value={embedLanguage}
                  onValueChange={(value) =>
                    setEmbedLanguage(value as "auto" | Locale)
                  }
                >
                  <SelectTrigger id="widget-embed-language" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{copy.auto}</SelectItem>
                    {SUPPORTED_LOCALES.map((language) => (
                      <SelectItem key={language} value={language}>
                        {nativeLocaleName(language)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {copy.publicAddress}
                </p>
                <a
                  className="flex min-w-0 items-start gap-2 break-all text-sm text-primary underline-offset-4 hover:underline"
                  href={embedPath(embedRecord)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {window.location.origin}
                  {embedPath(embedRecord)}
                  <RiExternalLinkLine
                    className="size-4 shrink-0"
                    aria-hidden="true"
                  />
                </a>
              </div>
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs font-medium">{copy.embedCode}</p>
                <div className="min-w-0 border bg-muted/25 p-3">
                  <OverlayScrollbar
                    axis="horizontal"
                    showEdgeMasks
                    className="min-w-0 w-full text-xs leading-relaxed text-foreground"
                    contentClassName="w-max min-w-full"
                  >
                    <HighlightedCode
                      source={embedCode(embedRecord)}
                      className="font-mono whitespace-pre"
                    />
                  </OverlayScrollbar>
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-xs font-semibold">{copy.embedDetails}</h3>
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">{copy.height}</dt>
                  <dd className="tabular-nums">
                    {suggestedWidgetHeight(
                      embedRecord.published ?? embedRecord.draft,
                    )}
                    px
                  </dd>
                  <dt className="text-muted-foreground">{copy.range}</dt>
                  <dd>
                    {(embedRecord.published ?? embedRecord.draft).range === "7d"
                      ? copy.sevenDays
                      : copy.thirtyDays}
                  </dd>
                  <dt className="text-muted-foreground">{copy.timeZone}</dt>
                  <dd>
                    {(embedRecord.published ?? embedRecord.draft).timeZone}
                  </dd>
                  <dt className="text-muted-foreground">{copy.theme}</dt>
                  <dd>
                    {(embedRecord.published ?? embedRecord.draft).theme ===
                    "auto"
                      ? copy.auto
                      : (embedRecord.published ?? embedRecord.draft).theme ===
                          "light"
                        ? copy.light
                        : copy.dark}
                  </dd>
                  <dt className="text-muted-foreground">{copy.embedMode}</dt>
                  <dd>
                    {(embedRecord.published ?? embedRecord.draft).embedMode ===
                    "any"
                      ? copy.any
                      : copy.restricted}
                  </dd>
                  {(embedRecord.published ?? embedRecord.draft).embedMode ===
                  "restricted" ? (
                    <>
                      <dt className="text-muted-foreground">
                        {copy.accessOrigins}
                      </dt>
                      <dd className="break-all">
                        {(
                          embedRecord.published ?? embedRecord.draft
                        ).allowedOrigins.join(", ")}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </div>
              <p className="border-l-2 border-primary/60 bg-muted/20 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                {copy.embedCaution}
              </p>
            </>
          ) : null}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter className="shrink-0 border-t p-4 sm:p-5">
          <Button variant="outline" onClick={() => onClose()}>
            {copy.close}
          </Button>
          <Button
            disabled={!embedRecord}
            onClick={() => {
              if (embedRecord) void copyEmbed(embedRecord);
            }}
          >
            <RiFileCopyLine className="size-4" aria-hidden="true" />
            {copy.copyEmbed}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
