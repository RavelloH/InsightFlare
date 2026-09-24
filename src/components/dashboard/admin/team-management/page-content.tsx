import { RiAddLine, RiGlobalLine, RiGroupLine } from "@remixicon/react";

import { PageHeading } from "@/components/dashboard/common/page-heading";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import Link from "@/lib/router";

import { useTeamManagementContext } from "./context";
import { TeamManagementCreateSiteDialog } from "./create-site-dialog";
import {
  TeamManagementMemberDialogs,
  TeamManagementMembersPanel,
} from "./members-panel";
import { TeamManagementSettingsPanel } from "./settings-panel";
import { TeamManagementSitesPanel } from "./sites-panel";
export function TeamManagementPageContent() {
  const {
    activeTeam,
    canManage,
    canManageSites,
    copy,
    currentTeamName,
    isPageDataLoading,
    locale,
    memberCount,
    panelSubtitle,
    panelTitle,
    setCreateSiteDialogOpen,
    setCreateSiteDomain,
    setCreateSiteError,
    setCreateSiteName,
    setCreateSitePublicSlug,
    siteCount,
    siteCreateCopy,
  } = useTeamManagementContext();
  const { activeTab } = useTeamManagementContext();
  return (
    <div className="space-y-6">
      <TeamManagementMemberDialogs />
      <PageHeading
        title={`${panelTitle} · ${currentTeamName}`}
        subtitle={panelSubtitle}
        actions={
          canManage ? (
            <>
              <Button variant="outline" asChild>
                <Link href={`/${locale}/app/${activeTeam.slug}/manage/sites`}>
                  <RiGlobalLine />
                  <span className="inline-flex items-center gap-1.5">
                    {copy.stats.sites}:
                    <AutoResizer
                      initial
                      animateWidth
                      animateHeight={false}
                      className="inline-flex items-center"
                    >
                      <AutoTransition
                        initial
                        className="inline-flex items-center"
                      >
                        {isPageDataLoading ? (
                          <span
                            key="sites-loading"
                            className="inline-flex items-center"
                          >
                            <Spinner className="size-3.5" />
                          </span>
                        ) : (
                          <span key="sites-value">{siteCount}</span>
                        )}
                      </AutoTransition>
                    </AutoResizer>
                  </span>
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/${locale}/app/${activeTeam.slug}/members`}>
                  <RiGroupLine />
                  <span className="inline-flex items-center gap-1.5">
                    {copy.stats.members}:
                    <AutoResizer
                      initial
                      animateWidth
                      animateHeight={false}
                      className="inline-flex items-center"
                    >
                      <AutoTransition
                        initial
                        className="inline-flex items-center"
                      >
                        {isPageDataLoading ? (
                          <span
                            key="members-loading"
                            className="inline-flex items-center"
                          >
                            <Spinner className="size-3.5" />
                          </span>
                        ) : (
                          <span key="members-value">{memberCount}</span>
                        )}
                      </AutoTransition>
                    </AutoResizer>
                  </span>
                </Link>
              </Button>
              {activeTab === "sites" && canManageSites ? (
                <Button
                  type="button"
                  onClick={() => {
                    setCreateSiteName("");
                    setCreateSiteDomain("");
                    setCreateSitePublicSlug("");
                    setCreateSiteError("");
                    setCreateSiteDialogOpen(true);
                  }}
                >
                  <RiAddLine />
                  <span>{siteCreateCopy.create}</span>
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <TeamManagementCreateSiteDialog />
      <div className="space-y-4">
        {activeTab === "sites" ? <TeamManagementSitesPanel /> : null}
        {activeTab === "settings" ? <TeamManagementSettingsPanel /> : null}
        {activeTab === "members" ? <TeamManagementMembersPanel /> : null}
      </div>
    </div>
  );
}
