import process from "node:process";

import ts from "typescript";

import { getAppMessagesType } from "./app-messages";
import {
  compareNodeShapes,
  comparePlaceholders,
  findUnusedLeaves,
  findUsedButMissing,
  formatUsageRefs,
} from "./diagnostics";
import { rlog } from "./logger";
import { LOCALE_PATHS, LOCALES, TSCONFIG_PATH } from "./paths";
import { pruneUnusedKeys, regenerateAppMessages } from "./prune";
import type { NodeInfo } from "./types";
import { collectTypePaths, parseTsConfig } from "./typescript";
import { collectUsedKeys } from "./usage-scanner";
import { collectNodes, readYaml } from "./yaml";

export async function runCli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  await regenerateAppMessages();
  rlog.info(
    `Loading translation files (${LOCALES.map((locale) => `${locale}.yaml`).join(", ")})...`,
  );
  const yamlByLocale = Object.fromEntries(
    await Promise.all(
      LOCALES.map(
        async (locale) =>
          [locale, await readYaml(LOCALE_PATHS[locale])] as const,
      ),
    ),
  );

  rlog.info("Parsing translation keys and building tree maps...");
  const nodesByLocale = Object.fromEntries(
    LOCALES.map((locale) => [locale, new Map<string, NodeInfo>()]),
  ) as Record<(typeof LOCALES)[number], Map<string, NodeInfo>>;
  const leavesByLocale = Object.fromEntries(
    LOCALES.map((locale) => [locale, new Map<string, string>()]),
  ) as Record<(typeof LOCALES)[number], Map<string, string>>;
  for (const locale of LOCALES) {
    collectNodes(
      yamlByLocale[locale],
      [],
      nodesByLocale[locale],
      leavesByLocale[locale],
    );
  }
  const enNodes = nodesByLocale.en;
  const enLeaves = leavesByLocale.en;

  rlog.info("Parsing tsconfig.json...");
  const config = parseTsConfig(TSCONFIG_PATH);

  rlog.info(
    `Creating TypeScript program for ${config.fileNames.length} files...`,
  );
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
  });

  rlog.info("Acquiring TypeScript TypeChecker...");
  const checker = program.getTypeChecker();

  rlog.info("Resolving referenced translation type paths...");
  const typePaths = collectTypePaths(program, checker);

  rlog.info("Analyzing AppMessages type properties...");
  const { type: appMessagesType, symbol: appMessagesSymbol } =
    getAppMessagesType(program, checker);

  rlog.info("Scanning codebase to collect all referenced keys...");
  const usageMap = collectUsedKeys(
    program,
    checker,
    appMessagesType,
    appMessagesSymbol,
    enNodes,
    typePaths,
  );
  const usedPaths = [...usageMap.keys()].sort();

  rlog.info("Running diagnostics validation...");

  const shapeDiffs = Object.fromEntries(
    LOCALES.filter((locale) => locale !== "en").map((locale) => [
      locale,
      compareNodeShapes(enNodes, nodesByLocale[locale]),
    ]),
  );
  const placeholderMismatchesByLocale = Object.fromEntries(
    LOCALES.filter((locale) => locale !== "en").map((locale) => [
      locale,
      comparePlaceholders(enLeaves, leavesByLocale[locale]),
    ]),
  );
  const usedButMissingInEn = findUsedButMissing(usedPaths, enNodes);
  const usedButMissingByLocale = Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      findUsedButMissing(usedPaths, nodesByLocale[locale]),
    ]),
  );
  const unusedKeysByLocale = Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      findUnusedLeaves(leavesByLocale[locale], usedPaths),
    ]),
  );

  const errors =
    Object.values(shapeDiffs).reduce(
      (total, shapeDiff) =>
        total +
        shapeDiff.missingOnRight.length +
        shapeDiff.missingOnLeft.length +
        shapeDiff.kindMismatch.length,
      0,
    ) +
    Object.values(placeholderMismatchesByLocale).reduce(
      (total, mismatches) => total + mismatches.length,
      0,
    ) +
    usedButMissingInEn.length +
    Object.entries(usedButMissingByLocale)
      .filter(([locale]) => locale !== "en")
      .reduce((total, [, missing]) => total + missing.length, 0);

  if (errors > 0) {
    rlog.error("I18n Check Failed!");
  } else {
    rlog.success("I18n Check Passed Successfully!");
  }

  for (const locale of LOCALES) {
    rlog.log(`- ${locale} leaf keys: ${leavesByLocale[locale].size}`);
  }
  rlog.log(`- referenced key paths: ${usedPaths.length}`);
  if (errors > 0) {
    rlog.error(`- structural errors: ${errors}`);
  } else {
    rlog.success(`- structural errors: ${errors}`);
  }

  for (const locale of LOCALES) {
    const unusedKeys = unusedKeysByLocale[locale];
    if (unusedKeys.length > 0) {
      rlog.warn(`- unused ${locale} leaf keys: ${unusedKeys.length}`);
    } else {
      rlog.log(`- unused ${locale} leaf keys: ${unusedKeys.length}`);
    }
  }

  for (const [locale, shapeDiff] of Object.entries(shapeDiffs)) {
    if (shapeDiff.missingOnRight.length > 0) {
      rlog.error(`\nMissing In ${locale}.yaml`);
      for (const key of shapeDiff.missingOnRight) {
        rlog.warn(`- ${key}`);
      }
    }

    if (shapeDiff.missingOnLeft.length > 0) {
      rlog.error(`\nExtra Keys In ${locale}.yaml`);
      for (const key of shapeDiff.missingOnLeft) {
        rlog.warn(`- ${key}`);
      }
    }

    if (shapeDiff.kindMismatch.length > 0) {
      rlog.error(`\nType Mismatches In ${locale}.yaml`);
      for (const key of shapeDiff.kindMismatch) {
        rlog.warn(`- ${key}`);
      }
    }
  }

  for (const [locale, placeholderMismatches] of Object.entries(
    placeholderMismatchesByLocale,
  )) {
    if (placeholderMismatches.length > 0) {
      rlog.error(`\nPlaceholder Mismatches In ${locale}.yaml`);
      for (const mismatch of placeholderMismatches) {
        rlog.warn(`- ${mismatch.key}`);
        rlog.log(`  en: ${mismatch.en.join(", ") || "(none)"}`);
        rlog.log(`  ${locale}: ${mismatch.zh.join(", ") || "(none)"}`);
      }
    }
  }

  for (const locale of LOCALES) {
    const usedButMissing = usedButMissingByLocale[locale];
    if (usedButMissing.length > 0) {
      rlog.error(`\nUsed But Missing In ${locale}.yaml`);
      for (const key of usedButMissing) {
        rlog.warn(`- ${key} (${formatUsageRefs(usageMap.get(key))})`);
      }
    }
  }

  for (const locale of LOCALES) {
    const unusedKeys = unusedKeysByLocale[locale];
    if (unusedKeys.length === 0) continue;
    rlog.file.info(`\nUnused ${locale}.yaml Keys`);
    rlog.screen.info(`Writing unused ${locale}.yaml keys to local log file...`);
    let i = 0;
    for (const key of unusedKeys) {
      rlog.file.info(`- ${key}`);
      i += 1;
      rlog.progress(i, unusedKeys.length);
    }
  }

  const isPruneMode = args.includes("--prune");

  if (
    isPruneMode &&
    Object.values(unusedKeysByLocale).some(
      (unusedKeys) => unusedKeys.length > 0,
    )
  ) {
    await pruneUnusedKeys(unusedKeysByLocale);
  }

  if (errors > 0) {
    process.exitCode = 1;
  }
}
