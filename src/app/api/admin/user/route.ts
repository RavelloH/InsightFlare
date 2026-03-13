import { NextResponse } from "next/server";
import { createAdminUser, removeAdminUser, updateAdminUser } from "@/lib/edge-client";
import { parseRequestBody, bodyStr } from "@/lib/form-helpers";

function normalizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const jsonStart = raw.lastIndexOf("{");
  if (jsonStart >= 0) {
    const maybeJson = raw.slice(jsonStart).trim();
    try {
      const parsed = JSON.parse(maybeJson) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch {
      // fall through to raw
    }
  }
  return raw;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);
  const intent = bodyStr(body, "intent") || "create";

  try {
    if (intent === "remove" || intent === "delete") {
      const userId = bodyStr(body, "userId");
      if (!userId) {
        return NextResponse.json({ ok: false, error: "missing_user_id" }, { status: 400 });
      }

      const result = await removeAdminUser({ userId });
      return NextResponse.json({ ok: true, data: result });
    }

    if (intent === "update") {
      const userId = bodyStr(body, "userId");
      if (!userId) {
        return NextResponse.json({ ok: false, error: "missing_user_id" }, { status: 400 });
      }

      const result = await updateAdminUser({
        userId,
        username: bodyStr(body, "username") || undefined,
        email: bodyStr(body, "email") || undefined,
        name: bodyStr(body, "name") || undefined,
        password: bodyStr(body, "password") || undefined,
        systemRole: bodyStr(body, "systemRole").toLowerCase() === "admin" ? "admin" : "user",
      });
      return NextResponse.json({ ok: true, data: result });
    }

    const username = bodyStr(body, "username");
    const email = bodyStr(body, "email");
    const password = String(body.password ?? "");
    const name = bodyStr(body, "name");
    const systemRole = bodyStr(body, "systemRole").toLowerCase() === "admin" ? "admin" : "user";

    if (!username || !email || password.length < 8) {
      return NextResponse.json({ ok: false, error: "invalid_user_input" }, { status: 400 });
    }

    const result = await createAdminUser({
      username,
      email,
      password,
      name: name || undefined,
      systemRole,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const msg = normalizeErrorMessage(error);
    return NextResponse.json(
      { ok: false, error: "user_mutation_failed", message: msg },
      { status: 500 },
    );
  }
}
