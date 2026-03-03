"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { AccountUserData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { shortDateTime } from "@/lib/dashboard/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface AdminUsersManagementClientProps {
  locale: Locale;
  messages: AppMessages;
}

interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

async function getUsers(): Promise<AccountUserData[]> {
  const response = await fetch("/api/private/admin/users", {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  const payload = (await response.json()) as ApiResponse<AccountUserData[]>;
  if (!response.ok || !payload.ok || !Array.isArray(payload.data)) {
    throw new Error(payload.message || payload.error || "load_users_failed");
  }
  return payload.data;
}

export function AdminUsersManagementClient({
  locale,
  messages,
}: AdminUsersManagementClientProps) {
  const t = messages.adminUsers;
  const [users, setUsers] = useState<AccountUserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [systemRole, setSystemRole] = useState<"admin" | "user">("user");

  useEffect(() => {
    let active = true;
    setLoading(true);
    getUsers()
      .then((data) => {
        if (!active) return;
        setUsers(data);
      })
      .catch((error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : t.loadFailed;
        toast.error(message || t.loadFailed);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [t.loadFailed]);

  async function refreshUsers() {
    const data = await getUsers();
    setUsers(data);
  }

  async function handleCreateUser() {
    const normalizedUsername = username.trim();
    const normalizedEmail = email.trim();
    if (
      normalizedUsername.length < 2 ||
      normalizedEmail.length < 3 ||
      !normalizedEmail.includes("@") ||
      password.length < 8
    ) {
      toast.error(t.invalidInput);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/user", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: normalizedUsername,
          email: normalizedEmail,
          name: name.trim() || undefined,
          password,
          systemRole,
        }),
      });
      const payload = (await response.json()) as ApiResponse<AccountUserData>;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || payload.error || t.createFailed);
      }
      setUsername("");
      setEmail("");
      setName("");
      setPassword("");
      setSystemRole("user");
      await refreshUsers();
      toast.success(t.createSuccess);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.createFailed;
      toast.error(message || t.createFailed);
    } finally {
      setSubmitting(false);
    }
  }

  const emptyText = loading ? messages.common.loading : t.noData;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{t.title}</h2>
        <p className="text-sm text-muted-foreground">{t.subtitle}</p>
      </div>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t.createTitle}</CardTitle>
          <CardDescription>{t.createSubtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateUser();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="admin-user-username">{t.username}</Label>
              <Input
                id="admin-user-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-user-email">{t.email}</Label>
              <Input
                id="admin-user-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-user-name">{t.name}</Label>
              <Input
                id="admin-user-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-user-password">{t.password}</Label>
              <Input
                id="admin-user-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="admin-user-role">{t.role}</Label>
              <Select
                value={systemRole}
                onValueChange={(value) => {
                  setSystemRole(value === "admin" ? "admin" : "user");
                }}
              >
                <SelectTrigger id="admin-user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{messages.common.user}</SelectItem>
                  <SelectItem value="admin">{messages.common.admin}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? t.creating : t.create}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.listTitle}</CardTitle>
          <CardDescription>{t.listSubtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
                <TableRow>
                <TableHead>{t.columns.name}</TableHead>
                <TableHead>{t.columns.username}</TableHead>
                <TableHead>{t.columns.email}</TableHead>
                <TableHead>{t.columns.role}</TableHead>
                <TableHead className="text-right">{t.columns.teams}</TableHead>
                <TableHead>{t.columns.created}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {emptyText}
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.name || user.username}</TableCell>
                    <TableCell>{user.username}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      {user.systemRole === "admin"
                        ? messages.common.admin
                        : messages.common.user}
                    </TableCell>
                    <TableCell className="text-right">{user.teamCount ?? 0}</TableCell>
                    <TableCell>{shortDateTime(locale, user.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
