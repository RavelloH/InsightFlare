import { describe, expect, it } from "vitest";

import {
  decryptAnalyticsEngineSecret,
  decryptLoginTurnstileSecret,
  decryptNotificationSecret,
  decryptTeamInviteToken,
  encryptAnalyticsEngineSecret,
  encryptLoginTurnstileSecret,
  encryptNotificationSecret,
  encryptTeamInviteToken,
} from "@/lib/edge/auth/secret-encryption";
import type { Env } from "@/lib/edge/types";

const env = {
  MAIN_SECRET: "main-secret-for-secret-encryption-tests",
  DAILY_SALT_SECRET: "daily-salt-secret-for-secret-encryption-tests",
} as Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">;

const PURPOSES = [
  {
    name: "notification",
    encrypt: encryptNotificationSecret,
    decrypt: decryptNotificationSecret,
  },
  {
    name: "login Turnstile",
    encrypt: encryptLoginTurnstileSecret,
    decrypt: decryptLoginTurnstileSecret,
  },
  {
    name: "Analytics Engine",
    encrypt: encryptAnalyticsEngineSecret,
    decrypt: decryptAnalyticsEngineSecret,
  },
  {
    name: "team invite token",
    encrypt: encryptTeamInviteToken,
    decrypt: decryptTeamInviteToken,
  },
] as const;

describe("secret encryption", () => {
  it.each(PURPOSES)(
    "round-trips a $name secret without exposing the plaintext",
    async ({ encrypt, decrypt }) => {
      const plaintext = "s3cr3t-値-with-unicode-and-symbols!@#";
      const encrypted = await encrypt(env, plaintext);

      expect(encrypted).not.toContain(plaintext);
      await expect(decrypt(env, encrypted)).resolves.toBe(plaintext);
    },
  );

  it.each(PURPOSES)(
    "uses a fresh nonce for every $name encryption",
    async ({ encrypt, decrypt }) => {
      const first = await encrypt(env, "same-secret");
      const second = await encrypt(env, "same-secret");

      expect(first).not.toBe(second);
      await expect(decrypt(env, first)).resolves.toBe("same-secret");
      await expect(decrypt(env, second)).resolves.toBe("same-secret");
    },
  );

  it.each(PURPOSES)(
    "refuses to decrypt a $name secret with another MAIN_SECRET",
    async ({ encrypt, decrypt }) => {
      const encrypted = await encrypt(env, "bound-to-the-secret");

      await expect(
        decrypt({ ...env, MAIN_SECRET: "a-different-main-secret" }, encrypted),
      ).rejects.toThrow();
    },
  );

  it("keeps every purpose isolated from the others", async () => {
    for (const source of PURPOSES) {
      const encrypted = await source.encrypt(env, "purpose-bound");
      for (const target of PURPOSES) {
        if (target.name === source.name) continue;
        await expect(target.decrypt(env, encrypted)).rejects.toThrow();
      }
    }
  });

  it("rejects tampered ciphertext", async () => {
    const encrypted = await encryptTeamInviteToken(env, "invite-token");
    const tampered = `${encrypted.slice(0, -4)}${
      encrypted.endsWith("AAAA") ? "BBBB" : "AAAA"
    }`;

    await expect(decryptTeamInviteToken(env, tampered)).rejects.toThrow();
  });
});
