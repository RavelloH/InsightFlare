import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, DEFAULT_LOCALE, isValidLocale } from "@/lib/i18n/config";

export default async function HomePage(): Promise<never> {
  const cookieStore = await cookies();
  const locale = cookieStore.get(LOCALE_COOKIE)?.value;
  const resolvedLocale = locale && isValidLocale(locale) ? locale : DEFAULT_LOCALE;
  redirect(`/${resolvedLocale}/app`);
}
