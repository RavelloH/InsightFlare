import { memo, useMemo } from "react";
import { RiShareForwardLine } from "@remixicon/react";

import { ContentSwitch } from "@/components/dashboard/content-switch";
import { ShareRadialCard } from "@/components/dashboard/share-radial-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { ReferrerSummaryData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface ReferrerSummarySectionProps {
  locale: Locale;
  messages: AppMessages;
  summary: ReferrerSummaryData["data"] | null;
  loading: boolean;
  hideSummaryCard?: boolean;
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-none border border-border/70 bg-muted/15 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-tight">
        {value}
      </p>
    </div>
  );
}

export const ReferrerSummarySection = memo(function ReferrerSummarySection({
  locale,
  messages,
  summary,
  loading,
  hideSummaryCard = false,
}: ReferrerSummarySectionProps) {
  const sortedTopSources = useMemo(
    () =>
      [...(summary?.topSources ?? [])].sort(
        (left, right) => right.views - left.views,
      ),
    [summary?.topSources],
  );
  const totalViews = summary?.totalViews ?? 0;
  const directViews = summary?.directViews ?? 0;
  const externalViews = summary?.externalViews ?? 0;
  const uniqueDomains = summary?.uniqueDomains ?? 0;
  const uniqueLinks = summary?.uniqueLinks ?? 0;
  const hasContent = summary !== null && totalViews > 0;
  const showInitialLoading = loading && !hasContent;
  const topSource = sortedTopSources[0] ?? null;
  const topSourceShare =
    totalViews > 0 && topSource ? topSource.views / totalViews : 0;
  const nextFourViews = useMemo(
    () => sortedTopSources.slice(1, 5).reduce((sum, row) => sum + row.views, 0),
    [sortedTopSources],
  );
  const longTailViews = Math.max(
    0,
    externalViews - sortedTopSources.reduce((sum, row) => sum + row.views, 0),
  );
  const splitItems = useMemo(
    () => [
      {
        key: "direct",
        label: messages.overview.direct,
        value: directViews,
        color: "var(--color-chart-1)",
      },
      {
        key: "external",
        label: messages.referrers.externalLabel,
        value: externalViews,
        color: "var(--color-chart-3)",
      },
    ],
    [
      directViews,
      externalViews,
      messages.overview.direct,
      messages.referrers.externalLabel,
    ],
  );
  const mixItems = useMemo(
    () => [
      {
        key: "top",
        label: topSource?.referrer ?? messages.referrers.topSource,
        value: topSource?.views ?? 0,
        color: "var(--color-chart-1)",
      },
      {
        key: "next",
        label: messages.referrers.nextSources,
        value: nextFourViews,
        color: "var(--color-chart-3)",
      },
      {
        key: "tail",
        label: messages.referrers.longTail,
        value: longTailViews,
        color: "var(--muted-foreground)",
        isOther: true,
      },
    ],
    [
      longTailViews,
      messages.referrers.longTail,
      messages.referrers.nextSources,
      messages.referrers.topSource,
      nextFourViews,
      topSource?.referrer,
      topSource?.views,
    ],
  );

  return (
    <section className="space-y-6">
      {hideSummaryCard ? null : (
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiShareForwardLine className="size-4" />
              {messages.referrers.summaryTitle}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ContentSwitch
              loading={loading}
              hasContent={hasContent}
              loadingLabel={messages.common.loading}
              emptyContent={<p>{messages.common.noData}</p>}
              minHeightClassName="min-h-[220px]"
            >
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <SummaryMetric
                    label={messages.common.views}
                    value={numberFormat(locale, totalViews)}
                  />
                  <SummaryMetric
                    label={messages.referrers.directViews}
                    value={numberFormat(locale, directViews)}
                  />
                  <SummaryMetric
                    label={messages.referrers.uniqueDomains}
                    value={numberFormat(locale, uniqueDomains)}
                  />
                  <SummaryMetric
                    label={messages.referrers.uniqueLinks}
                    value={numberFormat(locale, uniqueLinks)}
                  />
                </div>

                <div className="rounded-none border border-border/70 bg-muted/10 p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    {messages.referrers.topSource}
                  </p>
                  <p className="mt-2 break-words text-lg font-medium tracking-tight">
                    {topSource?.referrer ?? messages.referrers.noExternalSource}
                  </p>
                  {topSource ? (
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                      <span>
                        {messages.common.views}:{" "}
                        <span className="font-mono text-foreground">
                          {numberFormat(locale, topSource.views)}
                        </span>
                      </span>
                      <span>
                        {messages.referrers.topSourceShare}:{" "}
                        <span className="font-mono text-foreground">
                          {percentFormat(locale, topSourceShare)}
                        </span>
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </ContentSwitch>
          </CardContent>
        </Card>
      )}

      <ContentSwitch
        loading={false}
        hasContent={hasContent || showInitialLoading}
        loadingLabel={messages.common.loading}
        emptyContent={<p>{messages.common.noData}</p>}
        minHeightClassName="min-h-[280px]"
        initial={false}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <ShareRadialCard
            title={messages.referrers.splitTitle}
            items={splitItems}
            maxItems={2}
            locale={locale}
            loading={showInitialLoading}
            valueLabel={messages.common.views}
          />
          <ShareRadialCard
            title={messages.referrers.chartTitle}
            items={mixItems}
            maxItems={3}
            locale={locale}
            loading={showInitialLoading}
            valueLabel={messages.common.views}
          />
        </div>
      </ContentSwitch>
    </section>
  );
});
