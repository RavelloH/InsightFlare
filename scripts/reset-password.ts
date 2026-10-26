#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  hashResetPassword,
  lookupUserSql,
  parseResetPasswordOptions,
  parseWranglerRows,
  type PasswordResetUser,
  type ResetPasswordOptions,
  resetUserSql,
  verifyUserSql,
} from "./shared/password-reset-core";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER_CLI = path.join(
  ROOT_DIR,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const MAX_WRANGLER_OUTPUT = 2 * 1024 * 1024;

const HELP = [
  "Reset an InsightFlare user's password using Wrangler and remote D1.",
  "",
  "Usage:",
  "  pnpm run ops:admin:reset-password -- --user admin [--env name]",
  "",
  "Options:",
  "  --user      Existing username (required)",
  "  --env       Wrangler environment (optional)",
  "  --config    Wrangler config path (default: wrangler.toml)",
  "  --database  D1 binding/name (default: DB)",
  "  --help      Show this help",
  "",
  "Requires an interactive terminal and an authenticated Wrangler session.",
  "Only the selected user's password hash is updated; old sessions remain valid.",
].join("\n");

async function runWrangler(
  options: ResetPasswordOptions,
  sql: { command: string } | { file: string },
): Promise<string> {
  const args = [
    WRANGLER_CLI,
    "d1",
    "execute",
    options.database,
    "--remote",
    "--yes",
    "--json",
    "--config",
    path.resolve(ROOT_DIR, options.config),
    ...(options.env ? ["--env", options.env] : []),
    ...("file" in sql ? ["--file", sql.file] : ["--command", sql.command]),
  ];
  return new Promise((resolve, reject) => {
    let stdout = "";
    let combinedBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(stdout);
    };
    // No shell; passwords/hashes are never present in argv.
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Wrangler timed out; check connectivity."));
    }, 120_000);
    const capture = (chunk: Buffer, fromStdout: boolean) => {
      combinedBytes += chunk.byteLength;
      if (combinedBytes > MAX_WRANGLER_OUTPUT) {
        child.kill();
        finish(new Error("Wrangler output exceeded the safety limit."));
      } else if (fromStdout) {
        stdout += Buffer.from(chunk).toString("utf8");
      }
      // Do not print stderr: Wrangler may include portions of an SQL query.
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, false));
    child.once("error", () => {
      finish(new Error("Unable to start Wrangler. Check local dependencies."));
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            "Wrangler D1 command failed (exit " +
              (code ?? "unknown") +
              "). Check authentication, --config, --env and D1 access.",
          ),
        );
      } else {
        finish();
      }
    });
  });
}

async function readD1<T extends object>(
  options: ResetPasswordOptions,
  query: string,
): Promise<T[]> {
  return parseWranglerRows<T>(await runWrangler(options, { command: query }));
}

async function executePrivateSql(
  options: ResetPasswordOptions,
  sql: string,
): Promise<void> {
  // Wrangler requires --command or --file; only a file keeps password hashes
  // out of process command lines. Store it under a private, random temp path.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "insightflare-reset-"));
  const filePath = path.join(tempDir, "reset.sql");
  try {
    await fs.promises.chmod(tempDir, 0o700);
    await writeFile(filePath, sql + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await runWrangler(options, { file: filePath });
  } finally {
    // Never leave hashes in the repo or in its normal operation logs.
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function askConfirmation(expected: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      'Type "RESET ' + expected + '" to continue: ',
    );
    if (answer !== "RESET " + expected) {
      throw new Error("Cancelled: confirmation did not match.");
    }
  } finally {
    rl.close();
  }
}

async function readHiddenPassword(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY || !input.setRawMode) {
    throw new Error("An interactive terminal is required for password input.");
  }
  process.stdout.write(prompt);
  readline.emitKeypressEvents(input);
  const previousRaw = input.isRaw;
  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    const cleanup = () => {
      input.off("keypress", onKey);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
      process.stdout.write("\n");
    };
    const onKey = (
      str: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean } = {},
    ) => {
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(chars.join(""));
        return;
      }
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        cleanup();
        reject(new Error("Cancelled."));
        return;
      }
      if (key.name === "backspace") {
        chars.pop();
        return;
      }
      if (key.ctrl || key.meta || !str) return;
      for (const character of str) {
        if (
          (character.codePointAt(0) ?? 0) >= 32 &&
          character.codePointAt(0) !== 127 &&
          chars.length < 1024
        ) {
          chars.push(character);
        }
      }
    };
    input.on("keypress", onKey);
    input.setRawMode(true);
    input.resume();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  const options = parseResetPasswordOptions(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal.");
  }
  if (!fs.existsSync(WRANGLER_CLI)) {
    throw new Error("Wrangler is not installed; run pnpm install.");
  }
  const configPath = path.resolve(ROOT_DIR, options.config);
  if (!fs.existsSync(configPath)) {
    throw new Error("Wrangler config file not found: " + configPath);
  }

  console.log("InsightFlare password recovery (REMOTE D1)");
  console.log("Wrangler config:", configPath);
  console.log("Wrangler environment:", options.env ?? "(default)");
  console.log("D1 binding/name:", options.database);
  console.log("Looking up user...\n");

  const matches = await readD1<PasswordResetUser>(
    options,
    lookupUserSql(options.user),
  );
  if (matches.length === 0) throw new Error("User not found.");
  if (matches.length !== 1) {
    throw new Error("Username matches multiple users; refusing to proceed.");
  }
  const user = matches[0];
  if (
    !user ||
    typeof user.id !== "string" ||
    !user.id ||
    typeof user.username !== "string" ||
    typeof user.system_role !== "string" ||
    (user.password_hash !== null && typeof user.password_hash !== "string")
  ) {
    throw new Error("Unexpected user record returned by D1.");
  }
  console.log("User:", user.username);
  console.log("Role:", user.system_role);
  console.log("Database: remote (production or selected environment)");
  console.log("This operation does NOT revoke existing sessions.\n");

  await askConfirmation(user.username);
  const password = await readHiddenPassword("New password (hidden): ");
  if (password.length < 8 || password.length > 1024) {
    throw new Error("Password must contain 8-1024 characters.");
  }
  const repeated = await readHiddenPassword("Confirm password (hidden): ");
  if (password !== repeated) {
    throw new Error("Passwords do not match; no changes made.");
  }
  const hash = hashResetPassword(password);

  // Optimistic guard: if the password changed after our lookup, don't
  // overwrite another administrator's concurrent reset.
  await executePrivateSql(
    options,
    resetUserSql(user.id, user.password_hash, hash),
  );
  const verified = await readD1<{ password_hash: string | null }>(
    options,
    verifyUserSql(user.id),
  );
  if (verified.length !== 1 || verified[0]?.password_hash !== hash) {
    throw new Error(
      "Password update could not be verified (possibly changed concurrently).",
    );
  }
  console.log("\nPassword reset succeeded for:", user.username);
  console.log("Previously issued session tokens remain valid until expiry.");
}

main().catch((error: unknown) => {
  // Do not include SQL or Wrangler output in errors.
  console.error(
    "Password reset failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
