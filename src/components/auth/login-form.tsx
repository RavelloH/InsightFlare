import { useCallback, useEffect, useRef, useState } from "react";
import {
  RiLoginBoxLine,
  RiRefreshLine,
  RiShieldCrossLine,
} from "@remixicon/react";
import { toast } from "sonner";

import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { Locale } from "@/lib/i18n/config";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";

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
  | { enabled: false }
  | { enabled: true; siteKey: string; mode: "invisible" };

type TurnstileStatus =
  | "checking"
  | "disabled"
  | "loading"
  | "running"
  | "verified"
  | "error";

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

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      size: "invisible";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ) => string;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
  remove?: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SCRIPT_ID = "cloudflare-turnstile-script";
const TURNSTILE_TOKEN_TTL_MS = 240_000;
let turnstileScriptPromise: Promise<void> | null = null;

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

async function fetchLoginTurnstileConfig(): Promise<LoginTurnstileClientConfig> {
  if (import.meta.env.VITE_DEMO_MODE === "1") {
    const { demoRequest } = await import("@/lib/realtime/mock");
    const result = demoRequest({
      path: "/api/public/login-security",
    }) as TurnstilePublicResponse;
    const turnstile = result.data?.turnstile;
    return turnstile?.enabled && turnstile.siteKey
      ? { enabled: true, siteKey: turnstile.siteKey, mode: "invisible" }
      : { enabled: false };
  }

  const response = await fetch("/api/public/login-security", {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  const payload = (await response.json()) as TurnstilePublicResponse;
  const turnstile = payload.data?.turnstile;
  if (!response.ok || payload.ok !== true || !turnstile?.enabled) {
    return { enabled: false };
  }
  return turnstile.siteKey
    ? { enabled: true, siteKey: turnstile.siteKey, mode: "invisible" }
    : { enabled: false };
}

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(
      TURNSTILE_SCRIPT_ID,
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("load")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("load")), {
      once: true,
    });
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
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
  const widgetIdRef = useRef<string | null>(null);
  const verificationPromiseRef = useRef<Promise<string> | null>(null);
  const tokenRef = useRef<{ token: string; issuedAt: number } | null>(null);
  const configRef = useRef<LoginTurnstileClientConfig>({ enabled: false });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [turnstileConfig, setTurnstileConfig] =
    useState<LoginTurnstileClientConfig>({ enabled: false });
  const [turnstileStatus, setTurnstileStatus] =
    useState<TurnstileStatus>("checking");
  const [securityDialogOpen, setSecurityDialogOpen] = useState(false);

  useEffect(() => {
    configRef.current = turnstileConfig;
  }, [turnstileConfig]);

  const clearToken = useCallback(() => {
    tokenRef.current = null;
  }, []);

  const resetTurnstile = useCallback(() => {
    clearToken();
    const widgetId = widgetIdRef.current;
    if (widgetId && window.turnstile) {
      window.turnstile.reset(widgetId);
    }
  }, [clearToken]);

  const runTurnstile = useCallback(async (): Promise<string> => {
    const currentConfig = configRef.current;
    if (!currentConfig.enabled) return "";

    const existing = tokenRef.current;
    if (existing && Date.now() - existing.issuedAt < TURNSTILE_TOKEN_TTL_MS) {
      return existing.token;
    }
    if (verificationPromiseRef.current) return verificationPromiseRef.current;

    setTurnstileStatus((status) =>
      status === "loading" ? "loading" : "running",
    );

    const promise = new Promise<string>((resolve, reject) => {
      const container = turnstileRef.current;
      const turnstile = window.turnstile;
      if (!container || !turnstile) {
        reject(new Error("turnstile_unavailable"));
        return;
      }

      const callbacks = {
        callback: (token: string) => {
          tokenRef.current = { token, issuedAt: Date.now() };
          setTurnstileStatus("verified");
          verificationPromiseRef.current = null;
          resolve(token);
        },
        "error-callback": () => {
          clearToken();
          setTurnstileStatus("error");
          setSecurityDialogOpen(true);
          verificationPromiseRef.current = null;
          reject(new Error("turnstile_error"));
        },
        "expired-callback": () => {
          clearToken();
          setTurnstileStatus("error");
          verificationPromiseRef.current = null;
        },
      };

      if (!widgetIdRef.current) {
        widgetIdRef.current = turnstile.render(container, {
          sitekey: currentConfig.siteKey,
          size: "invisible",
          ...callbacks,
        });
      }
      turnstile.execute(widgetIdRef.current);
    });

    verificationPromiseRef.current = promise;
    return promise;
  }, [clearToken]);

  const initializeTurnstile = useCallback(async () => {
    try {
      const config = await fetchLoginTurnstileConfig();
      setTurnstileConfig(config);
      configRef.current = config;
      if (!config.enabled) {
        setTurnstileStatus("disabled");
        return;
      }
      setTurnstileStatus("loading");
      await loadTurnstileScript();
      await runTurnstile();
    } catch {
      clearToken();
      setTurnstileStatus("error");
      setSecurityDialogOpen(true);
    }
  }, [clearToken, runTurnstile]);

  useEffect(() => {
    void initializeTurnstile();
    return () => {
      const widgetId = widgetIdRef.current;
      if (widgetId && window.turnstile?.remove) {
        window.turnstile.remove(widgetId);
      }
      widgetIdRef.current = null;
      verificationPromiseRef.current = null;
    };
  }, [initializeTurnstile]);

  async function retrySecurityVerification() {
    setSecurityDialogOpen(false);
    resetTurnstile();
    setTurnstileStatus("running");
    try {
      await runTurnstile();
    } catch {
      setTurnstileStatus("error");
      setSecurityDialogOpen(true);
    }
  }

  async function handleLogin() {
    if (pending || redirecting) return;
    setPending(true);
    let loginSucceeded = false;
    try {
      const currentConfig = configRef.current;
      const turnstileToken = currentConfig.enabled ? await runTurnstile() : "";
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
      if (currentConfig.enabled) clearToken();
      const payload = (await response.json()) as LoginResponse;
      if (!response.ok || !payload.ok || !payload.data) {
        const code = apiErrorCode(payload);
        if (code === "turnstile_failed" || code === "turnstile_required") {
          resetTurnstile();
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
      toast.error(message || failedLabel);
    } finally {
      if (!loginSucceeded) setPending(false);
    }
  }

  const securityBlocking =
    turnstileConfig.enabled &&
    (turnstileStatus === "checking" ||
      turnstileStatus === "loading" ||
      turnstileStatus === "running" ||
      turnstileStatus === "error");
  const buttonDisabled = pending || redirecting || securityBlocking;
  const buttonLabel = redirecting
    ? redirectingLabel
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
          void handleLogin();
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
        <Button type="submit" className="w-full" disabled={buttonDisabled}>
          <AutoTransition className="inline-flex items-center gap-2">
            {showButtonSpinner ? (
              <span
                key={buttonLabel}
                className="inline-flex items-center gap-2"
              >
                <Spinner className="size-4" />
                {buttonLabel}
              </span>
            ) : (
              <span key="idle" className="inline-flex items-center gap-2">
                <RiLoginBoxLine className="size-4" />
                {buttonLabel}
              </span>
            )}
          </AutoTransition>
        </Button>
        {turnstileConfig.enabled ? (
          <div ref={turnstileRef} className="hidden" aria-hidden="true" />
        ) : null}
      </form>

      <Dialog open={securityDialogOpen} onOpenChange={setSecurityDialogOpen}>
        <DialogContent className="max-w-sm">
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
                void retrySecurityVerification();
              }}
            >
              <RiRefreshLine className="size-4" />
              {retrySecurityLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
