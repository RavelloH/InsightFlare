import { Lock, SlidersHorizontal } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
import { TeamSiteSwitcher } from "@/components/team-site-switcher";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchAdminSiteConfig, fetchAdminSites, fetchAdminTeams } from "@/lib/edge-client";

interface ConfigSearchParams {
  teamId?: string;
  siteId?: string;
  error?: string;
  message?: string;
}

function boolFromUnknown(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const v = input.toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  return fallback;
}

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<ConfigSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const teams = await fetchAdminTeams();
  const selectedTeamId =
    (params.teamId && teams.some((team) => team.id === params.teamId) ? params.teamId : undefined) || teams[0]?.id || "";
  const sites = selectedTeamId ? await fetchAdminSites(selectedTeamId) : [];
  const selectedSiteId =
    (params.siteId && sites.some((site) => site.id === params.siteId) ? params.siteId : undefined) || sites[0]?.id || "";
  const site = sites.find((item) => item.id === selectedSiteId) || null;
  const config = selectedSiteId ? await fetchAdminSiteConfig(selectedSiteId) : {};

  const privacy = (config.privacy && typeof config.privacy === "object" ? config.privacy : {}) as Record<string, unknown>;
  const maskQueryHashDetails = boolFromUnknown(privacy.maskQueryHashDetails, true);
  const maskVisitorTrajectory = boolFromUnknown(privacy.maskVisitorTrajectory, true);
  const maskBotSecurityFeatures = boolFromUnknown(privacy.maskBotSecurityFeatures, true);
  const maskDetailedReferrerUrl = boolFromUnknown(privacy.maskDetailedReferrerUrl, true);
  const hasError = Boolean(params.error);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-6 py-8">
      <TopNav active="config" teamId={selectedTeamId} siteId={selectedSiteId} />

      <header className="rounded-[1.75rem] border border-slate-200 bg-white/90 p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge>Site Configuration</Badge>
            <h1 className="mt-2 font-[var(--font-display)] text-4xl text-ink">Privacy & Publication</h1>
            <p className="mt-2 text-sm text-slate-600">
              Control public analytics exposure and privacy masking defaults for each site.
            </p>
          </div>
          <LogoutButton />
        </div>
        {teams.length > 0 && sites.length > 0 ? (
          <div className="mt-4">
            <TeamSiteSwitcher
              actionPath="/app/config"
              teams={teams}
              sites={sites}
              currentTeamId={selectedTeamId}
              currentSiteId={selectedSiteId}
            />
          </div>
        ) : null}
      </header>

      {hasError ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-4 text-sm text-red-700">
            Save failed: {params.error}
            {params.message ? ` (${params.message})` : ""}
          </CardContent>
        </Card>
      ) : null}

      {!site ? (
        <Card>
          <CardContent className="py-6 text-sm text-slate-600">
            No site found. Create one first in <a className="font-semibold text-accent underline" href="/app/teams">Teams</a>.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-2xl font-[var(--font-display)]">
              <SlidersHorizontal className="h-5 w-5 text-accent" />
              {site.name} ({site.domain})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form action="/api/admin/site-config" method="POST" className="space-y-5">
              <input type="hidden" name="siteId" value={site.id} />
              <input type="hidden" name="returnTo" value={`/app/config?teamId=${selectedTeamId}&siteId=${site.id}`} />

              <section className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Site Name</span>
                  <Input name="name" defaultValue={site.name} required />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Domain</span>
                  <Input name="domain" defaultValue={site.domain} required />
                </label>
              </section>

              <section className="rounded-xl2 border border-slate-200 bg-slate-50 p-4">
                <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-ink">
                  <Lock className="h-4 w-4 text-signal" />
                  Public Site Visibility
                </h2>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      name="publicEnabled"
                      value="1"
                      defaultChecked={Number(site.publicEnabled) === 1}
                    />
                    Enable public analytics page
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Public Slug</span>
                    <Input
                      name="publicSlug"
                      defaultValue={site.publicSlug || ""}
                      placeholder="example-public"
                    />
                  </label>
                </div>
              </section>

              <section className="rounded-xl2 border border-slate-200 bg-white p-4">
                <h2 className="mb-3 text-lg font-semibold text-ink">Privacy Masking Defaults</h2>
                <div className="grid gap-2 text-sm text-slate-700 md:grid-cols-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="maskQueryHashDetails" value="1" defaultChecked={maskQueryHashDetails} />
                    Hide Query/Hash Details
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="maskVisitorTrajectory" value="1" defaultChecked={maskVisitorTrajectory} />
                    Hide Visitor Trajectory
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="maskBotSecurityFeatures"
                      value="1"
                      defaultChecked={maskBotSecurityFeatures}
                    />
                    Hide Bot Security Features
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="maskDetailedReferrerUrl"
                      value="1"
                      defaultChecked={maskDetailedReferrerUrl}
                    />
                    Hide Detailed Referrer URL
                  </label>
                </div>
              </section>

              <Button type="submit">Save Configuration</Button>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

