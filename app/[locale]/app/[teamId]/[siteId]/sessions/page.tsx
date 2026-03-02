import { Clock } from "lucide-react";
import { Widget, WidgetHead, WidgetBody } from "@/components/widget/widget";
import { SessionCompactList } from "@/components/dashboard/session-compact-list";
import { DateRangePicker } from "@/components/dashboard/date-range-picker";
import { LiveCounter } from "@/components/shared/live-counter";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { fetchPrivateSessions } from "@/lib/edge-client";

interface SearchParams {
  from?: string;
  to?: string;
  fromIso?: string;
  toIso?: string;
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

export default async function SessionsPage({
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

  const wsBaseUrl =
    process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_URL ||
    process.env.INSIGHTFLARE_EDGE_URL ||
    "";
  const wsToken = process.env.NEXT_PUBLIC_INSIGHTFLARE_WS_TOKEN || "";

  const sessions = await fetchPrivateSessions({ siteId, from, to });

  return (
    <div className="mx-auto max-w-7xl">
      <div className="sticky top-0 z-[9] -mx-4 mb-4 border-b bg-background/80 px-4 py-1.5 backdrop-blur-sm md:-mx-6 md:px-6">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <DateRangePicker locale={locale} from={from} to={to} />
          {wsBaseUrl && (
            <LiveCounter
              siteId={siteId}
              wsBaseUrl={wsBaseUrl}
              wsToken={wsToken}
            />
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold">{t("sessions.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("sessions.description")}
          </p>
        </div>

        <Widget>
          <WidgetHead>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              {t("dashboard.sessionSnapshot")}
            </div>
          </WidgetHead>
          <WidgetBody>
            {sessions.data.length > 0 ? (
              <SessionCompactList
                sessions={sessions.data}
                emptyLabel={t("dashboard.noSessions")}
              />
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {t("common.noData")}
              </p>
            )}
          </WidgetBody>
        </Widget>
      </div>
    </div>
  );
}
