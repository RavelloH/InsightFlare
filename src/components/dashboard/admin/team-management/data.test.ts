import { beforeEach, describe, expect, it, vi } from "vitest";

const requestAdminService = vi.hoisted(() => vi.fn());

vi.mock("@/lib/dashboard-api/client/admin-service", () => ({
  requestAdminService,
}));

import {
  buildSitePath,
  fetchTeamInvites,
  fetchTeamMembers,
  fetchTeamSites,
  postJson,
} from "./model";

beforeEach(() => {
  requestAdminService.mockReset().mockResolvedValue([]);
});

describe("team management data access helpers", () => {
  it("builds team site paths and fetches members, sites, and invites with signals", async () => {
    const controller = new AbortController();
    expect(buildSitePath("en", "team-one", "site-one")).toBe(
      "/en/app/team-one/site-one",
    );
    await fetchTeamMembers("team-1", controller.signal);
    await fetchTeamSites("team-1", controller.signal);
    await fetchTeamInvites("team-1", controller.signal);
    expect(requestAdminService).toHaveBeenNthCalledWith(1, "members", {
      params: { teamId: "team-1" },
      signal: controller.signal,
    });
    expect(requestAdminService).toHaveBeenNthCalledWith(2, "sites", {
      params: { teamId: "team-1" },
      signal: controller.signal,
    });
    expect(requestAdminService).toHaveBeenNthCalledWith(3, "team-invites", {
      params: { teamId: "team-1" },
      signal: controller.signal,
    });
  });

  it("posts admin service mutations with the requested method and body", async () => {
    const body = { teamId: "team-1", intent: "remove" };
    await postJson("teams", body);
    expect(requestAdminService).toHaveBeenLastCalledWith("teams", {
      method: "POST",
      body,
    });
    await postJson("members", body, "PATCH");
    expect(requestAdminService).toHaveBeenLastCalledWith("members", {
      method: "PATCH",
      body,
    });
  });
});
