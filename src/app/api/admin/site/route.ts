import { NextResponse } from "next/server";
import { createAdminSite, removeAdminSite, updateAdminSite } from "@/lib/edge-client";
import { parseFormBool, safeRedirectPath, parseRequestBody, bodyStr } from "@/lib/form-helpers";

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
  const intent = bodyStr(body, "intent") || "create";

  const teamId = bodyStr(body, "teamId");
  const siteId = bodyStr(body, "siteId");
  const name = bodyStr(body, "name");
  const domain = bodyStr(body, "domain");
  const publicEnabled = parseFormBool(body.publicEnabled);
  const publicSlug = bodyStr(body, "publicSlug");

  try {
    if (intent === "remove") {
      if (siteId.length === 0) {
        if (isJson) return NextResponse.json({ ok: false, error: "missing_site_id" }, { status: 400 });
        const url = new URL(returnTo, request.url);
        url.searchParams.set("error", "missing_site_id");
        return NextResponse.redirect(url, { status: 303 });
      }
      const removed = await removeAdminSite({ siteId });
      if (isJson) return NextResponse.json({ ok: true, data: removed });
    } else if (intent === "update") {
      if (siteId.length === 0) {
        if (isJson) return NextResponse.json({ ok: false, error: "missing_site_id" }, { status: 400 });
        const url = new URL(returnTo, request.url);
        url.searchParams.set("error", "missing_site_id");
        return NextResponse.redirect(url, { status: 303 });
      }
      const updated = await updateAdminSite({
        siteId,
        teamId: teamId || undefined,
        name: name || undefined,
        domain: domain || undefined,
        publicEnabled,
        publicSlug: publicSlug || undefined,
      });
      if (isJson) return NextResponse.json({ ok: true, data: updated });
    } else {
      if (teamId.length === 0 || name.length === 0 || domain.length === 0) {
        if (isJson) return NextResponse.json({ ok: false, error: "invalid_site_input" }, { status: 400 });
        const url = new URL(returnTo, request.url);
        url.searchParams.set("error", "invalid_site_input");
        return NextResponse.redirect(url, { status: 303 });
      }
      const created = await createAdminSite({
        teamId,
        name,
        domain,
        publicEnabled,
        publicSlug: publicSlug || undefined,
      });
      if (isJson) return NextResponse.json({ ok: true, data: created });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("siteId", created.id);
      url.searchParams.set("teamId", created.teamId);
      return NextResponse.redirect(url, { status: 303 });
    }
  } catch (error) {
    const msg = normalizeErrorMessage(error);
    if (isJson) return NextResponse.json({ ok: false, error: "site_mutation_failed", message: msg }, { status: 500 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "site_mutation_failed");
    url.searchParams.set("message", msg);
    return NextResponse.redirect(url, { status: 303 });
  }

  return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
}
