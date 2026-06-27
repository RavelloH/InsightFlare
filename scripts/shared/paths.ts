import path from "node:path";
import process from "node:process";

export const ROOT_DIR = process.cwd();
export const LOGS_DIR = path.join(ROOT_DIR, "logs");
