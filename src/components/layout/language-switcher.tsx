"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RiTranslate2 as Languages } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface LanguageSwitcherProps {
  locale: string;
}

export function LanguageSwitcher({ locale }: LanguageSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function switchTo(newLocale: string) {
    const newPath = pathname.replace(new RegExp(`^/${locale}(?=/|$)`), `/${newLocale}`);
    const query = searchParams.toString();
    document.cookie = `if_locale=${newLocale};path=/;max-age=31536000`;
    router.replace(query ? `${newPath}?${query}` : newPath);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <Languages className="h-4 w-4" />
          <span className="sr-only">Switch language</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => switchTo("en")} className={locale === "en" ? "bg-accent" : ""}>
          English
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => switchTo("zh")} className={locale === "zh" ? "bg-accent" : ""}>
          中文
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
