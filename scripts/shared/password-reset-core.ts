import { randomBytes } from "node:crypto";

import { argon2id } from "@noble/hashes/argon2.js";

export interface ResetPasswordOptions {
  user: string;
  database: string;
  config: string;
  env?: string;
}

export interface PasswordResetUser {
  id: string;
  username: string;
  email: string;
  system_role: string;
  password_hash: string | null;
}

function requiredOption(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error("Missing value for --" + name);
  }
  return value;
}

export function parseResetPasswordOptions(
  argv: readonly string[],
): ResetPasswordOptions {
  const options = new Map<string, string>();
  const allowed = new Set(["user", "database", "config", "env"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error("Unexpected argument: " + arg);
    }
    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    if (!allowed.has(name) || options.has(name)) {
      throw new Error("Unknown or duplicated option: --" + name);
    }
    const value = requiredOption(
      name,
      separator === -1 ? argv[++index] : arg.slice(separator + 1),
    );
    if (value.startsWith("--")) {
      throw new Error("Missing value for --" + name);
    }
    options.set(name, value);
  }

  const user = requiredOption("user", options.get("user")).trim();
  // Match existing account creation rules; never accept arbitrary SQL input.
  if (!/^[a-z0-9._@-]{3,80}$/i.test(user)) {
    throw new Error("Invalid username (3-80 letters, digits, . _ @ -).");
  }
  const database = options.get("database") ?? "DB";
  if (!/^[a-zA-Z0-9_-]+$/.test(database)) {
    throw new Error("Invalid D1 binding or database name.");
  }
  const config = options.get("config") ?? "wrangler.toml";
  const env = options.get("env");
  if (env && !/^[a-zA-Z0-9_-]+$/.test(env)) {
    throw new Error("Invalid Wrangler environment name.");
  }
  return { user, database, config, ...(env ? { env } : {}) };
}

function sqlLiteral(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      throw new Error("Invalid control character in SQL value.");
    }
  }
  return "'" + value.replace(/'/g, "''") + "'";
}

export function lookupUserSql(username: string): string {
  return (
    "SELECT id, username, email, system_role, password_hash " +
    "FROM users WHERE lower(username) = lower(" +
    sqlLiteral(username) +
    ") LIMIT 2;"
  );
}

export function verifyUserSql(userId: string): string {
  return (
    "SELECT password_hash FROM users WHERE id = " +
    sqlLiteral(userId) +
    " LIMIT 1;"
  );
}

export function resetUserSql(
  userId: string,
  previousHash: string | null,
  newHash: string,
): string {
  const previousCondition =
    previousHash === null
      ? "password_hash IS NULL"
      : "password_hash = " + sqlLiteral(previousHash);
  return (
    "UPDATE users SET password_hash = " +
    sqlLiteral(newHash) +
    ", updated_at = unixepoch() WHERE id = " +
    sqlLiteral(userId) +
    " AND " +
    previousCondition +
    ";"
  );
}

export function parseWranglerRows<T extends object>(stdout: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new Error("Wrangler did not return valid JSON.");
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1) {
    throw new Error("Unexpected number of Wrangler statement results.");
  }
  const statement = statements[0];
  if (
    !statement ||
    typeof statement !== "object" ||
    !("results" in statement) ||
    !Array.isArray(statement.results) ||
    ("success" in statement && statement.success !== true)
  ) {
    throw new Error("Wrangler reported an invalid or unsuccessful D1 result.");
  }
  return statement.results as T[];
}

export function hashResetPassword(password: string): string {
  if (password.length < 8 || password.length > 1024) {
    throw new Error("Password must contain 8-1024 characters.");
  }
  const salt = randomBytes(16);
  const hash = argon2id(new TextEncoder().encode(password), salt, {
    m: 4096,
    t: 1,
    p: 1,
    version: 19,
    dkLen: 32,
  });
  return (
    "argon2id$v=19$m=4096,t=1,p=1$" +
    Buffer.from(salt).toString("base64url") +
    "$" +
    Buffer.from(hash).toString("base64url")
  );
}
