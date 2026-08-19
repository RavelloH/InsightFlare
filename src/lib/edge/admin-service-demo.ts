import { handleDemoRequest } from "@/lib/realtime/mock";
import { handleDemoNotificationEmailPreview } from "@/lib/realtime/mock/notification-email-preview";

import { adminServicePath, type AdminServiceRequest } from "./admin-service";

/**
 * Demo adapter for admin service calls. Keeping this behind the service
 * boundary lets the current mock implementation be replaced by server-owned
 * fixtures without changing API routes, SSR loaders, or UI clients.
 */
export async function executeDemoAdminService(
  input: AdminServiceRequest,
): Promise<Response> {
  if (input.route === "notification-email-preview") {
    return demoNotificationEmailPreviewResponse(input);
  }

  let body: unknown;
  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    try {
      body = await input.request.clone().json();
    } catch {
      body = undefined;
    }
  }

  try {
    const result = handleDemoRequest({
      path: adminServicePath(input.route),
      method: input.request.method,
      params: Object.fromEntries(input.url.searchParams),
      body,
    });
    const normalized = normalizeDemoEnvelope(result);
    return new Response(JSON.stringify(normalized), {
      status:
        normalized &&
        typeof normalized === "object" &&
        "ok" in normalized &&
        (normalized as { ok?: unknown }).ok === false
          ? 400
          : 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "demo_admin_error",
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

async function demoNotificationEmailPreviewResponse(
  input: AdminServiceRequest,
): Promise<Response> {
  const type = input.url.searchParams.get("type")?.trim();
  const previewType =
    type === "test" ||
    type === "milestone" ||
    type === "threshold" ||
    type === "change" ||
    type === "health"
      ? type
      : "report";
  const locale = input.url.searchParams.get("locale") === "zh" ? "zh" : "en";
  const format =
    input.url.searchParams.get("format") === "text" ? "text" : "json";

  try {
    const result = await handleDemoNotificationEmailPreview({
      type: previewType,
      locale,
      format,
    });
    return new Response(JSON.stringify({ ok: true, data: result }), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "demo_notification_preview_error",
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

function normalizeDemoEnvelope(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: true, data: result };
  }
  const record = result as Record<string, unknown>;
  if (record.ok === false) return result;
  if (record.ok === true && "data" in record) return result;
  return { ok: true, data: result };
}
