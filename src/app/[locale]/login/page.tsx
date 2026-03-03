import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { isAuthenticated } from "@/lib/auth";

interface LoginPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    error?: string;
    next?: string;
  }>;
}

function safeNextPath(value: string | undefined, locale: string): string {
  if (!value || !value.startsWith("/")) {
    return `/${locale}/app`;
  }
  return value;
}

function withNext(pathname: string, nextPath: string): string {
  const params = new URLSearchParams();
  if (nextPath) {
    params.set("next", nextPath);
  }
  return params.size > 0 ? `${pathname}?${params.toString()}` : pathname;
}

export default async function LoginPage({
  params,
  searchParams,
}: LoginPageProps) {
  const { locale } = await params;
  const search = await searchParams;
  const resolvedLocale = resolveLocale(locale);
  const t = getMessages(resolvedLocale);

  if (await isAuthenticated()) {
    redirect(`/${resolvedLocale}/app`);
  }

  const nextPath = safeNextPath(search.next, resolvedLocale);
  const showError = search.error === "invalid_credentials";

  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="py-8 w-full text-4xl flex items-center justify-center text-primary">
            InsightFlare
          </div>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-xl">{t.login.title}</CardTitle>
            <div className="flex items-center gap-1">
              <ThemeToggle
                lightLabel={t.actions.switchToLight}
                darkLabel={t.actions.switchToDark}
                className="w-fit self-end"
              />
              <Button
                variant={resolvedLocale === "en" ? "default" : "outline"}
                size="xs"
                asChild
              >
                <Link href={withNext("/en/login", nextPath)}>
                  {t.actions.switchToEnglish}
                </Link>
              </Button>
              <Button
                variant={resolvedLocale === "zh" ? "default" : "outline"}
                size="xs"
                asChild
              >
                <Link href={withNext("/zh/login", nextPath)}>
                  {t.actions.switchToChinese}
                </Link>
              </Button>
            </div>
          </div>

          <CardDescription>{t.login.subtitle}</CardDescription>
        </CardHeader>
        <CardContent className="pb-8">
          <form action="/api/auth/login" method="post" className="space-y-4">
            <input type="hidden" name="next" value={nextPath} />
            <div className="space-y-2">
              <Label htmlFor="username">{t.login.username}</Label>
              <Input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t.login.password}</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            {showError ? (
              <p className="text-xs text-destructive">
                {t.login.invalidCredentials}
              </p>
            ) : null}
            <Button type="submit" className="w-full">
              {t.login.signIn}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
