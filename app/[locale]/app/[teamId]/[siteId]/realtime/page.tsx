import { RealtimeFullView } from "@/components/dashboard/realtime-full-view";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";

export default async function RealtimePage({
  params,
}: {
  params: Promise<{ locale: string; teamId: string; siteId: string }>;
}) {
  const { locale: rawLocale, siteId } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;

  const wsBaseUrl =
    process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_URL ||
    process.env.INSIGHTFLARE_EDGE_URL ||
    "";
  const wsToken = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_TOKEN || "";

  return (
    <div className="mx-auto max-w-7xl space-y-4">
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
