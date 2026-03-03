import { redirect } from "next/navigation";
import { resolveLocale } from "@/lib/i18n/config";

interface LocalePageProps {
  params: Promise<{ locale: string }>;
}

export default async function LocalePage({ params }: LocalePageProps) {
  const { locale } = await params;
  const resolved = resolveLocale(locale);
  redirect(`/${resolved}/app`);
}
