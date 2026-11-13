import { beforeEach, describe, expect, it, vi } from "vitest";

import { canManageTeam, teamById } from "@/lib/edge/admin/access";
import { requireActor } from "@/lib/edge/admin/auth";
import { handleTeamInvitesAdmin } from "@/lib/edge/admin/teams/invites";
import {
  createAccountActionToken,
  getAccountActionTokenById,
  listTeamInviteTokens,
  revokeAccountActionToken,
} from "@/lib/edge/auth/account-action-tokens";
import { assertSitesBelongToTeam } from "@/lib/edge/auth/member-site-access";
import {
  decryptTeamInviteToken,
  encryptTeamInviteToken,
} from "@/lib/edge/auth/secret-encryption";
import { readConfig } from "@/lib/edge/system-config";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/auth/account-action-tokens", () => ({
  createAccountActionToken: vi.fn(),
  getAccountActionTokenById: vi.fn(),
  listTeamInviteTokens: vi.fn(),
  revokeAccountActionToken: vi.fn(),
  toPublicAccountActionToken: (row: { id: string; team_id: string }) => ({
    id: row.id,
    teamId: row.team_id,
  }),
}));
vi.mock("@/lib/edge/admin/access", () => ({
  canManageTeam: vi.fn(),
  teamById: vi.fn(),
}));
vi.mock("@/lib/edge/admin/auth", () => ({ requireActor: vi.fn() }));
vi.mock("@/lib/edge/system-config", () => ({ readConfig: vi.fn() }));
vi.mock("@/lib/edge/auth/member-site-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertSitesBelongToTeam: vi.fn(),
}));
vi.mock("@/lib/edge/auth/secret-encryption", () => ({
  decryptTeamInviteToken: vi.fn(),
  encryptTeamInviteToken: vi.fn(),
}));

const actor = {
  user: { id: "actor-1" },
  isAdmin: false,
} as unknown as Awaited<ReturnType<typeof requireActor>>;
const env = { DB: {} } as unknown as Env;
const record = {
  id: "invite-1",
  type: "team_invite" as const,
  teamId: "team-1",
  userId: "",
  email: "",
  payload: { teamRole: "member" } as Record<string, unknown>,
  createdByUserId: "actor-1",
  createdAt: 1,
  expiresAt: 2,
  usedAt: null,
  usedByUserId: "",
  revokedAt: null,
  status: "active" as const,
};

function call(method: string, body?: unknown, query = "") {
  const url = new URL(`https://app.example.test/api/invites${query}`);
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleTeamInvitesAdmin(req, env, url);
}
async function errorMessage(response: Response) {
  return JSON.stringify(await response.json());
}

describe("team invite admin handler branches", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requireActor).mockResolvedValue(actor);
    vi.mocked(canManageTeam).mockResolvedValue(true);
    vi.mocked(teamById).mockResolvedValue({
      id: "team-1",
      ownerUserId: "actor-1",
    });
    vi.mocked(readConfig).mockResolvedValue(null);
    vi.mocked(assertSitesBelongToTeam).mockResolvedValue(true);
    vi.mocked(createAccountActionToken).mockResolvedValue({
      token: "tok",
      record,
    } as never);
    vi.mocked(listTeamInviteTokens).mockResolvedValue([]);
  });

  it("returns the auth response when the actor is rejected", async () => {
    vi.mocked(requireActor).mockResolvedValue(
      new Response("no", { status: 401 }),
    );
    expect((await call("GET")).status).toBe(401);
  });

  describe("GET", () => {
    it("requires a team id, access and an existing team", async () => {
      const missing = await call("GET");
      expect(missing.status).toBe(400);
      expect(await errorMessage(missing)).toContain("teamId is required");

      vi.mocked(canManageTeam).mockResolvedValueOnce(false);
      expect((await call("GET", undefined, "?teamId=team-1")).status).toBe(403);

      vi.mocked(teamById).mockResolvedValueOnce(null);
      const notFound = await call("GET", undefined, "?teamId=team-1");
      expect(notFound.status).toBe(404);
      expect(await errorMessage(notFound)).toContain("Team not found");
    });

    it("leaves invites without usable tokens free of urls and strips ciphertext", async () => {
      vi.mocked(listTeamInviteTokens).mockResolvedValue([
        { ...record, id: "plain" },
        {
          ...record,
          id: "broken",
          payload: { teamRole: "member", tokenEncrypted: "bad" },
        },
      ]);
      vi.mocked(decryptTeamInviteToken).mockRejectedValue(new Error("x"));
      const response = await call("GET", undefined, "?teamId=team-1");
      const body = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };
      expect(body.data).toHaveLength(2);
      for (const invite of body.data) {
        expect(invite.url).toBeUndefined();
        expect(invite.code).toBeUndefined();
        expect(invite.payload).toEqual({ teamRole: "member" });
      }
    });
  });

  describe("POST", () => {
    const post = (body: unknown) => call("POST", body);

    it("rejects creation when invites are disabled", async () => {
      vi.mocked(readConfig).mockResolvedValue({ enabled: false });
      const response = await post({ teamId: "team-1" });
      expect(response.status).toBe(403);
      expect(await errorMessage(response)).toContain(
        "Team invites are disabled",
      );
    });

    it("validates team, access, email and sites", async () => {
      expect((await post({})).status).toBe(400);

      vi.mocked(canManageTeam).mockResolvedValueOnce(false);
      const forbidden = await post({ teamId: "team-1" });
      expect(forbidden.status).toBe(403);
      expect(await errorMessage(forbidden)).toContain(
        "Only team admins can create invites",
      );

      vi.mocked(teamById).mockResolvedValueOnce(null);
      expect((await post({ teamId: "team-1" })).status).toBe(404);

      const badEmail = await post({ teamId: "team-1", email: "ab" });
      expect(badEmail.status).toBe(400);
      expect(await errorMessage(badEmail)).toContain(
        "A valid email is required",
      );

      vi.mocked(assertSitesBelongToTeam).mockResolvedValueOnce(false);
      const badSites = await post({ teamId: "team-1", siteIds: ["other"] });
      expect(badSites.status).toBe(400);
      expect(await errorMessage(badSites)).toContain(
        "siteIds must belong to the team",
      );
      expect(createAccountActionToken).not.toHaveBeenCalled();
    });

    it("creates an email-less invite and tolerates encryption failure", async () => {
      vi.mocked(encryptTeamInviteToken).mockRejectedValue(new Error("no key"));
      const response = await post({ teamId: "team-1", role: "admin" });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { url: string; invite: { code: string } };
      };
      expect(body.data.url).toBe("https://app.example.test/invite#token=tok");
      expect(body.data.invite.code).toBe("tok");

      const args = vi.mocked(createAccountActionToken).mock.calls[0]![1];
      expect(args.email).toBeNull();
      const payload = await (
        args.tokenPayload as (token: string) => Promise<unknown>
      )("tok");
      expect(payload).toEqual({
        teamRole: "admin",
        siteIds: [],
        allowRegistration: true,
      });
    });
  });

  describe("PATCH", () => {
    const patch = (body: unknown) => call("PATCH", body);

    it("validates the revoke request", async () => {
      const unsupported = await patch({ intent: "delete" });
      expect(unsupported.status).toBe(400);
      expect(await errorMessage(unsupported)).toContain(
        "Unsupported invite action",
      );
      expect(
        await errorMessage(await patch({ intent: "revoke", inviteId: "i" })),
      ).toContain("teamId is required");
      expect(
        await errorMessage(await patch({ intent: "revoke", teamId: "t" })),
      ).toContain("inviteId is required");

      vi.mocked(canManageTeam).mockResolvedValueOnce(false);
      const forbidden = await patch({
        intent: "revoke",
        teamId: "team-1",
        inviteId: "invite-1",
      });
      expect(forbidden.status).toBe(403);
      expect(await errorMessage(forbidden)).toContain(
        "Only team admins can revoke invites",
      );
    });

    it("returns 404 for unknown, non-invite or foreign-team tokens", async () => {
      const body = { intent: "revoke", teamId: "team-1", inviteId: "invite-1" };
      const row = {
        id: "invite-1",
        type: "team_invite",
        team_id: "team-1",
      } as never;
      vi.mocked(getAccountActionTokenById).mockResolvedValueOnce(null);
      expect((await patch(body)).status).toBe(404);
      vi.mocked(getAccountActionTokenById).mockResolvedValueOnce({
        ...(row as object),
        type: "password_reset",
      } as never);
      expect((await patch(body)).status).toBe(404);
      vi.mocked(getAccountActionTokenById).mockResolvedValueOnce({
        ...(row as object),
        team_id: "team-2",
      } as never);
      const response = await patch(body);
      expect(response.status).toBe(404);
      expect(await errorMessage(response)).toContain("Invite not found");
      expect(revokeAccountActionToken).not.toHaveBeenCalled();
    });
  });

  it("rejects other methods", async () => {
    expect((await call("DELETE")).status).toBe(405);
  });
});
