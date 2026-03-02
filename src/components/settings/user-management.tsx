"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RiUserAddLine as UserPlus, RiGroupLine as UsersRound } from "@remixicon/react";
import type { AccountUserData } from "@/lib/edge-client";

interface UserManagementProps {
  users: AccountUserData[];
  labels: {
    createUser: string; username: string; email: string;
    displayName: string; systemRole: string; password: string;
    create: string; userDirectory: string; teams: string; role: string;
  };
}

export function UserManagement({ users, labels }: UserManagementProps) {
  const [loading, setLoading] = useState(false);
  const [role, setRole] = useState("user");
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/admin/user", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: "create",
          username: form.get("username"),
          email: form.get("email"),
          name: form.get("name") || undefined,
          password: form.get("password"),
          systemRole: role,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(labels.createUser);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            {labels.createUser}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{labels.username}</Label>
              <Input name="username" required placeholder="analyst" />
            </div>
            <div className="space-y-2">
              <Label>{labels.email}</Label>
              <Input name="email" type="email" required placeholder="analyst@example.com" />
            </div>
            <div className="space-y-2">
              <Label>{labels.displayName}</Label>
              <Input name="name" placeholder="Analyst" />
            </div>
            <div className="space-y-2">
              <Label>{labels.systemRole}</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>{labels.password}</Label>
              <Input name="password" type="password" required placeholder="At least 8 characters" />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={loading}>{labels.create}</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UsersRound className="h-5 w-5 text-primary" />
            {labels.userDirectory}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{labels.username}</TableHead>
                <TableHead>{labels.email}</TableHead>
                <TableHead>{labels.role}</TableHead>
                <TableHead>{labels.teams}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.username}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell><Badge variant="outline">{user.systemRole}</Badge></TableCell>
                  <TableCell>{user.teamCount ?? 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
