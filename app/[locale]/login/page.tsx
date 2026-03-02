import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { Flame } from "lucide-react";

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const dict = await getDictionary(locale);
  const t = (key: string) => dict[key] ?? key;
  const sp = await searchParams;
  const nextParam = typeof sp.next === "string" ? sp.next : `/${locale}/app`;
  const hasError = sp.error === "invalid_credentials";

  return (
    <main className="relative min-h-screen bg-background md:grid md:grid-cols-2">
      <header className="absolute inset-x-0 top-0 z-20 flex h-16 items-center justify-between px-6 md:px-8">
        <Link href={`/${locale}/login`} className="flex items-center gap-2">
          <Flame className="h-6 w-6 text-primary" />
          <span className="font-medium text-sm text-muted-foreground">
            InsightFlare
          </span>
        </Link>
        <nav className="hidden items-center gap-4 text-sm text-muted-foreground md:flex">
          <a href="https://openpanel.dev" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Openpanel
          </a>
          <a href="https://openpanel.dev/docs" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Docs
          </a>
          <a href="https://openpanel.dev/discord" target="_blank" rel="noopener noreferrer" className="hover:underline">
            Community
          </a>
        </nav>
      </header>

      <section className="hidden p-8 pt-24 md:block">
        <div className="relative h-full overflow-hidden rounded-xl border border-border bg-card p-8 shadow-sm">
          <div className="absolute -left-20 -top-16 h-64 w-64 rounded-full bg-chart-1/10 blur-3xl" />
          <div className="absolute -right-20 -bottom-20 h-72 w-72 rounded-full bg-chart-3/10 blur-3xl" />
          <div className="relative space-y-6">
            <Badge variant="signal">{t("login.hero.badge")}</Badge>
            <div className="space-y-2">
              <h1 className="text-4xl font-semibold leading-tight">
                {t("login.hero.title")}
              </h1>
              <p className="max-w-lg text-muted-foreground">
                {t("login.hero.description")}
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-md border border-border bg-def-100 p-4 text-sm text-muted-foreground">
                {t("login.hero.feature1")}
              </div>
              <div className="rounded-md border border-border bg-def-100 p-4 text-sm text-muted-foreground">
                {t("login.hero.feature2")}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="flex min-h-screen items-center justify-center px-4 pb-10 pt-24 md:px-8">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl">{t("login.title")}</CardTitle>
            <CardDescription>{t("login.subtitle")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form action="/api/auth/login" method="POST" className="space-y-4">
              <input type="hidden" name="next" value={nextParam} />
              <div className="space-y-2">
                <Label>{t("login.username")}</Label>
                <Input type="text" name="username" required placeholder="admin" />
              </div>
              <div className="space-y-2">
                <Label>{t("login.password")}</Label>
                <Input type="password" name="password" required placeholder="Enter account password" />
              </div>
              {hasError && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  {t("login.invalidCredentials")}
                </p>
              )}
              <Button type="submit" className="w-full">
                {t("login.enterDashboard")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
