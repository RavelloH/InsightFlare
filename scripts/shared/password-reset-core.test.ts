import { describe, expect, it } from "vitest";

import { verifyPassword } from "@/lib/edge/admin/auth";

import {
  hashResetPassword,
  lookupUserSql,
  parseD1Rows,
  parseResetPasswordOptions,
  resetUserSql,
  verifyUserSql,
} from "./password-reset-core";

const CF_DATABASE_ID = "12345678-1234-1234-1234-1234567890ab";

describe("password reset CLI options", () => {
  it("defaults to Wrangler and its configured D1 binding", () => {
    expect(parseResetPasswordOptions(["--user", "admin"])).toEqual({
      cli: "wrangler",
      user: "admin",
      database: "DB",
      config: "wrangler.toml",
    });
  });

  it("accepts Wrangler config, environment and database overrides", () => {
    expect(
      parseResetPasswordOptions([
        "--user=member-1",
        "--env",
        "production",
        "--database",
        "ACCOUNTS",
        "--config",
        "custom.toml",
      ]),
    ).toEqual({
      cli: "wrangler",
      user: "member-1",
      env: "production",
      database: "ACCOUNTS",
      config: "custom.toml",
    });
  });

  it("requires a D1 UUID for cf and accepts a named auth profile", () => {
    expect(
      parseResetPasswordOptions([
        "--cli",
        "cf",
        "--user",
        "admin",
        "--database",
        CF_DATABASE_ID,
        "--profile",
        "self-hosted-prod",
      ]),
    ).toEqual({
      cli: "cf",
      user: "admin",
      database: CF_DATABASE_ID,
      profile: "self-hosted-prod",
    });
  });

  it("rejects invalid CLI selections and cf database or profile values", () => {
    expect(() =>
      parseResetPasswordOptions(["--user", "admin", "--cli", "cloudflare"]),
    ).toThrow("Invalid --cli");
    expect(() =>
      parseResetPasswordOptions(["--user", "admin", "--cli", "cf"]),
    ).toThrow("Missing value for --database");
    expect(() =>
      parseResetPasswordOptions([
        "--user",
        "admin",
        "--cli",
        "cf",
        "--database",
        "insightflare",
      ]),
    ).toThrow("D1 database UUID");
    expect(() =>
      parseResetPasswordOptions([
        "--user",
        "admin",
        "--cli",
        "cf",
        "--database",
        CF_DATABASE_ID,
        "--profile",
        "prod profile",
      ]),
    ).toThrow("Invalid cf auth profile");
    expect(() =>
      parseResetPasswordOptions([
        "--user",
        "admin",
        "--cli",
        "cf",
        "--database",
        CF_DATABASE_ID,
        "--profile",
        "-q",
      ]),
    ).toThrow("Invalid cf auth profile");
  });

  it("rejects CLI-specific flags used with the wrong provider", () => {
    expect(() =>
      parseResetPasswordOptions([
        "--user",
        "admin",
        "--cli",
        "cf",
        "--database",
        CF_DATABASE_ID,
        "--config",
        "custom.toml",
      ]),
    ).toThrow("Wrangler-only");
    expect(() =>
      parseResetPasswordOptions([
        "--user",
        "admin",
        "--cli",
        "cf",
        "--database",
        CF_DATABASE_ID,
        "--env",
        "production",
      ]),
    ).toThrow("Wrangler-only");
    expect(() =>
      parseResetPasswordOptions(["--user", "admin", "--profile", "production"]),
    ).toThrow("only supported with --cli cf");
  });

  it("rejects unknown, duplicated, missing and password-bearing options", () => {
    expect(() => parseResetPasswordOptions([])).toThrow("Missing value");
    expect(() => parseResetPasswordOptions(["--user", "--env"])).toThrow();
    expect(() =>
      parseResetPasswordOptions(["--user", "admin", "--password", "secret"]),
    ).toThrow("Unknown or duplicated");
    expect(() =>
      parseResetPasswordOptions(["--user", "admin", "--user", "bob"]),
    ).toThrow("Unknown or duplicated");
    expect(() =>
      parseResetPasswordOptions([
        "--user",
        "admin",
        "--cli",
        "wrangler",
        "--cli",
        "cf",
      ]),
    ).toThrow("Unknown or duplicated");
    expect(() =>
      parseResetPasswordOptions(["--user", "admin' OR 1=1 --"]),
    ).toThrow("Invalid username");
  });
});

describe("password reset SQL", () => {
  it("quotes every value and restricts the guarded mutation", () => {
    expect(lookupUserSql("a' OR 1=1 --")).toContain(
      "lower('a'' OR 1=1 --') LIMIT 2",
    );
    expect(verifyUserSql("an'id")).toContain("id = 'an''id'");
    const sql = resetUserSql("id'1", "old'hash", "new'hash");
    expect(sql).toContain("password_hash = 'new''hash'");
    expect(sql).toContain("WHERE id = 'id''1'");
    expect(sql).toContain("AND password_hash = 'old''hash'");
    expect(resetUserSql("user-1", null, "hashed")).toContain(
      "AND password_hash IS NULL",
    );
    expect(() => verifyUserSql("bad\nid")).toThrow("control character");
  });
});

describe("D1 response parsing", () => {
  it.each(["wrangler", "cf"] as const)(
    "parses a successful %s JSON response",
    (cli) => {
      expect(
        parseD1Rows<{ id: string }>(
          JSON.stringify([{ results: [{ id: "u1" }], success: true }]),
          cli,
        ),
      ).toEqual([{ id: "u1" }]);
    },
  );

  it.each(["wrangler", "cf"] as const)(
    "rejects malformed, multi-statement and failed %s responses",
    (cli) => {
      expect(() => parseD1Rows("not json", cli)).toThrow("valid JSON");
      expect(() =>
        parseD1Rows(JSON.stringify([{ results: [] }, { results: [] }]), cli),
      ).toThrow("number");
      expect(() =>
        parseD1Rows(JSON.stringify([{ results: [], success: false }]), cli),
      ).toThrow("unsuccessful");
    },
  );

  it("rejects a response without a single result object", () => {
    expect(() => parseD1Rows("[]")).toThrow("number");
    expect(() => parseD1Rows(JSON.stringify({ success: true }))).toThrow(
      "invalid or unsuccessful",
    );
  });
});

describe("password hashing", () => {
  it("produces salted hashes compatible with live account verification", async () => {
    const password = "Test-密码-Reset-2026";
    const first = hashResetPassword(password);
    const second = hashResetPassword(password);
    expect(first).toMatch(
      /^argon2id\$v=19\$m=4096,t=1,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/,
    );
    expect(first).not.toBe(second);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", first)).resolves.toBe(false);
    expect(() => hashResetPassword("short")).toThrow("8-1024");
    expect(() => hashResetPassword("x".repeat(1025))).toThrow("8-1024");
  });
});
