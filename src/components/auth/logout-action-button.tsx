"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Locale } from "@/lib/i18n/config";
import { Button } from "@/components/ui/button";

interface LogoutActionButtonProps {
  locale: Locale;
  label: string;
  pendingLabel: string;
  successLabel: string;
  failedLabel: string;
}

export function LogoutActionButton({
  locale,
  label,
  pendingLabel,
  successLabel,
  failedLabel,
}: LogoutActionButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleLogout() {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(failedLabel);
      toast.success(successLabel);
      router.push(`/${locale}/login`);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : failedLabel;
      toast.error(message || failedLabel);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" variant="outline" onClick={() => void handleLogout()} disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}
