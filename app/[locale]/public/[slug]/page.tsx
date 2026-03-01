import { Globe2, LockKeyhole, TrendingUp } from "lucide-react";
import { TrendAreaChart } from "@/components/charts/trend-area-chart";
import { ReferrerBarChart } from "@/components/charts/referrer-bar-chart";
import { PagesBarChart } from "@/components/charts/pages-bar-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import {
  fetchPublicOverview,
  fetchPublicPages,
  fetchPublicReferrers,
  fetchPublicTrend,
} from "@/lib/edge-client";
import { compactNumber, formatPercent } from "@/lib/utils";

function resolveRange(searchParams: Record<string, string | string[] | undefined>): { from: number; to: number } {
  const now = Date.now();
  const fromRaw = searchParams.from;
  const toRaw = searchParams.to;
  const from =
    typeof fromRaw === "string" && Number.isFinite(Number(fromRaw))
      ? Math.floor(Number(fromRaw))
      : now - 30 * 24 * 60 * 60 * 1000;
  const to = typeof toRaw === "string" && Number.isFinite(Number(toRaw)) ? Math.floor(Number(toRaw)) : now;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

export default async function PublicSitePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const routeParams = await params;
  const { locale: rawLocale, slug } = routeParams;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const qp = await searchParams;
  const range = resolveRange(qp);

  const [overview, trend, pages, referrers] = await Promise.all([
    fetchPublicOverview(slug, range),
    fetchPublicTrend(slug, range),
    fetchPublicPages(slug, range),
    fetchPublicReferrers(slug, range),
  ]);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 md:px-6">
      <header className="rounded-xl border bg-card p-6">
        <Badge variant="signal">{t("public.badge")}</Badge>
        <h1 className="mt-2 font-[var(--font-display)] text-3xl font-semibold md:text-4xl">{t("public.title")}</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{t("public.description")}</p>
      </header>

      <section className="grid gap-4 md:grid-cols-4">
        {[
          { label: t("dashboard.views"), value: compactNumber(overview.data.views) },
          { label: t("dashboard.sessions"), value: compactNumber(overview.data.sessions) },
          { label: t("dashboard.visitors"), value: compactNumber(overview.data.visitors) },
          { label: t("dashboard.bounceRate"), value: formatPercent(overview.data.bounceRate) },
        ].map((metric) => (
          <Card key={metric.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{metric.label}</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{metric.value}</CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            {t("public.trend")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TrendAreaChart data={trend.data} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe2 className="h-5 w-5 text-primary" />
              {t("public.topReferrers")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {referrers.data.length > 0 ? (
              <ReferrerBarChart data={referrers.data} directLabel={t("dashboard.direct")} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("common.noData")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LockKeyhole className="h-5 w-5 text-chart-3" />
              {t("public.topPaths")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pages.data.length > 0 ? (
              <PagesBarChart data={pages.data} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("common.noData")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
