import { NextResponse } from "next/server";
import { createAdminTeam, removeAdminTeam, updateAdminTeam } from "@/lib/edge-client";
import { safeRedirectPath, parseRequestBody, bodyStr } from "@/lib/form-helpers";

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
  const isJson = (request.headers.get("content-type") || "").includes("application/json");
  const returnTo = safeRedirectPath(body.returnTo as string | undefined, "/app/teams");
  const intent = bodyStr(body, "intent");

  const teamId = bodyStr(body, "teamId");
  const name = bodyStr(body, "name");
  const slug = bodyStr(body, "slug");

  if (intent === "remove" || intent === "delete") {
    if (teamId.length === 0) {
      if (isJson) return NextResponse.json({ ok: false, error: "missing_team_id" }, { status: 400 });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "missing_team_id");
      return NextResponse.redirect(url, { status: 303 });
    }

    try {
      const result = await removeAdminTeam({ teamId });
      if (isJson) return NextResponse.json({ ok: true, data: result });
      return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
    } catch (error) {
      const msg = normalizeErrorMessage(error);
      if (isJson) return NextResponse.json({ ok: false, error: "remove_team_failed", message: msg }, { status: 500 });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "remove_team_failed");
      url.searchParams.set("message", msg);
      return NextResponse.redirect(url, { status: 303 });
    }
  }

  if (name.length < 2) {
    if (isJson) return NextResponse.json({ ok: false, error: "invalid_team_name" }, { status: 400 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "invalid_team_name");
    return NextResponse.redirect(url, { status: 303 });
  }

  if (teamId.length > 0) {
    try {
      const updated = await updateAdminTeam({
        teamId,
        name,
        slug: slug || undefined,
      });
      if (isJson) return NextResponse.json({ ok: true, data: updated });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("teamId", updated.id);
      return NextResponse.redirect(url, { status: 303 });
    } catch (error) {
      const msg = normalizeErrorMessage(error);
      if (isJson) return NextResponse.json({ ok: false, error: "update_team_failed", message: msg }, { status: 500 });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "update_team_failed");
      url.searchParams.set("message", msg);
      return NextResponse.redirect(url, { status: 303 });
    }
  }

  try {
    const created = await createAdminTeam({
      name,
      slug: slug || undefined,
    });
    if (isJson) return NextResponse.json({ ok: true, data: created });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("teamId", created.id);
    return NextResponse.redirect(url, { status: 303 });
  } catch (error) {
    const msg = normalizeErrorMessage(error);
    if (isJson) return NextResponse.json({ ok: false, error: "create_team_failed", message: msg }, { status: 500 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "create_team_failed");
    url.searchParams.set("message", msg);
    return NextResponse.redirect(url, { status: 303 });
  }
}
