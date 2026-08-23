import type { Locale } from "@/lib/i18n/config";

export function sharePath(locale: Locale, slug: string, section?: string) {
  const base = `/${locale}/share/${encodeURIComponent(slug)}`;
  return section ? `${base}/${section}` : base;
}
