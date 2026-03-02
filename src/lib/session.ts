export type SystemRole = "admin" | "user";

export interface DashboardSession {
  userId: string;
  username: string;
  displayName: string;
  systemRole: SystemRole;
  exp: number;
}

function sessionSecret(): string {
  const fromEnv =
    process.env.DASHBOARD_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    "";
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  return "insightflare-session-secret-change-me";
}

function bytes(input: string): Uint8Array {
  const encoded = new TextEncoder().encode(input);
  const out = new Uint8Array(encoded.length);
  out.set(encoded);
  return out;
}
function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

function base64UrlEncode(input: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < input.length; i += 1) {
    binary += String.fromCharCode(input[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function hmacSha256(message: string, secret: string): Promise<Uint8Array> {
  const secretBuffer = toArrayBuffer(bytes(secret));
  const messageBuffer = toArrayBuffer(bytes(message));
  const key = await crypto.subtle.importKey(
    "raw",
    secretBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, messageBuffer);
  return new Uint8Array(sig);
}

export async function createSessionToken(
  claims: Omit<DashboardSession, "exp">,
  maxAgeSeconds: number,
): Promise<string> {
  const payload: DashboardSession = {
    ...claims,
    exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
  };
  const encodedPayload = base64UrlEncode(bytes(JSON.stringify(payload)));
  const signature = await hmacSha256(encodedPayload, sessionSecret());
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

export async function verifySessionToken(token: string | null | undefined): Promise<DashboardSession | null> {
  if (!token || token.length < 20) {
    return null;
  }
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return null;
  }

  const expectedSig = await hmacSha256(payloadPart, sessionSecret());
  let actualSig: Uint8Array;
  try {
    actualSig = base64UrlDecode(signaturePart);
  } catch {
    return null;
  }
  if (!bytesEqual(expectedSig, actualSig)) {
    return null;
  }

  let parsed: unknown;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadPart));
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const maybe = parsed as Partial<DashboardSession>;
  const userId = String(maybe.userId || "");
  const username = String(maybe.username || "");
  const displayName = String(maybe.displayName || "");
  const systemRole = maybe.systemRole === "admin" ? "admin" : "user";
  const exp = Number(maybe.exp || 0);
  if (!userId || !username || !Number.isFinite(exp) || exp <= 0) {
    return null;
  }
  if (Math.floor(Date.now() / 1000) >= exp) {
    return null;
  }

  return {
    userId,
    username,
    displayName,
    systemRole,
    exp,
  };
}
