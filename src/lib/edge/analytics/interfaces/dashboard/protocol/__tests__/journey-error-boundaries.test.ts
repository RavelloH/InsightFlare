import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleJourneyCollectionContract,
  handleJourneyEventDetailContract,
  handleSessionDetailContract,
  handleSessionsContract,
  handleVisitorDetailContract,
  handleVisitorsContract,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/journeys";
import type { Env } from "@/lib/edge/types";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/edge/analytics/composition", async (importOriginal) => ({
  ...(await importOriginal()),
  createEdgeSiteAnalyticsRuntime: () => ({ execute: mocks.execute }),
}));
const env = {} as Env;
const context = { requestId: "journey-check" } as never;
const url = (params: string) =>
  new URL("https://example.test/api/private/visitors?" + params);

beforeEach(() => {
  mocks.execute
    .mockReset()
    .mockResolvedValue({ ok: true, data: { items: [{ id: "one" }] } });
});

describe("journey protocol rejects incomplete context and invalid windows", () => {
  it("rejects malformed analysis parameters before issuing SQL query", async () => {
    expect(
      (
        await handleVisitorsContract(
          env,
          "site",
          url("from=100&to=20"),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleVisitorsContract(
          env,
          "site",
          url("from=0&to=50&analysisOutcome=converted"),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleVisitorsContract(
          env,
          "site",
          url(
            "from=0&to=50&analysisType=goal&analysisId=abc&analysisOutcome=converted",
          ),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleSessionsContract(
          env,
          "site",
          url(
            "from=0&to=50&analysisType=funnel&analysisId=abc&analysisStepId=step&analysisOutcome=invalid",
          ),
          context,
        )
      ).status,
    ).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects malformed detail windows and propagates query failures", async () => {
    expect(
      (
        await handleSessionDetailContract(
          env,
          "site",
          url("sessionId=s1&from=100&to=50"),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleVisitorDetailContract(
          env,
          "site",
          url("visitorId=v1&from=100&to=50"),
          context,
        )
      ).status,
    ).toBe(400);
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid-cursor" },
    });
    expect(
      (await handleVisitorsContract(env, "site", url("from=0&to=50"), context))
        .status,
    ).toBe(400);
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid-cursor" },
    });
    expect(
      (await handleSessionsContract(env, "site", url("from=0&to=50"), context))
        .status,
    ).toBe(400);
  });

  it("propagates safe domain errors from visitor and session details", async () => {
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid-cursor" },
    });
    expect(
      (
        await handleVisitorDetailContract(
          env,
          "site",
          url("visitorId=v1&from=0&to=50"),
          context,
        )
      ).status,
    ).toBe(400);
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid-cursor" },
    });
    expect(
      (
        await handleSessionDetailContract(
          env,
          "site",
          url("sessionId=s1&from=0&to=50"),
          context,
        )
      ).status,
    ).toBe(400);
  });

  it("validates collection target before execution and returns the canonical result", async () => {
    expect(
      (
        await handleJourneyCollectionContract(
          env,
          "site",
          url("from=100&to=50"),
          "visitor-events",
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleJourneyCollectionContract(
          env,
          "site",
          url("from=0&to=50"),
          "visitor-events",
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleJourneyCollectionContract(
          env,
          "site",
          url("from=0&to=50"),
          "session-events",
          context,
        )
      ).status,
    ).toBe(400);
    const success = await handleJourneyCollectionContract(
      env,
      "site",
      url("visitorId=v1&from=0&to=50"),
      "visitor-sessions",
      context,
    );
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({
      ok: true,
      data: { items: [{ id: "one" }] },
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      "visitor-sessions",
      expect.objectContaining({ visitorId: "v1" }),
    );
  });

  it("validates journey-event ID, kind, window, and backend failures", async () => {
    expect(
      (
        await handleJourneyEventDetailContract(
          env,
          "site",
          url("from=0&to=50"),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleJourneyEventDetailContract(
          env,
          "site",
          url("eventId=e1&eventKind=wrong&from=0&to=50"),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleJourneyEventDetailContract(
          env,
          "site",
          url("eventId=e1&from=100&to=50"),
          context,
        )
      ).status,
    ).toBe(400);
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid-cursor" },
    });
    expect(
      (
        await handleJourneyEventDetailContract(
          env,
          "site",
          url("eventId=e1&from=0&to=50"),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleJourneyEventDetailContract(
          env,
          "site",
          url("eventId=e1&eventKind=pageview&from=0&to=50"),
          context,
        )
      ).status,
    ).toBe(200);
  });
});
