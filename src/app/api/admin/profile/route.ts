import { NextResponse } from "next/server";
import { updateMyProfile } from "@/lib/edge-client";
import { parseRequestBody, bodyStr } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);

  try {
    const result = await updateMyProfile({
      username: bodyStr(body, "username") || undefined,
      email: bodyStr(body, "email") || undefined,
      name: bodyStr(body, "name") || undefined,
      password: bodyStr(body, "password") || undefined,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: "profile_update_failed", message: msg },
      { status: 500 },
    );
  }
}
