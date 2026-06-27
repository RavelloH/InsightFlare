"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  RiArrowDownSLine,
  RiComputerLine,
  RiGlobalLine,
  RiMoonLine,
  RiSunLine,
} from "@remixicon/react";

import { DashboardHeaderControls } from "@/components/dashboard/dashboard-header-controls";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface ShareHeaderProps {
  locale: Locale;
  messages: AppMessages;
  publicSiteId: string;
  siteName: string;
}

function localeSwitchPath(pathname: string, locale: Locale): string {
  const withoutLocale = pathname.replace(/^\/(en|zh)(?=\/|$)/, "") || "/";
  return `/${locale}${withoutLocale}`;
}

function pickThemeIcon(theme: string) {
  if (theme === "dark") return RiMoonLine;
  if (theme === "light") return RiSunLine;
  return RiComputerLine;
}

export function ShareHeader({
  locale,
  messages,
  publicSiteId,
  siteName,
}: ShareHeaderProps) {
  const pathname = usePathname() || `/${locale}`;
  const router = useRouter();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const themeValue =
    theme === "light" || theme === "dark" || theme === "system"
      ? theme
      : "system";
  const currentTheme = resolvedTheme === "dark" ? "dark" : "light";
  const ThemeIcon = pickThemeIcon(
    themeValue === "system" ? currentTheme : themeValue,
  );
  const [themeDrawerOpen, setThemeDrawerOpen] = useState(false);
  const [languageDrawerOpen, setLanguageDrawerOpen] = useState(false);
  const switchLocale = (nextLocale: Locale) => {
    if (nextLocale !== locale) {
      router.push(localeSwitchPath(pathname, nextLocale));
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem className="shrink-0">
              <BreadcrumbLink asChild>
                <Link
                  href="https://github.com/RavelloH/InsightFlare"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-foreground transition-colors hover:text-primary"
                >
                  <Image
                    src="/android-chrome-192x192.png"
                    alt="InsightFlare"
                    width={192}
                    height={192}
                    className="size-6 shrink-0"
                    priority
                  />
                  <span className="hidden max-w-[24vw] truncate text-sm font-semibold md:block xl:max-w-none">
                    <span className="text-primary">InsightFlare</span>{" "}
                    <span className="text-muted-foreground">V1</span>
                  </span>
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>

            <BreadcrumbSeparator className="shrink-0" />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="block max-w-full truncate text-sm">
                {siteName}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-2">
        <Drawer open={themeDrawerOpen} onOpenChange={setThemeDrawerOpen}>
          <DrawerTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="inline-flex bg-background xl:hidden"
              aria-label={messages.common.theme}
            >
              <ThemeIcon className="size-4 text-muted-foreground" />
            </Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>{messages.common.theme}</DrawerTitle>
            </DrawerHeader>
            <div className="grid gap-2 px-4 pb-4">
              <DrawerClose asChild>
                <Button
                  type="button"
                  variant={themeValue === "light" ? "default" : "outline"}
                  className="justify-start gap-2"
                  onClick={() => setTheme("light")}
                >
                  <RiSunLine className="size-4" />
                  {messages.actions.switchToLight}
                </Button>
              </DrawerClose>
              <DrawerClose asChild>
                <Button
                  type="button"
                  variant={themeValue === "dark" ? "default" : "outline"}
                  className="justify-start gap-2"
                  onClick={() => setTheme("dark")}
                >
                  <RiMoonLine className="size-4" />
                  {messages.actions.switchToDark}
                </Button>
              </DrawerClose>
              <DrawerClose asChild>
                <Button
                  type="button"
                  variant={themeValue === "system" ? "default" : "outline"}
                  className="justify-start gap-2"
                  onClick={() => setTheme("system")}
                >
                  <RiComputerLine className="size-4" />
                  {messages.common.system}
                </Button>
              </DrawerClose>
            </div>
          </DrawerContent>
        </Drawer>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="hidden gap-2 bg-background xl:inline-flex"
              aria-label={messages.common.theme}
            >
              <ThemeIcon className="size-4 text-muted-foreground" />
              <span>{messages.common.theme}</span>
              <RiArrowDownSLine
                className="size-4 text-muted-foreground"
                data-icon="inline-end"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuLabel>{messages.common.theme}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={themeValue}
              onValueChange={(value) => {
                if (
                  value === "light" ||
                  value === "dark" ||
                  value === "system"
                ) {
                  setTheme(value);
                }
              }}
            >
              <DropdownMenuRadioItem value="light">
                <RiSunLine className="size-4 text-muted-foreground" />
                {messages.actions.switchToLight}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <RiMoonLine className="size-4 text-muted-foreground" />
                {messages.actions.switchToDark}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <RiComputerLine className="size-4 text-muted-foreground" />
                {messages.common.system}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Drawer open={languageDrawerOpen} onOpenChange={setLanguageDrawerOpen}>
          <DrawerTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="inline-flex bg-background xl:hidden"
              aria-label={messages.common.language}
            >
              <RiGlobalLine className="size-4 text-muted-foreground" />
            </Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>{messages.common.language}</DrawerTitle>
            </DrawerHeader>
            <div className="grid gap-2 px-4 pb-4">
              <DrawerClose asChild>
                <Button
                  type="button"
                  variant={locale === "en" ? "default" : "outline"}
                  className="justify-start"
                  onClick={() => switchLocale("en")}
                >
                  {messages.actions.switchToEnglish}
                </Button>
              </DrawerClose>
              <DrawerClose asChild>
                <Button
                  type="button"
                  variant={locale === "zh" ? "default" : "outline"}
                  className="justify-start"
                  onClick={() => switchLocale("zh")}
                >
                  {messages.actions.switchToChinese}
                </Button>
              </DrawerClose>
            </div>
          </DrawerContent>
        </Drawer>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="hidden gap-2 bg-background xl:inline-flex"
              aria-label={messages.common.language}
            >
              <RiGlobalLine className="size-4 text-muted-foreground" />
              <span>{messages.common.language}</span>
              <RiArrowDownSLine
                className="size-4 text-muted-foreground"
                data-icon="inline-end"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuLabel>{messages.common.language}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={locale}
              onValueChange={(value) => {
                const nextLocale = value === "zh" ? "zh" : "en";
                switchLocale(nextLocale);
              }}
            >
              <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="zh">中文</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="shrink-0 [&>div]:flex-nowrap [&_button]:shrink-0">
          <DashboardHeaderControls
            locale={locale}
            messages={messages}
            siteId={publicSiteId}
            showControls
            showFilterSheet
            showRealtimeBadge={false}
          />
        </div>
      </div>
    </div>
  );
}
