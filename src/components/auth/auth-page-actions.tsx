import {
  RiArrowDownSLine,
  RiCheckLine,
  RiComputerLine,
  RiGlobalLine,
  RiMoonLine,
  RiSunLine,
} from "@remixicon/react";

import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Locale, SUPPORTED_LOCALES } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";

interface AuthPageActionsProps {
  locale: Locale;
  messages: AppMessages;
  buildHref: (locale: Locale) => string;
}

function localeLabel(messages: AppMessages, locale: Locale): string {
  if (locale === "zh") return messages.actions.switchToChinese;
  if (locale === "ja") return messages.actions.switchToJapanese;
  return messages.actions.switchToEnglish;
}

function pickThemeIcon(theme: string) {
  if (theme === "dark") return RiMoonLine;
  if (theme === "light") return RiSunLine;
  return RiComputerLine;
}

export function AuthPageActions({
  locale,
  messages,
  buildHref,
}: AuthPageActionsProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const themeValue =
    theme === "light" || theme === "dark" || theme === "system"
      ? theme
      : "system";
  const currentTheme = resolvedTheme === "dark" ? "dark" : "light";
  const ThemeIcon = pickThemeIcon(
    themeValue === "system" ? currentTheme : themeValue,
  );

  const themeOptions: ReadonlyArray<{
    value: "light" | "dark" | "system";
    icon: typeof RiSunLine;
    label: string;
  }> = [
    { value: "light", icon: RiSunLine, label: messages.actions.switchToLight },
    { value: "dark", icon: RiMoonLine, label: messages.actions.switchToDark },
    { value: "system", icon: RiComputerLine, label: messages.common.system },
  ];

  return (
    <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="inline-flex gap-2 bg-background"
            aria-label={messages.common.theme}
          >
            <ThemeIcon className="size-4 text-muted-foreground" />
            <span>{messages.common.theme}</span>
            <RiArrowDownSLine className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuLabel>{messages.common.theme}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={themeValue}
            onValueChange={(value) => {
              if (value === "light" || value === "dark" || value === "system") {
                setTheme(value);
              }
            }}
          >
            {themeOptions.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <option.icon className="size-4 text-muted-foreground" />
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="inline-flex gap-2 bg-background"
            aria-label={messages.common.language}
          >
            <RiGlobalLine className="size-4 text-muted-foreground" />
            <span>{messages.common.language}</span>
            <RiArrowDownSLine className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuLabel>{messages.common.language}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {SUPPORTED_LOCALES.map((item) => (
            <DropdownMenuItem key={item} asChild>
              <Link href={buildHref(item)}>
                <span className="inline-flex w-4 justify-center">
                  {locale === item ? <RiCheckLine className="size-4" /> : null}
                </span>
                <span>{localeLabel(messages, item)}</span>
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
