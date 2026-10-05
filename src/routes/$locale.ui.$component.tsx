import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { Clickable } from "@insightflare/ui/clickable";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@insightflare/ui/tabs";
import { RiArrowDownSLine, RiArrowUpSLine } from "@remixicon/react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { toast } from "sonner";

import { getUiGalleryCopy } from "@/components/ui-gallery/copy";
import { formatUiGalleryMessage } from "@/components/ui-gallery/format-copy";
import {
  findUiGalleryEntry,
  type UiGalleryContract,
  type UiGalleryEntry,
} from "@/components/ui-gallery/registry";
import { createUiGallerySource } from "@/components/ui-gallery/source-code";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { dashboardPageTitle } from "@/lib/page-title";
import Link from "@/lib/router";

const MAX_PROP_VALUES_PER_ROW = 5;
const MIN_PROP_VALUE_WIDTH = 144;
const PROP_VALUE_GAP = 1;
const COLLAPSED_CODE_HEIGHT = 240;
const LIVE_TABLE_TOTAL_ROWS = 36;
const LIVE_TABLE_INITIAL_ROWS = 14;
const LIVE_TABLE_PAGE_SIZE = 7;
type UiGalleryPropCard = UiGalleryContract["propCards"][number];
type UiGalleryPropValue = UiGalleryPropCard["values"][number];

const LIVE_TABLE_LABELS = [
  "Pricing page",
  "Product overview",
  "Free trial",
  "Checkout",
  "Customer stories",
  "Integration directory",
  "Documentation",
  "Feature tour",
  "Team invite",
  "Security overview",
  "API quickstart",
  "Template library",
  "Contact sales",
  "Mobile app",
  "Developer portal",
  "Annual plans",
  "Workspace setup",
  "Migration guide",
  "Usage report",
  "Community forum",
  "Status page",
  "Release notes",
  "Partner program",
  "Help center",
  "Onboarding",
  "Event tracking",
  "Data export",
  "Account settings",
  "Referral program",
  "Changelog",
  "Privacy center",
  "Newsletter",
  "Webhooks",
  "Single sign-on",
  "Saved reports",
  "Billing portal",
];

function createLiveTableRows(tick: number, count: number) {
  return LIVE_TABLE_LABELS.slice(0, count).map((label, index) => {
    const pageViews = Math.max(
      180,
      Math.round(
        14_000 - index * 430 + Math.sin((tick + index * 2.15) * 0.72) * 1_100,
      ),
    );
    const sourceViews = Math.max(
      160,
      Math.round(
        15_500 - index * 390 + Math.cos((tick + index * 1.4) * 0.66) * 1_350,
      ),
    );

    return {
      key: `live-ranking-${index}`,
      label,
      pages: {
        views: pageViews,
        visitors: Math.round(pageViews * (0.38 + (index % 4) * 0.025)),
      },
      sources: {
        views: sourceViews,
        visitors: Math.round(sourceViews * (0.41 + (index % 5) * 0.02)),
      },
    };
  });
}

function LiveTabbedTablePreview({
  contract,
  cardId,
  valueId,
  previewOverrides,
}: {
  contract: UiGalleryContract;
  cardId: string;
  valueId: string;
  previewOverrides?: Record<string, unknown>;
}) {
  const [rankingTick, setRankingTick] = useState(0);
  const [rankingRowCount, setRankingRowCount] = useState(
    LIVE_TABLE_INITIAL_ROWS,
  );
  const [rankingLoadingMore, setRankingLoadingMore] = useState(false);
  const loadInFlightRef = useRef(false);
  const loadTimeoutRef = useRef<number | null>(null);

  const loadMoreRows = useCallback(() => {
    if (loadInFlightRef.current || rankingRowCount >= LIVE_TABLE_TOTAL_ROWS) {
      return;
    }

    loadInFlightRef.current = true;
    setRankingLoadingMore(true);
    const nextCount = Math.min(
      LIVE_TABLE_TOTAL_ROWS,
      rankingRowCount + LIVE_TABLE_PAGE_SIZE,
    );
    loadTimeoutRef.current = window.setTimeout(() => {
      setRankingRowCount(nextCount);
      setRankingLoadingMore(false);
      loadInFlightRef.current = false;
      loadTimeoutRef.current = null;
    }, 720);
  }, [rankingRowCount]);

  useEffect(() => {
    const intervalId = window.setInterval(
      () => setRankingTick((tick) => tick + 1),
      1000,
    );
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(
    () => () => {
      if (loadTimeoutRef.current !== null) {
        window.clearTimeout(loadTimeoutRef.current);
      }
    },
    [],
  );

  const rows = createLiveTableRows(rankingTick, rankingRowCount);
  return contract.renderPropValue(cardId, valueId, true, {
    ...previewOverrides,
    state: rankingLoadingMore ? "loading-more" : "ready",
    rows,
    rowsByTab: { pages: rows, sources: rows },
    hasMore: rankingRowCount < LIVE_TABLE_TOTAL_ROWS,
    onLoadMore: loadMoreRows,
  });
}

export const Route = createFileRoute("/$locale/ui/$component")({
  beforeLoad: ({ params }) => {
    if (!findUiGalleryEntry(params.component)) throw notFound();
  },
  head: ({ params }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          findUiGalleryEntry(params.component)?.contract.title ??
            "UI Components",
          {},
        ),
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: UiGalleryDetail,
});

function UiGalleryDetail() {
  const { component: slug } = Route.useParams();
  const locale = resolveLocale(Route.useParams().locale);
  const entry = findUiGalleryEntry(slug);
  if (!entry) throw notFound();

  const { contract } = entry;
  const maxValuesPerRow = Math.max(
    1,
    Math.floor(entry.maxValuesPerRow ?? MAX_PROP_VALUES_PER_ROW),
  );
  const copy = getUiGalleryCopy(entry, locale);
  const messages = getMessages(locale).uiGallery;
  const installPackage =
    entry.packageType === "ui"
      ? "@insightflare/ui"
      : "@insightflare/product-ui";
  const installCommands = [
    `npm i ${installPackage}`,
    `pnpm add ${installPackage}`,
    `yarn add ${installPackage}`,
  ];
  const propGridRef = useRef<HTMLDivElement>(null);
  const [valuesPerRow, setValuesPerRow] = useState(MAX_PROP_VALUES_PER_ROW);

  useEffect(() => {
    const element = propGridRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const updateValuesPerRow = () => {
      const width = element.getBoundingClientRect().width;
      const columns = Math.max(
        1,
        Math.min(
          maxValuesPerRow,
          Math.floor(
            (width + PROP_VALUE_GAP) / (MIN_PROP_VALUE_WIDTH + PROP_VALUE_GAP),
          ),
        ),
      );
      setValuesPerRow(columns);
    };

    updateValuesPerRow();
    const observer = new ResizeObserver(updateValuesPerRow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [maxValuesPerRow]);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-[0.16em] text-primary">
            {copy.category}
          </p>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">
              {copy.title}
            </h1>
            <code className="font-mono text-xs text-muted-foreground">
              {entry.apiEntry}
            </code>
          </div>
        </div>
        <div
          role="group"
          aria-label="Package installation commands"
          className="inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 border bg-muted/30 px-3 py-2"
        >
          {installCommands.map((command, index) => (
            <Fragment key={command}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-border">
                  /
                </span>
              ) : null}
              <code className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                {command}
              </code>
            </Fragment>
          ))}
        </div>
      </div>

      <section
        aria-labelledby="component-fixtures-heading"
        className="space-y-4"
      >
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2
              id="component-fixtures-heading"
              className="text-lg font-semibold"
            >
              {messages.canonicalStates}
            </h2>
          </div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatUiGalleryMessage(messages.statesCount, {
              count: contract.propCards.reduce(
                (total, card) => total + card.values.length,
                0,
              ),
            })}
          </span>
        </div>

        <div ref={propGridRef} className="grid gap-4">
          {contract.propCards.map((card) => {
            const valueRows = splitIntoBalancedRows(
              card.values,
              Math.min(valuesPerRow, maxValuesPerRow),
            );

            return (
              <PropCard
                key={card.id}
                entry={entry}
                card={card}
                valueRows={valueRows}
                previewLabel={messages.previewState}
                resetLabel={messages.resetPreview}
                expandCodeLabel={messages.expandCode}
                collapseCodeLabel={messages.collapseCode}
              />
            );
          })}
        </div>
      </section>

      <div className="flex justify-end">
        <Button variant="outline" asChild>
          <Link href={"/" + locale + "/ui"}>
            {messages.browseAllComponents}
          </Link>
        </Button>
      </div>
    </div>
  );
}

function PropCard({
  entry,
  card,
  valueRows,
  previewLabel,
  resetLabel,
  expandCodeLabel,
  collapseCodeLabel,
}: {
  entry: UiGalleryEntry;
  card: UiGalleryPropCard;
  valueRows: UiGalleryPropValue[][];
  previewLabel: string;
  resetLabel: string;
  expandCodeLabel: string;
  collapseCodeLabel: string;
}) {
  const firstValueId = card.values[0]?.id ?? "";
  const [activeValueId, setActiveValueId] = useState(firstValueId);
  const [autoCycle, setAutoCycle] = useState(0);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [codeOverflows, setCodeOverflows] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);
  const activeValue =
    card.values.find((value) => value.id === activeValueId) ?? card.values[0];
  const shouldAutoCycle =
    entry.slug === "animated-number" ||
    entry.slug === "auto-transition" ||
    entry.slug === "auto-resizer";

  useEffect(() => {
    if (!shouldAutoCycle) return;

    const intervalId = window.setInterval(
      () => setAutoCycle((cycle) => cycle + 1),
      entry.slug === "auto-resizer" ? 1200 : 2400,
    );
    return () => window.clearInterval(intervalId);
  }, [entry.slug, shouldAutoCycle]);

  const source = activeValue
    ? createUiGallerySource(
        entry,
        entry.contract.renderPropValue(card.id, activeValue.id, true),
      )
    : "";

  useEffect(() => {
    const code = codeRef.current;
    if (!code) return;

    const measureOverflow = () => {
      setCodeOverflows(code.scrollHeight > COLLAPSED_CODE_HEIGHT);
    };

    measureOverflow();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measureOverflow);
    observer.observe(code);
    return () => observer.disconnect();
  }, [source]);

  return (
    <Card
      id={card.id}
      data-ui-prop-card={card.prop}
      className="scroll-mt-20 gap-0 py-0"
    >
      <CardHeader className="flex min-h-12 items-center justify-between border-b !py-0">
        <CardTitle className="font-mono text-sm">{card.prop}</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="grid gap-px bg-border/70">
          {valueRows.map((row, rowIndex) => (
            <div
              key={`${card.id}-row-${rowIndex}`}
              className="grid gap-px"
              style={{
                gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))`,
              }}
            >
              {row.map((value) => (
                <div
                  key={value.id}
                  data-ui-prop-value={value.id}
                  className="flex min-h-28 min-w-0 flex-col gap-3 bg-card px-4 py-8"
                >
                  <div className="flex min-h-16 w-full min-w-0 flex-1 items-center justify-center">
                    <PropValuePreview
                      contract={entry.contract}
                      entrySlug={entry.slug}
                      cardId={card.id}
                      valueId={value.id}
                      deferred={value.preview === "on-demand"}
                      previewAlignment={entry.previewAlignment ?? "center"}
                      previewLabel={previewLabel}
                      resetLabel={resetLabel}
                      previewOverrides={getDynamicPreviewOverrides(
                        entry.slug,
                        card.id,
                        value.id,
                        autoCycle,
                      )}
                    />
                  </div>
                  <code className="mt-auto block text-center font-mono text-[10px] text-muted-foreground">
                    {formatPropValue(value.value)}
                  </code>
                </div>
              ))}
            </div>
          ))}
        </div>
      </CardContent>
      <div className="border-t bg-card">
        <Tabs
          value={activeValue?.id ?? ""}
          onValueChange={setActiveValueId}
          className="gap-0"
        >
          <div className="px-3 py-2">
            <TabsList
              variant="line"
              aria-label={`${card.prop} example values`}
              className="h-auto w-full flex-wrap justify-start gap-x-2 gap-y-1 p-0"
            >
              {card.values.map((value) => (
                <TabsTrigger
                  key={value.id}
                  value={value.id}
                  className="h-8 flex-none rounded-none px-2 font-mono text-[11px] after:hidden"
                >
                  {formatPropValue(value.value)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {activeValue ? (
            <TabsContent
              value={activeValue.id}
              className="mt-0 px-4 py-4"
              data-ui-prop-source={activeValue.id}
            >
              <div>
                <div className="relative">
                  <AutoResizer
                    className="relative"
                    duration={0.32}
                    maxHeight={
                      codeOverflows && !codeExpanded
                        ? COLLAPSED_CODE_HEIGHT
                        : undefined
                    }
                  >
                    <pre
                      ref={codeRef}
                      className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-6 text-foreground/85"
                    >
                      <code>{source}</code>
                    </pre>
                  </AutoResizer>
                  {codeOverflows && !codeExpanded ? (
                    <div className="absolute inset-x-0 bottom-0 z-10 flex h-16 items-end justify-center bg-gradient-to-b from-transparent via-card/90 to-card pb-2">
                      <Clickable
                        className="gap-1 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                        hoverScale={1.04}
                        tapScale={0.98}
                        aria-expanded={false}
                        aria-label={expandCodeLabel}
                        onClick={() => setCodeExpanded(true)}
                      >
                        <span>{expandCodeLabel}</span>
                        <RiArrowDownSLine className="size-4" />
                      </Clickable>
                    </div>
                  ) : null}
                </div>
                {codeOverflows && codeExpanded ? (
                  <div className="flex justify-center pt-2">
                    <Clickable
                      className="gap-1 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                      hoverScale={1.04}
                      tapScale={0.98}
                      aria-expanded={true}
                      aria-label={collapseCodeLabel}
                      onClick={() => setCodeExpanded(false)}
                    >
                      <span>{collapseCodeLabel}</span>
                      <RiArrowUpSLine className="size-4" />
                    </Clickable>
                  </div>
                ) : null}
              </div>
            </TabsContent>
          ) : null}
        </Tabs>
      </div>
    </Card>
  );
}

function getTransitionPreviewOverrides(valueId: string, cycle: number) {
  return {
    transitionKey: `${valueId}-${cycle}`,
    children: cycle % 2 === 0 ? "Updated content" : "Refreshed content",
  };
}

function getDynamicPreviewOverrides(
  entrySlug: string,
  cardId: string,
  valueId: string,
  cycle: number,
) {
  if (entrySlug === "animated-number") {
    const selectedValue = cardId === "value" ? Number(valueId) : 1284;
    return Number.isFinite(selectedValue)
      ? { value: selectedValue + (cycle % 2 === 0 ? 0 : 4387) }
      : undefined;
  }

  if (entrySlug === "auto-transition") {
    return getTransitionPreviewOverrides(valueId, cycle);
  }

  if (entrySlug === "auto-resizer") {
    const hasStaggeredBooleanState =
      (cardId === "animateHeight" || cardId === "animateWidth") &&
      (valueId === "true" || valueId === "false");
    const phase = cycle % 8;
    const showLongContent = hasStaggeredBooleanState
      ? valueId === "true"
        ? phase === 1 || phase === 2
        : phase === 4 || phase === 5
      : cycle % 2 === 0
        ? valueId === "long-content"
        : valueId !== "long-content";
    return {
      children: showLongContent ? (
        <div className="max-w-xs space-y-2 text-sm">
          <p>A longer measured summary that wraps across several lines.</p>
          <p className="text-muted-foreground">
            The container tracks this height as the content changes.
          </p>
        </div>
      ) : (
        <p className="max-w-xs text-sm">A short measured summary.</p>
      ),
    };
  }

  return undefined;
}

function formatPropValue(value: string | number | boolean) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function splitIntoBalancedRows<T>(items: readonly T[], maxPerRow: number) {
  if (items.length === 0) return [];

  const rowCount = Math.ceil(items.length / maxPerRow);
  const baseRowSize = Math.floor(items.length / rowCount);
  const extraItems = items.length % rowCount;
  let start = 0;

  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const rowSize = baseRowSize + (rowIndex < extraItems ? 1 : 0);
    const row = items.slice(start, start + rowSize);
    start += rowSize;
    return row;
  });
}

function PropValuePreview({
  contract,
  entrySlug,
  cardId,
  valueId,
  deferred,
  previewAlignment,
  previewLabel,
  resetLabel,
  previewOverrides,
}: {
  contract: UiGalleryContract;
  entrySlug: string;
  cardId: string;
  valueId: string;
  deferred: boolean;
  previewAlignment: "center" | "start" | "centered-left";
  previewLabel: string;
  resetLabel: string;
  previewOverrides?: Record<string, unknown>;
}) {
  const [showDeferredPreview, setShowDeferredPreview] = useState(false);
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const scrollAxis = cardId === "axis" ? valueId : "horizontal";
  const isLiveTabbedTableDemo =
    entrySlug === "tabbed-table" && cardId === "state" && valueId === "ready";
  const isOverlayScrollbarAxisDemo =
    entrySlug === "overlay-scrollbar" && cardId === "axis";
  const isOverlayScrollbarMaskDemo =
    entrySlug === "overlay-scrollbar" &&
    cardId === "showEdgeMasks" &&
    valueId === "true";
  const isVerticalScrollMaskDemo =
    entrySlug === "vertical-scroll-mask" && cardId === "enabled";
  const isAutoToastDemo =
    entrySlug === "sonner" && (cardId === "position" || cardId === "theme");

  useEffect(() => {
    if (
      !isOverlayScrollbarAxisDemo &&
      !isOverlayScrollbarMaskDemo &&
      !isVerticalScrollMaskDemo
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const element = scrollElementRef.current;
      if (!element) return;

      if (
        (isOverlayScrollbarAxisDemo && scrollAxis !== "vertical") ||
        isOverlayScrollbarMaskDemo
      ) {
        const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
        const nextLeft = element.scrollLeft > 1 ? 0 : maxLeft;
        element.scrollTo({ left: nextLeft, behavior: "smooth" });
      }

      if (
        isVerticalScrollMaskDemo ||
        (isOverlayScrollbarAxisDemo &&
          (scrollAxis === "vertical" || scrollAxis === "both"))
      ) {
        const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
        const nextTop = element.scrollTop > 1 ? 0 : maxTop;
        element.scrollTo({ top: nextTop, behavior: "smooth" });
      }
    }, 2100);

    return () => window.clearInterval(intervalId);
  }, [
    entrySlug,
    isOverlayScrollbarAxisDemo,
    isOverlayScrollbarMaskDemo,
    isVerticalScrollMaskDemo,
    scrollAxis,
  ]);

  useEffect(() => {
    if (!isAutoToastDemo) return;

    const toasterId = `ui-gallery-${cardId}-${valueId}`;
    const messages = ["Settings saved", "Report exported", "Link copied"];
    let messageIndex = 0;
    const showToast = () => {
      toast.success(messages[messageIndex % messages.length], {
        toasterId,
        duration: 3800,
      });
      messageIndex += 1;
    };
    const firstTimeout = window.setTimeout(showToast, 500);
    const intervalId = window.setInterval(showToast, 4000);

    return () => {
      window.clearTimeout(firstTimeout);
      window.clearInterval(intervalId);
    };
  }, [cardId, isAutoToastDemo, valueId]);

  if (deferred && !showDeferredPreview) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={() => setShowDeferredPreview(true)}
      >
        {previewLabel}
      </Button>
    );
  }

  const previewContentClass =
    previewAlignment === "start"
      ? "w-full min-w-0 text-left [&>*]:mx-0"
      : previewAlignment === "centered-left"
        ? "w-full max-w-sm min-w-0 text-left [&>*]:mx-auto"
        : "w-full min-w-0 text-center [&>*]:mx-auto";

  return (
    <div
      className={`flex w-full min-w-0 flex-col gap-3 ${previewAlignment === "start" ? "items-start" : "items-center"}`}
    >
      <div className={previewContentClass}>
        {isLiveTabbedTableDemo ? (
          <LiveTabbedTablePreview
            contract={contract}
            cardId={cardId}
            valueId={valueId}
            previewOverrides={previewOverrides}
          />
        ) : (
          contract.renderPropValue(cardId, valueId, showDeferredPreview, {
            ...previewOverrides,
            ...(entrySlug === "overlay-scrollbar"
              ? { scrollElementRef }
              : entrySlug === "vertical-scroll-mask"
                ? { hostRef: scrollElementRef }
                : {}),
          })
        )}
      </div>
      {deferred ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowDeferredPreview(false)}
        >
          {resetLabel}
        </Button>
      ) : null}
    </div>
  );
}
