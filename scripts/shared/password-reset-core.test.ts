import { describe, expect, it } from "vitest";

import { verifyPassword } from "@/lib/edge/admin/auth";

import {
  hashResetPassword,
  lookupUserSql,
  parseResetPasswordOptions,
  parseWranglerRows,
  resetUserSql,
  verifyUserSql,
} from "./password-reset-core";

describe("Wrangler-only password reset helpers", () => {
  it("requires an existing username and uses the D1 binding by default", () => {
    expect(parseResetPasswordOptions(["--user", "admin"])).toEqual({
      user: "admin",
      database: "DB",
      config: "wrangler.toml",
    });
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
      user: "member-1",
      env: "production",
      database: "ACCOUNTS",
      config: "custom.toml",
    });
  });

  it("rejects unknown, ambiguous and password-bearing CLI flags", () => {
    expect(() => parseResetPasswordOptions([])).toThrow("Missing value");
    expect(() => parseResetPasswordOptions(["--user", "--env"])).toThrow();
    expect(() =>
      parseResetPasswordOptions(["--user", "admin", "--password", "secret"]),
    ).toThrow("Unknown or duplicated");
    expect(() =>
      parseResetPasswordOptions(["--user", "admin", "--user", "bob"]),
    ).toThrow("Unknown or duplicated");
    expect(() =>
      parseResetPasswordOptions(["--user", "admin' OR 1=1 --"]),
    ).toThrow("Invalid username");
  });

  it("quotes every SQL value and restricts the guarded mutation", () => {
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

  it("parses structured Wrangler JSON and rejects failed responses", () => {
    expect(
      parseWranglerRows<{ id: string }>(
        JSON.stringify([{ results: [{ id: "u1" }], success: true }]),
      ),
    ).toEqual([{ id: "u1" }]);
    expect(() => parseWranglerRows("not json")).toThrow("valid JSON");
    expect(() =>
      parseWranglerRows(JSON.stringify([{ results: [], success: false }])),
    ).toThrow("unsuccessful");
    expect(() => parseWranglerRows("[]")).toThrow("number");
  });

  it("produces random salted hashes compatible with live account verification", async () => {
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
