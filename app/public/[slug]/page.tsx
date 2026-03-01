import { Globe2, LockKeyhole, TrendingUp } from "lucide-react";
import { TrendChart } from "@/components/charts/trend-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  fetchPublicOverview,
  fetchPublicPages,
  fetchPublicReferrers,
  fetchPublicTrend,
} from "@/lib/edge-client";
import { compactNumber, formatPercent } from "@/lib/utils";

function resolveRange(searchParams: Record<string, string | string[] | undefined>): { from: number; to: number } {
  const now = Date.now();
  const fromRaw = searchParams.from;
  const toRaw = searchParams.to;
  const from =
    typeof fromRaw === "string" && Number.isFinite(Number(fromRaw))
      ? Math.floor(Number(fromRaw))
      : now - 30 * 24 * 60 * 60 * 1000;
  const to = typeof toRaw === "string" && Number.isFinite(Number(toRaw)) ? Math.floor(Number(toRaw)) : now;
  return {
    from: Math.min(from, to),
    to: Math.max(from, to),
  };
}

export default async function PublicSitePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const routeParams = await params;
  const qp = await searchParams;
  const range = resolveRange(qp);

  const [overview, trend, pages, referrers] = await Promise.all([
    fetchPublicOverview(routeParams.slug, range),
    fetchPublicTrend(routeParams.slug, range),
    fetchPublicPages(routeParams.slug, range),
    fetchPublicReferrers(routeParams.slug, range),
  ]);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8">
      <header className="rounded-[1.75rem] border border-slate-200 bg-white/90 p-6 shadow-card">
        <Badge variant="signal">Public Analytics</Badge>
        <h1 className="mt-2 font-[var(--font-display)] text-4xl text-ink">InsightFlare Public Lens</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          This page intentionally exposes only aggregate trend data. Query/hash details, visitor trajectories, and full
          referrer URLs are masked.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-[0.15em] text-slate-500">Views</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-ink">{compactNumber(overview.data.views)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-[0.15em] text-slate-500">Sessions</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-ink">{compactNumber(overview.data.sessions)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-[0.15em] text-slate-500">Visitors</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-ink">{compactNumber(overview.data.visitors)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-[0.15em] text-slate-500">Bounce Rate</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-ink">{formatPercent(overview.data.bounceRate)}</CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
            <TrendingUp className="h-5 w-5 text-accent" />
            Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TrendChart data={trend.data} />
        </CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <Globe2 className="h-5 w-5 text-accent" />
              Top Referrer Domains
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {referrers.data.map((item) => (
                  <TableRow key={item.referrer}>
                    <TableCell>{item.referrer || "direct"}</TableCell>
                    <TableCell className="text-right">{compactNumber(item.views)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <LockKeyhole className="h-5 w-5 text-signal" />
              Top Paths (Masked Mode)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.data.map((item) => (
                  <TableRow key={item.pathname}>
                    <TableCell>{item.pathname}</TableCell>
                    <TableCell className="text-right">{compactNumber(item.views)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
