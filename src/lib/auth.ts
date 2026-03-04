import { SESSION_COOKIE } from "./constants";
import type { DashboardSession } from "./session";
import { verifySessionToken } from "./session";

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookieValue(cookieHeader: string, key: string): string {
  if (!cookieHeader) return "";
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === key) {
      return decodeCookieValue(rawValue.join("="));
    }
  }
  return "";
}

async function readServerCookieHeader(): Promise<string> {
  try {
    const mod = await import("next/headers");
    const h = await mod.headers();
    return h.get("cookie") || "";
  } catch {
    return "";
  }
}

export async function getSessionToken(): Promise<string> {
  if (typeof document !== "undefined") {
    return parseCookieValue(document.cookie || "", SESSION_COOKIE);
  }
  const cookieHeader = await readServerCookieHeader();
  return parseCookieValue(cookieHeader, SESSION_COOKIE);
}

export async function getSession(): Promise<DashboardSession | null> {
  const token = await getSessionToken();
  return verifySessionToken(token);
}

export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession();
  return Boolean(session);
}
