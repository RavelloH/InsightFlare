import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./constants";

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return token === "1";
}

