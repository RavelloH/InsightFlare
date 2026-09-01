import { describe, expect, it, vi } from "vitest";

import { sweepIngestAlarms } from "@/lib/edge/ingest-alarm-sweep";
import type { InvocationLogger } from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";

function logger(): InvocationLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as InvocationLogger;
}

function createEnv(
  siteIds: string[],
  responses: Response[] = siteIds.map(
    () => new Response(null, { status: 200 }),
  ),
) {
  let responseIndex = 0;
  const fetch = vi.fn(async () => responses[responseIndex++]);
  const get = vi.fn(() => ({ fetch }));
  const env = {
    DB: {
      prepare: vi.fn(() => ({
        all: vi.fn(async () => ({
          results: siteIds.map((id) => ({ id })),
        })),
      })),
    },
    INGEST_DO: {
      idFromName: vi.fn((siteId: string) => siteId),
      get,
    },
  } as unknown as Env;
  return { env, fetch, get };
}

describe("sweepIngestAlarms", () => {
  it("reconciles every site without forcing a flush", async () => {
    const { env, fetch, get } = createEnv(["site-a", "site-b"]);

    await sweepIngestAlarms(env, logger());

    expect(get).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://ingest.internal/reconcile",
      {
        method: "POST",
      },
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://ingest.internal/reconcile",
      {
        method: "POST",
      },
    );
  });

  it("continues the sweep when one site cannot be reconciled", async () => {
    const { env, fetch } = createEnv(
      ["site-a", "site-b"],
      [
        new Response(null, { status: 500 }),
        new Response(null, { status: 200 }),
      ],
    );
    const observability = logger();

    await sweepIngestAlarms(env, observability);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(observability.warn).toHaveBeenCalledWith(
      "scheduled.ingest_alarm_sweep_site_failed",
      expect.objectContaining({ siteId: "site-a" }),
    );
  });
});
