import { deriveSecret, rootSecret, SECRET_PURPOSES } from "@/lib/secrets";

import type { Env } from "./types";

const FORMAT_PREFIX = "v1";
const AES_GCM_IV_BYTES = 12;

function b64u(input: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < input.length; index += 1) {
    binary += String.fromCharCode(input[index]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64u(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function hexToBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

function getRootSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
): string {
  const secret = rootSecret(env);
  if (!secret) {
    throw new Error(
      "MAIN_SECRET or DAILY_SALT_SECRET is required to encrypt secrets",
    );
  }
  return secret;
}

async function secretEncryptionKey(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  purpose: string,
): Promise<CryptoKey> {
  const derivedHex = await deriveSecret(getRootSecret(env), purpose);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(hexToBytes(derivedHex)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  secret: string,
  purpose: string,
): Promise<string> {
  const key = await secretEncryptionKey(env, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    new TextEncoder().encode(secret),
  );
  return `${FORMAT_PREFIX}:${b64u(iv)}:${b64u(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  encrypted: string,
  purpose: string,
): Promise<string> {
  const parts = encrypted.split(":");
  if (parts.length !== 3 || parts[0] !== FORMAT_PREFIX) {
    throw new Error("Invalid encrypted secret format");
  }
  const iv = fromB64u(parts[1]);
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw new Error("Invalid encrypted secret IV");
  }
  const ciphertext = fromB64u(parts[2]);
  const key = await secretEncryptionKey(env, purpose);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function encryptNotificationSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  secret: string,
): Promise<string> {
  return encryptSecret(
    env,
    secret,
    SECRET_PURPOSES.notificationSecretEncryption,
  );
}

export async function decryptNotificationSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  encrypted: string,
): Promise<string> {
  return decryptSecret(
    env,
    encrypted,
    SECRET_PURPOSES.notificationSecretEncryption,
  );
}

export async function encryptLoginTurnstileSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  secret: string,
): Promise<string> {
  return encryptSecret(
    env,
    secret,
    SECRET_PURPOSES.loginTurnstileSecretEncryption,
  );
}

export async function decryptLoginTurnstileSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  encrypted: string,
): Promise<string> {
  return decryptSecret(
    env,
    encrypted,
    SECRET_PURPOSES.loginTurnstileSecretEncryption,
  );
}

export async function encryptAnalyticsEngineSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  secret: string,
): Promise<string> {
  return encryptSecret(
    env,
    secret,
    SECRET_PURPOSES.analyticsEngineSecretEncryption,
  );
}

export async function decryptAnalyticsEngineSecret(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  encrypted: string,
): Promise<string> {
  try {
    return await decryptSecret(
      env,
      encrypted,
      SECRET_PURPOSES.analyticsEngineSecretEncryption,
    );
  } catch (currentError) {
    try {
      return await decryptSecret(
        env,
        encrypted,
        SECRET_PURPOSES.legacyBotAnalyticsSecretEncryption,
      );
    } catch {
      throw currentError;
    }
  }
}

export async function encryptTeamInviteToken(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  token: string,
): Promise<string> {
  return encryptSecret(env, token, SECRET_PURPOSES.teamInviteTokenEncryption);
}

export async function decryptTeamInviteToken(
  env: Pick<Env, "MAIN_SECRET" | "DAILY_SALT_SECRET">,
  encrypted: string,
): Promise<string> {
  return decryptSecret(
    env,
    encrypted,
    SECRET_PURPOSES.teamInviteTokenEncryption,
  );
}
