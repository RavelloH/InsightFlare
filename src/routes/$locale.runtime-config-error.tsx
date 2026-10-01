import { Button } from "@insightflare/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { OverlayScrollbar } from "@insightflare/ui/overlay-scrollbar";
import {
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiKey2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";

import { dashboardPageTitle } from "@/lib/page-title";
import Link from "@/lib/router";
export const Route = createFileRoute("/$locale/runtime-config-error")({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.runtimeConfigError.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages } = Route.useRouteContext();
  const copy = messages.runtimeConfigError;
  return (
    <main className="min-h-svh bg-background text-foreground">
      <section className="mx-auto grid min-h-svh w-full max-w-5xl place-items-center px-4 py-8">
        <Card className="w-full border-destructive/30">
          <CardHeader className="gap-5 border-b border-destructive/20 px-6 py-6 md:px-8">
            <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
              <div className="space-y-4">
                <div className="inline-flex w-fit items-center gap-2 border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium uppercase text-destructive">
                  <RiErrorWarningLine className="size-3.5" />
                  {copy.eyebrow}
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {messages.appName}
                  </p>
                  <CardTitle className="max-w-3xl text-balance text-2xl font-semibold md:text-3xl">
                    {copy.heading}
                  </CardTitle>
                  <CardDescription className="max-w-2xl text-sm leading-6">
                    {copy.description}
                  </CardDescription>
                </div>
              </div>
              <div className="grid size-14 shrink-0 place-items-center border border-destructive/30 bg-destructive/10 text-destructive">
                <RiKey2Line className="size-7" />
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-6 px-6 py-6 md:grid-cols-2 md:px-8">
            <div className="space-y-4">
              <h2 className="text-sm font-medium">{copy.requiredTitle}</h2>
              <p className="text-xs text-muted-foreground">
                {copy.requiredDescription}
              </p>
              <div className="grid gap-2">
                <code className="border bg-muted px-3 py-2 text-xs">
                  MAIN_SECRET
                </code>
                <code className="border bg-muted px-3 py-2 text-xs">
                  DAILY_SALT_SECRET
                </code>
              </div>
              <p className="text-xs text-muted-foreground">{copy.secretHint}</p>
            </div>
            <div className="space-y-4">
              <h2 className="inline-flex items-center gap-2 text-sm font-medium">
                <RiTerminalBoxLine className="size-4" />
                {copy.commandTitle}
              </h2>
              <p className="text-xs text-muted-foreground">
                {copy.commandDescription}
              </p>
              <OverlayScrollbar
                axis="horizontal"
                className="border bg-muted"
                contentClassName="w-max min-w-full px-3 py-2"
              >
                <code className="block whitespace-pre text-xs">
                  pnpm run ops:secret:main
                </code>
              </OverlayScrollbar>
              <p className="text-xs text-muted-foreground">
                {copy.quickStartHint}
              </p>
            </div>
            <div className="flex flex-col gap-2 border-t pt-5 md:col-span-2 md:flex-row md:justify-end">
              <Button variant="outline" asChild>
                <Link href="https://github.com/RavelloH/InsightFlare">
                  {copy.docsLabel}
                  <RiExternalLinkLine className="size-3.5" />
                </Link>
              </Button>
              <Button asChild>
                <Link href={`/${locale}/app`}>{copy.homeLabel}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
