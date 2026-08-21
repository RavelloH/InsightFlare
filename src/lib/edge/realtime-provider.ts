import "@tanstack/react-start/server-only";

import type { Env } from "@/lib/edge/types";

export interface RealtimeSnapshot {
  readonly activeVisitors: number;
  readonly events: readonly Record<string, unknown>[];
  readonly sessions: readonly Record<string, unknown>[];
}

function asRecords(value: unknown): readonly Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => !item || typeof item !== "object" || Array.isArray(item),
    )
  ) {
    throw new Error("data-unavailable");
  }
  return value as readonly Record<string, unknown>[];
}

/** Encapsulates the ingest Durable Object transport for typed realtime readers. */
export class RealtimeProvider {
  constructor(private readonly env: Env) {}

  async snapshot(input: {
    readonly siteId: string;
    readonly fromMs: number;
    readonly toMs: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<RealtimeSnapshot> {
    try {
      const stub = this.env.INGEST_DO.get(
        this.env.INGEST_DO.idFromName(input.siteId),
      );
      const params = new URLSearchParams({
        from: String(input.fromMs),
        to: String(input.toMs),
        limit: String(input.limit),
      });
      const response = await stub.fetch(
        `https://ingest.internal/snapshot?${params}`,
        {
          method: "GET",
          signal: input.signal,
        },
      );
      if (!response.ok) throw new Error("data-unavailable");
      const value = (await response.json()) as {
        activeNow?: unknown;
        data?: unknown;
      };
      const activeVisitors =
        typeof value.activeNow === "number" &&
        Number.isSafeInteger(value.activeNow) &&
        value.activeNow >= 0
          ? value.activeNow
          : 0;
      return {
        activeVisitors,
        events: asRecords(value.data ?? []),
        sessions: [],
      };
    } catch {
      throw new Error("data-unavailable");
    }
  }

  async activeVisitors(input: {
    readonly siteId: string;
    readonly signal?: AbortSignal;
  }): Promise<number> {
    try {
      const stub = this.env.INGEST_DO.get(
        this.env.INGEST_DO.idFromName(input.siteId),
      );
      const response = await stub.fetch("https://ingest.internal/active", {
        method: "GET",
        signal: input.signal,
      });
      if (!response.ok) throw new Error("data-unavailable");
      const value = (await response.json()) as { activeNow?: unknown };
      return typeof value.activeNow === "number" &&
        Number.isSafeInteger(value.activeNow) &&
        value.activeNow >= 0
        ? value.activeNow
        : 0;
    } catch {
      throw new Error("data-unavailable");
    }
  }
}
