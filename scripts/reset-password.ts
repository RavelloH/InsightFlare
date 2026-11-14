#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  hashResetPassword,
  lookupUserSql,
  parseResetPasswordOptions,
  type PasswordResetUser,
  resetUserSql,
  verifyUserSql,
} from "./shared/password-reset-core";
import {
  executePrivateResetSql,
  readResetD1,
  resetD1Entrypoint,
} from "./shared/password-reset-d1";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));

const HELP = [
  "Reset an InsightFlare user's password using Wrangler or cf and remote D1.",
  "",
  "Usage:",
  "  pnpm run ops:admin:reset-password -- --user admin [--env name]",
  "  pnpm run ops:admin:reset-password -- --user admin --cli cf --database <D1_UUID>",
  "",
  "Options:",
  "  --user      Existing username (required)",
  "  --cli       wrangler (default) or cf",
  "  --env       Wrangler environment (Wrangler only)",
  "  --config    Wrangler config path (default: wrangler.toml; Wrangler only)",
  "  --database  Wrangler binding/name (default: DB) or required cf D1 UUID",
  "  --profile   cf auth profile (cf only; otherwise uses cf default account)",
  "  --help      Show this help",
  "",
  "Requires an interactive terminal and authenticated CLI access to remote D1.",
  "Only the selected user's password hash is updated; old sessions remain valid.",
].join("\n");

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
  if (args[0] === "--") args.shift();
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  const options = parseResetPasswordOptions(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal.");
  }
  if (!fs.existsSync(resetD1Entrypoint(ROOT_DIR, options.cli))) {
    throw new Error(options.cli + " is not installed; run pnpm install.");
  }
  console.log("InsightFlare password recovery (REMOTE D1)");
  console.log("CLI:", options.cli);
  if (options.cli === "wrangler") {
    const configPath = path.resolve(ROOT_DIR, options.config);
    if (!fs.existsSync(configPath)) {
      throw new Error("Wrangler config file not found: " + configPath);
    }
    console.log("Wrangler config:", configPath);
    console.log("Wrangler environment:", options.env ?? "(default)");
  } else {
    console.log("cf auth profile:", options.profile ?? "(default)");
    console.log(
      "cf account:",
      process.env.CLOUDFLARE_ACCOUNT_ID ?? "(cf account context)",
    );
  }
  console.log("Remote D1 database:", options.database);
  console.log("Looking up user...\n");

  const matches = await readResetD1<PasswordResetUser>(
    ROOT_DIR,
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
  await executePrivateResetSql(
    ROOT_DIR,
    options,
    resetUserSql(user.id, user.password_hash, hash),
  );
  const verified = await readResetD1<{ password_hash: string | null }>(
    ROOT_DIR,
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
  // Do not include SQL or CLI output in errors.
  console.error(
    "Password reset failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
