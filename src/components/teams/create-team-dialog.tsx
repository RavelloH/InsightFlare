"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import { RiAddLine as Plus } from "@remixicon/react";

interface CreateTeamDialogProps {
  locale: string;
  labels: { createTeam: string; teamName: string; slug: string; create: string; cancel: string };
}

export function CreateTeamDialog({ locale, labels }: CreateTeamDialogProps) {
  const [open, setOpen] = useState(false);
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
          name: form.get("name"),
          slug: form.get("slug") || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(labels.createTeam);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ResponsiveModal open={open} onOpenChange={setOpen}>
      <ResponsiveModalTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          {labels.createTeam}
        </Button>
      </ResponsiveModalTrigger>
      <ResponsiveModalContent>
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>{labels.createTeam}</ResponsiveModalTitle>
          <ResponsiveModalDescription />
        </ResponsiveModalHeader>
        <form onSubmit={handleSubmit} className="space-y-4 p-4 md:p-0">
          <div className="space-y-2">
            <Label>{labels.teamName}</Label>
            <Input name="name" required placeholder="Growth Ops" />
          </div>
          <div className="space-y-2">
            <Label>{labels.slug}</Label>
            <Input name="slug" placeholder="growth-ops" />
          </div>
          <ResponsiveModalFooter>
            <Button type="submit" disabled={loading}>{labels.create}</Button>
          </ResponsiveModalFooter>
        </form>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
