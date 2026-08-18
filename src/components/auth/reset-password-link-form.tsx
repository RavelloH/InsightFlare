import { useEffect, useState } from "react";
import { RiCloseLine, RiLoginBoxLine, RiSave3Line } from "@remixicon/react";
import { toast } from "sonner";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { shortDateTime } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";
import { extractErrorMessage } from "@/lib/response-envelope";
import Link from "@/lib/router";
import { useRouter } from "@/lib/router";

type ResetCopy = AppMessages["accountLinks"]["resetPassword"];

interface ResetPasswordLinkFormProps {
  locale: Locale;
  copy: ResetCopy;
}

interface ApiResponse<T> {
  ok?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface ResetInspectData {
  type: "password_reset";
  user: {
    username: string;
    email: string;
  };
  expiresAt: number;
}

interface ResetCompleteData {
  type: "password_reset";
  reset: boolean;
}

function tokenFromHash(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("token")?.trim() || "";
}

function apiMessage(payload: ApiResponse<unknown>, fallback: string): string {
  return extractErrorMessage(payload, fallback);
}

function epochSecondsToMs(value: number): number {
  return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
}

export function ResetPasswordLinkForm({
  locale,
  copy,
}: ResetPasswordLinkFormProps) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [resetInfo, setResetInfo] = useState<ResetInspectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    const nextToken = tokenFromHash();
    setToken(nextToken);
    if (!nextToken) {
      setError(copy.missingToken);
      setLoading(false);
      return;
    }

    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/public/account-links/inspect", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: nextToken }),
        });
        const payload =
          (await response.json()) as ApiResponse<ResetInspectData>;
        if (
          !response.ok ||
          !payload.ok ||
          payload.data?.type !== "password_reset"
        ) {
          throw new Error(apiMessage(payload, copy.loadFailed));
        }
        setResetInfo(payload.data);
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : copy.loadFailed,
        );
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [copy.loadFailed, copy.missingToken]);

  async function resetPassword() {
    if (!token || submitting) return;
    if (password.length < 8) {
      toast.error(copy.passwordTooShort);
      return;
    }
    if (password !== confirmPassword) {
      toast.error(copy.passwordMismatch);
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/public/account-links/complete", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const payload = (await response.json()) as ApiResponse<ResetCompleteData>;
      if (
        !response.ok ||
        !payload.ok ||
        payload.data?.type !== "password_reset"
      ) {
        throw new Error(apiMessage(payload, copy.resetFailed));
      }
      toast.success(copy.resetDone);
      navigateWithTransition(router, `/${locale}/login`, { replace: true });
    } catch (submitError) {
      toast.error(
        submitError instanceof Error ? submitError.message : copy.resetFailed,
      );
      setSubmitting(false);
    }
  }

  const contentKey = loading
    ? "loading"
    : error || !resetInfo
      ? "error"
      : "form";

  return (
    <AutoResizer initial>
      <AutoTransition initial duration={0.22} transitionKey={contentKey}>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-4" />
            {copy.loading}
          </div>
        ) : error || !resetInfo ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-3 text-destructive">
              <RiCloseLine className="mt-0.5 size-4 shrink-0" />
              <p>{error || copy.loadFailed}</p>
            </div>
            <Button asChild variant="outline" className="w-full">
              <Link href={`/${locale}/login`}>
                <RiLoginBoxLine className="size-4" />
                {copy.signIn}
              </Link>
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void resetPassword();
            }}
          >
            <div className="grid gap-2 border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {copy.accountLabel}
                </span>
                <span className="text-right font-medium">
                  {resetInfo.user.username}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{copy.emailLabel}</span>
                <span className="text-right">{resetInfo.user.email}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {copy.expiresLabel}
                </span>
                <span className="text-right">
                  {shortDateTime(locale, epochSecondsToMs(resetInfo.expiresAt))}
                </span>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="reset-password">{copy.passwordLabel}</Label>
              <Input
                id="reset-password"
                value={password}
                type="password"
                autoComplete="new-password"
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="reset-confirm-password">
                {copy.confirmPasswordLabel}
              </Label>
              <Input
                id="reset-confirm-password"
                value={confirmPassword}
                type="password"
                autoComplete="new-password"
                minLength={8}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              <AutoTransition
                className="inline-flex items-center gap-2"
                transitionKey={submitting ? "submitting" : "idle"}
              >
                {submitting ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner className="size-4" />
                    {copy.resetting}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <RiSave3Line className="size-4" />
                    {copy.reset}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </form>
        )}
      </AutoTransition>
    </AutoResizer>
  );
}
