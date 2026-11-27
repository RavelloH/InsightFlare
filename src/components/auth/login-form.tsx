import { useCallback, useEffect, useRef, useState } from "react";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import { Input } from "@insightflare/ui/input";
import { Label } from "@insightflare/ui/label";
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogDescription as DialogDescription,
  ResponsiveDialogFooter as DialogFooter,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogTitle as DialogTitle,
} from "@insightflare/ui/responsive-dialog";
import { Spinner } from "@insightflare/ui/spinner";
import {
  RiLoginBoxLine,
  RiRefreshLine,
  RiShieldCrossLine,
} from "@remixicon/react";
import { toast } from "sonner";

import type { Locale } from "@/lib/i18n/config";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";

import { verifyTurnstile } from "./turnstile-client";

interface LoginFormProps {
  locale: Locale;
  nextPath: string;
  usernameLabel: string;
  passwordLabel: string;
  signInLabel: string;
  signingInLabel: string;
  verifyingSecurityLabel: string;
  securityVerificationFailedLabel: string;
  securityVerificationTitleLabel: string;
  retrySecurityLabel: string;
  redirectingLabel: string;
  invalidCredentialsLabel: string;
  failedLabel: string;
}

interface LoginResponse {
  ok: boolean;
  data?: {
    next: string;
  };
  error?: string | { code?: string; message?: string };
  message?: string;
}

type LoginTurnstileClientConfig =
  { enabled: false } | { enabled: true; siteKey: string; mode: "invisible" };

type TurnstileStatus =
  "checking" | "disabled" | "running" | "verified" | "error";

interface TurnstilePublicResponse {
  ok?: boolean;
  data?: {
    turnstile?: {
      enabled?: boolean;
      siteKey?: string;
      mode?: string;
    };
  };
}

const TURNSTILE_TOKEN_TTL_MS = 240_000;

function apiErrorCode(payload: LoginResponse): string {
  if (typeof payload.error === "string") return payload.error;
  if (
    payload.error &&
    typeof payload.error === "object" &&
    "code" in payload.error
  ) {
    const code = (payload.error as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

async function fetchLoginTurnstileConfig(
  signal: AbortSignal,
): Promise<LoginTurnstileClientConfig> {
  const response = await fetch("/api/public/login-security", {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    signal,
  });
  const payload = (await response.json()) as TurnstilePublicResponse;
  const turnstile = payload.data?.turnstile;
  if (
    !response.ok ||
    payload.ok !== true ||
    typeof turnstile?.enabled !== "boolean"
  ) {
    throw new Error("turnstile_config_unavailable");
  }
  if (!turnstile.enabled) return { enabled: false };
  if (!turnstile.siteKey) throw new Error("turnstile_config_unavailable");
  return { enabled: true, siteKey: turnstile.siteKey, mode: "invisible" };
}

export function LoginForm({
  locale,
  nextPath,
  usernameLabel,
  passwordLabel,
  signInLabel,
  signingInLabel,
  verifyingSecurityLabel,
  securityVerificationFailedLabel,
  securityVerificationTitleLabel,
  retrySecurityLabel,
  redirectingLabel,
  invalidCredentialsLabel,
  failedLabel,
}: LoginFormProps) {
  const router = useRouter();
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const verificationRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const tokenRef = useRef<{ token: string; issuedAt: number } | null>(null);
  const configRef = useRef<LoginTurnstileClientConfig | null>(null);
  const mountedRef = useRef(false);
  const submittingRef = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [turnstileStatus, setTurnstileStatus] =
    useState<TurnstileStatus>("checking");
  const [securityDialogOpen, setSecurityDialogOpen] = useState(false);

  const clearToken = useCallback(() => {
    tokenRef.current = null;
    window.clearTimeout(refreshTimerRef.current);
  }, []);

  const prepareSecurity = useCallback(
    async function prepare(): Promise<void> {
      verificationRef.current?.abort();
      clearToken();
      const controller = new AbortController();
      verificationRef.current = controller;
      const { signal } = controller;
      try {
        let config = configRef.current;
        if (!config) {
          setTurnstileStatus("checking");
          config = await fetchLoginTurnstileConfig(signal);
          signal.throwIfAborted();
          configRef.current = config;
        }
        if (!config.enabled) {
          setTurnstileStatus("disabled");
          return;
        }
        setTurnstileStatus("running");
        const container = turnstileRef.current;
        if (!container) throw new Error("turnstile_unavailable");
        const token = await verifyTurnstile(container, config.siteKey, signal);
        signal.throwIfAborted();
        tokenRef.current = { token, issuedAt: Date.now() };
        setTurnstileStatus("verified");
        refreshTimerRef.current = window.setTimeout(() => {
          if (!submittingRef.current) void prepare();
        }, TURNSTILE_TOKEN_TTL_MS);
      } catch {
        if (signal.aborted) return;
        clearToken();
        setTurnstileStatus("error");
        setSecurityDialogOpen(true);
      }
    },
    [clearToken],
  );

  useEffect(() => {
    mountedRef.current = true;
    void prepareSecurity();
    return () => {
      mountedRef.current = false;
      verificationRef.current?.abort();
      clearToken();
    };
  }, [clearToken, prepareSecurity]);

  function retrySecurityVerification() {
    setSecurityDialogOpen(false);
    void prepareSecurity();
  }

  async function handleLogin() {
    if (
      submittingRef.current ||
      redirecting ||
      !configRef.current ||
      (turnstileStatus !== "verified" && turnstileStatus !== "disabled")
    )
      return;
    const currentConfig = configRef.current;
    const token = tokenRef.current;
    if (
      currentConfig.enabled &&
      (!token || Date.now() - token.issuedAt >= TURNSTILE_TOKEN_TTL_MS)
    ) {
      void prepareSecurity();
      return;
    }
    submittingRef.current = true;
    clearToken();
    setPending(true);
    let loginSucceeded = false;
    let securityFailed = false;
    try {
      const turnstileToken = token?.token ?? "";
      const response = await fetch("/api/public/session", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username,
          password,
          next: nextPath,
          ...(currentConfig.enabled ? { turnstileToken } : {}),
        }),
      });
      const payload = (await response.json()) as LoginResponse;
      if (!mountedRef.current) return;
      if (!response.ok || !payload.ok || !payload.data) {
        const code = apiErrorCode(payload);
        if (
          [
            "turnstile_failed",
            "turnstile_required",
            "turnstile_not_configured",
            "turnstile_verification_error",
          ].includes(code)
        ) {
          securityFailed = true;
          configRef.current = null;
          setTurnstileStatus("error");
          setSecurityDialogOpen(true);
          throw new Error(securityVerificationFailedLabel);
        }
        const message =
          code === "invalid_credentials" ||
          payload.error === "invalid_credentials"
            ? invalidCredentialsLabel
            : payload.message || failedLabel;
        throw new Error(message);
      }
      setRedirecting(true);
      loginSucceeded = true;
      navigateWithTransition(router, payload.data.next || `/${locale}/app`);
    } catch (error) {
      const message = error instanceof Error ? error.message : failedLabel;
      if (mountedRef.current) toast.error(message || failedLabel);
    } finally {
      if (!loginSucceeded) {
        submittingRef.current = false;
        if (mountedRef.current) {
          setPending(false);
          if (currentConfig.enabled && !securityFailed) void prepareSecurity();
        }
      }
    }
  }

  const securityError = turnstileStatus === "error";
  const securityBlocking =
    turnstileStatus === "checking" || turnstileStatus === "running";
  const buttonDisabled = pending || redirecting || securityBlocking;
  const buttonLabel = redirecting
    ? redirectingLabel
    : securityError
      ? retrySecurityLabel
      : securityBlocking
        ? verifyingSecurityLabel
        : pending
          ? signingInLabel
          : signInLabel;
  const showButtonSpinner = pending || redirecting || securityBlocking;

  return (
    <>
      <form
        className="space-y-4"
        method="post"
        action="/api/public/session"
        onSubmit={(event) => {
          event.preventDefault();
          if (securityError) retrySecurityVerification();
          else void handleLogin();
        }}
      >
        <input type="hidden" name="next" value={nextPath} />
        <div className="space-y-2">
          <Label htmlFor="username">{usernameLabel}</Label>
          <Input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{passwordLabel}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <Button
          type={securityError ? "button" : "submit"}
          onClick={securityError ? retrySecurityVerification : undefined}
          className="w-full"
          disabled={buttonDisabled}
        >
          <AutoTransition className="inline-flex items-center gap-[var(--button-content-gap)]">
            {showButtonSpinner ? (
              <span
                key={buttonLabel}
                className="inline-flex items-center gap-[var(--button-content-gap)]"
              >
                <Spinner data-icon="inline-start" />
                {buttonLabel}
              </span>
            ) : (
              <span
                key={securityError ? "retry" : "idle"}
                className="inline-flex items-center gap-[var(--button-content-gap)]"
              >
                {securityError ? (
                  <RiRefreshLine data-icon="inline-start" />
                ) : (
                  <RiLoginBoxLine data-icon="inline-start" />
                )}
                {buttonLabel}
              </span>
            )}
          </AutoTransition>
        </Button>
        <div ref={turnstileRef} className="hidden" aria-hidden="true" />
      </form>

      <Dialog open={securityDialogOpen} onOpenChange={setSecurityDialogOpen}>
        <DialogContent desktopClassName="max-w-sm">
          <DialogHeader>
            <DialogTitle
              icon={RiShieldCrossLine}
              iconClassName="text-destructive"
            >
              {securityVerificationTitleLabel}
            </DialogTitle>
            <DialogDescription>
              {securityVerificationFailedLabel}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                retrySecurityVerification();
              }}
            >
              <RiRefreshLine data-icon="inline-start" />
              {retrySecurityLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
