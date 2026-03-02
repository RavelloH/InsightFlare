import { redirect } from "next/navigation";
import { isValidLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import type { Locale } from "@/lib/i18n/config";

export default async function TeamMembersPage({
  params,
}: {
  params: Promise<{ locale: string; teamId: string }>;
}) {
  const { locale: rawLocale, teamId } = await params;
  const locale: Locale = isValidLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  redirect(`/${locale}/app/${teamId}/settings`);
}
