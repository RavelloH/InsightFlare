import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./constants";
import type { DashboardSession } from "./session";
import { verifySessionToken } from "./session";

export async function getSessionToken(): Promise<string> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value || "";
}

export async function getSession(): Promise<DashboardSession | null> {
  const token = await getSessionToken();
  return verifySessionToken(token);
}

export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession();
  return Boolean(session);
}
