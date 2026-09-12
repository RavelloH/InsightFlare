import { fnv1a } from "@/lib/realtime/demo-utils";

const DEMO_CURSOR_VERSION = 1;
const DEMO_CURSOR_SECRET = "insightflare-demo-pagination-v1";
const MAX_DEMO_CURSOR_LENGTH = 12_288;
const MAX_DEMO_CURSOR_PAYLOAD_BYTES = 8_192;

export type DemoPagination = {
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export class DemoInvalidCursorError extends Error {
  readonly code = "invalid-cursor";

  constructor() {
    super("invalid-cursor");
    this.name = "DemoInvalidCursorError";
  }
}

function defaultRowSearchValues<T>(row: T): readonly unknown[] {
  if (!row || typeof row !== "object") return [row];
  const record = row as Record<string, unknown>;
  return [
    record.label,
    record.value,
    record.pathname,
    record.referrer,
    record.channel,
    record.key,
  ];
}

function numericRowValue(row: unknown, key: string): number {
  if (!row || typeof row !== "object") return 0;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function defaultRowComparator<T>(
  params: Record<string, string | number>,
): ((left: T, right: T) => number) | undefined {
  const comparisonEnabled =
    params.compare === "same" || params.compare === "previous";
  const normalSort =
    params.sort === "sessions" ||
    params.sort === "visitors" ||
    params.sort === "views"
      ? params.sort
      : null;
  if (!comparisonEnabled && !normalSort) return undefined;

  const direction = params.direction === "asc" ? 1 : -1;
  const metric = params.metric === "visitors" ? "visitors" : "views";
  const sortBy =
    params.sortBy === "reference" || params.sortBy === "change"
      ? params.sortBy
      : "current";
  const comparisonValue = (row: T, side: "current" | "reference") => {
    if (side === "current") return numericRowValue(row, metric);
    if (!row || typeof row !== "object") return 0;
    return numericRowValue((row as Record<string, unknown>).reference, metric);
  };
  const comparisonChange = (row: T) => {
    if (!row || typeof row !== "object") return Number.NEGATIVE_INFINITY;
    const change = (row as Record<string, unknown>).change;
    if (!change || typeof change !== "object") return Number.NEGATIVE_INFINITY;
    const metricChange = (change as Record<string, unknown>)[metric];
    if (!metricChange || typeof metricChange !== "object") {
      return Number.NEGATIVE_INFINITY;
    }
    const relative = (metricChange as Record<string, unknown>).relative;
    return typeof relative === "number" && Number.isFinite(relative)
      ? relative
      : Number.NEGATIVE_INFINITY;
  };
  const rowLabel = (row: T) =>
    String(
      defaultRowSearchValues(row).find((value) => String(value ?? "").trim()) ??
        "",
    );

  return (left, right) => {
    if (comparisonEnabled) {
      if (sortBy === "change") {
        const leftNew =
          comparisonValue(left, "reference") === 0 &&
          comparisonValue(left, "current") > 0;
        const rightNew =
          comparisonValue(right, "reference") === 0 &&
          comparisonValue(right, "current") > 0;
        if (leftNew !== rightNew) {
          return direction === 1 ? (leftNew ? 1 : -1) : leftNew ? -1 : 1;
        }
      }
      const leftValue =
        sortBy === "reference"
          ? comparisonValue(left, "reference")
          : sortBy === "change"
            ? comparisonChange(left)
            : comparisonValue(left, "current");
      const rightValue =
        sortBy === "reference"
          ? comparisonValue(right, "reference")
          : sortBy === "change"
            ? comparisonChange(right)
            : comparisonValue(right, "current");
      return (
        (leftValue - rightValue) * direction ||
        rowLabel(left).localeCompare(rowLabel(right))
      );
    }

    return (
      (numericRowValue(left, normalSort!) -
        numericRowValue(right, normalSort!)) *
        direction || rowLabel(left).localeCompare(rowLabel(right))
    );
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function signature(payload: string): string {
  return fnv1a(`${DEMO_CURSOR_SECRET}:${payload}`)
    .toString(16)
    .padStart(8, "0");
}

function cursorPayload(binding: unknown, key: unknown): string {
  return JSON.stringify({
    v: DEMO_CURSOR_VERSION,
    binding: JSON.stringify(canonicalize(binding)),
    key: canonicalize(key),
  });
}

export function encodeDemoCursor(binding: unknown, key: unknown): string {
  const payload = cursorPayload(binding, key);
  return `${encodeBase64Url(payload)}.${signature(payload)}`;
}

export function decodeDemoCursor<T>(
  cursor: unknown,
  binding: unknown,
  validateKey: (value: unknown) => value is T,
): T | null {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  if (typeof cursor !== "string" || cursor.length > MAX_DEMO_CURSOR_LENGTH) {
    throw new DemoInvalidCursorError();
  }
  const separator = cursor.lastIndexOf(".");
  if (separator <= 0 || separator === cursor.length - 1) {
    throw new DemoInvalidCursorError();
  }
  try {
    const payloadPart = cursor.slice(0, separator);
    const payload = decodeBase64Url(payloadPart);
    if (
      new TextEncoder().encode(payload).byteLength >
      MAX_DEMO_CURSOR_PAYLOAD_BYTES
    ) {
      throw new DemoInvalidCursorError();
    }
    if (signature(payload) !== cursor.slice(separator + 1)) {
      throw new DemoInvalidCursorError();
    }
    const parsed = JSON.parse(payload) as {
      v?: unknown;
      binding?: unknown;
      key?: unknown;
    };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Object.keys(parsed).length !== 3 ||
      parsed.v !== DEMO_CURSOR_VERSION ||
      parsed.binding !== JSON.stringify(canonicalize(binding)) ||
      !validateKey(parsed.key)
    ) {
      throw new DemoInvalidCursorError();
    }
    return parsed.key;
  } catch (error) {
    if (error instanceof DemoInvalidCursorError) throw error;
    throw new DemoInvalidCursorError();
  }
}

export function demoPage<T>(
  rows: readonly T[],
  params: Record<string, string | number>,
  binding: unknown,
  defaultLimit: number,
  maxLimit = 500,
  zeroUsesFallback = true,
  options?: {
    search?: string;
    getSearchValues?: (row: T) => readonly unknown[];
    compare?: (left: T, right: T) => number;
  },
): { items: T[]; pagination: DemoPagination } {
  const rawLimit = Number(params.limit ?? defaultLimit);
  const parsedLimit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : null;
  const limit = Math.max(
    1,
    Math.min(
      maxLimit,
      parsedLimit === null || (zeroUsesFallback && parsedLimit <= 0)
        ? defaultLimit
        : parsedLimit,
    ),
  );
  const search =
    options?.search?.trim().toLowerCase() ??
    String(params.search ?? params.q ?? "")
      .trim()
      .toLowerCase();
  const searchValues = options?.getSearchValues ?? defaultRowSearchValues;
  const searchableRows = search
    ? rows.filter((row) =>
        searchValues(row).some((value) =>
          String(value ?? "")
            .trim()
            .toLowerCase()
            .includes(search),
        ),
      )
    : [...rows];
  const compare = options?.compare ?? defaultRowComparator<T>(params);
  const orderedRows = compare
    ? [...searchableRows].sort(compare)
    : searchableRows;
  const cursor = decodeDemoCursor(
    params.cursor,
    binding,
    (value): value is { index: number } =>
      Boolean(
        value &&
        typeof value === "object" &&
        Object.keys(value).length === 1 &&
        Number.isSafeInteger((value as { index?: unknown }).index) &&
        (value as { index: number }).index >= 0,
      ),
  );
  const start = cursor?.index ?? 0;
  const requested = orderedRows.slice(start, start + limit + 1);
  const items = requested.slice(0, limit);
  const hasMore = requested.length > limit;
  return {
    items,
    pagination: {
      limit,
      returned: items.length,
      hasMore,
      nextCursor: hasMore
        ? encodeDemoCursor(binding, { index: start + items.length })
        : null,
    },
  };
}
