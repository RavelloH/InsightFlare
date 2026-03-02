import { SUPPORTED_LOCALES, DEFAULT_LOCALE, LOCALE_COOKIE, isValidLocale } from "./config";
import type { Locale } from "./config";

export function getLocaleFromHeaders(
  cookies: { get: (name: string) => { value: string } | undefined },
  acceptLanguage: string | null,
): Locale {
  const cookieValue = cookies.get(LOCALE_COOKIE)?.value;
  if (cookieValue && isValidLocale(cookieValue)) {
    return cookieValue;
  }

  if (acceptLanguage) {
    const preferred = acceptLanguage
      .split(",")
      .map((part) => {
        const [lang] = part.trim().split(";");
        return lang.trim().toLowerCase().slice(0, 2);
      })
      .find((code) => isValidLocale(code));
    if (preferred) {
      return preferred as Locale;
    }
  }

  return DEFAULT_LOCALE;
}

export function extractLocaleFromPathname(pathname: string): { locale: Locale | null; rest: string } {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length > 0 && isValidLocale(segments[0])) {
    return {
      locale: segments[0] as Locale,
      rest: "/" + segments.slice(1).join("/"),
    };
  }
  return { locale: null, rest: pathname };
}

export { SUPPORTED_LOCALES, DEFAULT_LOCALE, LOCALE_COOKIE };
