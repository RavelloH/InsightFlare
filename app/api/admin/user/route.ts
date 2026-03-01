import { NextResponse } from "next/server";
import { createAdminUser, updateAdminUser } from "@/lib/edge-client";
import { safeRedirectPath } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const returnTo = safeRedirectPath(formData.get("returnTo"), "/app/account");
  const intent = String(formData.get("intent") || "create").trim().toLowerCase();

  try {
    if (intent === "update") {
      const userId = String(formData.get("userId") || "").trim();
      if (!userId) {
        const url = new URL(returnTo, request.url);
        url.searchParams.set("error", "missing_user_id");
        return NextResponse.redirect(url, { status: 303 });
      }

      await updateAdminUser({
        userId,
        username: String(formData.get("username") || "").trim() || undefined,
        email: String(formData.get("email") || "").trim() || undefined,
        name: String(formData.get("name") || "").trim() || undefined,
        password: String(formData.get("password") || "").trim() || undefined,
        systemRole:
          String(formData.get("systemRole") || "").trim().toLowerCase() === "admin"
            ? "admin"
            : "user",
      });
      return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
    }

    const username = String(formData.get("username") || "").trim();
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    const name = String(formData.get("name") || "").trim();
    const systemRole =
      String(formData.get("systemRole") || "user").trim().toLowerCase() === "admin" ? "admin" : "user";

    if (!username || !email || password.length < 8) {
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "invalid_user_input");
      return NextResponse.redirect(url, { status: 303 });
    }

    await createAdminUser({
      username,
      email,
      password,
      name: name || undefined,
      systemRole,
    });

    return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
  } catch (error) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "user_mutation_failed");
    url.searchParams.set("message", error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(url, { status: 303 });
  }
}
