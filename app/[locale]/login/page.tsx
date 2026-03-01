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
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <div className="grid w-full max-w-5xl gap-8 md:grid-cols-[1.2fr_1fr]">
        <section className="space-y-6 rounded-xl border bg-card/70 p-8 backdrop-blur">
          <Badge variant="signal">{t("login.hero.badge")}</Badge>
          <div className="flex items-center gap-3">
            <Flame className="h-10 w-10 text-primary" />
            <h1 className="font-[var(--font-display)] text-4xl leading-tight md:text-5xl">
              {t("login.hero.title")}
            </h1>
          </div>
          <p className="max-w-md text-muted-foreground">
            {t("login.hero.description")}
          </p>
          <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            <div className="rounded-lg border p-4">
              {t("login.hero.feature1")}
            </div>
            <div className="rounded-lg border p-4">
              {t("login.hero.feature2")}
            </div>
          </div>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl font-[var(--font-display)]">{t("login.title")}</CardTitle>
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
                <p className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  {t("login.invalidCredentials")}
                </p>
              )}
              <Button type="submit" className="w-full">
                {t("login.enterDashboard")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
