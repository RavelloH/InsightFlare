import { useEffect, useState } from "react";
import { RiCheckLine, RiCloseLine, RiLoginBoxLine } from "@remixicon/react";
import { toast } from "sonner";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
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

type InviteCopy = AppMessages["accountLinks"]["invite"];

interface InviteLinkFormProps {
  locale: Locale;
  copy: InviteCopy;
}

interface ApiResponse<T> {
  ok?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface TeamInfo {
  id: string;
  name?: string;
  slug?: string;
}

interface InviteInspectData {
  type: "team_invite";
  team: TeamInfo;
  email?: string;
  payload?: {
    teamRole?: "admin" | "member";
  };
  requiresLogin?: boolean;
  allowsRegistration?: boolean;
  expiresAt: number;
}

interface InviteCompleteData {
  type: "team_invite";
  team?: TeamInfo;
  registered?: boolean;
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

export function InviteLinkForm({ locale, copy }: InviteLinkFormProps) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [invite, setInvite] = useState<InviteInspectData | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [hash, setHash] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const loginHref = (() => {
    const next = encodeURIComponent(`/${locale}/invite${hash}`);
    return `/${locale}/login?next=${next}`;
  })();

  useEffect(() => {
    setHash(window.location.hash);
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
        const sessionResponse = await fetch("/api/private/session", {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        });
        setSignedIn(sessionResponse.ok);

        const response = await fetch("/api/public/account-links/inspect", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: nextToken }),
        });
        const payload =
          (await response.json()) as ApiResponse<InviteInspectData>;
        if (
          !response.ok ||
          !payload.ok ||
          payload.data?.type !== "team_invite"
        ) {
          throw new Error(apiMessage(payload, copy.loadFailed));
        }
        setInvite(payload.data);
        if (payload.data.email) setEmail(payload.data.email);
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

  async function completeInvite() {
    if (!token || !invite || submitting) return;
    setSubmitting(true);
    try {
      const body = signedIn
        ? { token }
        : { token, username, email, name, password };
      const response = await fetch("/api/public/account-links/complete", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload =
        (await response.json()) as ApiResponse<InviteCompleteData>;
      if (!response.ok || !payload.ok || payload.data?.type !== "team_invite") {
        throw new Error(apiMessage(payload, copy.acceptFailed));
      }
      toast.success(copy.accepted);
      const slug = payload.data.team?.slug || invite.team.slug;
      const appTarget = slug ? `/${locale}/app/${slug}` : `/${locale}/app`;
      const target =
        payload.data.registered && !signedIn
          ? `/${locale}/login?next=${encodeURIComponent(appTarget)}`
          : appTarget;
      navigateWithTransition(router, target);
    } catch (submitError) {
      toast.error(
        submitError instanceof Error ? submitError.message : copy.acceptFailed,
      );
      setSubmitting(false);
    }
  }

  const role =
    invite?.payload?.teamRole === "admin"
      ? copy.roles.admin
      : copy.roles.member;
  const canRegister = invite?.allowsRegistration !== false;
  const requiresLogin =
    Boolean(invite?.requiresLogin) || (!signedIn && !canRegister);

  const contentKey = loading ? "loading" : error || !invite ? "error" : "form";
  const accountActionKey = signedIn
    ? "signed-in"
    : requiresLogin
      ? "requires-login"
      : "register";

  return (
    <AutoResizer initial>
      <AutoTransition initial duration={0.22} transitionKey={contentKey}>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-4" />
            {copy.loading}
          </div>
        ) : error || !invite ? (
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
              void completeInvite();
            }}
          >
            <div className="grid gap-2 border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{copy.teamLabel}</span>
                <span className="text-right font-medium">
                  {invite.team.name || invite.team.slug || invite.team.id}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{copy.roleLabel}</span>
                <Badge
                  variant={
                    invite.payload?.teamRole === "admin"
                      ? "default"
                      : "secondary"
                  }
                >
                  {role}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{copy.emailLabel}</span>
                <span className="text-right">
                  {invite.email || copy.anyEmail}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {copy.expiresLabel}
                </span>
                <span className="text-right">
                  {shortDateTime(locale, epochSecondsToMs(invite.expiresAt))}
                </span>
              </div>
            </div>

            <AutoResizer initial>
              <AutoTransition
                initial={false}
                duration={0.2}
                transitionKey={accountActionKey}
              >
                {signedIn ? (
                  <div className="flex items-start gap-2 border border-primary/20 bg-primary/5 p-3 text-primary">
                    <RiCheckLine className="mt-0.5 size-4 shrink-0" />
                    <p>{copy.signedInNotice}</p>
                  </div>
                ) : requiresLogin ? (
                  <Button asChild className="w-full">
                    <Link href={loginHref}>
                      <RiLoginBoxLine className="size-4" />
                      {copy.signIn}
                    </Link>
                  </Button>
                ) : (
                  <div className="space-y-4">
                    <div className="grid gap-2">
                      <Label htmlFor="invite-username">
                        {copy.usernameLabel}
                      </Label>
                      <Input
                        id="invite-username"
                        value={username}
                        autoComplete="username"
                        onChange={(event) => setUsername(event.target.value)}
                        required
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="invite-email">
                        {copy.accountEmailLabel}
                      </Label>
                      <Input
                        id="invite-email"
                        value={email}
                        type="email"
                        autoComplete="email"
                        onChange={(event) => setEmail(event.target.value)}
                        disabled={Boolean(invite.email)}
                        required
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="invite-name">{copy.nameLabel}</Label>
                      <Input
                        id="invite-name"
                        value={name}
                        autoComplete="name"
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="invite-password">
                        {copy.passwordLabel}
                      </Label>
                      <Input
                        id="invite-password"
                        value={password}
                        type="password"
                        autoComplete="new-password"
                        minLength={8}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                      />
                    </div>
                  </div>
                )}
              </AutoTransition>
            </AutoResizer>

            <AutoResizer initial>
              <AutoTransition
                initial={false}
                duration={0.2}
                transitionKey={requiresLogin ? "empty" : "submit"}
              >
                {!requiresLogin ? (
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={submitting}
                  >
                    <AutoTransition
                      className="inline-flex items-center gap-2"
                      transitionKey={submitting ? "submitting" : "idle"}
                    >
                      {submitting ? (
                        <span className="inline-flex items-center gap-2">
                          <Spinner className="size-4" />
                          {copy.accepting}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <RiCheckLine className="size-4" />
                          {copy.accept}
                        </span>
                      )}
                    </AutoTransition>
                  </Button>
                ) : null}
              </AutoTransition>
            </AutoResizer>
          </form>
        )}
      </AutoTransition>
    </AutoResizer>
  );
}
