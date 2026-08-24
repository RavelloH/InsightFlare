/**
 * In-isolate aggregate cache. Keys are already opaque canonical hashes: this
 * class never accepts request objects or user supplied identifiers, which
 * keeps cache identity and transport data separate.
 */
export interface OperationCachePolicy {
  readonly ttlMs: number;
  readonly maxEntries: number;
  /** Hard serialized UTF-8 cap; oversized results are success-but-uncached. */
  readonly maxEntryBytes?: number;
}

export type OperationCacheStatus = "hit" | "miss" | "shared" | "bypass";

export interface OperationCacheResult<T> {
  readonly value: T;
  readonly status: OperationCacheStatus;
  readonly ageMs: number;
}

const NON_SEMANTIC_KEYS = new Set([
  "requestId",
  "generatedAt",
  "capturedAt",
  "capturedAtMs",
  "diagnostics",
  "cacheAge",
  "rowsRead",
  "responseBytes",
]);

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([key]) => !NON_SEMANTIC_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new TypeError("cache identity must be JSON-compatible");
}

/** Hashes canonical query semantics before they reach a cache map/key. */
export async function createOperationCacheKey(input: {
  readonly contractRevision: string;
  readonly operation: string;
  readonly operationRevision: string;
  readonly subjectFingerprint: string;
  readonly policyRevision: string;
  readonly query: unknown;
}): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `__query_cache/v1/${input.operation}/${hash}`;
}

interface Entry<T> {
  readonly value: T;
  readonly writtenAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * Bounded success-only cache with per-key single-flight. Backend failures are
 * intentionally not represented here: callers may bypass this in-isolate
 * layer without turning an analytics read into an error.
 */
export class OperationResultCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly pending = new Map<string, Promise<unknown>>();

  async getOrLoad<T>(input: {
    readonly key: string;
    readonly policy: OperationCachePolicy | null;
    readonly load: () => Promise<T>;
    readonly now?: () => number;
  }): Promise<OperationCacheResult<T>> {
    const now = input.now?.() ?? Date.now();
    const policy = input.policy;
    if (!policy || policy.ttlMs <= 0 || policy.maxEntries <= 0) {
      return { value: await input.load(), status: "bypass", ageMs: 0 };
    }

    const cached = this.entries.get(input.key) as Entry<T> | undefined;
    if (cached && cached.expiresAtMs > now) {
      // Refresh insertion order so eviction is bounded LRU.
      this.entries.delete(input.key);
      this.entries.set(input.key, cached);
      return {
        value: cached.value,
        status: "hit",
        ageMs: now - cached.writtenAtMs,
      };
    }
    if (cached) this.entries.delete(input.key);

    const running = this.pending.get(input.key) as Promise<T> | undefined;
    if (running) {
      return { value: await running, status: "shared", ageMs: 0 };
    }

    const load = input.load();
    this.pending.set(input.key, load);
    try {
      const value = await load;
      if (
        policy.maxEntryBytes !== undefined &&
        new TextEncoder().encode(canonicalJson(value)).byteLength >
          policy.maxEntryBytes
      ) {
        return { value, status: "bypass", ageMs: 0 };
      }
      const writtenAtMs = input.now?.() ?? Date.now();
      this.entries.set(input.key, {
        value,
        writtenAtMs,
        expiresAtMs: writtenAtMs + policy.ttlMs,
      });
      while (this.entries.size > policy.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (!oldest) break;
        this.entries.delete(oldest);
      }
      return { value, status: "miss", ageMs: 0 };
    } finally {
      this.pending.delete(input.key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }
}
