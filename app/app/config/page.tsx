import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, DEFAULT_LOCALE, isValidLocale } from "@/lib/i18n/config";

export default async function ConfigShim({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieStore = await cookies();
  const locale = cookieStore.get(LOCALE_COOKIE)?.value;
  const resolvedLocale = locale && isValidLocale(locale) ? locale : DEFAULT_LOCALE;
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === "string") qs.set(key, val);
  }
  const search = qs.toString();
  redirect(`/${resolvedLocale}/app/settings${search ? `?${search}` : ""}`);
}
