import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const nextParam = typeof params.next === "string" ? params.next : "/app";
  const hasError = params.error === "invalid_credentials";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center px-6 py-16">
      <div className="grid w-full gap-8 md:grid-cols-[1.2fr_1fr]">
        <section className="space-y-6 rounded-[1.75rem] border border-white/70 bg-white/70 p-8 shadow-card backdrop-blur">
          <Badge variant="signal">Control Plane</Badge>
          <h1 className="font-[var(--font-display)] text-5xl leading-[1.05] text-ink">
            InsightFlare
            <br />
            Operations Desk
          </h1>
          <p className="max-w-md text-slate-600">
            Single pane for ingest health, site analytics, and long-range trend diagnostics across team workspaces.
          </p>
          <div className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
            <div className="rounded-xl2 border border-slate-200 bg-white/80 p-4">
              Public pages enforce masked analytics output.
            </div>
            <div className="rounded-xl2 border border-slate-200 bg-white/80 p-4">
              D1 migrations run automatically before build.
            </div>
          </div>
        </section>

        <Card className="border-slate-200/90 bg-white/95">
          <CardHeader>
            <CardTitle className="text-2xl font-[var(--font-display)]">Sign in</CardTitle>
            <CardDescription>Use your InsightFlare account credentials.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action="/api/auth/login" method="POST" className="space-y-4">
              <input type="hidden" name="next" value={nextParam} />
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Username</span>
                <Input type="text" name="username" required placeholder="admin" />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Password</span>
                <Input type="password" name="password" required placeholder="Enter account password" />
              </label>
              {hasError ? (
                <p className="rounded-xl2 border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  Invalid credentials. Please try again.
                </p>
              ) : null}
              <Button type="submit" className="w-full">
                Enter Dashboard
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
