import { KeyRound, ShieldCheck, UserPlus, UsersRound } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAdminMe, fetchAdminUsers } from "@/lib/edge-client";

interface AccountSearchParams {
  error?: string;
  message?: string;
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<AccountSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const me = await fetchAdminMe();
  const users = me.user.systemRole === "admin" ? await fetchAdminUsers() : [];

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      <TopNav active="account" />

      <header className="rounded-[1.75rem] border border-slate-200 bg-white/90 p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Badge>Account Center</Badge>
            <h1 className="mt-2 font-[var(--font-display)] text-4xl text-ink">Users & Profile</h1>
            <p className="mt-2 text-sm text-slate-600">
              Manage your own account settings. System admins can also manage platform users.
            </p>
          </div>
          <LogoutButton />
        </div>
      </header>

      {params.error ? (
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
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <KeyRound className="h-5 w-5 text-accent" />
              My Profile
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form action="/api/admin/profile" method="POST" className="space-y-3">
              <input type="hidden" name="returnTo" value="/app/account" />
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Username</span>
                <Input name="username" defaultValue={me.user.username} required />
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Email</span>
                <Input name="email" type="email" defaultValue={me.user.email} required />
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Display Name</span>
                <Input name="name" defaultValue={me.user.name || ""} />
              </label>
              <label className="space-y-1">
                <span className="text-xs uppercase tracking-[0.12em] text-slate-500">New Password (optional)</span>
                <Input name="password" type="password" placeholder="Leave empty to keep current password" />
              </label>
              <Button type="submit">Update Profile</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
              <ShieldCheck className="h-5 w-5 text-accent" />
              Current Identity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <p>
              <span className="font-semibold">User ID:</span> {me.user.id}
            </p>
            <p>
              <span className="font-semibold">Username:</span> {me.user.username}
            </p>
            <p>
              <span className="font-semibold">Role:</span> {me.user.systemRole}
            </p>
            <p>
              <span className="font-semibold">Joined:</span> {new Date(me.user.createdAt * 1000).toLocaleString()}
            </p>
          </CardContent>
        </Card>
      </section>

      {me.user.systemRole === "admin" ? (
        <section className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
                <UserPlus className="h-5 w-5 text-accent" />
                Create User
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form action="/api/admin/user" method="POST" className="grid gap-3 md:grid-cols-2">
                <input type="hidden" name="intent" value="create" />
                <input type="hidden" name="returnTo" value="/app/account" />
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Username</span>
                  <Input name="username" required placeholder="analyst" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Email</span>
                  <Input name="email" type="email" required placeholder="analyst@example.com" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Display Name</span>
                  <Input name="name" placeholder="Analyst" />
                </label>
                <label className="space-y-1">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">System Role</span>
                  <select name="systemRole" className="h-10 w-full rounded-xl2 border border-slate-300 bg-white px-3 text-sm">
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs uppercase tracking-[0.12em] text-slate-500">Password</span>
                  <Input name="password" type="password" required placeholder="At least 8 characters" />
                </label>
                <div className="md:col-span-2">
                  <Button type="submit">Create Account</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl font-[var(--font-display)]">
                <UsersRound className="h-5 w-5 text-accent" />
                User Directory
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Username</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Teams</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.username}</TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>{user.systemRole}</TableCell>
                      <TableCell>{user.teamCount ?? 0}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </main>
  );
}
