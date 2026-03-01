"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import { Globe2 } from "lucide-react";

interface CreateSiteDialogProps {
  teamId: string;
  labels: {
    createSite: string; siteName: string; domain: string;
    publicSlug: string; enablePublic: string; create: string;
  };
}

export function CreateSiteDialog({ teamId, labels }: CreateSiteDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [publicEnabled, setPublicEnabled] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/admin/site", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: "create",
          teamId,
          name: form.get("name"),
          domain: form.get("domain"),
          publicSlug: form.get("publicSlug") || undefined,
          publicEnabled,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(labels.createSite);
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
        <Button size="sm" variant="outline" className="gap-2">
          <Globe2 className="h-4 w-4" />
          {labels.createSite}
        </Button>
      </ResponsiveModalTrigger>
      <ResponsiveModalContent>
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>{labels.createSite}</ResponsiveModalTitle>
          <ResponsiveModalDescription />
        </ResponsiveModalHeader>
        <form onSubmit={handleSubmit} className="space-y-4 p-4 md:p-0">
          <div className="space-y-2">
            <Label>{labels.siteName}</Label>
            <Input name="name" required placeholder="Main Marketing Site" />
          </div>
          <div className="space-y-2">
            <Label>{labels.domain}</Label>
            <Input name="domain" required placeholder="example.com" />
          </div>
          <div className="space-y-2">
            <Label>{labels.publicSlug}</Label>
            <Input name="publicSlug" placeholder="example-public" />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="publicEnabled" checked={publicEnabled} onCheckedChange={(v) => setPublicEnabled(Boolean(v))} />
            <Label htmlFor="publicEnabled" className="text-sm font-normal">{labels.enablePublic}</Label>
          </div>
          <ResponsiveModalFooter>
            <Button type="submit" disabled={loading}>{labels.create}</Button>
          </ResponsiveModalFooter>
        </form>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
