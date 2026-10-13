import path from "node:path";
import process from "node:process";

export const ROOT_DIR = process.cwd();
export const SRC_DIR = path.join(ROOT_DIR, "src");
export const SCRIPTS_DIR = path.join(ROOT_DIR, "scripts");
export const LOCALES = ["en", "zh", "zh-tw", "ja"] as const;
export type LocaleCode = (typeof LOCALES)[number];
export const LOCALE_PATHS = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    path.join(SRC_DIR, "i18n", `${locale}.yaml`),
  ]),
) as Record<LocaleCode, string>;
export const EN_PATH = LOCALE_PATHS.en;
export const TSCONFIG_PATH = path.join(ROOT_DIR, "tsconfig.json");
export const APP_MESSAGES_PATH = path.join(
  SRC_DIR,
  "lib",
  "i18n",
  "messages.ts",
);

export function asPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

export function relativeFromRoot(input: string): string {
  return asPosix(path.relative(ROOT_DIR, input));
}

export function joinPath(parts: string[]): string {
  return parts.join(".");
}

export function isRelevantSourceFile(filePath: string): boolean {
  const normalized = asPosix(filePath);
  if (normalized.includes("/node_modules/")) return false;
  return (
    normalized.startsWith(asPosix(SRC_DIR)) ||
    normalized.startsWith(asPosix(SCRIPTS_DIR))
  );
}
