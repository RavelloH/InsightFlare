import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleNotificationEmailPreviewAdmin,
  handleNotificationPreferences,
  handleNotificationRead,
  handleNotificationRulePreviewAdmin,
  handleNotificationRuleRunAdmin,
  handleNotificationRulesAdmin,
  handleNotifications,
  handleNotificationsReadAll,
  handleNotificationTestAdmin,
} from "@/lib/edge/admin/notifications/handler";
const requireActor = vi.hoisted(() => vi.fn());
const canManageTeam = vi.hoisted(() => vi.fn());
const canManageSite = vi.hoisted(() => vi.fn());
const canReadTeam = vi.hoisted(() => vi.fn());
const createNotificationRule = vi.hoisted(() => vi.fn());
const deleteNotificationRule = vi.hoisted(() => vi.fn());
const listNotificationRules = vi.hoisted(() => vi.fn());
const updateNotificationRule = vi.hoisted(() => vi.fn());
const getNotificationRule = vi.hoisted(() => vi.fn());
const listNotificationMessagesForTeam = vi.hoisted(() => vi.fn());
const listNotificationMessagesForUser = vi.hoisted(() => vi.fn());
const countUnreadAttentionMessages = vi.hoisted(() => vi.fn());
const markNotificationMessageRead = vi.hoisted(() => vi.fn());
const markAllNotificationMessagesRead = vi.hoisted(() => vi.fn());
const getUserNotificationPreferences = vi.hoisted(() => vi.fn());
const updateUserNotificationPreferences = vi.hoisted(() => vi.fn());
const createManualTestNotification = vi.hoisted(() => vi.fn());
const createNotificationRulePreview = vi.hoisted(() => vi.fn());
const runNotificationRuleManually = vi.hoisted(() => vi.fn());
const runScheduledTask = vi.hoisted(() => vi.fn());
const renderNotificationEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/edge/admin/auth", () => ({
  requireActor,
}));
vi.mock("@/lib/edge/admin/access", () => ({
  canManageSite,
  canManageTeam,
  canReadTeam,
}));
vi.mock("@/lib/notifications/edge/rule-store", () => ({
  createNotificationRule,
  deleteNotificationRule,
  getNotificationRule,
  listNotificationRules,
  updateNotificationRule,
}));
vi.mock("@/lib/notifications/edge/message-store", () => ({
  countUnreadAttentionMessages,
  listNotificationMessagesForTeam,
  listNotificationMessagesForUser,
  markAllNotificationMessagesRead,
  markNotificationMessageRead,
}));
vi.mock("@/lib/notifications/edge/preferences", () => ({
  getUserNotificationPreferences,
  updateUserNotificationPreferences,
}));
vi.mock("@/lib/notifications/edge/notification-task", () => ({
  createManualTestNotification,
  createNotificationRulePreview,
  runNotificationRuleManually,
  NOTIFICATION_TASK_KEY: "notification_tick",
  NOTIFICATION_TASK_NAME: "Notification dispatch",
}));
vi.mock("@/lib/edge/scheduled-tasks/runner", () => ({
  runScheduledTask,
}));
vi.mock("@/lib/notifications/edge/email-renderer", () => ({
  renderNotificationEmail,
}));
function request(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://edge.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function getRequest(path: string): Request {
  return new Request(`https://edge.test${path}`);
}
function methodRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`https://edge.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function patchRequest(body: Record<string, unknown>): Request {
  return new Request("https://edge.test/api/private/admin/notification-rules", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function rule() {
  return {
    id: "rule-1",
    teamId: "team-1",
    siteId: "site-1",
    type: "report",
  };
}
describe("admin notification handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireActor.mockResolvedValue({
      user: { id: "user-1" },
      isAdmin: false,
    });
    updateNotificationRule.mockResolvedValue(rule());
    createNotificationRule.mockResolvedValue(rule());
    deleteNotificationRule.mockResolvedValue(true);
    listNotificationRules.mockResolvedValue([rule()]);
    listNotificationMessagesForTeam.mockResolvedValue([{ id: "msg-team" }]);
    listNotificationMessagesForUser.mockResolvedValue([{ id: "msg-user" }]);
    countUnreadAttentionMessages.mockResolvedValue(2);
    markNotificationMessageRead.mockResolvedValue({ id: "msg-1", readAt: 1 });
    markAllNotificationMessagesRead.mockResolvedValue(3);
    getUserNotificationPreferences.mockResolvedValue({ channels: {} });
    updateUserNotificationPreferences.mockResolvedValue({
      channels: { email: true },
    });
    createNotificationRulePreview.mockResolvedValue({ status: "checked" });
    runNotificationRuleManually.mockResolvedValue({
      summary: { emailFailed: 0 },
      messageCount: 0,
    });
    renderNotificationEmail.mockResolvedValue({
      subject: "Preview",
      html: "<p>Preview</p>",
      text: "Preview text",
    });
    createManualTestNotification.mockResolvedValue({
      message: { id: "msg-test", deliveryStatus: "sent" },
      summary: { messagesCreated: 1 },
    });
    runScheduledTask.mockImplementation(async (_env, _task, _opts, handler) =>
      handler({ runId: "run-1", logger: {}, startedAt: Date.now() }),
    );
  });

  it("lists, creates, and deletes notification rules", async () => {
    const url = new URL(
      "https://edge.test/api/private/admin/notification-rules?teamId=team-1&siteId=site-1",
    );
    const list = await handleNotificationRulesAdmin(
      getRequest(url.pathname + url.search),
      {} as never,
      url,
    );
    const create = await handleNotificationRulesAdmin(
      request("/api/private/admin/notification-rules", {
        teamId: " team-1 ",
        siteId: " site-1 ",
        name: "",
        description: " Desc ",
        type: "report",
        enabled: false,
        scheduleJson: { kind: "daily" },
        condition: { metric: "views" },
        recipient: { mode: "creator" },
      }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    const removed = await handleNotificationRulesAdmin(
      methodRequest(
        "DELETE",
        "/api/private/admin/notification-rules?id=rule-1",
      ),
      {} as never,
      new URL(
        "https://edge.test/api/private/admin/notification-rules?id=rule-1",
      ),
    );

    expect(list.status).toBe(200);
    expect(create.status).toBe(200);
    expect(removed.status).toBe(200);
    expect(listNotificationRules).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        teamId: "team-1",
        siteId: "site-1",
      },
    );
    expect(createNotificationRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        teamId: "team-1",
        siteId: "site-1",
        name: "Notification rule",
        enabled: false,
      }),
    );
    expect(deleteNotificationRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "rule-1",
    );
  });

  it("maps forbidden rule list access for ordinary team members", async () => {
    listNotificationRules.mockRejectedValueOnce(new Error("Forbidden"));
    const url = new URL(
      "https://edge.test/api/private/admin/notification-rules?teamId=team-1",
    );

    const response = await handleNotificationRulesAdmin(
      getRequest(url.pathname + url.search),
      {} as never,
      url,
    );

    expect(response.status).toBe(403);
    expect(listNotificationRules).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ user: { id: "user-1" }, isAdmin: false }),
      { teamId: "team-1", siteId: undefined },
    );
  });

  it("allows rule list access for team owners and admins", async () => {
    const url = new URL(
      "https://edge.test/api/private/admin/notification-rules?teamId=team-1",
    );

    const response = await handleNotificationRulesAdmin(
      getRequest(url.pathname + url.search),
      {} as never,
      url,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, data: [{ id: "rule-1" }] });
  });

  it("denies ordinary members rule management mutations", async () => {
    createNotificationRule.mockRejectedValueOnce(new Error("Forbidden"));
    updateNotificationRule.mockRejectedValueOnce(new Error("Forbidden"));
    deleteNotificationRule.mockRejectedValueOnce(new Error("Forbidden"));

    const create = await handleNotificationRulesAdmin(
      request("/api/private/admin/notification-rules", { teamId: "team-1" }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    const update = await handleNotificationRulesAdmin(
      patchRequest({ ruleId: "rule-1", name: "x" }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    const remove = await handleNotificationRulesAdmin(
      methodRequest(
        "DELETE",
        "/api/private/admin/notification-rules?id=rule-1",
      ),
      {} as never,
      new URL(
        "https://edge.test/api/private/admin/notification-rules?id=rule-1",
      ),
    );

    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
    expect(remove.status).toBe(403);
  });

  it("validates rule mutations and maps store errors", async () => {
    const missingTeam = await handleNotificationRulesAdmin(
      request("/api/private/admin/notification-rules", {}),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    const missingPatchId = await handleNotificationRulesAdmin(
      patchRequest({ name: "Missing id" }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    const missingDeleteId = await handleNotificationRulesAdmin(
      methodRequest("DELETE", "/api/private/admin/notification-rules"),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    updateNotificationRule.mockRejectedValueOnce(new Error("Not Found"));
    const notFound = await handleNotificationRulesAdmin(
      patchRequest({ ruleId: "missing", name: "x" }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );

    expect(missingTeam.status).toBe(400);
    expect(missingPatchId.status).toBe(400);
    expect(missingDeleteId.status).toBe(400);
    expect(notFound.status).toBe(404);
  });

  it("returns auth responses, method-not-allowed, and forbidden mapped errors", async () => {
    requireActor.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const unauthorized = await handleNotificationRulesAdmin(
      getRequest("/api/private/admin/notification-rules"),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    expect(unauthorized.status).toBe(401);

    const unsupportedRules = await handleNotificationRulesAdmin(
      methodRequest("PUT", "/api/private/admin/notification-rules"),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    const unsupportedPreview = await handleNotificationRulePreviewAdmin(
      getRequest("/api/private/admin/notification-rules/preview"),
      {} as never,
    );
    const unsupportedRun = await handleNotificationRuleRunAdmin(
      getRequest("/api/private/admin/notification-rules/run"),
      {} as never,
    );
    expect(unsupportedRules.status).toBe(405);
    expect(unsupportedPreview.status).toBe(405);
    expect(unsupportedRun.status).toBe(405);

    createNotificationRule.mockRejectedValueOnce(new Error("Forbidden"));
    const forbidden = await handleNotificationRulesAdmin(
      request("/api/private/admin/notification-rules", { teamId: "team-1" }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    updateNotificationRule.mockRejectedValueOnce("plain failure");
    const badRequest = await handleNotificationRulesAdmin(
      patchRequest({ ruleId: "rule-1", name: "x" }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );
    expect(forbidden.status).toBe(403);
    expect(badRequest.status).toBe(400);
  });

  it("passes only explicit fields for notification rule enabled patches", async () => {
    const response = await handleNotificationRulesAdmin(
      patchRequest({ ruleId: "rule-1", enabled: false }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );

    expect(response.status).toBe(200);
    expect(updateNotificationRule).toHaveBeenCalledWith(
      expect.anything(),
      {
        user: { id: "user-1" },
        isAdmin: false,
      },
      {
        ruleId: "rule-1",
        enabled: false,
      },
    );
  });

  it("passes only explicit fields for notification rule name patches", async () => {
    await handleNotificationRulesAdmin(
      patchRequest({ ruleId: "rule-1", name: "Renamed" }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );

    expect(updateNotificationRule).toHaveBeenCalledWith(
      expect.anything(),
      {
        user: { id: "user-1" },
        isAdmin: false,
      },
      {
        ruleId: "rule-1",
        name: "Renamed",
      },
    );
  });

  it("passes all supported explicit fields for notification rule patches", async () => {
    const schedule = { kind: "daily", time: "09:00" };
    const recipient = { mode: "team" };
    await handleNotificationRulesAdmin(
      patchRequest({
        id: "rule-1",
        teamId: " team-2 ",
        siteId: " ",
        name: " Renamed ",
        description: " Updated ",
        type: "traffic_spike",
        enabled: "nope",
        schedule,
        condition: { metric: "views" },
        recipient,
      }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );

    expect(updateNotificationRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        ruleId: "rule-1",
        teamId: "team-2",
        siteId: null,
        name: "Renamed",
        description: "Updated",
        type: "traffic_spike",
        schedule,
        condition: { metric: "views" },
        recipient,
      },
    );
  });

  it("ignores non-record notification rule conditions", async () => {
    await handleNotificationRulesAdmin(
      patchRequest({ ruleId: "rule-1", condition: ["bad"] }),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-rules"),
    );

    expect(updateNotificationRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { ruleId: "rule-1" },
    );
  });

  it("denies preview and manual run when the actor cannot manage the rule", async () => {
    getNotificationRule.mockResolvedValue(rule());
    canManageTeam.mockResolvedValue(false);

    const preview = await handleNotificationRulePreviewAdmin(
      request("/api/private/admin/notification-rules/preview", {
        ruleId: "rule-1",
      }),
      {} as never,
    );
    const run = await handleNotificationRuleRunAdmin(
      request("/api/private/admin/notification-rules/run", {
        ruleId: "rule-1",
      }),
      {} as never,
    );

    expect(preview.status).toBe(403);
    expect(run.status).toBe(403);
    expect(createNotificationRulePreview).not.toHaveBeenCalled();
    expect(runScheduledTask).not.toHaveBeenCalled();
    expect(runNotificationRuleManually).not.toHaveBeenCalled();
  });

  it("previews and manually runs manageable rules", async () => {
    getNotificationRule.mockResolvedValue(rule());
    canManageTeam.mockResolvedValue(true);
    canManageSite.mockResolvedValue(true);

    const preview = await handleNotificationRulePreviewAdmin(
      request("/api/private/admin/notification-rules/preview", {
        id: "rule-1",
      }),
      {} as never,
    );
    const run = await handleNotificationRuleRunAdmin(
      request("/api/private/admin/notification-rules/run", {
        ruleId: "rule-1",
      }),
      {} as never,
    );

    expect(preview.status).toBe(200);
    expect(run.status).toBe(200);
    expect(createNotificationRulePreview).toHaveBeenCalledWith(
      expect.anything(),
      rule(),
    );
    expect(runScheduledTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scopeType: "notification_rule",
        scopeId: "rule-1",
      }),
      undefined,
      expect.any(Function),
    );
  });

  it("previews site-less rules and marks failed manual runs as partial", async () => {
    getNotificationRule.mockResolvedValue({ ...rule(), siteId: null });
    canManageTeam.mockResolvedValue(true);
    runNotificationRuleManually.mockResolvedValueOnce({
      summary: { emailFailed: 1 },
      messageCount: 1,
    });
    const taskResults: Array<{ status: string }> = [];
    runScheduledTask.mockImplementationOnce(
      async (_env, _task, _opts, handler) => {
        taskResults.push(
          await handler({ runId: "run-2", logger: {}, startedAt: Date.now() }),
        );
      },
    );

    const preview = await handleNotificationRulePreviewAdmin(
      request("/api/private/admin/notification-rules/preview", {
        ruleId: "rule-1",
      }),
      {} as never,
    );
    const run = await handleNotificationRuleRunAdmin(
      request("/api/private/admin/notification-rules/run", { id: "rule-1" }),
      {} as never,
    );

    expect(preview.status).toBe(200);
    expect(run.status).toBe(200);
    expect(canManageSite).not.toHaveBeenCalled();
    expect(taskResults).toEqual([
      expect.objectContaining({ status: "partial" }),
    ]);
  });

  it("maps unmanaged rule sites to forbidden responses", async () => {
    getNotificationRule.mockResolvedValue(rule());
    canManageTeam.mockResolvedValue(true);
    canManageSite.mockResolvedValue(false);

    const preview = await handleNotificationRulePreviewAdmin(
      request("/api/private/admin/notification-rules/preview", {
        ruleId: "rule-1",
      }),
      {} as never,
    );

    expect(preview.status).toBe(403);
    expect(createNotificationRulePreview).not.toHaveBeenCalled();
  });

  it("validates preview and run payloads and maps missing manageable rules", async () => {
    const missingPreviewId = await handleNotificationRulePreviewAdmin(
      request("/api/private/admin/notification-rules/preview", {}),
      {} as never,
    );
    const missingRunId = await handleNotificationRuleRunAdmin(
      request("/api/private/admin/notification-rules/run", {}),
      {} as never,
    );
    getNotificationRule.mockResolvedValue(null);
    const notFound = await handleNotificationRulePreviewAdmin(
      request("/api/private/admin/notification-rules/preview", {
        id: "missing",
      }),
      {} as never,
    );

    expect(missingPreviewId.status).toBe(400);
    expect(missingRunId.status).toBe(400);
    expect(notFound.status).toBe(404);
  });

  it("lists notifications through team or user scoped paths", async () => {
    canManageTeam.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const teamUrl = new URL(
      "https://edge.test/api/private/notifications?teamId=team-1&userId=user-2&siteId=site-1&type=report&severity=warning&unread=1&before=120.7&limit=200",
    );
    const userUrl = new URL(
      "https://edge.test/api/private/notifications?teamId=team-2&userId=user-2&limit=nope",
    );

    const teamResponse = await handleNotifications(
      getRequest(teamUrl.pathname + teamUrl.search),
      {} as never,
      teamUrl,
    );
    const userResponse = await handleNotifications(
      getRequest(userUrl.pathname + userUrl.search),
      {} as never,
      userUrl,
    );

    expect(teamResponse.status).toBe(200);
    expect(userResponse.status).toBe(200);
    expect(listNotificationMessagesForTeam).toHaveBeenCalledWith(
      expect.anything(),
      {
        teamId: "team-1",
        userId: "user-2",
        siteId: "site-1",
        type: "report",
        severity: "warning",
        unread: true,
        limit: 100,
        before: 120,
      },
    );
    expect(listNotificationMessagesForUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "user-1",
        teamId: "team-2",
        limit: 50,
      }),
    );
  });

  it("uses the team notification path directly for admins", async () => {
    requireActor.mockResolvedValueOnce({
      user: { id: "admin-1" },
      isAdmin: true,
    });
    const url = new URL(
      "https://edge.test/api/private/notifications?teamId=team-1&limit=0&before=bad",
    );

    const response = await handleNotifications(
      getRequest(url.pathname + url.search),
      {} as never,
      url,
    );

    expect(response.status).toBe(200);
    expect(canManageTeam).not.toHaveBeenCalled();
    expect(listNotificationMessagesForTeam).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "team-1",
        limit: 1,
        before: undefined,
      }),
    );
  });

  it("returns method and mapped errors for notification lists", async () => {
    const unsupported = await handleNotifications(
      methodRequest("POST", "/api/private/notifications", {}),
      {} as never,
      new URL("https://edge.test/api/private/notifications"),
    );
    listNotificationMessagesForUser.mockRejectedValueOnce(
      new Error("Invalid notification request"),
    );
    const failed = await handleNotifications(
      getRequest("/api/private/notifications"),
      {} as never,
      new URL("https://edge.test/api/private/notifications"),
    );

    expect(unsupported.status).toBe(405);
    expect(failed.status).toBe(400);
  });

  it("lets admins request another user's notification list", async () => {
    requireActor.mockResolvedValueOnce({
      user: { id: "admin-1" },
      isAdmin: true,
    });
    const url = new URL(
      "https://edge.test/api/private/notifications?userId=user-2&unread=1&before=0&limit=5",
    );

    const response = await handleNotifications(
      getRequest(url.pathname + url.search),
      {} as never,
      url,
    );

    expect(response.status).toBe(200);
    expect(listNotificationMessagesForUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "user-2",
        unread: true,
        before: undefined,
        limit: 5,
      }),
    );
  });

  it("handles notification preferences and read actions", async () => {
    const preferences = await handleNotificationPreferences(
      getRequest("/api/private/notification-preferences"),
      {} as never,
    );
    const update = await handleNotificationPreferences(
      methodRequest("PATCH", "/api/private/notification-preferences", {
        channels: { email: true },
      }),
      {} as never,
    );
    const read = await handleNotificationRead(
      methodRequest("PATCH", "/api/private/notifications/msg-1/read"),
      {} as never,
      "msg-1",
    );
    const readAll = await handleNotificationsReadAll(
      methodRequest("PATCH", "/api/private/notifications/read-all", {
        teamId: " team-1 ",
      }),
      {} as never,
    );

    expect(preferences.status).toBe(200);
    expect(update.status).toBe(200);
    expect(read.status).toBe(200);
    expect(readAll.status).toBe(200);
    expect(markNotificationMessageRead).toHaveBeenCalledWith(
      expect.anything(),
      {
        messageId: "msg-1",
        userId: "user-1",
      },
    );
    expect(markAllNotificationMessagesRead).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: "user-1",
        teamId: "team-1",
      },
    );
  });

  it("marks all notifications read without an optional team filter", async () => {
    const readAll = await handleNotificationsReadAll(
      methodRequest("PATCH", "/api/private/notifications/read-all", {}),
      {} as never,
    );

    expect(readAll.status).toBe(200);
    expect(markAllNotificationMessagesRead).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: "user-1",
        teamId: undefined,
      },
    );
  });

  it("returns auth responses from notification sub-handlers", async () => {
    requireActor.mockResolvedValue(new Response("nope", { status: 401 }));

    const responses = await Promise.all([
      handleNotificationRulePreviewAdmin(
        request("/api/private/admin/notification-rules/preview", {
          ruleId: "rule-1",
        }),
        {} as never,
      ),
      handleNotificationRuleRunAdmin(
        request("/api/private/admin/notification-rules/run", {
          ruleId: "rule-1",
        }),
        {} as never,
      ),
      handleNotifications(
        getRequest("/api/private/notifications"),
        {} as never,
        new URL("https://edge.test/api/private/notifications"),
      ),
      handleNotificationPreferences(
        getRequest("/api/private/notification-preferences"),
        {} as never,
      ),
      handleNotificationRead(
        methodRequest("PATCH", "/api/private/notifications/msg-1/read"),
        {} as never,
        "msg-1",
      ),
      handleNotificationsReadAll(
        methodRequest("PATCH", "/api/private/notifications/read-all", {}),
        {} as never,
      ),
      handleNotificationTestAdmin(
        request("/api/private/admin/notification-test", { teamId: "team-1" }),
        {} as never,
      ),
      handleNotificationEmailPreviewAdmin(
        getRequest("/api/private/admin/notification-email-preview"),
        {} as never,
        new URL(
          "https://edge.test/api/private/admin/notification-email-preview",
        ),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401, 401, 401, 401,
    ]);
  });

  it("renders notification email previews for admins", async () => {
    requireActor.mockResolvedValue({
      user: { id: "admin-1" },
      isAdmin: true,
    });

    const html = await handleNotificationEmailPreviewAdmin(
      getRequest("/api/private/admin/notification-email-preview?type=bad"),
      {} as never,
      new URL(
        "https://edge.test/api/private/admin/notification-email-preview?type=bad&locale=bad",
      ),
    );
    const text = await handleNotificationEmailPreviewAdmin(
      getRequest("/api/private/admin/notification-email-preview?format=text"),
      {} as never,
      new URL(
        "https://edge.test/api/private/admin/notification-email-preview?type=health&format=text",
      ),
    );
    const json = await handleNotificationEmailPreviewAdmin(
      getRequest("/api/private/admin/notification-email-preview?format=json"),
      {} as never,
      new URL(
        "https://edge.test/api/private/admin/notification-email-preview?type=test&format=json",
      ),
    );

    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toBe("<p>Preview</p>");
    expect(await text.text()).toBe("Preview text");
    expect(await json.json()).toMatchObject({
      ok: true,
      data: { subject: "Preview" },
    });
    expect(renderNotificationEmail).toHaveBeenCalledTimes(3);
  });

  it("rejects non-admin and non-GET email preview requests", async () => {
    const forbidden = await handleNotificationEmailPreviewAdmin(
      getRequest("/api/private/admin/notification-email-preview"),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-email-preview"),
    );
    requireActor.mockResolvedValueOnce({
      user: { id: "admin-1" },
      isAdmin: true,
    });
    const method = await handleNotificationEmailPreviewAdmin(
      methodRequest("POST", "/api/private/admin/notification-email-preview"),
      {} as never,
      new URL("https://edge.test/api/private/admin/notification-email-preview"),
    );

    expect(forbidden.status).toBe(403);
    expect(method.status).toBe(405);
  });

  it("returns method and validation errors for preferences and read handlers", async () => {
    const unsupportedPreferences = await handleNotificationPreferences(
      methodRequest("POST", "/api/private/notification-preferences", {}),
      {} as never,
    );
    const unsupportedRead = await handleNotificationRead(
      getRequest("/api/private/notifications/msg-1/read"),
      {} as never,
      "msg-1",
    );
    const missingReadId = await handleNotificationRead(
      methodRequest("PATCH", "/api/private/notifications/read"),
      {} as never,
      "",
    );
    const unsupportedReadAll = await handleNotificationsReadAll(
      getRequest("/api/private/notifications/read-all"),
      {} as never,
    );

    expect(unsupportedPreferences.status).toBe(405);
    expect(unsupportedRead.status).toBe(405);
    expect(missingReadId.status).toBe(400);
    expect(unsupportedReadAll.status).toBe(405);
  });

  it("sends manual test notifications with permission checks", async () => {
    canReadTeam.mockResolvedValue(true);
    canManageTeam.mockResolvedValue(false);

    const self = await handleNotificationTestAdmin(
      request("/api/private/admin/notification-test", { teamId: "team-1" }),
      {} as never,
    );
    const deniedOtherUser = await handleNotificationTestAdmin(
      request("/api/private/admin/notification-test", {
        teamId: "team-1",
        userId: "user-2",
      }),
      {} as never,
    );
    canManageTeam.mockResolvedValue(true);
    const otherUser = await handleNotificationTestAdmin(
      request("/api/private/admin/notification-test", {
        teamId: "team-1",
        siteId: "site-1",
        userId: "user-2",
      }),
      {} as never,
    );

    expect(self.status).toBe(200);
    expect(deniedOtherUser.status).toBe(403);
    expect(otherUser.status).toBe(200);
    expect(createManualTestNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        siteId: "site-1",
        userId: "user-2",
      }),
    );
  });

  it("validates manual test notification permissions and partial outcomes", async () => {
    const missingTeam = await handleNotificationTestAdmin(
      request("/api/private/admin/notification-test", {}),
      {} as never,
    );
    canReadTeam.mockResolvedValueOnce(false);
    const unreadableTeam = await handleNotificationTestAdmin(
      request("/api/private/admin/notification-test", { teamId: "team-1" }),
      {} as never,
    );
    canReadTeam.mockResolvedValue(true);
    canManageTeam.mockResolvedValue(true);
    createManualTestNotification.mockResolvedValueOnce({
      message: { id: "msg-test", deliveryStatus: "failed" },
      summary: { messagesCreated: 1 },
    });
    const partial = await handleNotificationTestAdmin(
      request("/api/private/admin/notification-test", { teamId: "team-1" }),
      {} as never,
    );

    expect(missingTeam.status).toBe(400);
    expect(unreadableTeam.status).toBe(403);
    expect(partial.status).toBe(200);
    expect(runScheduledTask).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ scopeType: "team", scopeId: "team-1" }),
      undefined,
      expect.any(Function),
    );
  });
});
