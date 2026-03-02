import { RiTestTubeLine as Beaker, RiTimeLine as Clock4 } from "@remixicon/react";
import { PrecisionQuery } from "@/components/precision-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";

interface SearchParams {
  from?: string;
  to?: string;
}

function parseNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

export default async function PrecisionPage({
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
  const now = Date.now();
  const defaultFrom = now - 3 * 365 * 24 * 60 * 60 * 1000;
  const from = parseNumber(sp.from, defaultFrom);
  const to = parseNumber(sp.to, now);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("precision.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("precision.description")}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="bg-def-200 rounded-lg p-1 inline-flex">
                <Clock4 className="h-4 w-4" />
              </span>
              {t("precision.timeRange")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>From: {new Date(from).toLocaleString()}</p>
            <p>To: {new Date(to).toLocaleString()}</p>
            <p>{t("precision.timeTip")}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="bg-def-200 rounded-lg p-1 inline-flex">
                <Beaker className="h-4 w-4" />
              </span>
              {t("precision.inputDataset")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Site: {siteId}</p>
            <p>{t("precision.archiveSource")}</p>
            <p>{t("precision.archiveFormat")}</p>
          </CardContent>
        </Card>
      </div>

      <PrecisionQuery siteId={siteId} from={from} to={to} />
    </div>
  );
}
