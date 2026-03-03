"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Locale } from "@/lib/i18n/config";
import { Button } from "@/components/ui/button";

interface LogoutActionButtonProps {
  locale: Locale;
  label: string;
}

function copy(locale: Locale) {
  if (locale === "zh") {
    return {
      pending: "退出中...",
      success: "已退出登录。",
      failed: "退出登录失败，请稍后重试。",
    };
  }

  return {
    pending: "Signing out...",
    success: "Signed out.",
    failed: "Failed to sign out. Please try again.",
  };
}

export function LogoutActionButton({ locale, label }: LogoutActionButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const t = copy(locale);

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
      if (!response.ok) throw new Error(t.failed);
      toast.success(t.success);
      router.push(`/${locale}/login`);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : t.failed;
      toast.error(message || t.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" variant="outline" onClick={() => void handleLogout()} disabled={pending}>
      {pending ? t.pending : label}
    </Button>
  );
}
