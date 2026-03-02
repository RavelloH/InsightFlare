import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const sp = await searchParams;
  const nextParam = typeof sp.next === "string" ? sp.next : `/${locale}/app`;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <form action="/api/auth/login" method="POST" className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6">
        <h1 className="text-center text-2xl font-semibold">InsightFlare</h1>
        <input type="hidden" name="next" value={nextParam} />
        <div className="space-y-2">
          <label htmlFor="username" className="block text-sm font-medium">
            用户名
          </label>
          <input
            id="username"
            type="text"
            name="username"
            required
            autoComplete="username"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="password" className="block text-sm font-medium">
            密码
          </label>
          <input
            id="password"
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button
          type="submit"
          className="h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          登录
        </button>
      </form>
    </main>
  );
}
