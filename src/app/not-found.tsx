import { headers } from "next/headers";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getMessages } from "@/lib/i18n/messages";
import { resolveLocale } from "@/lib/i18n/config";

function localeFromPathname(pathname: string | null): string | undefined {
  if (!pathname) return undefined;
  const segment = pathname.split("/")[1];
  return segment;
}

function firstHeaderValue(source: Headers, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source.get(key);
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function firstIpFromForwarded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

export default async function SiteNotFound() {
  const requestHeaders = await headers();
  const pathname = requestHeaders.get("x-pathname");
  const resolved = resolveLocale(localeFromPathname(pathname));
  const t = getMessages(resolved);
  const protocol =
    firstHeaderValue(requestHeaders, ["x-forwarded-proto"]) || "http";
  const host = firstHeaderValue(requestHeaders, ["x-forwarded-host", "host"]);
  const requestPath = pathname || "/";
  const requestUrl = host ? `${protocol}://${host}${requestPath}` : requestPath;
  const requestId =
    firstHeaderValue(requestHeaders, [
      "x-request-id",
      "cf-ray",
      "x-vercel-id",
    ]) || crypto.randomUUID();
  const ip =
    firstIpFromForwarded(
      firstHeaderValue(requestHeaders, ["x-forwarded-for"]),
    ) ||
    firstHeaderValue(requestHeaders, ["cf-connecting-ip", "x-real-ip"]) ||
    "-";
  const country = firstHeaderValue(requestHeaders, [
    "cf-ipcountry",
    "x-vercel-ip-country",
  ]);
  const region = firstHeaderValue(requestHeaders, [
    "cf-region",
    "x-vercel-ip-country-region",
  ]);
  const city = firstHeaderValue(requestHeaders, [
    "cf-ipcity",
    "x-vercel-ip-city",
  ]);
  const location = [country, region, city].filter(Boolean).join(" / ") || "-";
  const timestamp = new Date().toISOString();

  const diagnostics: Array<{ key: string; value: string }> = [
    { key: "reason", value: "not_found_route" },
    { key: "access_id", value: requestId },
    { key: "ip", value: ip },
    { key: "region", value: location },
    { key: "timestamp", value: timestamp },
    { key: "request_url", value: requestUrl },
  ];

  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-xl border-border/80 shadow-lg">
        <CardHeader className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <CardTitle>{t.empty.siteNotFound}</CardTitle>
            <Badge variant="destructive">404</Badge>
          </div>
          <CardDescription>{t.appName}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden">
            {diagnostics.map((item) => (
              <div
                key={item.key}
                className="grid grid-cols-[128px_minmax(0,1fr)] gap-3 border-b border-border/70 px-3 py-2 last:border-b-0"
              >
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  {item.key}
                </p>
                <p className="break-all font-mono text-xs">{item.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
