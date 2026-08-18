/**
 * Standalone watcher for src/i18n/*.yaml -> src/lib/i18n/messages.ts.
 *
 * Runtime reads translations from messages.ts (the generated artifact), not
 * from the yaml sources directly. This script keeps the artifact in sync while
 * editing yaml, so changes take effect without manually re-running
 * `npm run check:i18n -- --prune`.
 *
 * Use `npm run watch:i18n`, or just `npm run dev` (the dev runner embeds the
 * same watcher).
 */
import { createYamlWatcher } from "./i18n-check/watch";
import { createScriptLogger } from "./shared/logger";

const rlog = createScriptLogger({
  logFile: "watch-i18n.log",
});

const watcher = createYamlWatcher(rlog);
watcher.start();

rlog.info("Watching for changes. Press Ctrl+C to stop.");
