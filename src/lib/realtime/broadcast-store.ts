import type { RealtimeBroadcastMessage } from "@/lib/realtime/types";

type BroadcastCallback = (
  message: RealtimeBroadcastMessage,
) => void | Promise<void>;

interface BroadcastEntry {
  id: symbol;
  callback: BroadcastCallback;
}

const callbacks: BroadcastEntry[] = [];

export function registerRealtimeBroadcastCallback(
  id: symbol,
  callback: BroadcastCallback,
): void {
  callbacks.push({ id, callback });
}

export function unregisterRealtimeBroadcastCallback(id: symbol): void {
  const index = callbacks.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    callbacks.splice(index, 1);
  }
}

export async function broadcastRealtimeMessage(
  message: RealtimeBroadcastMessage,
): Promise<void> {
  await Promise.allSettled(
    callbacks.map(({ callback }) => Promise.resolve(callback(message))),
  );
}

export function getRealtimeBroadcastCallbackCount(): number {
  return callbacks.length;
}
