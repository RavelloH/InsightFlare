import { execSync } from "node:child_process";
import fs from "node:fs/promises";

import YAML from "yaml";

import { rlog } from "./logger";
import { APP_MESSAGES_PATH, LOCALE_PATHS, LOCALES } from "./paths";
import type { JsonLike } from "./types";

function tsKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function toTsInterface(
  obj: JsonLike,
  indent: number = 2,
  path: string[] = [],
): string {
  const currentPath = path.join(".");
  if (
    currentPath === "common.continentLabels" ||
    currentPath === "geo.investigation.typeLabels" ||
    currentPath === "filterBuilder.fieldLabels" ||
    currentPath === "filterBuilder.operatorLabels"
  ) {
    return "Record<string, string>";
  }

  if (Array.isArray(obj)) {
    return "string[]";
  }

  if (obj && typeof obj === "object") {
    const entries = Object.entries(obj);
    if (entries.length === 0) {
      return "Record<string, never>";
    }

    const spaces = " ".repeat(indent);
    const childSpaces = " ".repeat(indent + 2);
    const lines = ["{"];
    for (const [key, value] of entries) {
      const propType = toTsInterface(value, indent + 2, [...path, key]);
      lines.push(`${childSpaces}${tsKey(key)}: ${propType};`);
    }
    lines.push(`${spaces}}`);
    return lines.join("\n");
  }

  return "string";
}

function formatMessagesConst(locale: string, value: unknown): string {
  return `const ${locale}Messages = ${JSON.stringify(value, null, 2)} as AppMessages;`;
}

function buildMessagesOutput(
  parsedYamlByLocale: Record<(typeof LOCALES)[number], unknown>,
): string {
  const interfaceBody = [];
  for (const [key, value] of Object.entries(
    parsedYamlByLocale.en as Record<string, unknown>,
  )) {
    const propType = toTsInterface(value as JsonLike, 2, [key]);
    interfaceBody.push(`  ${tsKey(key)}: ${propType};`);
  }

  return `import type { Locale } from "./config";

export interface AppMessages {
${interfaceBody.join("\n")}
}

${LOCALES.map((locale) => formatMessagesConst(locale, parsedYamlByLocale[locale])).join("\n\n")}

const DICTIONARIES: Record<Locale, AppMessages> = {
${LOCALES.map((locale) => `  ${locale}: ${locale}Messages,`).join("\n")}
};

export function getMessages(locale: Locale): AppMessages {
  return DICTIONARIES[locale];
}
`;
}

function formatMessagesFile(): void {
  execSync(`npx prettier --write ${JSON.stringify(APP_MESSAGES_PATH)}`, {
    stdio: "pipe",
  });
}

export async function regenerateAppMessages(): Promise<void> {
  const parsedYamlByLocale = Object.fromEntries(
    await Promise.all(
      LOCALES.map(async (locale) => [
        locale,
        YAML.parse(await fs.readFile(LOCALE_PATHS[locale], "utf8")),
      ]),
    ),
  ) as Record<(typeof LOCALES)[number], unknown>;

  await fs.writeFile(
    APP_MESSAGES_PATH,
    buildMessagesOutput(parsedYamlByLocale),
    "utf8",
  );
  formatMessagesFile();
  rlog.success("Successfully regenerated messages.ts schema!");
}

export async function pruneUnusedKeys(
  unusedKeysByLocale: Record<string, string[]>,
): Promise<void> {
  rlog.info("\nPruning unused keys from translation files...");

  const textByLocale = Object.fromEntries(
    await Promise.all(
      LOCALES.map(async (locale) => [
        locale,
        await fs.readFile(LOCALE_PATHS[locale], "utf8"),
      ]),
    ),
  ) as Record<(typeof LOCALES)[number], string>;

  const docByLocale = Object.fromEntries(
    LOCALES.map((locale) => [locale, YAML.parseDocument(textByLocale[locale])]),
  );

  const prunedCounts: Record<string, number> = {};
  for (const locale of LOCALES) {
    let pruned = 0;
    for (const key of unusedKeysByLocale[locale] ?? []) {
      docByLocale[locale].deleteIn(key.split("."));
      pruned += 1;
    }
    prunedCounts[locale] = pruned;
  }

  const prunedTextByLocale = Object.fromEntries(
    LOCALES.map((locale) => [locale, docByLocale[locale].toString()]),
  ) as Record<(typeof LOCALES)[number], string>;

  await Promise.all(
    LOCALES.map((locale) =>
      fs.writeFile(LOCALE_PATHS[locale], prunedTextByLocale[locale], "utf8"),
    ),
  );

  rlog.success(
    `Successfully pruned ${LOCALES.map((locale) => `${prunedCounts[locale]} keys from ${locale}.yaml`).join(", ")}!`,
  );

  rlog.info("Regenerating messages.ts schema to match pruned translations...");
  const parsedYamlByLocale = Object.fromEntries(
    LOCALES.map((locale) => [locale, YAML.parse(prunedTextByLocale[locale])]),
  ) as Record<(typeof LOCALES)[number], unknown>;

  await fs.writeFile(
    APP_MESSAGES_PATH,
    buildMessagesOutput(parsedYamlByLocale),
    "utf8",
  );
  formatMessagesFile();
  rlog.success("Successfully regenerated messages.ts schema!");
}
