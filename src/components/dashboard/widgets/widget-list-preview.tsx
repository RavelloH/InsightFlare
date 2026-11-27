import { type ReactNode, useEffect, useRef, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import { RiLoader4Line, RiRestartLine } from "@remixicon/react";

import { type Locale } from "@/lib/i18n/config";
import type { WidgetData, WidgetRecord } from "@/lib/widgets/contract";
import { suggestedWidgetHeight } from "@/lib/widgets/contract";

import type { widgetLabels } from "./labels";
import { type ApiResult, widgetRequest } from "./widget-manager-model";
import { PreviewFrame } from "./widget-preview-frame";

const MASONRY_ROW_HEIGHT = 8;
const MASONRY_CARD_GAP = 16;

export function MasonryItem({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [rowSpan, setRowSpan] = useState(1);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => {
      const contentHeight = element.getBoundingClientRect().height;
      const next = Math.max(
        1,
        Math.ceil((contentHeight + MASONRY_CARD_GAP) / MASONRY_ROW_HEIGHT),
      );
      setRowSpan((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-w-0" style={{ gridRowEnd: `span ${rowSpan}` }}>
      <div ref={contentRef} className="min-w-0">
        {children}
      </div>
    </div>
  );
}

// Filter switches remount cards. Reuse recent preview data so a remount does
// not re-run its analytics query; edits change updatedAt/revision and miss.
const PREVIEW_CACHE_TTL_MS = 60_000;
const PREVIEW_CACHE_LIMIT = 200;
const previewCache = new Map<string, { data: WidgetData; expiresAt: number }>();

function previewCacheKey(record: WidgetRecord): string {
  return `${record.uuid}:${record.updatedAt}:${record.revision}`;
}

function cachedPreview(key: string): WidgetData | null {
  const hit = previewCache.get(key);
  return hit && hit.expiresAt > Date.now() ? hit.data : null;
}

function rememberPreview(key: string, data: WidgetData): void {
  previewCache.delete(key);
  if (previewCache.size >= PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value;
    if (oldest !== undefined) previewCache.delete(oldest);
  }
  previewCache.set(key, { data, expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS });
}

export function WidgetListPreview({
  record,
  basePath,
  copy,
  locale,
  siteOrigin,
}: {
  record: WidgetRecord;
  basePath: string;
  copy: ReturnType<typeof widgetLabels>;
  locale: Locale;
  siteOrigin?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const cacheKey = previewCacheKey(record);
  const [data, setData] = useState<WidgetData | null>(() =>
    cachedPreview(cacheKey),
  );
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const config = record.published ?? record.draft;
  const height = Math.min(suggestedWidgetHeight(config), 460);

  // Only query previews when their cards approach the viewport. A team may
  // have many widgets, and each preview executes a real analytics query.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const cached = attempt === 0 ? cachedPreview(cacheKey) : null;
    if (cached) {
      setData(cached);
      return;
    }
    let active = true;
    setData(null);
    setFailed(false);
    void widgetRequest<ApiResult<WidgetData>>(`${basePath}/preview`, "POST", {
      siteId: record.siteId,
      config,
    })
      .then((result) => {
        rememberPreview(cacheKey, result.data);
        if (active) setData(result.data);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [basePath, cacheKey, config, record.siteId, visible, attempt]);

  return (
    <div ref={containerRef} className="min-w-0 w-full">
      <AutoResizer className="w-full" duration={0.24}>
        <AutoTransition
          transitionKey={data ? "loaded" : failed ? "failed" : "loading"}
          initial={false}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className="min-w-0 w-full"
        >
          {data ? (
            <PreviewFrame
              title={config.title || copy.preview}
              width={360}
              height={height}
              label={copy.preview}
              fluid
              hideLabel
              autoHeight
              uuid={record.uuid}
              config={config}
              data={data}
              locale={locale}
              siteOrigin={siteOrigin}
            />
          ) : (
            <div
              className="flex min-h-28 w-full items-center justify-center bg-muted/10 text-muted-foreground"
              aria-label={copy.preview}
              role="status"
            >
              {failed ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAttempt((current) => current + 1)}
                >
                  <RiRestartLine className="size-4" aria-hidden="true" />
                  {copy.retry}
                </Button>
              ) : (
                <RiLoader4Line
                  className="size-5 animate-spin"
                  aria-label={copy.loading}
                />
              )}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}
