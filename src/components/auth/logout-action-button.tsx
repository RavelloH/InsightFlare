import { useState } from "react";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import { Spinner } from "@insightflare/ui/spinner";
import { RiLogoutBoxLine } from "@remixicon/react";
import { toast } from "sonner";

import type { Locale } from "@/lib/i18n/config";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";

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
      const response = await fetch("/api/public/session", {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error(failedLabel);
      toast.success(successLabel);
      navigateWithTransition(router, `/${locale}/login`);
    } catch (error) {
      const message = error instanceof Error ? error.message : failedLabel;
      toast.error(message || failedLabel);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void handleLogout()}
      disabled={pending}
    >
      <AutoTransition className="inline-flex items-center gap-2">
        {pending ? (
          <span key="pending" className="inline-flex items-center gap-2">
            <Spinner className="size-4" />
            {pendingLabel}
          </span>
        ) : (
          <span key="idle" className="inline-flex items-center gap-2">
            <RiLogoutBoxLine className="size-4" />
            {label}
          </span>
        )}
      </AutoTransition>
    </Button>
  );
}
