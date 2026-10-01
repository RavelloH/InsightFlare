import { useMemo, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@insightflare/ui/breadcrumb";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
} from "@insightflare/ui/sidebar";
import { VerticalScrollMask } from "@insightflare/ui/vertical-scroll-mask";
import {
  type RemixiconComponentType,
  RiAlarmWarningLine,
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiBankCardLine,
  RiBarChart2Line,
  RiCalendarLine,
  RiChat1Line,
  RiChatQuoteLine,
  RiCheckboxLine,
  RiCursorLine,
  RiEqualizerLine,
  RiExpandDiagonalLine,
  RiFileList3Line,
  RiFlowChart,
  RiHashtag,
  RiInputMethodLine,
  RiLayoutColumnLine,
  RiLayoutGridLine,
  RiLoader4Line,
  RiMore2Line,
  RiNotification3Line,
  RiPieChart2Line,
  RiPriceTag3Line,
  RiPulseLine,
  RiQuestionLine,
  RiRadioButtonLine,
  RiRectangleLine,
  RiRepeatLine,
  RiRouteLine,
  RiScrollToBottomLine,
  RiSeparator,
  RiSideBarLine,
  RiSmartphoneLine,
  RiStackLine,
  RiTableLine,
  RiTargetLine,
  RiToggleLine,
} from "@remixicon/react";
import { Outlet, useLocation } from "@tanstack/react-router";

import { AppShellLayout } from "@/components/app-shell-layout";
import { AppSidebarBrand } from "@/components/app-sidebar-brand";
import { SidebarAppearanceMenus } from "@/components/sidebar-appearance-menus";
import {
  getUiGalleryCategoryLabel,
  getUiGalleryCopy,
} from "@/components/ui-gallery/copy";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";

import { listUiGalleryCategories, uiGalleryRegistry } from "./registry";

const uiEntryIcons: Record<string, RemixiconComponentType> = {
  button: RiRectangleLine,
  "button-group": RiLayoutGridLine,
  badge: RiPriceTag3Line,
  calendar: RiCalendarLine,
  checkbox: RiCheckboxLine,
  clickable: RiCursorLine,
  field: RiInputMethodLine,
  input: RiInputMethodLine,
  label: RiPriceTag3Line,
  "radio-group": RiRadioButtonLine,
  separator: RiSeparator,
  skeleton: RiLoader4Line,
  slider: RiEqualizerLine,
  spinner: RiLoader4Line,
  switch: RiToggleLine,
  tabs: RiLayoutColumnLine,
  breadcrumb: RiRouteLine,
  chart: RiBarChart2Line,
  select: RiArrowDownSLine,
  dialog: RiChat1Line,
  popover: RiChatQuoteLine,
  tooltip: RiQuestionLine,
  drawer: RiSideBarLine,
  "alert-dialog": RiAlarmWarningLine,
  "dropdown-menu": RiMore2Line,
  "responsive-dialog": RiSmartphoneLine,
  sheet: RiFileList3Line,
  table: RiTableLine,
  card: RiBankCardLine,
  sidebar: RiSideBarLine,
  "animated-number": RiHashtag,
  "app-overlay": RiStackLine,
  "auto-resizer": RiExpandDiagonalLine,
  "auto-transition": RiRepeatLine,
  "overlay-scrollbar": RiScrollToBottomLine,
  sonner: RiNotification3Line,
  "vertical-scroll-mask": RiScrollToBottomLine,
  "goal-visualization": RiTargetLine,
  funnel: RiFlowChart,
  "realtime-traffic-trend": RiPulseLine,
  sharing: RiPieChart2Line,
  "tabbed-table": RiTableLine,
};
const uiGalleryCategories = listUiGalleryCategories();

export function UiGalleryShell() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const locale = resolveLocale(pathname.split("/")[1]);
  const localePath = pathname.replace(/^\/[^/]+/, "");
  const switchToEn = "/en" + localePath;
  const switchToZh = "/zh" + localePath;
  const switchToJa = "/ja" + localePath;
  const messages = getMessages(locale);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const categories = uiGalleryCategories;
  const filteredByCategory = useMemo(
    () =>
      new Map(
        categories.map((category) => [
          category,
          uiGalleryRegistry.filter((entry) => {
            const { contract } = entry;
            const copy = getUiGalleryCopy(entry, locale);
            const matchesCategory = contract.categoryId === category;
            const matchesSearch =
              normalizedQuery.length === 0 ||
              (copy.title + " " + copy.category + " " + contract.id)
                .toLocaleLowerCase()
                .includes(normalizedQuery);
            return matchesCategory && matchesSearch;
          }),
        ]),
      ),
    [categories, locale, normalizedQuery],
  );
  const visibleCount = [...filteredByCategory.values()].reduce(
    (total, entries) => total + entries.length,
    0,
  );
  const currentSlug = pathname.split("/ui/")[1];
  const currentEntry = uiGalleryRegistry.find(
    ({ slug }) => slug === currentSlug,
  );
  const galleryMessages = messages.uiGallery;
  const currentTitle = currentEntry
    ? getUiGalleryCopy(currentEntry, locale).title
    : galleryMessages.pageTitle;

  return (
    <AppShellLayout
      sidebar={
        <Sidebar variant="inset" collapsible="icon">
          <SidebarHeader>
            <AppSidebarBrand
              href={"/" + locale + "/ui"}
              appName="InsightFlare"
              suffix="UI"
            />
            <label className="group-data-[collapsible=icon]:hidden relative block px-2 pb-2">
              <SidebarInput
                aria-label={galleryMessages.searchLabel}
                placeholder={galleryMessages.searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          </SidebarHeader>
          <div className="shrink-0">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu className="mb-2">
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link href={"/" + locale + "/app"}>
                        <RiArrowLeftLine />
                        <span>{galleryMessages.backToApp}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={!currentEntry}>
                      <Link href={"/" + locale + "/ui"}>
                        <RiLayoutGridLine
                          className="size-4 shrink-0"
                          aria-hidden
                        />
                        <span>{galleryMessages.library}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator className="!mx-2 !w-auto group-data-[collapsible=icon]:hidden" />
          </div>
          <VerticalScrollMask
            className="min-h-0 flex-1"
            maskClassName="from-sidebar via-sidebar/80 to-transparent"
          >
            <SidebarContent className="overflow-visible">
              {categories.map((category) => {
                const entries = filteredByCategory.get(category) ?? [];
                if (entries.length === 0) return null;

                return (
                  <SidebarGroup key={category}>
                    <SidebarGroupLabel>
                      {getUiGalleryCategoryLabel(category, locale)}
                    </SidebarGroupLabel>
                    <SidebarMenu>
                      {entries.map((entry) => {
                        const { slug } = entry;
                        const active = currentSlug === slug;
                        const Icon = uiEntryIcons[slug] ?? RiLayoutGridLine;
                        const copy = getUiGalleryCopy(entry, locale);
                        return (
                          <SidebarMenuItem key={slug}>
                            <SidebarMenuButton asChild isActive={active}>
                              <Link href={"/" + locale + "/ui/" + slug}>
                                <Icon className="size-4 shrink-0" aria-hidden />
                                <span>{copy.title}</span>
                              </Link>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroup>
                );
              })}
              {visibleCount === 0 ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  {galleryMessages.noSearchResults}
                </p>
              ) : null}
            </SidebarContent>
          </VerticalScrollMask>
          <SidebarFooter className="!m-0 !gap-0 !p-0">
            <SidebarAppearanceMenus
              locale={locale}
              switchToEn={switchToEn}
              switchToZh={switchToZh}
              switchToJa={switchToJa}
              messages={messages}
            />
          </SidebarFooter>
        </Sidebar>
      }
      header={
        <div className="p-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger aria-label={galleryMessages.toggleNavigation} />
            <div className="min-w-0 flex-1">
              <Breadcrumb className="md:hidden">
                <BreadcrumbList className="flex-nowrap">
                  <BreadcrumbItem className="min-w-0">
                    {currentEntry ? (
                      <BreadcrumbLink asChild>
                        <Link href={"/" + locale + "/ui"}>
                          {galleryMessages.library}
                        </Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>{galleryMessages.library}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                  {currentEntry ? (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem className="min-w-0">
                        <BreadcrumbPage className="block truncate">
                          {currentTitle}
                        </BreadcrumbPage>
                      </BreadcrumbItem>
                    </>
                  ) : null}
                </BreadcrumbList>
              </Breadcrumb>
              <Breadcrumb className="hidden md:block">
                <BreadcrumbList className="flex-nowrap">
                  <BreadcrumbItem className="min-w-0">
                    {currentEntry ? (
                      <BreadcrumbLink asChild>
                        <Link href={"/" + locale + "/ui"}>
                          {galleryMessages.library}
                        </Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>{galleryMessages.library}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                  {currentEntry ? (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem className="min-w-0">
                        <BreadcrumbPage className="block truncate">
                          {getUiGalleryCopy(currentEntry, locale).title}
                        </BreadcrumbPage>
                      </BreadcrumbItem>
                    </>
                  ) : null}
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          </div>
        </div>
      }
      contentAs="main"
      contentClassName="mx-auto min-w-0 w-full max-w-[1400px] flex-1 p-4 md:p-6"
      contentDataAttributes={{ "data-ui-gallery-content": "" }}
    >
      <Outlet />
    </AppShellLayout>
  );
}
