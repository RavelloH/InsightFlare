import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

import type { ResetPasswordOptions } from "./password-reset-core";
import {
  executePrivateResetSql,
  readResetD1,
  resetD1Args,
  resetD1Entrypoint,
  runResetD1,
} from "./password-reset-d1";

const ROOT = path.resolve(".");
const CF_DATABASE_ID = "12345678-1234-1234-1234-1234567890ab";
const JSON_ROWS = JSON.stringify([{ results: [{ id: "u1" }], success: true }]);

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function completeChild(
  child: FakeChild,
  stdout = JSON_ROWS,
  exitCode: number | null = 0,
  stderr = "",
): void {
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
}

function wranglerOptions(): ResetPasswordOptions {
  return {
    cli: "wrangler",
    user: "admin",
    database: "ACCOUNTS",
    config: "custom.toml",
    env: "production",
  };
}

function cfOptions(): ResetPasswordOptions {
  return {
    cli: "cf",
    user: "admin",
    database: CF_DATABASE_ID,
    profile: "self-hosted-prod",
  };
}

function lastSpawnArgs(): string[] {
  const args = spawnMock.mock.lastCall?.[1];
  if (!Array.isArray(args)) throw new Error("spawn was not called");
  return args as string[];
}

function lastSpawnOptions(): { cwd?: string; env?: NodeJS.ProcessEnv } {
  const options = spawnMock.mock.lastCall?.[2];
  if (!options || typeof options !== "object") {
    throw new Error("spawn options were not passed");
  }
  return options as { cwd?: string; env?: NodeJS.ProcessEnv };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe("D1 CLI arguments", () => {
  it("uses cf d1 query with the database UUID and optional profile", () => {
    expect(resetD1Entrypoint(ROOT, "cf")).toBe(
      path.join(ROOT, "node_modules", "cf", "bin", "cf"),
    );
    expect(
      resetD1Args(ROOT, cfOptions(), { command: "SELECT id FROM users;" }),
    ).toEqual([
      "d1",
      "query",
      CF_DATABASE_ID,
      "--profile",
      "self-hosted-prod",
      "--sql",
      "SELECT id FROM users;",
    ]);
  });

  it("uses Wrangler remote D1 arguments and configures its environment", () => {
    expect(resetD1Entrypoint(ROOT, "wrangler")).toBe(
      path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
    );
    expect(
      resetD1Args(ROOT, wranglerOptions(), {
        command: "SELECT id FROM users;",
      }),
    ).toEqual([
      "d1",
      "execute",
      "ACCOUNTS",
      "--remote",
      "--yes",
      "--json",
      "--config",
      path.resolve(ROOT, "custom.toml"),
      "--env",
      "production",
      "--command",
      "SELECT id FROM users;",
    ]);
  });

  it("parses successful query output for either CLI", async () => {
    spawnMock.mockImplementation((_command: string, _args: string[]) => {
      const child = makeChild();
      completeChild(child);
      return child;
    });

    await expect(
      readResetD1<{ id: string }>(ROOT, cfOptions(), "SELECT id FROM users;"),
    ).resolves.toEqual([{ id: "u1" }]);
    spawnMock.mockClear();

    spawnMock.mockImplementation((_command: string, _args: string[]) => {
      const child = makeChild();
      completeChild(child);
      return child;
    });
    await expect(
      readResetD1<{ id: string }>(
        ROOT,
        wranglerOptions(),
        "SELECT id FROM users;",
      ),
    ).resolves.toEqual([{ id: "u1" }]);
  });
});

describe("private password reset SQL", () => {
  it.each(["cf", "wrangler"] as const)(
    "writes secrets to a private %s file, excludes them from argv, and removes the file",
    async (cli) => {
      const sql =
        "UPDATE users SET password_hash = 'NEW_HASH_MARKER' " +
        "WHERE id = 'USER_ID_MARKER';";
      const fileOption = cli === "cf" ? "--body" : "--file";
      let filePath = "";
      let contentPromise: Promise<string> | undefined;
      spawnMock.mockImplementation((_command: string, args: string[]) => {
        const index = args.indexOf(fileOption);
        if (index < 0) throw new Error("private file argument was not passed");
        const fileArgument = args[index + 1];
        if (!fileArgument) throw new Error("private file path was missing");
        filePath = cli === "cf" ? fileArgument.slice(1) : fileArgument;
        contentPromise = readFile(filePath, "utf8");
        const child = makeChild();
        completeChild(child);
        return child;
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await executePrivateResetSql(
        ROOT,
        cli === "cf" ? cfOptions() : wranglerOptions(),
        sql,
      );

      const contents = await contentPromise;
      if (cli === "cf") {
        expect(JSON.parse(contents ?? "null")).toEqual({ sql });
      } else {
        expect(contents).toBe(sql + "\n");
      }
      const args = lastSpawnArgs();
      expect(args.join(" ")).not.toContain("NEW_HASH_MARKER");
      expect(args.join(" ")).not.toContain("USER_ID_MARKER");
      expect(args).toContain(cli === "cf" ? "--body" : "--file");
      expect(args).toContain(cli === "cf" ? "--profile" : "--config");
      expect(args).not.toContain(cli === "cf" ? "--config" : "--profile");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.dirname(filePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("removes the private file after an unsuccessful D1 response", async () => {
    let filePath = "";
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const index = args.indexOf("--body");
      const fileArgument = args[index + 1];
      if (!fileArgument) throw new Error("private file path was missing");
      filePath = fileArgument.slice(1);
      const child = makeChild();
      completeChild(child, JSON.stringify([{ results: [], success: false }]));
      return child;
    });

    await expect(
      executePrivateResetSql(
        ROOT,
        cfOptions(),
        "UPDATE users SET x = 'secret';",
      ),
    ).rejects.toThrow("unsuccessful");
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the private file when the CLI exits unsuccessfully", async () => {
    let filePath = "";
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const index = args.indexOf("--file");
      const foundPath = args[index + 1];
      if (!foundPath) throw new Error("private file path was missing");
      filePath = foundPath;
      const child = makeChild();
      completeChild(child, "", 1);
      return child;
    });

    await expect(
      executePrivateResetSql(
        ROOT,
        wranglerOptions(),
        "UPDATE users SET x = 'secret';",
      ),
    ).rejects.toThrow("D1 command failed");
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("D1 process failures", () => {
  it("reports launch failures without exposing CLI output", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    spawnMock.mockImplementation(() => {
      const child = makeChild();
      queueMicrotask(() => child.emit("error", new Error("private failure")));
      return child;
    });

    await expect(
      runResetD1(ROOT, cfOptions(), { command: "SELECT 1;" }),
    ).rejects.toThrow("Unable to start cf");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("kills a CLI that times out", async () => {
    vi.useFakeTimers();
    let child: FakeChild | undefined;
    spawnMock.mockImplementation(() => {
      child = makeChild();
      return child;
    });

    const operation = runResetD1(ROOT, cfOptions(), {
      command: "SELECT 1;",
    });
    const rejection = expect(operation).rejects.toThrow("cf timed out");
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(child?.kill).toHaveBeenCalledOnce();
  });

  it("kills a CLI that exceeds the captured output limit", async () => {
    let child: FakeChild | undefined;
    spawnMock.mockImplementation(() => {
      child = makeChild();
      queueMicrotask(() => {
        child?.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
      });
      return child;
    });

    await expect(
      runResetD1(ROOT, cfOptions(), { command: "SELECT 1;" }),
    ).rejects.toThrow("output exceeded the safety limit");
    expect(child?.kill).toHaveBeenCalledOnce();
  });

  it("keeps process execution scoped to the repository and quiets CLI logging", async () => {
    spawnMock.mockImplementation((_command: string, _args: string[]) => {
      const child = makeChild();
      completeChild(child);
      return child;
    });

    await runResetD1(ROOT, cfOptions(), { command: "SELECT 1;" });
    expect(lastSpawnOptions()).toMatchObject({
      cwd: ROOT,
      env: { WRANGLER_LOG: "none", NO_COLOR: "1" },
    });
  });
});
