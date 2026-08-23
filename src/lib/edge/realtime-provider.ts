import "@tanstack/react-start/server-only";

import type { Env } from "@/lib/edge/types";
import {
  RealtimeEventSchema,
  RealtimeVisitSchema,
  type RealtimeEvent,
  type RealtimeVisit,
} from "@/schemas/realtime";

export interface RealtimeSnapshot {
  readonly activeNow: number;
  readonly events: readonly RealtimeEvent[];
  readonly visits: readonly RealtimeVisit[];
}

function parseEvents(value: unknown): readonly RealtimeEvent[] {
  const result = RealtimeEventSchema.array().safeParse(value);
  if (!result.success) {
    throw new Error("data-unavailable");
  }
  return result.data;
}

function parseVisits(value: unknown): readonly RealtimeVisit[] {
  const result = RealtimeVisitSchema.array().safeParse(value);
  if (!result.success) {
    throw new Error("data-unavailable");
  }
  return result.data;
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
        events?: unknown;
        visits?: unknown;
      };
      const activeNow =
        typeof value.activeNow === "number" &&
        Number.isSafeInteger(value.activeNow) &&
        value.activeNow >= 0
          ? value.activeNow
          : 0;
      return {
        activeNow,
        events: parseEvents(value.events ?? []),
        visits: parseVisits(value.visits ?? []),
      };
    } catch {
      throw new Error("data-unavailable");
    }
  }

  async activeNow(input: {
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
