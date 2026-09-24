import {
  RiAddLine,
  RiCheckboxBlankCircleLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiGlobalLine,
  RiLinksLine,
  RiLockLine,
  RiMailSendLine,
  RiSettings3Line,
} from "@remixicon/react";
import { toast } from "sonner";

import { DataTableSwitch } from "@/components/dashboard/common/data-table-switch";
import { TableActionButton } from "@/components/dashboard/common/table-action-button";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { shortDateTime } from "@/lib/dashboard/format";
import type { SiteData } from "@/lib/dashboard-api/client/edge";
import { formatI18nTemplate } from "@/lib/i18n/template";

import { useTeamManagementContext } from "./context";
import { epochSecondsToMs, normalizeSiteIds, siteAccessSummary } from "./model";
export function SiteAccessSelectorButtons({
  siteIds,
  sites,
  allSitesLabel,
  noSitesLabel,
  onAllSites,
  onToggleSite,
}: {
  siteIds: string[];
  sites: Array<Pick<SiteData, "id" | "name" | "domain">>;
  allSitesLabel: string;
  noSitesLabel: string;
  onAllSites: () => void;
  onToggleSite: (siteId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant={siteIds.length === 0 ? "default" : "outline"}
        size="sm"
        onClick={onAllSites}
      >
        {siteIds.length === 0 ? <RiCheckLine /> : <RiCheckboxBlankCircleLine />}
        <span>{allSitesLabel}</span>
      </Button>
      {sites.length > 0 ? (
        sites.map((site) => {
          const checked = siteIds.includes(site.id);
          return (
            <Button
              key={site.id}
              type="button"
              variant={checked ? "default" : "outline"}
              size="sm"
              onClick={() => onToggleSite(site.id)}
            >
              {checked ? <RiCheckLine /> : <RiCheckboxBlankCircleLine />}
              <span>{site.name || site.domain || site.id}</span>
            </Button>
          );
        })
      ) : (
        <p className="text-sm text-muted-foreground">{noSitesLabel}</p>
      )}
    </div>
  );
}
export function TeamInviteCreateCard() {
  const {
    canManage,
    copy,
    creatingInvite,
    handleCopyLatestInviteUrl,
    handleCreateInvite,
    inviteEmail,
    inviteExpiresInHours,
    inviteRole,
    inviteSiteIds,
    latestInviteUrl,
    setInviteEmail,
    setInviteExpiresInHours,
    setInviteRole,
    setInviteSiteAccessDialogOpen,
    setInviteSiteIds,
    sites,
  } = useTeamManagementContext();
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiMailSendLine className="size-4" />
          {copy.members.invitesTitle}
        </CardTitle>
        <CardDescription>{copy.members.invitesSubtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        <form
          className="flex h-full flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateInvite();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="invite-email">
              {copy.members.inviteEmailLabel}
            </Label>
            <Input
              id="invite-email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder={copy.members.inviteEmailPlaceholder}
              disabled={!canManage}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="invite-role">{copy.members.columns.role}</Label>
              <Select
                value={inviteRole}
                onValueChange={(value) => {
                  const nextRole = value === "admin" ? "admin" : "member";
                  setInviteRole(nextRole);
                  if (nextRole === "admin") setInviteSiteIds([]);
                }}
                disabled={!canManage}
              >
                <SelectTrigger id="invite-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">
                    {copy.members.roleLabels.member}
                  </SelectItem>
                  <SelectItem value="admin">
                    {copy.members.roleLabels.admin}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-expires">
                {copy.members.inviteExpiresLabel}
              </Label>
              <Input
                id="invite-expires"
                value={inviteExpiresInHours}
                onChange={(event) =>
                  setInviteExpiresInHours(event.target.value)
                }
                inputMode="numeric"
                disabled={!canManage}
              />
            </div>
          </div>
          {inviteRole === "member" ? (
            <div className="space-y-2">
              <Label>{copy.members.siteAccessLabel}</Label>
              <Button
                type="button"
                variant="outline"
                disabled={!canManage}
                className="w-full justify-between"
                onClick={() => setInviteSiteAccessDialogOpen(true)}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <RiGlobalLine className="size-4 shrink-0" />
                  <span className="truncate">
                    {siteAccessSummary(inviteSiteIds, sites, copy.members)}
                  </span>
                </span>
                <RiSettings3Line className="size-4 shrink-0 text-muted-foreground" />
              </Button>
            </div>
          ) : (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {copy.members.siteAccessAdmins}
            </div>
          )}
          <Button
            type="submit"
            className="mt-auto self-start"
            disabled={creatingInvite || !canManage}
          >
            <AutoTransition className="inline-flex items-center gap-2">
              {creatingInvite ? (
                <span key="creating" className="inline-flex items-center gap-2">
                  <Spinner className="size-4" />
                  {copy.members.creatingInvite}
                </span>
              ) : (
                <span key="create" className="inline-flex items-center gap-2">
                  <RiAddLine className="size-4" />
                  {copy.members.createInvite}
                </span>
              )}
            </AutoTransition>
          </Button>
        </form>

        {latestInviteUrl ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input value={latestInviteUrl} readOnly className="font-mono" />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void handleCopyLatestInviteUrl();
              }}
            >
              <RiFileCopyLine className="size-4" />
              <span>{copy.members.copyInvite}</span>
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
export function TeamInviteLinksCard() {
  const {
    canManage,
    copy,
    handleCopyInviteUrl,
    invites,
    loading,
    locale,
    messages,
    revokingInviteId,
    setRevokeInviteTarget,
    sites,
    window,
  } = useTeamManagementContext();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiLinksLine className="size-4" />
          {copy.members.inviteLinksTitle}
        </CardTitle>
        <CardDescription>{copy.members.inviteLinksSubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTableSwitch
          loading={loading}
          hasContent={invites.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={copy.members.noInvites}
          colSpan={9}
          header={
            <TableRow>
              <TableHead>{copy.members.columns.email}</TableHead>
              <TableHead>{copy.members.columns.inviteCode}</TableHead>
              <TableHead>{copy.members.columns.role}</TableHead>
              <TableHead>{copy.members.columns.siteAccess}</TableHead>
              <TableHead>{copy.members.columns.status}</TableHead>
              <TableHead>{copy.members.columns.createdAt}</TableHead>
              <TableHead>{copy.members.columns.expiresAt}</TableHead>
              <TableHead>{copy.members.columns.usedAt}</TableHead>
              <TableHead className="text-right">
                {copy.members.columns.action}
              </TableHead>
            </TableRow>
          }
          rows={invites.map((invite) => (
            <TableRow key={invite.id}>
              <TableCell>{invite.email || copy.members.anyEmail}</TableCell>
              <TableCell>
                {invite.code ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-flex"
                        tabIndex={!invite.url ? 0 : undefined}
                      >
                        <button
                          type="button"
                          className="font-mono text-xs text-primary underline-offset-4 hover:underline disabled:pointer-events-none disabled:text-muted-foreground"
                          disabled={!invite.url}
                          aria-label={copy.members.copyInvite}
                          onClick={() => {
                            void handleCopyInviteUrl(invite);
                          }}
                        >
                          {invite.code}
                        </button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{copy.members.copyInvite}</TooltipContent>
                  </Tooltip>
                ) : (
                  "-"
                )}
              </TableCell>
              <TableCell>
                {invite.payload.teamRole === "admin"
                  ? copy.members.roleLabels.admin
                  : copy.members.roleLabels.member}
              </TableCell>
              <TableCell>
                {invite.payload.teamRole === "admin"
                  ? copy.members.siteAccessAll
                  : siteAccessSummary(
                      normalizeSiteIds(invite.payload.siteIds),
                      sites,
                      copy.members,
                    )}
              </TableCell>
              <TableCell>
                {copy.members.inviteStatuses[invite.status]}
              </TableCell>
              <TableCell>
                {shortDateTime(
                  locale,
                  epochSecondsToMs(invite.createdAt),
                  window.timeZone,
                )}
              </TableCell>
              <TableCell>
                {shortDateTime(
                  locale,
                  epochSecondsToMs(invite.expiresAt),
                  window.timeZone,
                )}
              </TableCell>
              <TableCell>
                {invite.usedAt
                  ? shortDateTime(
                      locale,
                      epochSecondsToMs(invite.usedAt),
                      window.timeZone,
                    )
                  : "-"}
              </TableCell>
              <TableCell className="text-right">
                <TableActionButton
                  onClick={() => {
                    setRevokeInviteTarget(invite);
                  }}
                  disabled={
                    !canManage ||
                    invite.status !== "active" ||
                    revokingInviteId === invite.id
                  }
                  label={formatI18nTemplate(copy.members.revokeInviteAction, {
                    target: invite.email || copy.members.anyEmail,
                  })}
                  tone="destructive"
                  transitionKey={
                    revokingInviteId === invite.id ? "revoking" : "revoke"
                  }
                >
                  {revokingInviteId === invite.id ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <RiDeleteBinLine className="size-4" />
                  )}
                </TableActionButton>
              </TableCell>
            </TableRow>
          ))}
        />
      </CardContent>
    </Card>
  );
}
export function TeamMembersTableCard() {
  const {
    activeTeam,
    canManage,
    changingRoleId,
    copy,
    currentUserId,
    handleChangeMemberRole,
    loading,
    locale,
    members,
    messages,
    removingMemberId,
    savingSiteAccessId,
    setEditingSiteIds,
    setRemoveMemberTarget,
    setSiteAccessDialogMember,
    sites,
    systemRole,
    window,
  } = useTeamManagementContext();
  return (
    <Card>
      <CardContent className="pt-4">
        <DataTableSwitch
          loading={loading}
          hasContent={members.length > 0}
          loadingLabel={messages.common.loading}
          emptyLabel={copy.members.noMembers}
          colSpan={7}
          header={
            <TableRow>
              <TableHead>{copy.members.columns.name}</TableHead>
              <TableHead>{copy.members.columns.username}</TableHead>
              <TableHead>{copy.members.columns.email}</TableHead>
              <TableHead>{copy.members.columns.role}</TableHead>
              <TableHead>{copy.members.columns.siteAccess}</TableHead>
              <TableHead>{copy.members.columns.joinedAt}</TableHead>
              <TableHead className="text-right">
                {copy.members.columns.action}
              </TableHead>
            </TableRow>
          }
          rows={members.map((member) => (
            <TableRow key={member.userId}>
              <TableCell className="font-medium">
                {member.name || member.username}
              </TableCell>
              <TableCell>{member.username}</TableCell>
              <TableCell>{member.email}</TableCell>
              <TableCell>
                {member.role === "owner" ? (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <RiLockLine className="size-3.5" />
                    {copy.members.roleLabels.owner}
                  </span>
                ) : (
                  <Select
                    value={member.role === "admin" ? "admin" : "member"}
                    disabled={!canManage || changingRoleId === member.userId}
                    onValueChange={(value) => {
                      const next: "admin" | "member" =
                        value === "admin" ? "admin" : "member";
                      const current: "admin" | "member" =
                        member.role === "admin" ? "admin" : "member";
                      if (next === current) return;
                      const isSelfDemote =
                        member.userId === currentUserId &&
                        systemRole !== "admin" &&
                        activeTeam.ownerUserId !== currentUserId &&
                        next === "member";
                      if (isSelfDemote) {
                        toast.error(copy.toasts.roleChangeFailed);
                        return;
                      }
                      void handleChangeMemberRole(member.userId, next);
                    }}
                  >
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <AutoTransition className="inline-flex items-center gap-1.5">
                        {changingRoleId === member.userId ? (
                          <span
                            key="role-changing"
                            className="inline-flex items-center gap-1.5"
                          >
                            <Spinner className="size-3" />
                          </span>
                        ) : (
                          <span key="role-value">
                            <SelectValue />
                          </span>
                        )}
                      </AutoTransition>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">
                        {copy.members.roleLabels.member}
                      </SelectItem>
                      <SelectItem value="admin">
                        {copy.members.roleLabels.admin}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </TableCell>
              <TableCell>
                {member.role === "member" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      !canManage || savingSiteAccessId === member.userId
                    }
                    className="justify-between"
                    onClick={() => {
                      setSiteAccessDialogMember(member);
                      setEditingSiteIds(normalizeSiteIds(member.siteIds));
                    }}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <RiGlobalLine className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate">
                        {siteAccessSummary(
                          normalizeSiteIds(member.siteIds),
                          sites,
                          copy.members,
                        )}
                      </span>
                    </span>
                    {savingSiteAccessId === member.userId ? (
                      <Spinner className="size-3.5 shrink-0" />
                    ) : (
                      <RiSettings3Line className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled
                    className="justify-start"
                  >
                    <RiGlobalLine className="size-3.5" />
                    <span className="truncate">
                      {copy.members.siteAccessAll}
                    </span>
                  </Button>
                )}
              </TableCell>
              <TableCell>
                {shortDateTime(
                  locale,
                  epochSecondsToMs(member.joinedAt),
                  window.timeZone,
                )}
              </TableCell>
              <TableCell className="text-right">
                {member.role === "owner" ? null : (
                  <TableActionButton
                    onClick={() => {
                      setRemoveMemberTarget(member);
                    }}
                    disabled={!canManage || removingMemberId === member.userId}
                    label={formatI18nTemplate(copy.members.removeMemberAction, {
                      target: member.name || member.username || member.email,
                    })}
                    tone="destructive"
                    transitionKey={
                      removingMemberId === member.userId ? "removing" : "remove"
                    }
                  >
                    {removingMemberId === member.userId ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <RiDeleteBinLine className="size-4" />
                    )}
                  </TableActionButton>
                )}
              </TableCell>
            </TableRow>
          ))}
        />
      </CardContent>
    </Card>
  );
}
