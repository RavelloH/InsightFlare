import "@/lib/iconify";

import jetBrainsMonoLatinUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import { RiFileWarningLine, RiGithubLine, RiHome4Line } from "@remixicon/react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
  useLocation,
} from "@tanstack/react-router";

import { GlobalScrollbars } from "@/components/global-scrollbars";
import { AppQueryProvider } from "@/components/query-client-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { TimeZoneProvider } from "@/components/time-zone-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_NAME } from "@/lib/constants";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";

import "@/app/globals.css";

const THEME_INIT_SCRIPT = `(function(){try{var k='insightflare-theme';var t=localStorage.getItem(k)||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})()`;
const ESBUILD_NAME_HELPER_SCRIPT = `(function(){if(typeof globalThis.__name!=="function"){globalThis.__name=function(target){return target}}})()`;
const DEMO_ANALYTICS_SCRIPT_SRC =
  "https://insight.ravelloh.com/script.js?siteId=04de9d96-fcec-41b1-b259-56e0dbaa2c5e";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      { name: "description", content: `${APP_NAME} analytics dashboard` },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  }),
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning data-overlayscrollbars-initialize>
      <head>
        <link
          rel="preload"
          href={jetBrainsMonoLatinUrl}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <HeadContent />
      </head>
      <body className="antialiased font-mono" data-overlayscrollbars-initialize>
        <ScriptOnce>{THEME_INIT_SCRIPT}</ScriptOnce>
        <GlobalScrollbars />
        <ScriptOnce>{ESBUILD_NAME_HELPER_SCRIPT}</ScriptOnce>
        <AppQueryProvider>
          <TimeZoneProvider>
            <ThemeProvider>
              <TooltipProvider>
                <Outlet />
              </TooltipProvider>
              <Toaster />
            </ThemeProvider>
          </TimeZoneProvider>
        </AppQueryProvider>
        {import.meta.env.VITE_DEMO_MODE === "1" ? (
          <script defer src={DEMO_ANALYTICS_SCRIPT_SRC} />
        ) : null}
        <Scripts />
      </body>
    </html>
  );
}

export function NotFoundPage() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const locale = resolveLocale(pathname.split("/")[1]);
  const messages = getMessages(locale);
  const copy = messages.errorPage;
  const reportUrl = buildErrorReportUrl({
    pathname,
    status: 404,
    reason: copy.notFoundReason,
  });

  return (
    <ErrorPageLayout
      locale={locale}
      pathname={pathname || "/"}
      messages={messages}
      status={404}
      eyebrow={copy.notFoundEyebrow}
      title={copy.notFoundTitle}
      description={copy.notFoundDescription}
      reason={copy.notFoundReason}
      reportUrl={reportUrl}
      details={null}
    />
  );
}

export function ErrorPage({ error }: { error: Error }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const locale = resolveLocale(pathname.split("/")[1]);
  const messages = getMessages(locale);
  const copy = messages.errorPage;
  const errorName = error instanceof Error ? error.name : "Error";
  const errorMessage =
    error instanceof Error ? error.message : "Unexpected application error";
  const reportUrl = buildErrorReportUrl({
    pathname,
    status: 500,
    reason: copy.unexpectedReason,
    errorName,
    errorMessage,
  });

  return (
    <ErrorPageLayout
      locale={locale}
      pathname={pathname || "/"}
      messages={messages}
      status={500}
      eyebrow={copy.errorEyebrow}
      title={copy.errorTitle}
      description={copy.errorDescription}
      reason={copy.unexpectedReason}
      reportUrl={reportUrl}
      details={{ errorName, errorMessage }}
    />
  );
}

function buildErrorReportUrl({
  pathname,
  status,
  reason,
  errorName,
  errorMessage,
}: {
  pathname: string;
  status: number;
  reason: string;
  errorName?: string;
  errorMessage?: string;
}) {
  const title = `[Bug] ${APP_NAME} ${status} on ${pathname || "/"}`;
  const body = [
    "### What happened",
    "",
    "Please describe what you expected and what happened.",
    "",
    "### Diagnostic context",
    `- Status: ${status}`,
    `- Reason: ${reason}`,
    `- Path: ${pathname || "/"}`,
    ...(errorName ? [`- Error type: ${errorName}`] : []),
    ...(errorMessage ? [`- Error message: ${errorMessage}`] : []),
    "",
    "Generated by the InsightFlare error page.",
  ].join("\n");

  return `https://github.com/RavelloH/InsightFlare/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=bug`;
}

function ErrorPageLayout({
  locale,
  pathname,
  messages,
  status,
  eyebrow,
  title,
  description,
  reason,
  reportUrl,
  details,
}: {
  locale: string;
  pathname: string;
  messages: ReturnType<typeof getMessages>;
  status: 404 | 500;
  eyebrow: string;
  title: string;
  description: string;
  reason: string;
  reportUrl: string;
  details: { errorName: string; errorMessage: string } | null;
}) {
  const copy = messages.errorPage;
  const rows = [
    [copy.statusLabel, String(status)],
    [copy.reasonLabel, reason],
    [copy.requestLabel, pathname],
    [copy.timestampLabel, "-"],
    [copy.diagnosticIdLabel, "-"],
  ];

  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card
        className={`w-full max-w-xl shadow-lg ${status === 500 ? "border-destructive/30" : "border-border/80"}`}
      >
        <CardHeader className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="inline-flex items-center gap-2 text-lg">
              <RiFileWarningLine
                className={
                  status === 500 ? "size-4 text-destructive" : "size-4"
                }
              />
              {title}
            </CardTitle>
            <Badge variant="destructive">{status}</Badge>
          </div>
          <CardDescription>
            <span className="mr-2 text-[11px] uppercase tracking-[0.08em]">
              {eyebrow}
            </span>
            {description}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="overflow-hidden border border-border/70">
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 border-b border-border/70 px-3 py-2 last:border-b-0 sm:grid-cols-[140px_minmax(0,1fr)]"
              >
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  {label}
                </p>
                <p className="break-all font-mono text-xs">{value}</p>
              </div>
            ))}
            {details ? (
              <>
                <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 border-b border-border/70 px-3 py-2 sm:grid-cols-[140px_minmax(0,1fr)]">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    {copy.errorTypeLabel}
                  </p>
                  <p className="break-all font-mono text-xs">
                    {details.errorName}
                  </p>
                </div>
                <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 px-3 py-2 sm:grid-cols-[140px_minmax(0,1fr)]">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    {copy.errorMessageLabel}
                  </p>
                  <p className="break-words font-mono text-xs text-muted-foreground">
                    {details.errorMessage}
                  </p>
                </div>
              </>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 border-t border-border/70 pt-4 sm:flex-row sm:justify-end">
            <Button variant="outline" asChild>
              <Link href={`/${locale}/app`}>
                <RiHome4Line data-icon="inline-start" />
                {copy.homeAction}
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={reportUrl} target="_blank" rel="noreferrer">
                <RiGithubLine data-icon="inline-start" />
                {copy.reportAction}
              </Link>
            </Button>
          </div>
          <p className="text-right text-[11px] text-muted-foreground">
            {copy.reportHint}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
