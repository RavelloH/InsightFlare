import { getSession } from "@/lib/auth";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { TopHeader } from "@/components/layout/top-header";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { CommandPalette } from "@/components/layout/command-palette";
import { SidebarProvider } from "@/components/layout/sidebar-context";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const session = await getSession();

  if (!session) {
    // Auth redirect is centralized in middleware.
    throw new Error("missing_session_in_protected_layout");
  }

  const dictionary = await getDictionary(locale);

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar locale={locale} session={session} />
        <div className="flex flex-1 flex-col">
          <TopHeader locale={locale} session={session} />
          <main className="flex-1 overflow-auto p-4 pb-20 md:p-6 md:pb-6">
            {children}
          </main>
        </div>
        <MobileBottomNav locale={locale} />
        <CommandPalette locale={locale} dictionary={dictionary} />
      </div>
    </SidebarProvider>
  );
}
