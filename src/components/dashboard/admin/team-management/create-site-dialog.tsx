import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@insightflare/ui/dialog";
import { Input } from "@insightflare/ui/input";
import { Label } from "@insightflare/ui/label";
import { Spinner } from "@insightflare/ui/spinner";
import { RiAddLine, RiCloseLine, RiGlobalLine } from "@remixicon/react";

import { useTeamManagementContext } from "./context";
export function TeamManagementCreateSiteDialog() {
  const {
    createSiteDialogOpen,
    createSiteDomain,
    createSiteError,
    createSiteName,
    createSitePublicSlug,
    creatingSite,
    handleCreateSite,
    messages,
    setCreateSiteDialogOpen,
    setCreateSiteDomain,
    setCreateSiteError,
    setCreateSiteName,
    setCreateSitePublicSlug,
    siteCreateCopy,
  } = useTeamManagementContext();

  return (
    <Dialog
      open={createSiteDialogOpen}
      onOpenChange={(next) => {
        if (!next && creatingSite) return;
        setCreateSiteDialogOpen(next);
        if (!next) {
          setCreateSiteError("");
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle icon={RiGlobalLine}>
            {siteCreateCopy.createTitle}
          </DialogTitle>
          <DialogDescription>{siteCreateCopy.createSubtitle}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateSite();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="team-dashboard-create-site-name">
              {siteCreateCopy.name}
            </Label>
            <Input
              id="team-dashboard-create-site-name"
              value={createSiteName}
              onChange={(event) => setCreateSiteName(event.target.value)}
              minLength={2}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="team-dashboard-create-site-domain">
              {siteCreateCopy.domain}
            </Label>
            <Input
              id="team-dashboard-create-site-domain"
              value={createSiteDomain}
              onChange={(event) => setCreateSiteDomain(event.target.value)}
              minLength={3}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="team-dashboard-create-site-public-slug">
              {siteCreateCopy.publicSlug}
            </Label>
            <Input
              id="team-dashboard-create-site-public-slug"
              value={createSitePublicSlug}
              onChange={(event) => setCreateSitePublicSlug(event.target.value)}
            />
          </div>

          {createSiteError ? (
            <p className="text-xs text-destructive">{createSiteError}</p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateSiteDialogOpen(false)}
              disabled={creatingSite}
            >
              <RiCloseLine data-icon="inline-start" />
              <span>{messages.teamSelect.cancel}</span>
            </Button>
            <Button type="submit" disabled={creatingSite}>
              <AutoTransition className="inline-flex items-center gap-[var(--button-content-gap)]">
                {creatingSite ? (
                  <span
                    key="creating-site"
                    className="inline-flex items-center gap-[var(--button-content-gap)]"
                  >
                    <Spinner data-icon="inline-start" />
                    {siteCreateCopy.creating}
                  </span>
                ) : (
                  <span
                    key="create-site"
                    className="inline-flex items-center gap-[var(--button-content-gap)]"
                  >
                    <RiAddLine data-icon="inline-start" />
                    {siteCreateCopy.create}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
