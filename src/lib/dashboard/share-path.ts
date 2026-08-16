import type { Locale } from "@/lib/i18n/config";
export function sharePath(_locale: Locale, slug: string, section?: string) {
  const base = `/share/${encodeURIComponent(slug)}`;
  return section ? `${base}/${section}` : base;
}
