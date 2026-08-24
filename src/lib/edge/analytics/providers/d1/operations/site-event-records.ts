import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  type FilterDocument,
  filterFingerprint,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { mapEventRecord } from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import {
  parseEventRecordCursor,
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
  serializeEventRecordCursor,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import type { Env } from "@/lib/edge/types";
import { sha256Hex } from "@/lib/edge/utils";
import { rootSecret } from "@/lib/secrets";

export interface ReadSiteEventRecordsInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly search?: string;
  readonly eventName?: string;
  readonly sort: {
    readonly field: "occurredAt" | "eventName" | "pathname";
    readonly direction: "asc" | "desc";
  };
  readonly page: { readonly limit: number; readonly cursor?: string | null };
}

type EventRecordPageResult = {
  readonly items: ReturnType<typeof mapEventRecord>[];
  readonly page: {
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
};

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  );
}

async function cursorBinding(
  input: ReadSiteEventRecordsInput,
): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      "event-records-v1",
      input.siteId,
      input.window.startMs,
      input.window.endExclusiveMs,
      input.window.timeZone,
      filterFingerprint(input.filters, analyticsFilterRegistry),
      input.search ?? null,
      input.eventName ?? null,
      input.sort,
    ]),
  );
}

async function decodeCursor(
  input: ReadSiteEventRecordsInput,
): Promise<string | null> {
  if (!input.page.cursor) return null;
  const secret = rootSecret(input.env);
  if (!secret) return null;
  const [payload, signature, extra] = input.page.cursor.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    (await sign(secret, payload)) !== signature
  )
    return null;
  try {
    const value = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(
            payload.replaceAll("-", "+").replaceAll("_", "/") +
              "=".repeat((4 - (payload.length % 4)) % 4),
          ),
          (character) => character.charCodeAt(0),
        ),
      ),
    ) as { binding?: string; cursor?: string };
    return value.binding === (await cursorBinding(input)) &&
      typeof value.cursor === "string"
      ? value.cursor
      : null;
  } catch {
    return null;
  }
}

async function encodeCursor(
  input: ReadSiteEventRecordsInput,
  cursor: string,
): Promise<string> {
  const secret = rootSecret(input.env);
  if (!secret) throw new Error("data-unavailable");
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ binding: await cursorBinding(input), cursor }),
    ),
  );
  return `${payload}.${await sign(secret, payload)}`;
}

export async function readSiteEventRecords(input: ReadSiteEventRecordsInput) {
  const sort = {
    key: input.sort.field,
    direction: input.sort.direction,
  } as const;
  if (!rootSecret(input.env)) throw new Error("data-unavailable");
  const rawCursor = await decodeCursor(input);
  const cursor = rawCursor ? parseEventRecordCursor(rawCursor, sort) : null;
  if (input.page.cursor && !cursor) throw new Error("invalid-cursor");
  const page = await queryEventRecordPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    {
      pageSize: input.page.limit,
      sort,
      search: input.search,
      eventName: input.eventName,
      cursor,
    },
  );
  return {
    items: page.rows.map(mapEventRecord),
    page: {
      limit: input.page.limit,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor
        ? await encodeCursor(input, serializeEventRecordCursor(page.nextCursor))
        : null,
    },
  } satisfies EventRecordPageResult;
}

export async function readSiteEventDetail(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly eventId: string;
}) {
  const result = await queryEventRecordDetailFromD1(
    input.env,
    input.siteId,
    input.eventId,
    input.window,
  );
  if (!result) throw new Error("resource-not-found");
  return result;
}
