import {
  RiArrowRightLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiSave3Line,
  RiSettings3Line,
} from "@remixicon/react";

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

import { useTeamManagementContext } from "./context";
import {
  TeamInviteCreateCard,
  TeamInviteLinksCard,
  TeamMembersTableCard,
} from "./invite-cards";
export function TeamManagementSettingsPanel() {
  const {
    activeTab,
    canAdminister,
    copy,
    deleteTeamDialogOpen,
    deletingTeam,
    handleDeleteTeam,
    handleSaveTeamSettings,
    handleTransferOwner,
    isRealOwner,
    messages,
    savingTeam,
    setDeleteTeamDialogOpen,
    setTeamName,
    setTeamSlug,
    setTransferDialogOpen,
    setTransferTargetId,
    teamName,
    teamSlug,
    transferDialogOpen,
    transferTargetId,
    transferableMembers,
    transferring,
  } = useTeamManagementContext();

  return activeTab === "settings" ? (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiSettings3Line className="size-4" />
              {copy.settings.title}
            </CardTitle>
            <CardDescription>{copy.settings.subtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveTeamSettings();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="team-name">{copy.settings.nameLabel}</Label>
                <Input
                  id="team-name"
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                  minLength={2}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="team-slug">{copy.settings.slugLabel}</Label>
                <Input
                  id="team-slug"
                  value={teamSlug}
                  onChange={(event) => setTeamSlug(event.target.value)}
                />
              </div>

              <Button
                type="submit"
                className="mt-auto self-start"
                disabled={savingTeam || deletingTeam}
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {savingTeam ? (
                    <span
                      key="saving"
                      className="inline-flex items-center gap-2"
                    >
                      <Spinner className="size-4" />
                      {copy.settings.saving}
                    </span>
                  ) : (
                    <span key="save" className="inline-flex items-center gap-2">
                      <RiSave3Line className="size-4" />
                      {copy.settings.save}
                    </span>
                  )}
                </AutoTransition>
              </Button>
            </form>
          </CardContent>
        </Card>
        <TeamInviteCreateCard />
      </div>

      <TeamInviteLinksCard />

      <TeamMembersTableCard />

      <div className="grid gap-4 lg:grid-cols-2">
        {isRealOwner ? (
          <AlertDialog
            open={transferDialogOpen}
            onOpenChange={(open) => {
              if (transferring) return;
              setTransferDialogOpen(open);
            }}
          >
            <Card className="h-full border-amber-500/40">
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-2">
                  <RiArrowRightLine className="size-4" />
                  {copy.settings.transferTitle}
                </CardTitle>
                <CardDescription>
                  {copy.settings.transferSubtitle}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex h-full flex-col gap-3">
                {transferableMembers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {copy.settings.noTransferableMembers}
                  </p>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="transfer-target">
                      {copy.settings.transferTargetLabel}
                    </Label>
                    <Select
                      value={transferTargetId}
                      onValueChange={setTransferTargetId}
                      disabled={transferring}
                    >
                      <SelectTrigger id="transfer-target" className="w-full">
                        <SelectValue
                          placeholder={copy.settings.transferTargetPlaceholder}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {transferableMembers.map((member) => (
                          <SelectItem key={member.userId} value={member.userId}>
                            {member.name || member.username} · {member.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="mt-auto flex pt-2">
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      disabled={
                        transferring ||
                        !transferTargetId ||
                        transferableMembers.length === 0
                      }
                    >
                      <AutoTransition className="inline-flex items-center gap-2">
                        {transferring ? (
                          <span
                            key="transferring"
                            className="inline-flex items-center gap-2"
                          >
                            <Spinner className="size-4" />
                            {copy.settings.transferring}
                          </span>
                        ) : (
                          <span
                            key="transfer"
                            className="inline-flex items-center gap-2"
                          >
                            <RiArrowRightLine className="size-4" />
                            {copy.settings.transfer}
                          </span>
                        )}
                      </AutoTransition>
                    </Button>
                  </AlertDialogTrigger>
                </div>
              </CardContent>
            </Card>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle icon={RiArrowRightLine}>
                  {copy.settings.transferTitle}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {copy.settings.transferConfirm}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={transferring}>
                  <RiCloseLine className="size-4" />
                  <span>{messages.teamSelect.cancel}</span>
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={transferring}
                  onClick={(event) => {
                    event.preventDefault();
                    void handleTransferOwner();
                  }}
                >
                  <AutoTransition className="inline-flex items-center gap-2">
                    {transferring ? (
                      <span
                        key="transferring-dialog"
                        className="inline-flex items-center gap-2"
                      >
                        <Spinner className="size-4" />
                        {copy.settings.transferring}
                      </span>
                    ) : (
                      <span
                        key="confirm-transfer-dialog"
                        className="inline-flex items-center gap-2"
                      >
                        <RiArrowRightLine className="size-4" />
                        {copy.settings.transfer}
                      </span>
                    )}
                  </AutoTransition>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}

        {canAdminister ? (
          <AlertDialog
            open={deleteTeamDialogOpen}
            onOpenChange={(open) => {
              if (deletingTeam) return;
              setDeleteTeamDialogOpen(open);
            }}
          >
            <Card className="h-full border-destructive/40">
              <CardHeader>
                <CardTitle className="inline-flex items-center gap-2">
                  <RiDeleteBinLine className="size-4" />
                  {copy.settings.delete}
                </CardTitle>
                <CardDescription>{copy.settings.deleteConfirm}</CardDescription>
              </CardHeader>
              <CardContent className="flex h-full items-end">
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={savingTeam || deletingTeam}
                  >
                    <AutoTransition className="inline-flex items-center gap-2">
                      {deletingTeam ? (
                        <span
                          key="deleting"
                          className="inline-flex items-center gap-2"
                        >
                          <Spinner className="size-4" />
                          {copy.settings.deleting}
                        </span>
                      ) : (
                        <span
                          key="delete"
                          className="inline-flex items-center gap-2"
                        >
                          <RiDeleteBinLine className="size-4" />
                          {copy.settings.delete}
                        </span>
                      )}
                    </AutoTransition>
                  </Button>
                </AlertDialogTrigger>
              </CardContent>
            </Card>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle icon={RiDeleteBinLine}>
                  {copy.settings.delete}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {copy.settings.deleteConfirm}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deletingTeam}>
                  <RiCloseLine className="size-4" />
                  <span>{messages.teamSelect.cancel}</span>
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={deletingTeam}
                  onClick={(event) => {
                    event.preventDefault();
                    void handleDeleteTeam();
                  }}
                >
                  <AutoTransition className="inline-flex items-center gap-2">
                    {deletingTeam ? (
                      <span
                        key="deleting-dialog"
                        className="inline-flex items-center gap-2"
                      >
                        <Spinner className="size-4" />
                        {copy.settings.deleting}
                      </span>
                    ) : (
                      <span
                        key="confirm-delete-dialog"
                        className="inline-flex items-center gap-2"
                      >
                        <RiDeleteBinLine className="size-4" />
                        {copy.settings.delete}
                      </span>
                    )}
                  </AutoTransition>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </div>
  ) : null;
}
