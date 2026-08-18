/**
 * Watches src/i18n/*.yaml and regenerates src/lib/i18n/messages.ts after a
 * debounce. Used both by the standalone `watch:i18n` script and by the dev
 * runner, so a single implementation stays in sync.
 *
 * Runtime reads translations from messages.ts (the generated artifact), not
 * from the yaml sources directly, so this keeps the artifact updated while
 * editing yaml.
 */
import fs from "node:fs";
import path from "node:path";

import type Rlog from "rlog-js";

import { LOCALE_PATHS, LOCALES } from "./paths";
import { regenerateAppMessages } from "./prune";

const DEBOUNCE_MS = 120;

export interface YamlWatcher {
  start(): void;
  stop(): void;
}

export function createYamlWatcher(rlog: Rlog): YamlWatcher {
  const watchDir = path.dirname(LOCALE_PATHS.en);
  const watchedNames = new Set(LOCALES.map((locale) => `${locale}.yaml`));

  let timer: NodeJS.Timeout | null = null;
  let pending = false;
  let closed = false;
  let watcher: fs.FSWatcher | null = null;

  async function regenerate(): Promise<void> {
    try {
      await regenerateAppMessages();
      rlog.success(
        "  regenerated messages.ts from " + LOCALES.join(", ") + ".yaml",
      );
    } catch (error) {
      rlog.error(
        "  regeneration failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function scheduleRegenerate(): void {
    if (pending || closed) return;
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      timer = null;
      void regenerate();
    }, DEBOUNCE_MS);
  }

  return {
    start(): void {
      rlog.info(`Watching ${watchDir} for changes: ${LOCALES.join(", ")}.yaml`);
      rlog.info("Regenerating messages.ts...");
      void regenerate();

      watcher = fs.watch(watchDir, (_eventType, filename) => {
        if (!filename) return;
        const name = path.basename(filename.toString());
        if (!watchedNames.has(name)) return;
        scheduleRegenerate();
      });
    },
    stop(): void {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watcher?.close();
      watcher = null;
    },
  };
}
