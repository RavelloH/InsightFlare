import { SUPPORTED_LOCALES } from "@/lib/i18n/config";

export function shouldUseHono(pathname: string): boolean {
  return (
    SUPPORTED_LOCALES.some(
      (locale) =>
        pathname === `/${locale}/widget` ||
        pathname.startsWith(`/${locale}/widget/`),
    ) ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/widget" ||
    pathname.startsWith("/widget/") ||
    pathname === "/__e2e__" ||
    pathname.startsWith("/__e2e__/") ||
    pathname === "/collect" ||
    pathname === "/script.js" ||
    pathname === "/healthz" ||
    pathname === "/notification-email-preview" ||
    pathname.startsWith("/.well-known/")
  );
}
