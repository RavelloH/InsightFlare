import jetBrainsMonoLatinUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
} from "@tanstack/react-router";

import { GlobalScrollbars } from "@/components/global-scrollbars";
import { AppQueryProvider } from "@/components/query-client-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { TimeZoneProvider } from "@/components/time-zone-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_NAME } from "@/lib/constants";

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

function NotFoundPage() {
  return (
    <main className="grid min-h-svh place-items-center p-6">
      <div className="space-y-2 text-center">
        <p className="text-4xl font-semibold">404</p>
        <p className="text-sm text-muted-foreground">Page not found</p>
      </div>
    </main>
  );
}
