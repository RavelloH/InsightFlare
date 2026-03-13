import { NextResponse } from "next/server";
import { addAdminMember, removeAdminMember } from "@/lib/edge-client";
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
  const intent = bodyStr(body, "intent") || "add";

  const teamId = bodyStr(body, "teamId");
  if (intent === "remove") {
    const userId = bodyStr(body, "userId");
    if (teamId.length === 0 || userId.length === 0) {
      return NextResponse.json(
        { ok: false, error: "invalid_member_remove_input" },
        { status: 400 },
      );
    }

    try {
      const result = await removeAdminMember({ teamId, userId });
      return NextResponse.json({ ok: true, data: result });
    } catch (error) {
      const msg = normalizeErrorMessage(error);
      return NextResponse.json(
        { ok: false, error: "remove_member_failed", message: msg },
        { status: 500 },
      );
    }
  }

  const identifier = bodyStr(body, "identifier");
  if (teamId.length === 0 || identifier.length < 2) {
    return NextResponse.json({ ok: false, error: "invalid_member_input" }, { status: 400 });
  }

  try {
    const result = await addAdminMember({ teamId, identifier });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const msg = normalizeErrorMessage(error);
    return NextResponse.json(
      { ok: false, error: "add_member_failed", message: msg },
      { status: 500 },
    );
  }
}
