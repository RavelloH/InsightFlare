import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./constants";
import type { DashboardSession } from "./session";
import { verifySessionToken } from "./session";

export async function getSession(): Promise<DashboardSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value || "";
  return verifySessionToken(token);
}

export async function isAuthenticated(): Promise<boolean> {
  const session = await getSession();
  return Boolean(session);
}
