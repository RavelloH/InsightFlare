import fs from "node:fs";
import path from "node:path";

import Rlog from "rlog-js";

import { LOGS_DIR } from "./paths";

interface ScriptLoggerOptions {
  logFile?: string;
  silent?: boolean;
}

export function createScriptLogger(options: ScriptLoggerOptions = {}): Rlog {
  const logFilePath = options.logFile
    ? path.join(LOGS_DIR, options.logFile)
    : undefined;

  if (logFilePath && !fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  return new Rlog({
    enableColorfulOutput: true,
    logFilePath,
    silent: options.silent,
  });
}
