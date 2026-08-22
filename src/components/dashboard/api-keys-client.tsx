import { type SetStateAction, useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiCheckboxBlankCircleLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiKey2Line,
  RiRefreshLine,
} from "@remixicon/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { TableActionButton } from "@/components/dashboard/table-action-button";
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
import { AutoResizer } from "@/components/ui/auto-resizer";
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
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
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
import { requestAdminService } from "@/lib/admin-service-client";
import type { ApiKeysInitialData } from "@/lib/dashboard/management-data";
import type { ApiKeyData, ApiKeyScope } from "@/lib/edge-client-types";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface ApiKeysClientProps {
  locale: Locale;
  messages: AppMessages;
  teamId: string;
  sites: Array<{ id: string; name: string; domain: string }>;
  initialData?: ApiKeysInitialData | null;
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
  if (scope === "analysis:read") return copy.scopes.analysisRead;
  if (scope === "analysis:write") return copy.scopes.analysisWrite;
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
  if (scope === "analysis:read") return copy.scopeDescriptions.analysisRead;
  if (scope === "analysis:write") return copy.scopeDescriptions.analysisWrite;
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
      key: "analysis",
      label: copy.scopeGroups.analysis,
      scopes: ["analysis:read", "analysis:write"],
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

export function ApiKeysClient({
  locale,
  messages,
  teamId,
  sites,
  initialData = null,
}: ApiKeysClientProps) {
  const copy = messages.teamManagement.apiKeys;
  const cancelLabel = messages.teamSelect.cancel;
  const queryClient = useQueryClient();
  const keysQueryKey = ["dashboard", "api-keys", teamId] as const;
  const keysQuery = useQuery({
    queryKey: keysQueryKey,
    queryFn: ({ signal }) =>
      requestAdminService<ApiKeyData[]>("api-keys", {
        params: { teamId },
        signal,
      }),
    initialData: initialData?.keys,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const keys = keysQuery.data ?? [];
  const loading = keysQuery.isPending;
  const setKeys = (updater: SetStateAction<ApiKeyData[]>) => {
    queryClient.setQueryData<ApiKeyData[]>(keysQueryKey, (current = []) =>
      typeof updater === "function" ? updater(current) : updater,
    );
  };
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

  useEffect(() => {
    if (keysQuery.isError) toast.error(copy.loadFailed);
  }, [copy.loadFailed, keysQuery.errorUpdatedAt, keysQuery.isError]);

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
      const created = await requestAdminService<ApiKeyCreateResponse>(
        "api-keys",
        {
          method: "POST",
          body: {
            teamId,
            name,
            scopes,
            siteIds,
            expiresInDays:
              expiration === "never" ? "never" : Number(expiration),
          },
        },
      );
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
      const revoked = await requestAdminService<ApiKeyData | null>("api-keys", {
        method: "PATCH",
        body: { teamId, keyId, intent: "revoke" },
      });
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
      const rotated = await requestAdminService<ApiKeyCreateResponse>(
        "api-keys",
        {
          method: "PATCH",
          body: { teamId, keyId, intent: "rotate" },
        },
      );
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
          <AutoResizer initial>
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
                <div
                  key="loading"
                  className="flex h-32 items-center justify-center text-sm text-muted-foreground"
                >
                  <span className="inline-flex items-center gap-2">
                    <Spinner className="size-4" />
                    {copy.loading}
                  </span>
                </div>
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
                          <div className="flex justify-end gap-2">
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <TableActionButton
                                  label={copy.rotate}
                                  disabled={
                                    key.status !== "active" ||
                                    busyKeyId === key.id
                                  }
                                  transitionKey={
                                    busyKeyId === key.id ? "rotating" : "rotate"
                                  }
                                >
                                  {busyKeyId === key.id ? (
                                    <Spinner className="size-3.5" />
                                  ) : (
                                    <RiRefreshLine className="size-4" />
                                  )}
                                </TableActionButton>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle icon={RiRefreshLine}>
                                    {copy.rotate}
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {copy.rotateConfirm}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>
                                    <RiCloseLine className="size-4" />
                                    <span>{cancelLabel}</span>
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => void rotateKey(key.id)}
                                  >
                                    <RiRefreshLine className="size-4" />
                                    <span>{copy.rotate}</span>
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <TableActionButton
                                  label={copy.revoke}
                                  tone="destructive"
                                  disabled={
                                    key.status !== "active" ||
                                    busyKeyId === key.id
                                  }
                                  transitionKey={
                                    busyKeyId === key.id ? "revoking" : "revoke"
                                  }
                                >
                                  {busyKeyId === key.id ? (
                                    <Spinner className="size-3.5" />
                                  ) : (
                                    <RiDeleteBinLine className="size-4" />
                                  )}
                                </TableActionButton>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle icon={RiDeleteBinLine}>
                                    {copy.revoke}
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {copy.revokeConfirm}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>
                                    <RiCloseLine className="size-4" />
                                    <span>{cancelLabel}</span>
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    variant="destructive"
                                    onClick={() => void revokeKey(key.id)}
                                  >
                                    <RiDeleteBinLine className="size-4" />
                                    <span>{copy.revoke}</span>
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
          </AutoResizer>
        </CardContent>
      </Card>

      <ResponsiveDialog open={createOpen} onOpenChange={setCreateOpen}>
        <ResponsiveDialogContent desktopClassName="max-w-2xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiKey2Line}>
              {copy.createTitle}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {copy.createSubtitle}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="grid gap-4">
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
                  {siteIds.length === 0 ? (
                    <RiCheckLine />
                  ) : (
                    <RiCheckboxBlankCircleLine />
                  )}
                  <span>{copy.allSites}</span>
                </Button>
                {sites.map((site) => (
                  <Button
                    key={site.id}
                    type="button"
                    variant={siteIds.includes(site.id) ? "default" : "outline"}
                    size="sm"
                    onClick={() => toggleSite(site.id)}
                  >
                    {siteIds.includes(site.id) ? (
                      <RiCheckLine />
                    ) : (
                      <RiCheckboxBlankCircleLine />
                    )}
                    <span>{site.name}</span>
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
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
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
                  <span key="create" className="inline-flex items-center gap-2">
                    <RiAddLine className="size-4" />
                    {copy.create}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <Dialog open={secretOpen} onOpenChange={setSecretOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle icon={RiKey2Line}>
              {copy.oneTimeSecretTitle}
            </DialogTitle>
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
