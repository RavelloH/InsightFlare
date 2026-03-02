"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RiSettings4Line as Settings2 } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TeamConfigFormProps {
  team: {
    id: string;
    name: string;
    slug: string;
  };
  labels: {
    teamConfiguration: string;
    teamName: string;
    slug: string;
    saveConfig: string;
  };
}

export function TeamConfigForm({ team, labels }: TeamConfigFormProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/admin/team", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId: team.id,
          name: form.get("name"),
          slug: form.get("slug") || "",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(labels.saveConfig);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-5 w-5 text-primary" />
          {labels.teamConfiguration}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>{labels.teamName}</Label>
            <Input name="name" defaultValue={team.name} required />
          </div>
          <div className="space-y-2">
            <Label>{labels.slug}</Label>
            <Input name="slug" defaultValue={team.slug} />
          </div>
          <Button type="submit" disabled={loading}>
            {labels.saveConfig}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
