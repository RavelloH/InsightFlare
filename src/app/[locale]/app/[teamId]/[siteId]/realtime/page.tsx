import { RealtimeFullView } from "@/components/dashboard/realtime-full-view";
import { StickyDashboardHeader } from "@/components/dashboard/sticky-dashboard-header";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";

interface SearchParams {
  from?: string;
  to?: string;
  fromIso?: string;
  toIso?: string;
  interval?: string;
}

function parseDateInput(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const num = Number(value);
  if (Number.isFinite(num)) return Math.floor(num);
  return null;
}

function resolveRange(sp: SearchParams): { from: number; to: number } {
  const now = Date.now();
  const from =
    parseDateInput(sp.fromIso) ??
    parseDateInput(sp.from) ??
    now - 7 * 24 * 60 * 60 * 1000;
  const to = parseDateInput(sp.toIso) ?? parseDateInput(sp.to) ?? now;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

export default async function RealtimePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; teamId: string; siteId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale: rawLocale, siteId } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;
  const { from, to } = resolveRange(sp);
  const interval = sp.interval === "hour" ? "hour" : "day";

  const wsBaseUrl =
    process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_URL ||
    process.env.INSIGHTFLARE_EDGE_URL ||
    "";
  const wsToken = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_TOKEN || "";

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <StickyDashboardHeader
        locale={locale}
        from={from}
        to={to}
        interval={interval}
        siteId={siteId}
        wsBaseUrl={wsBaseUrl}
        wsToken={wsToken}
      />

      <div>
        <h1 className="text-xl font-semibold">{t("realtime.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("realtime.description")}
        </p>
      </div>

      <RealtimeFullView
        siteId={siteId}
        wsBaseUrl={wsBaseUrl}
        wsToken={wsToken}
        labels={{
          title: t("dashboard.realtimeStream"),
          wsHint: t("dashboard.wsHint"),
          waitingLive: t("dashboard.waitingLive"),
          noEvents: t("realtime.noEvents"),
          live: t("dashboard.liveVisitors"),
        }}
      />
    </div>
  );
}
