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
import { UserPlus } from "lucide-react";

interface AddMemberDialogProps {
  teamId: string;
  labels: {
    addMember: string; userIdentifier: string;
    identifierPlaceholder: string; create: string;
  };
}

export function AddMemberDialog({ teamId, labels }: AddMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/admin/member", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, identifier: form.get("identifier") }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(labels.addMember);
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
          <UserPlus className="h-4 w-4" />
          {labels.addMember}
        </Button>
      </ResponsiveModalTrigger>
      <ResponsiveModalContent>
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>{labels.addMember}</ResponsiveModalTitle>
          <ResponsiveModalDescription />
        </ResponsiveModalHeader>
        <form onSubmit={handleSubmit} className="space-y-4 p-4 md:p-0">
          <div className="space-y-2">
            <Label>{labels.userIdentifier}</Label>
            <Input name="identifier" required placeholder={labels.identifierPlaceholder} />
          </div>
          <ResponsiveModalFooter>
            <Button type="submit" disabled={loading}>{labels.create}</Button>
          </ResponsiveModalFooter>
        </form>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
