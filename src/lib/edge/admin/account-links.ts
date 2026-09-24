import { byId, requireActor } from "@/lib/edge/admin/auth";
import {
  bad,
  forb,
  jsonResponseFor,
  na,
  nf,
  parseJson,
} from "@/lib/edge/admin/response";
import { createAccountActionToken } from "@/lib/edge/auth/account-action-tokens";
import type { Env } from "@/lib/edge/types";
import { clampString, nowEpochSeconds } from "@/lib/edge/utils";
const PASSWORD_RESET_EXPIRES_IN_SECONDS = 24 * 60 * 60;
function resetPasswordUrl(req: Request, token: string): string {
  const url = new URL(req.url);
  return `${url.origin}/reset-password#token=${encodeURIComponent(token)}`;
}
export async function handleAccountLinksAdmin(
  req: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb("Only system admin can create account links", undefined, req);
  }
  if (req.method !== "POST") return na(req);

  const body = await parseJson(req);
  const type = clampString(String(body.type || ""), 40);
  if (type !== "password_reset") {
    return bad("Unsupported account link type", undefined, req);
  }

  const userId = clampString(String(body.userId || ""), 120);
  if (!userId) return bad("userId is required", undefined, req);
  const target = await byId(env, userId);
  if (!target) return nf("User not found", undefined, req);

  const expiresAt = nowEpochSeconds() + PASSWORD_RESET_EXPIRES_IN_SECONDS;
  const created = await createAccountActionToken(env, {
    type: "password_reset",
    userId,
    createdByUserId: actor.user.id,
    expiresAt,
  });

  return jsonResponseFor(req, {
    ok: true,
    data: {
      url: resetPasswordUrl(req, created.token),
      expiresAt: created.record.expiresAt,
    },
  });
}
