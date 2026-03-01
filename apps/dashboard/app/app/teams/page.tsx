import { Copy, Globe2, Shield, Users } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAdminMembers, fetchAdminSites, fetchAdminTeams } from "@/lib/edge-client";

interface TeamsSearchParams {
  teamId?: string;
  siteId?: string;
  error?: string;
  message?: string;
}

export default async function TeamsPage({
  searchParams,
}: {
  searchParams: Promise<TeamsSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const teams = await fetchAdminTeams();
  const selectedTeamId =
    (params.teamId && teams.some((team) => team.id === params.teamId) ? params.teamId : undefined) || teams[0]?.id || "";
  const sites = selectedTeamId ? await fetchAdminSites(selectedTeamId) : [];
  const members = selectedTeamId ? await fetchAdminMembers(selectedTeamId) : [];
  const edgeBase = process.env.INSIGHTFLARE_EDGE_URL || "http://127.0.0.1:8787";
  const hasError = Boolean(params.error);

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      <TopNav active="teams" teamId={selectedTeamId} siteId={params.siteId} />

      <header className="rounded-[1.75rem] border border-slate-200 bg-white/90 p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge>Tenant Management</Badge>
            <h1 className="mt-2 font-[var(--font-display)] text-4xl text-ink">Teams, Sites, Members</h1>
            <p className="mt-2 text-sm text-slate-600">
              Manage workspace ownership and installation targets before collecting production traffic.
            </p>
          </div>
          <LogoutButton />
        </div>
      </header>

      {hasError ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-4 text-sm text-red-700">
            Operation failed: {params.error}
            {params.message ? ` (${params.message})` : ""}
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl font-[var(--font-display)]">Create Team</CardTitle>
          </CardHeader>
          <CardContent>
            <form action="/api/admin/team" method="POST" className="space-y-3">
              <input type="hidden" name="returnTo" value="/app/teams" />
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Team Name</span>
                <Input name="name" required placeholder="Growth Ops" />
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Slug (optional)</span>
                <Input name="slug" placeholder="growth-ops" />
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Owner Email (optional)</span>
                <Input name="ownerEmail" placeholder="owner@example.com" />
              </label>
              <Button type="submit">Create Team</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl font-[var(--font-display)]">Select Team</CardTitle>
          </CardHeader>
          <CardContent>
            {teams.length === 0 ? (
              <p className="text-sm text-slate-600">No team yet. Create one from the left panel.</p>
            ) : (
              <form action="/app/teams" method="GET" className="space-y-3">
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Current Team</span>
                  <select
                    name="teamId"
                    defaultValue={selectedTeamId}
                    className="h-10 w-full rounded-xl2 border border-slate-300 bg-white px-3 text-sm"
                  >
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name} ({team.memberCount} members)
                      </option>
                    ))}
                  </select>
                </label>
                <Button type="submit" variant="secondary">
                  Load Team
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </section>

      {selectedTeamId ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
                <Globe2 className="h-5 w-5 text-accent" />
                Create Site
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form action="/api/admin/site" method="POST" className="space-y-3">
                <input type="hidden" name="intent" value="create" />
                <input type="hidden" name="teamId" value={selectedTeamId} />
                <input type="hidden" name="returnTo" value={`/app/teams?teamId=${selectedTeamId}`} />
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Site Name</span>
                  <Input name="name" required placeholder="Main Marketing Site" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Domain</span>
                  <Input name="domain" required placeholder="example.com" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Public Slug (optional)</span>
                  <Input name="publicSlug" placeholder="example-public" />
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" name="publicEnabled" value="1" />
                  Enable public analytics page
                </label>
                <Button type="submit">Create Site</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
                <Users className="h-5 w-5 text-accent" />
                Add Team Member
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form action="/api/admin/member" method="POST" className="space-y-3">
                <input type="hidden" name="teamId" value={selectedTeamId} />
                <input type="hidden" name="returnTo" value={`/app/teams?teamId=${selectedTeamId}`} />
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Email</span>
                  <Input type="email" name="email" required placeholder="analyst@example.com" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Name (optional)</span>
                  <Input name="name" placeholder="Analyst" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Role</span>
                  <select name="role" className="h-10 w-full rounded-xl2 border border-slate-300 bg-white px-3 text-sm">
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    <option value="owner">owner</option>
                  </select>
                </label>
                <Button type="submit">Add Member</Button>
              </form>
            </CardContent>
          </Card>
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl font-[var(--font-display)]">Sites</CardTitle>
          </CardHeader>
          <CardContent>
            {sites.length === 0 ? (
              <p className="text-sm text-slate-600">No site created for this team yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Public</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.map((site) => (
                    <TableRow key={site.id}>
                      <TableCell>
                        <a className="font-medium text-accent hover:underline" href={`/app/config?teamId=${selectedTeamId}&siteId=${site.id}`}>
                          {site.name}
                        </a>
                      </TableCell>
                      <TableCell>{site.domain}</TableCell>
                      <TableCell>
                        {Number(site.publicEnabled) === 1 ? (
                          <Badge variant="default">{site.publicSlug || "enabled"}</Badge>
                        ) : (
                          <Badge variant="outline">off</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <Copy className="h-5 w-5 text-accent" />
              Installation Snippets
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sites.length === 0 ? (
              <p className="text-sm text-slate-600">Create a site to get install snippet.</p>
            ) : (
              sites.map((site) => {
                const snippet = `<script defer src="${edgeBase}/script.js?siteId=${site.id}"></script>`;
                return (
                  <div key={site.id} className="rounded-xl2 border border-slate-200 bg-white p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="font-medium text-ink">{site.name}</p>
                      <Badge variant="outline">{site.domain}</Badge>
                    </div>
                    <code className="block overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                      {snippet}
                    </code>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <Shield className="h-5 w-5 text-accent" />
              Team Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            {members.length === 0 ? (
              <p className="text-sm text-slate-600">No member in this team yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => (
                    <TableRow key={`${member.teamId}:${member.userId}`}>
                      <TableCell>{member.email}</TableCell>
                      <TableCell>{member.name || "-"}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{member.role}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

