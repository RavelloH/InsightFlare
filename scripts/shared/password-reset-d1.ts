import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseD1Rows, type ResetPasswordOptions } from "./password-reset-core";

const MAX_OUTPUT = 2 * 1024 * 1024;

export function resetD1Entrypoint(
  root: string,
  cli: ResetPasswordOptions["cli"],
) {
  return cli === "cf"
    ? path.join(root, "node_modules", "cf", "bin", "cf")
    : path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
}

export function resetD1Args(
  root: string,
  options: ResetPasswordOptions,
  sql: { command: string } | { file: string },
): string[] {
  if (options.cli === "cf") {
    return [
      "d1",
      "query",
      options.database,
      ...(options.profile ? ["--profile", options.profile] : []),
      ...("file" in sql ? ["--body", "@" + sql.file] : ["--sql", sql.command]),
    ];
  }
  return [
    "d1",
    "execute",
    options.database,
    "--remote",
    "--yes",
    "--json",
    "--config",
    path.resolve(root, options.config),
    ...(options.env ? ["--env", options.env] : []),
    ...("file" in sql ? ["--file", sql.file] : ["--command", sql.command]),
  ];
}

export async function runResetD1(
  root: string,
  options: ResetPasswordOptions,
  sql: { command: string } | { file: string },
): Promise<string> {
  const cli = options.cli;
  const args = [
    resetD1Entrypoint(root, cli),
    ...resetD1Args(root, options, sql),
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
    // Invoke Node directly on every platform; no shell or password/hash in argv.
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, WRANGLER_LOG: "none", NO_COLOR: "1" },
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(cli + " timed out; check connectivity."));
    }, 120_000);
    const capture = (chunk: Buffer, fromStdout: boolean) => {
      combinedBytes += chunk.byteLength;
      if (combinedBytes > MAX_OUTPUT) {
        child.kill();
        finish(new Error(cli + " output exceeded the safety limit."));
      } else if (fromStdout) {
        stdout += Buffer.from(chunk).toString("utf8");
      }
      // Never echo CLI output: it can contain SQL, hashes or account details.
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, false));
    child.once("error", () => {
      finish(
        new Error("Unable to start " + cli + ". Check local dependencies."),
      );
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            cli +
              " D1 command failed (exit " +
              (code ?? "unknown") +
              "). Check authentication, database and " +
              (cli === "cf"
                ? "--profile / CLOUDFLARE_ACCOUNT_ID."
                : "--config / --env."),
          ),
        );
      } else {
        finish();
      }
    });
  });
}

export async function readResetD1<T extends object>(
  root: string,
  options: ResetPasswordOptions,
  query: string,
): Promise<T[]> {
  return parseD1Rows<T>(
    await runResetD1(root, options, { command: query }),
    options.cli,
  );
}

export async function executePrivateResetSql(
  root: string,
  options: ResetPasswordOptions,
  sql: string,
): Promise<void> {
  // cf accepts a JSON body file; Wrangler accepts a SQL file. Both keep hashes
  // out of process command lines, and the private file is removed on failure too.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "insightflare-reset-"));
  const filePath = path.join(
    tempDir,
    options.cli === "cf" ? "reset.json" : "reset.sql",
  );
  try {
    await chmod(tempDir, 0o700);
    await writeFile(
      filePath,
      (options.cli === "cf" ? JSON.stringify({ sql }) : sql) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    parseD1Rows(
      await runResetD1(root, options, { file: filePath }),
      options.cli,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
