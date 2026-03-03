"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Locale } from "@/lib/i18n/config";
import { navigateWithTransition } from "@/lib/page-transition";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface LoginFormProps {
  locale: Locale;
  nextPath: string;
  usernameLabel: string;
  passwordLabel: string;
  signInLabel: string;
  signingInLabel: string;
  invalidCredentialsLabel: string;
  failedLabel: string;
}

interface LoginResponse {
  ok: boolean;
  data?: {
    next: string;
  };
  error?: string;
  message?: string;
}

export function LoginForm({
  locale,
  nextPath,
  usernameLabel,
  passwordLabel,
  signInLabel,
  signingInLabel,
  invalidCredentialsLabel,
  failedLabel,
}: LoginFormProps) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  async function handleLogin() {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username,
          password,
          next: nextPath,
        }),
      });
      const payload = (await response.json()) as LoginResponse;
      if (!response.ok || !payload.ok || !payload.data) {
        const message = payload.error === "invalid_credentials"
          ? invalidCredentialsLabel
          : payload.message || failedLabel;
        throw new Error(message);
      }
      navigateWithTransition(router, payload.data.next || `/${locale}/app`);
    } catch (error) {
      const message = error instanceof Error ? error.message : failedLabel;
      toast.error(message || failedLabel);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleLogin();
      }}
    >
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
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? signingInLabel : signInLabel}
      </Button>
    </form>
  );
}
