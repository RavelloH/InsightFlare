import { RiCloseLine, RiDeleteBinLine, RiSave3Line } from "@remixicon/react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Spinner } from "@/components/ui/spinner";
import { formatI18nTemplate } from "@/lib/i18n/template";

import { useTeamManagementContext } from "./context";
import {
  SiteAccessSelectorButtons,
  TeamInviteCreateCard,
  TeamInviteLinksCard,
  TeamMembersTableCard,
} from "./invite-cards";
export function TeamManagementMembersPanel() {
  return (
    <div className="space-y-4">
      <TeamInviteCreateCard />
      <TeamInviteLinksCard />
      <TeamMembersTableCard />
    </div>
  );
}
export function TeamManagementMemberDialogs() {
  const {
    copy,
    editingSiteIds,
    handleRemoveMember,
    handleRevokeInvite,
    handleSaveMemberSiteAccess,
    inviteSiteAccessDialogOpen,
    inviteSiteIds,
    messages,
    removeMemberTarget,
    removingMemberId,
    revokeInviteTarget,
    revokingInviteId,
    savingSiteAccessId,
    setEditingSiteIds,
    setInviteSiteAccessDialogOpen,
    setInviteSiteIds,
    setRemoveMemberTarget,
    setRevokeInviteTarget,
    setSiteAccessDialogMember,
    siteAccessDialogMember,
    sites,
    toggleEditingSite,
    toggleInviteSite,
  } = useTeamManagementContext();

  const inviteSiteAccessDialog = (
    <ResponsiveDialog
      open={inviteSiteAccessDialogOpen}
      onOpenChange={setInviteSiteAccessDialogOpen}
    >
      <ResponsiveDialogContent desktopClassName="max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {copy.members.siteAccessDialogTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {copy.members.invitesTitle}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <Field>
            <FieldLabel>{copy.members.siteAccessLabel}</FieldLabel>
            <FieldDescription>
              {copy.members.siteAccessDescription}
            </FieldDescription>
            <SiteAccessSelectorButtons
              siteIds={inviteSiteIds}
              sites={sites}
              allSitesLabel={copy.members.siteAccessAll}
              noSitesLabel={copy.members.noSitesForAccess}
              onAllSites={() => setInviteSiteIds([])}
              onToggleSite={(siteId) =>
                toggleInviteSite(siteId, !inviteSiteIds.includes(siteId))
              }
            />
          </Field>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button
            type="button"
            onClick={() => setInviteSiteAccessDialogOpen(false)}
          >
            <RiSave3Line className="size-4" />
            <span>{copy.members.saveSiteAccess}</span>
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );

  const siteAccessDialog = (
    <ResponsiveDialog
      open={Boolean(siteAccessDialogMember)}
      onOpenChange={(open) => {
        if (open) return;
        setSiteAccessDialogMember(null);
        setEditingSiteIds([]);
      }}
    >
      <ResponsiveDialogContent desktopClassName="max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {copy.members.siteAccessDialogTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {siteAccessDialogMember
              ? siteAccessDialogMember.name || siteAccessDialogMember.username
              : copy.members.roleLabels.member}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <Field>
            <FieldLabel>{copy.members.siteAccessLabel}</FieldLabel>
            <FieldDescription>
              {copy.members.siteAccessDescription}
            </FieldDescription>
            <SiteAccessSelectorButtons
              siteIds={editingSiteIds}
              sites={sites}
              allSitesLabel={copy.members.siteAccessAll}
              noSitesLabel={copy.members.noSitesForAccess}
              onAllSites={() => setEditingSiteIds([])}
              onToggleSite={(siteId) =>
                toggleEditingSite(siteId, !editingSiteIds.includes(siteId))
              }
            />
          </Field>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSiteAccessDialogMember(null);
              setEditingSiteIds([]);
            }}
          >
            {copy.members.cancelSiteAccess}
          </Button>
          <Button
            type="button"
            disabled={
              !siteAccessDialogMember ||
              savingSiteAccessId === siteAccessDialogMember.userId
            }
            onClick={() => {
              void handleSaveMemberSiteAccess();
            }}
          >
            {siteAccessDialogMember &&
            savingSiteAccessId === siteAccessDialogMember.userId ? (
              <Spinner className="size-4" />
            ) : (
              <RiSave3Line className="size-4" />
            )}
            <span>{copy.members.saveSiteAccess}</span>
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );

  const revokeInviteDialog = (
    <AlertDialog
      open={Boolean(revokeInviteTarget)}
      onOpenChange={(open) => {
        if (revokingInviteId) return;
        if (!open) setRevokeInviteTarget(null);
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle icon={RiDeleteBinLine}>
            {revokeInviteTarget
              ? formatI18nTemplate(copy.members.revokeInviteAction, {
                  target: revokeInviteTarget.email || copy.members.anyEmail,
                })
              : copy.members.revokeInvite}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {revokeInviteTarget
              ? formatI18nTemplate(copy.members.revokeInviteConfirm, {
                  target: revokeInviteTarget.email || copy.members.anyEmail,
                })
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(revokingInviteId)}>
            <RiCloseLine className="size-4" />
            <span>{messages.teamSelect.cancel}</span>
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!revokeInviteTarget || Boolean(revokingInviteId)}
            onClick={(event) => {
              event.preventDefault();
              if (revokeInviteTarget) {
                void handleRevokeInvite(revokeInviteTarget.id);
              }
            }}
          >
            <RiDeleteBinLine className="size-4" />
            <span>{copy.members.revokeInvite}</span>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const removeMemberDialog = (
    <AlertDialog
      open={Boolean(removeMemberTarget)}
      onOpenChange={(open) => {
        if (removingMemberId) return;
        if (!open) setRemoveMemberTarget(null);
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle icon={RiDeleteBinLine}>
            {removeMemberTarget
              ? formatI18nTemplate(copy.members.removeMemberAction, {
                  target:
                    removeMemberTarget.name ||
                    removeMemberTarget.username ||
                    removeMemberTarget.email,
                })
              : copy.members.remove}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {removeMemberTarget
              ? formatI18nTemplate(copy.members.removeMemberConfirm, {
                  target:
                    removeMemberTarget.name ||
                    removeMemberTarget.username ||
                    removeMemberTarget.email,
                })
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={Boolean(removingMemberId)}>
            <RiCloseLine className="size-4" />
            <span>{messages.teamSelect.cancel}</span>
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!removeMemberTarget || Boolean(removingMemberId)}
            onClick={(event) => {
              event.preventDefault();
              if (removeMemberTarget) {
                void handleRemoveMember(removeMemberTarget.userId);
              }
            }}
          >
            <RiDeleteBinLine className="size-4" />
            <span>{copy.members.remove}</span>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return (
    <>
      {inviteSiteAccessDialog}
      {siteAccessDialog}
      {revokeInviteDialog}
      {removeMemberDialog}
    </>
  );
}
