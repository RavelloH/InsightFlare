export const BROWSER_ENGINE_BLINK_TOKENS = [
  "chrome",
  "chromium",
  "edge",
  "edg",
  "opera",
  "opr",
  "brave",
  "vivaldi",
  "arc",
  "samsung internet",
  "webview",
  "yandex",
  "uc browser",
  "duckduckgo",
  "whale",
  "qqbrowser",
  "miui browser",
  "coc coc",
] as const;

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function includesAny(value: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => value.includes(token));
}

export function browserEngineLabel(browser: string, os?: string): string {
  const normalizedBrowser = normalizeValue(browser);
  const normalizedOs = normalizeValue(os ?? "");

  if (!normalizedBrowser) return "";
  if (
    normalizedBrowser.includes("internet explorer") ||
    normalizedBrowser === "ie" ||
    normalizedBrowser.includes("trident")
  ) {
    return "Trident";
  }
  if (normalizedOs.includes("ios")) {
    return "WebKit";
  }
  if (
    normalizedBrowser.includes("opera mini") ||
    normalizedBrowser.includes("presto")
  ) {
    return "Presto";
  }
  if (
    normalizedBrowser.includes("firefox") ||
    normalizedBrowser.includes("gecko")
  ) {
    return "Gecko";
  }
  if (includesAny(normalizedBrowser, BROWSER_ENGINE_BLINK_TOKENS)) {
    return "Blink";
  }
  if (
    normalizedBrowser.includes("safari") ||
    normalizedBrowser.includes("webkit")
  ) {
    return "WebKit";
  }
  return "";
}

export function browserEngineCaseSql(
  browserColumn: string,
  osColumn?: string,
): string {
  const normalizedBrowser = `LOWER(TRIM(COALESCE(${browserColumn}, '')))`;
  const normalizedOs = osColumn
    ? `LOWER(TRIM(COALESCE(${osColumn}, '')))`
    : "''";
  const blinkCondition = BROWSER_ENGINE_BLINK_TOKENS.map(
    (token) => `${normalizedBrowser} LIKE '%${token}%'`,
  ).join(" OR ");

  return `CASE
    WHEN ${normalizedBrowser} = '' THEN ''
    WHEN ${normalizedBrowser} LIKE '%internet explorer%' OR ${normalizedBrowser} = 'ie' OR ${normalizedBrowser} LIKE '%trident%' THEN 'Trident'
    WHEN ${normalizedOs} LIKE '%ios%' THEN 'WebKit'
    WHEN ${normalizedBrowser} LIKE '%opera mini%' OR ${normalizedBrowser} LIKE '%presto%' THEN 'Presto'
    WHEN ${normalizedBrowser} LIKE '%firefox%' OR ${normalizedBrowser} LIKE '%gecko%' THEN 'Gecko'
    WHEN ${blinkCondition} THEN 'Blink'
    WHEN ${normalizedBrowser} LIKE '%safari%' OR ${normalizedBrowser} LIKE '%webkit%' THEN 'WebKit'
    ELSE ''
  END`;
}
