import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import * as prettier from "prettier";
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

function localeVar(locale: string): string {
  return locale.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "Messages";
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

  return `// @generated from src/i18n/*.yaml. DO NOT EDIT. Edit the YAML source files instead.
import type { Locale } from "../config";
${LOCALES.map((locale) => "import " + localeVar(locale) + " from " + JSON.stringify("./locale-" + locale) + ";").join("\n")}

export interface AppMessages {
${interfaceBody.join("\n")}
}


const DICTIONARIES: Record<Locale, AppMessages> = {
${LOCALES.map((locale) => `  ${tsKey(locale)}: ${localeVar(locale)},`).join("\n")}
};

export function getMessages(locale: Locale): AppMessages {
  return DICTIONARIES[locale];
}
`;
}

async function writeMessagesFile(
  source: string,
  target = APP_MESSAGES_PATH,
): Promise<void> {
  const prettierOptions = await prettier.resolveConfig(target);
  const formatted = await prettier.format(source, {
    ...(prettierOptions ?? {}),
    filepath: target,
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    if ((await fs.readFile(target, "utf8")) === formatted) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Never expose a partially generated file to a parallel typecheck or watcher.
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, formatted, "utf8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writeAllMessages(
  parsedYamlByLocale: Record<(typeof LOCALES)[number], unknown>,
): Promise<void> {
  const directory = path.dirname(APP_MESSAGES_PATH);
  const header = "// @generated from src/i18n/*.yaml. DO NOT EDIT.\n";
  await Promise.all([
    ...LOCALES.map((locale) =>
      writeMessagesFile(
        header +
          'import type { AppMessages } from "./messages";\n' +
          "export default " +
          JSON.stringify(parsedYamlByLocale[locale], null, 2) +
          " as AppMessages;\n",
        path.join(directory, "locale-" + locale + ".ts"),
      ),
    ),
    ...(["errorPage", "notificationEmail"] as const).map((section) =>
      writeMessagesFile(
        header +
          'import type { Locale } from "../config";\nimport type { AppMessages } from "./messages";\n' +
          "export default " +
          JSON.stringify(
            Object.fromEntries(
              LOCALES.map((locale) => [
                locale,
                (parsedYamlByLocale[locale] as Record<string, unknown>)[
                  section
                ],
              ]),
            ),
            null,
            2,
          ) +
          " as Record<Locale, AppMessages[" +
          JSON.stringify(section) +
          "]>;\n",
        path.join(
          directory,
          section === "errorPage" ? "error-pages.ts" : "notification-email.ts",
        ),
      ),
    ),
  ]);
  await writeMessagesFile(buildMessagesOutput(parsedYamlByLocale));
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

  await writeAllMessages(parsedYamlByLocale);
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

  await writeAllMessages(parsedYamlByLocale);
  rlog.success("Successfully regenerated messages.ts schema!");
}
