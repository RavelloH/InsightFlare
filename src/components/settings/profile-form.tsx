"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RiKey2Line as KeyRound } from "@remixicon/react";

interface ProfileFormProps {
  user: { username: string; email: string; name: string };
  labels: {
    myProfile: string; username: string; email: string;
    displayName: string; newPassword: string; passwordHint: string;
    updateProfile: string;
  };
}

export function ProfileForm({ user, labels }: ProfileFormProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    const body: Record<string, string> = {};
    const username = form.get("username") as string;
    const email = form.get("email") as string;
    const name = form.get("name") as string;
    const password = form.get("password") as string;
    if (username) body.username = username;
    if (email) body.email = email;
    body.name = name || "";
    if (password) body.password = password;

    try {
      const res = await fetch("/api/admin/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(labels.updateProfile);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          {labels.myProfile}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>{labels.username}</Label>
            <Input name="username" defaultValue={user.username} required />
          </div>
          <div className="space-y-2">
            <Label>{labels.email}</Label>
            <Input name="email" type="email" defaultValue={user.email} required />
          </div>
          <div className="space-y-2">
            <Label>{labels.displayName}</Label>
            <Input name="name" defaultValue={user.name || ""} />
          </div>
          <div className="space-y-2">
            <Label>{labels.newPassword}</Label>
            <Input name="password" type="password" placeholder={labels.passwordHint} />
          </div>
          <Button type="submit" disabled={loading}>{labels.updateProfile}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
