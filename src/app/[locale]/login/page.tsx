import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoginForm } from "@/components/auth/login-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { isAuthenticated } from "@/lib/auth";

interface LoginPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
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
          <LoginForm
            locale={resolvedLocale}
            nextPath={nextPath}
            usernameLabel={t.login.username}
            passwordLabel={t.login.password}
            signInLabel={t.login.signIn}
            signingInLabel={t.loginForm.signingIn}
            invalidCredentialsLabel={t.login.invalidCredentials}
            failedLabel={t.loginForm.failed}
          />
        </CardContent>
      </Card>
    </main>
  );
}
