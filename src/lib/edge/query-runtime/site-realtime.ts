import "@tanstack/react-start/server-only";

import { RealtimeProvider } from "@/lib/edge/realtime-provider";
import type { Env } from "@/lib/edge/types";

interface RealtimeInput {
  readonly env: Env;
  readonly siteId: string;
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly signal?: AbortSignal;
}

async function snapshot(input: RealtimeInput & { readonly limit: number }) {
  return new RealtimeProvider(input.env).snapshot({
    siteId: input.siteId,
    fromMs: input.startMs,
    toMs: input.endExclusiveMs,
    limit: input.limit,
    signal: input.signal,
  });
}

export function readSiteRealtimeSnapshot(
  input: RealtimeInput & { readonly limit: number },
) {
  return snapshot(input);
}

export async function readSiteRealtimeActiveVisitors(input: RealtimeInput) {
  return {
    activeVisitors: await new RealtimeProvider(input.env).activeVisitors(input),
  };
}

export async function readSiteRealtimeEvents(
  input: RealtimeInput & { readonly limit: number },
) {
  return { items: (await snapshot(input)).events };
}

export async function readSiteRealtimeSessions(
  input: RealtimeInput & { readonly limit: number },
) {
  return { items: (await snapshot(input)).sessions };
}
