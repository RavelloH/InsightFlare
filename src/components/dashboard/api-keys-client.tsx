"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiFileCopyLine,
  RiKey2Line,
  RiRefreshLine,
} from "@remixicon/react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ApiKeyData, ApiKeyScope } from "@/lib/edge-client-types";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface ApiKeysClientProps {
  locale: Locale;
  messages: AppMessages;
  teamId: string;
  sites: Array<{ id: string; name: string; domain: string }>;
}

interface ApiKeyCreateResponse {
  key: ApiKeyData;
  secret: string;
}

type ExpirationChoice = "30" | "90" | "180" | "365" | "never";

interface ScopeGroup {
  key: string;
  label: string;
  scopes: ApiKeyScope[];
}

function scopeLabel(
  copy: AppMessages["teamManagement"]["apiKeys"],
  scope: ApiKeyScope,
) {
  if (scope === "analytics:read") return copy.scopes.analyticsRead;
  if (scope === "site:read") return copy.scopes.siteRead;
  if (scope === "site:write") return copy.scopes.siteWrite;
  if (scope === "site_config:read") return copy.scopes.siteConfigRead;
  return copy.scopes.siteConfigWrite;
}

function scopeDescription(
  copy: AppMessages["teamManagement"]["apiKeys"],
  scope: ApiKeyScope,
) {
  if (scope === "analytics:read") return copy.scopeDescriptions.analyticsRead;
  if (scope === "site:read") return copy.scopeDescriptions.siteRead;
  if (scope === "site:write") return copy.scopeDescriptions.siteWrite;
  if (scope === "site_config:read")
    return copy.scopeDescriptions.siteConfigRead;
  return copy.scopeDescriptions.siteConfigWrite;
}

function getScopeGroups(
  copy: AppMessages["teamManagement"]["apiKeys"],
): ScopeGroup[] {
  return [
    {
      key: "analytics",
      label: copy.scopeGroups.analytics,
      scopes: ["analytics:read"],
    },
    {
      key: "site",
      label: copy.scopeGroups.site,
      scopes: ["site:read", "site:write"],
    },
    {
      key: "siteConfig",
      label: copy.scopeGroups.siteConfig,
      scopes: ["site_config:read", "site_config:write"],
    },
  ];
}

function dateTime(locale: Locale, value: number | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

async function readPayload<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as {
    ok?: boolean;
    data?: T;
    error?: string;
  };
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error || "request_failed");
  }
  return payload.data;
}

export function ApiKeysClient({
  locale,
  messages,
  teamId,
  sites,
}: ApiKeysClientProps) {
  const copy = messages.teamManagement.apiKeys;
  const cancelLabel = messages.teamSelect.cancel;
  const [keys, setKeys] = useState<ApiKeyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>([
    "analytics:read",
    "site:read",
  ]);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [expiration, setExpiration] = useState<ExpirationChoice>("180");
  const [submitting, setSubmitting] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState("");

  const siteNameById = useMemo(
    () => new Map(sites.map((site) => [site.id, site.name])),
    [sites],
  );

  async function loadKeys() {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
      setKeys([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/private/admin/api-keys?teamId=${encodeURIComponent(teamId)}`,
        {
          credentials: "include",
          cache: "no-store",
        },
      );
      setKeys(await readPayload<ApiKeyData[]>(response));
    } catch {
      toast.error(copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadKeys();
  }, [teamId]);

  function toggleScope(scope: ApiKeyScope) {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  }

  function toggleSite(siteId: string) {
    setSiteIds((current) =>
      current.includes(siteId)
        ? current.filter((item) => item !== siteId)
        : [...current, siteId],
    );
  }

  async function createKey() {
    if (name.trim().length < 2 || scopes.length === 0) {
      toast.error(copy.invalidInput);
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/private/admin/api-keys", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          teamId,
          name,
          scopes,
          siteIds,
          expiresInDays: expiration === "never" ? "never" : Number(expiration),
        }),
      });
      const created = await readPayload<ApiKeyCreateResponse>(response);
      setKeys((current) => [created.key, ...current]);
      setRevealedSecret(created.secret);
      setSecretOpen(true);
      setCreateOpen(false);
      setName("");
      setScopes(["analytics:read", "site:read"]);
      setSiteIds([]);
      setExpiration("180");
    } catch {
      toast.error(copy.createFailed);
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeKey(keyId: string) {
    setBusyKeyId(keyId);
    try {
      const response = await fetch("/api/private/admin/api-keys", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, keyId, intent: "revoke" }),
      });
      const revoked = await readPayload<ApiKeyData | null>(response);
      if (revoked) {
        setKeys((current) =>
          current.map((key) => (key.id === revoked.id ? revoked : key)),
        );
      }
    } catch {
      toast.error(copy.revokeFailed);
    } finally {
      setBusyKeyId("");
    }
  }

  async function rotateKey(keyId: string) {
    setBusyKeyId(keyId);
    try {
      const response = await fetch("/api/private/admin/api-keys", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId, keyId, intent: "rotate" }),
      });
      const rotated = await readPayload<ApiKeyCreateResponse>(response);
      setKeys((current) => [
        rotated.key,
        ...current.map((key) =>
          key.id === keyId
            ? {
                ...key,
                status: "revoked" as const,
                revokedAt: Math.floor(Date.now() / 1000),
              }
            : key,
        ),
      ]);
      setRevealedSecret(rotated.secret);
      setSecretOpen(true);
    } catch {
      toast.error(copy.rotateFailed);
    } finally {
      setBusyKeyId("");
    }
  }

  async function copySecret() {
    await navigator.clipboard.writeText(revealedSecret);
    toast.success(copy.copied);
  }

  function siteScopeLabel(key: ApiKeyData): string {
    if (key.siteIds.length === 0) return copy.allSites;
    return key.siteIds
      .map((siteId) => siteNameById.get(siteId) || siteId)
      .join(", ");
  }

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <RiAddLine />
          {copy.create}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <RiKey2Line className="size-4" />
            {copy.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AutoTransition
            transitionKey={
              loading ? "loading" : keys.length === 0 ? "empty" : "data"
            }
            initial={false}
            duration={0.15}
            type="fade"
            presenceMode="wait"
          >
            {loading ? (
              <p
                key="loading"
                className="py-8 text-center text-sm text-muted-foreground"
              >
                {copy.loading}
              </p>
            ) : keys.length === 0 ? (
              <div
                key="empty"
                className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground"
              >
                <RiKey2Line className="size-8 text-muted-foreground/70" />
                <p>{copy.empty}</p>
              </div>
            ) : (
              <Table key="data">
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.columns.name}</TableHead>
                    <TableHead>{copy.columns.scopes}</TableHead>
                    <TableHead>{copy.columns.sites}</TableHead>
                    <TableHead>{copy.columns.expires}</TableHead>
                    <TableHead>{copy.columns.lastUsed}</TableHead>
                    <TableHead>{copy.columns.status}</TableHead>
                    <TableHead className="text-right">
                      {copy.columns.action}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell>
                        <div className="font-medium">{key.name}</div>
                        <div className="font-mono text-muted-foreground">
                          {key.prefix}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-72 whitespace-normal">
                        <div className="flex flex-wrap gap-1">
                          {key.scopes.map((scope) => (
                            <Badge key={scope} variant="outline">
                              {scopeLabel(copy, scope)}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-56 truncate">
                        {siteScopeLabel(key)}
                      </TableCell>
                      <TableCell>
                        {key.expiresAt
                          ? dateTime(locale, key.expiresAt)
                          : copy.neverExpires}
                      </TableCell>
                      <TableCell>
                        {key.lastUsedAt
                          ? dateTime(locale, key.lastUsedAt)
                          : copy.notUsed}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            key.status === "active" ? "secondary" : "outline"
                          }
                        >
                          {copy.status[key.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  key.status !== "active" ||
                                  busyKeyId === key.id
                                }
                              >
                                <AutoTransition className="inline-flex items-center gap-2">
                                  {busyKeyId === key.id ? (
                                    <span
                                      key="rotating"
                                      className="inline-flex items-center gap-2"
                                    >
                                      <Spinner className="size-4" />
                                      {copy.rotate}
                                    </span>
                                  ) : (
                                    <span
                                      key="rotate"
                                      className="inline-flex items-center gap-2"
                                    >
                                      <RiRefreshLine />
                                      {copy.rotate}
                                    </span>
                                  )}
                                </AutoTransition>
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {copy.rotate}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {copy.rotateConfirm}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>
                                  {cancelLabel}
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => void rotateKey(key.id)}
                                >
                                  {copy.rotate}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={
                                  key.status !== "active" ||
                                  busyKeyId === key.id
                                }
                              >
                                <AutoTransition className="inline-flex items-center gap-2">
                                  {busyKeyId === key.id ? (
                                    <span
                                      key="revoking"
                                      className="inline-flex items-center gap-2"
                                    >
                                      <Spinner className="size-4" />
                                      {copy.revoke}
                                    </span>
                                  ) : (
                                    <span key="revoke">{copy.revoke}</span>
                                  )}
                                </AutoTransition>
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {copy.revoke}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {copy.revokeConfirm}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>
                                  {cancelLabel}
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  variant="destructive"
                                  onClick={() => void revokeKey(key.id)}
                                >
                                  {copy.revoke}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </AutoTransition>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{copy.createTitle}</DialogTitle>
            <DialogDescription>{copy.createSubtitle}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="api-key-name">{copy.nameLabel}</FieldLabel>
              <Input
                id="api-key-name"
                value={name}
                placeholder={copy.namePlaceholder}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>{copy.scopesTitle}</FieldLabel>
              <FieldDescription>{copy.scopesDescription}</FieldDescription>
              <div className="grid gap-3">
                {getScopeGroups(copy).map((group) => (
                  <div key={group.key}>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                      {group.label}
                    </div>
                    <div className="grid gap-1 pl-5">
                      {group.scopes.map((scope) => (
                        <label
                          key={scope}
                          className="flex items-start gap-2 cursor-pointer py-0.5"
                        >
                          <Checkbox
                            checked={scopes.includes(scope)}
                            onCheckedChange={() => toggleScope(scope)}
                            className="mt-0.5"
                          />
                          <div className="grid gap-0">
                            <span className="text-xs">
                              {scopeLabel(copy, scope)}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {scopeDescription(copy, scope)}
                            </span>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Field>
            <Field>
              <FieldLabel>{copy.siteScopeTitle}</FieldLabel>
              <FieldDescription>{copy.siteScopeDescription}</FieldDescription>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant={siteIds.length === 0 ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSiteIds([])}
                >
                  {copy.allSites}
                </Button>
                {sites.map((site) => (
                  <Button
                    key={site.id}
                    type="button"
                    variant={siteIds.includes(site.id) ? "default" : "outline"}
                    size="sm"
                    onClick={() => toggleSite(site.id)}
                  >
                    {site.name}
                  </Button>
                ))}
              </div>
            </Field>
            <Field>
              <FieldLabel>{copy.expirationLabel}</FieldLabel>
              <Select
                value={expiration}
                onValueChange={(value) =>
                  setExpiration(value as ExpirationChoice)
                }
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">{copy.expiration30}</SelectItem>
                  <SelectItem value="90">{copy.expiration90}</SelectItem>
                  <SelectItem value="180">{copy.expiration180}</SelectItem>
                  <SelectItem value="365">{copy.expiration365}</SelectItem>
                  <SelectItem value="never">{copy.expirationNever}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button onClick={createKey} disabled={submitting}>
              <AutoTransition className="inline-flex items-center gap-2">
                {submitting ? (
                  <span
                    key="creating"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.creating}
                  </span>
                ) : (
                  <span key="create">{copy.create}</span>
                )}
              </AutoTransition>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={secretOpen} onOpenChange={setSecretOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{copy.oneTimeSecretTitle}</DialogTitle>
            <DialogDescription>
              {copy.oneTimeSecretDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="break-all border bg-muted/40 p-3 font-mono text-xs">
            {revealedSecret}
          </div>
          <DialogFooter>
            <Button onClick={copySecret}>
              <RiFileCopyLine />
              {copy.copySecret}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
