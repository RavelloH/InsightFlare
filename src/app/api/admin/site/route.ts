import { NextResponse } from "next/server";
import { createAdminSite, removeAdminSite, updateAdminSite } from "@/lib/edge-client";
import { parseFormBool, parseRequestBody, bodyStr } from "@/lib/form-helpers";

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

  const teamId = bodyStr(body, "teamId");
  const siteId = bodyStr(body, "siteId");
  const name = bodyStr(body, "name");
  const domain = bodyStr(body, "domain");
  const publicEnabled = parseFormBool(body.publicEnabled);
  const publicSlug = bodyStr(body, "publicSlug");

  try {
    if (intent === "remove") {
      if (siteId.length === 0) {
        return NextResponse.json({ ok: false, error: "missing_site_id" }, { status: 400 });
      }
      const removed = await removeAdminSite({ siteId });
      return NextResponse.json({ ok: true, data: removed });
    } else if (intent === "update") {
      if (siteId.length === 0) {
        return NextResponse.json({ ok: false, error: "missing_site_id" }, { status: 400 });
      }
      const updated = await updateAdminSite({
        siteId,
        teamId: teamId || undefined,
        name: name || undefined,
        domain: domain || undefined,
        publicEnabled,
        publicSlug: publicSlug || undefined,
      });
      return NextResponse.json({ ok: true, data: updated });
    } else {
      if (teamId.length === 0 || name.length === 0 || domain.length === 0) {
        return NextResponse.json({ ok: false, error: "invalid_site_input" }, { status: 400 });
      }
      const created = await createAdminSite({
        teamId,
        name,
        domain,
        publicEnabled,
        publicSlug: publicSlug || undefined,
      });
      return NextResponse.json({ ok: true, data: created });
    }
  } catch (error) {
    const msg = normalizeErrorMessage(error);
    return NextResponse.json(
      { ok: false, error: "site_mutation_failed", message: msg },
      { status: 500 },
    );
  }
}
