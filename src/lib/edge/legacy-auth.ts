import { SESSION_COOKIE, SESSION_DURATION_SECONDS } from "@/lib/constants";
import { handleAuthLoginAdmin } from "@/lib/edge/admin-users";
import { appNow } from "@/lib/edge/e2e-clock";
import { readLoginTurnstileRuntimeConfig } from "@/lib/edge/login-turnstile-runtime";
import { getInvocationLogger } from "@/lib/edge/observability-bindings";
import { decryptLoginTurnstileSecret } from "@/lib/edge/secret-encryption";
import { verifyTurnstileToken } from "@/lib/edge/turnstile-siteverify";
import type { Env } from "@/lib/edge/types";
import {
  assertContentSize,
  BODY_SIZE_LIMITS,
  bodyStr,
  parseRequestBody,
} from "@/lib/form-helpers";
import { bad, errorResponse, jsonResponseFor, na, una } from "@/lib/response";
import { dashboardSessionSecret } from "@/lib/secrets";

interface LoginUser {
  id: string;
  username: string;
  name?: string;
  systemRole?: "admin" | "user";
}

interface LoginPayload {
  ok?: boolean;
  data?: {
    user?: LoginUser;
  };
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
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function hmacSha256(
  message: string,
  secret: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(bytes(message)),
  );
  return new Uint8Array(sig);
}

async function createSessionTokenForEnv(
  env: Env,
  claims: {
    userId: string;
    username: string;
    displayName: string;
    systemRole: "admin" | "user";
  },
  maxAgeSeconds: number,
): Promise<string> {
  const secret = await dashboardSessionSecret(env);
  if (!secret) {
    throw new Error(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for sessions",
    );
  }
  const payload = {
    ...claims,
    exp: Math.floor(appNow() / 1000) + maxAgeSeconds,
  };
  const encodedPayload = base64UrlEncode(bytes(JSON.stringify(payload)));
  const signature = await hmacSha256(encodedPayload, secret);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

function requestRemoteIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "";
  return forwarded.split(",")[0]?.trim() || "";
}

function requestHostname(request: Request): string {
  try {
    return new URL(request.url).hostname;
  } catch {
    return request.headers.get("host")?.split(":")[0]?.trim() || "";
  }
}

export async function handleLegacyAuthLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return na(request);

  const sizeError = assertContentSize(request, BODY_SIZE_LIMITS.LOGIN);
  if (sizeError) return sizeError;

  const body = await parseRequestBody(request);
  const username = bodyStr(body, "username") || bodyStr(body, "email");
  const password = String(body.password ?? "");
  const turnstileToken = bodyStr(body, "turnstileToken");
  const nextPathRaw = bodyStr(body, "next") || "/app";
  const nextPathClean = nextPathRaw.split("?")[0].replace(/\/+$/, "");
  const isUnsafe =
    !nextPathRaw.startsWith("/") ||
    nextPathRaw.startsWith("//") ||
    nextPathClean === "/login" ||
    nextPathClean.endsWith("/login");
  const nextPath = isUnsafe ? "/app" : nextPathRaw;

  if (username.length < 2 || password.length < 1) {
    return bad("Invalid credentials", "invalid_credentials", request);
  }

  const turnstileConfig = await readLoginTurnstileRuntimeConfig(env);
  if (turnstileConfig?.enabled) {
    if (!turnstileToken) {
      return bad(
        "Turnstile verification is required",
        "turnstile_required",
        request,
      );
    }

    let secret: string;
    try {
      secret = await decryptLoginTurnstileSecret(
        env,
        turnstileConfig.secretKeyEncrypted,
      );
    } catch {
      return bad(
        "Turnstile is not configured correctly",
        "turnstile_not_configured",
        request,
      );
    }

    const result = await verifyTurnstileToken({
      requireSiteverifyUrl: env.INSIGHTFLARE_E2E === "1",
      secret,
      token: turnstileToken,
      remoteIp: requestRemoteIp(request),
      expectedHostname: requestHostname(request),
      siteverifyUrl:
        env.INSIGHTFLARE_E2E === "1"
          ? env.INSIGHTFLARE_E2E_TURNSTILE_SITEVERIFY_URL
          : undefined,
      logger: getInvocationLogger(env),
    });
    if (!result.ok) {
      return bad(
        result.reason === "network_error"
          ? "Turnstile verification is temporarily unavailable"
          : "Turnstile verification failed",
        result.reason === "network_error"
          ? "turnstile_verification_error"
          : "turnstile_failed",
        request,
      );
    }
  }

  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  const adminRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ username, password }),
  });
  const adminResponse = await handleAuthLoginAdmin(adminRequest, env);
  const text = await adminResponse.text();

  if (!adminResponse.ok) {
    if (adminResponse.status === 401) {
      return una("Invalid credentials", "invalid_credentials", request);
    }
    return errorResponse(
      request,
      adminResponse.status >= 400 ? adminResponse.status : 502,
      "login_upstream_failed",
      text,
    );
  }

  let payload: LoginPayload;
  try {
    payload = JSON.parse(text) as LoginPayload;
  } catch {
    return errorResponse(
      request,
      502,
      "login_upstream_failed",
      "Login response payload is invalid JSON",
    );
  }

  const user = payload.data?.user;
  if (!payload.ok || !user?.id || !user.username) {
    return errorResponse(
      request,
      502,
      "login_upstream_failed",
      "Login response payload is missing user data",
    );
  }

  const token = await createSessionTokenForEnv(
    env,
    {
      userId: user.id,
      username: user.username,
      displayName: user.name || user.username,
      systemRole: user.systemRole === "admin" ? "admin" : "user",
    },
    SESSION_DURATION_SECONDS,
  );

  const cookieParts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DURATION_SECONDS}`,
  ];
  if (process.env.NODE_ENV === "production") {
    cookieParts.push("Secure");
  }

  const response = jsonResponseFor(request, {
    ok: true,
    data: { next: nextPath },
  });
  response.headers.set("set-cookie", cookieParts.join("; "));
  return response;
}

export function handleLegacyAuthLogout(request: Request): Response {
  const response = jsonResponseFor(request, {
    ok: true,
    data: { next: "/login" },
  });
  response.headers.set(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return response;
}
