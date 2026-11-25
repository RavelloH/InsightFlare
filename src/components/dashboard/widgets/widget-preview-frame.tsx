import { useEffect, useMemo, useRef, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { RiEyeLine } from "@remixicon/react";

import { type Locale } from "@/lib/i18n/config";
import type { WidgetConfig, WidgetData } from "@/lib/widgets/contract";
import { renderWidgetDocument } from "@/lib/widgets/embed";

export function PreviewFrame({
  title,
  width,
  height,
  label,
  uuid,
  config,
  data,
  locale,
  siteOrigin,
  fluid = false,
  hideLabel = false,
  autoHeight = false,
}: {
  title: string;
  width: number;
  height: number;
  label: string;
  uuid: string;
  config: WidgetConfig;
  data: WidgetData | null;
  locale: Locale;
  siteOrigin?: string;
  fluid?: boolean;
  hideLabel?: boolean;
  autoHeight?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const srcDoc = useMemo(
    () =>
      data
        ? renderWidgetDocument({
            uuid,
            config,
            preview: true,
            previewData: data,
            autoHeight,
            localeOverride: locale,
            siteOrigin,
          })
        : undefined,
    [uuid, config, data, autoHeight, locale, siteOrigin],
  );

  useEffect(() => {
    if (!autoHeight || !srcDoc) return;
    // Keep the last measured height until the new iframe reports its content.
    // Resetting to the type-based fallback would cause a visible height bounce.
    const onHeight = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message: unknown = event.data;
      if (!message || typeof message !== "object") return;
      if (!("type" in message) || !("height" in message)) return;
      if (message.type !== "insightflare-widget-height") return;
      const nextHeight = message.height;
      if (
        typeof nextHeight !== "number" ||
        !Number.isFinite(nextHeight) ||
        nextHeight < 1 ||
        nextHeight > 2000
      )
        return;
      setMeasuredHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    };
    window.addEventListener("message", onHeight);
    return () => window.removeEventListener("message", onHeight);
  }, [autoHeight, srcDoc]);

  const isBadge =
    config.type === "realtime" && config.realtimeLayout === "badge";
  return (
    <div
      className={`${hideLabel ? "min-w-0" : "min-w-0 space-y-1.5"} ${isBadge ? "flex min-h-[152px] flex-col justify-center" : ""}`}
    >
      {hideLabel ? null : (
        <p className="text-[11px] text-muted-foreground">{label}</p>
      )}
      <AutoResizer className="w-full" duration={0.24}>
        <AutoTransition
          transitionKey={
            data
              ? `${width}:${JSON.stringify(data)}:${config.type}:${config.title}`
              : "empty"
          }
          initial={false}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className="min-w-0 w-full"
        >
          <div
            className={`mx-auto w-full overflow-hidden bg-muted/20 transition-[max-width] duration-200 ${hideLabel ? "" : "border"}`}
            style={{
              height: autoHeight
                ? (measuredHeight ?? height)
                : Math.min(height, 460),
              maxWidth: fluid ? undefined : width,
            }}
          >
            {srcDoc ? (
              <iframe
                ref={frameRef}
                title={title}
                srcDoc={srcDoc}
                sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                className="h-full w-full border-0"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
                <RiEyeLine className="size-5" aria-hidden="true" />
                <span>{title}</span>
              </div>
            )}
          </div>
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}
