import {
  matchScore,
  normalized,
  type SearchKind,
  type SearchScope,
} from "./core";

/** Persisted fields are an explicit closed list: never accept arbitrary payload keys. */
export const SAFE_FIELDS = [
  "page.path",
  "referrer.domain",
  "event.name",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "client.browser",
] as const;
export type SafeField = (typeof SAFE_FIELDS)[number];
export interface ObservedCandidate {
  field: SafeField;
  value: string;
}
export interface PerceptionValue extends ObservedCandidate {
  id: string;
  kind: SearchKind;
  scope: Required<SearchScope>;
  observedAt: number;
  observeCount: number; // Seen locally; NOT PV, UV, or database frequency.
}
const TTL_MS = 30 * 86400_000;
export const MAX_PER_SCOPE = 500;
export const MAX_TOTAL = 2000;
const DB_NAME = "insightflare-perception-v1";
const DB_VERSION = 2;
const SAFE_SET: ReadonlySet<string> = new Set(SAFE_FIELDS);
export function isSafeField(field: string): field is SafeField {
  return SAFE_SET.has(field);
}
const ID_PATTERN =
  /(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|[a-f0-9]{24,}|(?:^|[/_-])[0-9]{10,}(?:$|[/_-]))/iu;
const SECRET_PATTERN =
  /(?:token|secret|password|passwd|apikey|api_key|bearer|authorization|sessionid|visitorid)/iu;
const scopeKey = (scope: Required<SearchScope>) =>
  JSON.stringify([scope.userId, scope.teamId, scope.siteId]);
const valueId = (scope: Required<SearchScope>, field: string, value: string) =>
  JSON.stringify([
    scope.userId,
    scope.teamId,
    scope.siteId,
    field,
    normalized(value),
  ]);
function fieldKind(field: SafeField): SearchKind {
  if (field === "page.path") return "page";
  if (field === "referrer.domain") return "referrer";
  if (field === "event.name") return "event";
  if (field === "client.browser") return "browser";
  return "campaign";
}
/** Strictly sanitize *before* memory or IndexedDB, not just before display. */
export function safeCandidate(
  field: string,
  raw: unknown,
): ObservedCandidate | null {
  if (!SAFE_SET.has(field) || typeof raw !== "string") return null;
  const candidate = raw.normalize("NFKC").trim();
  if (
    !candidate ||
    candidate.length > 120 ||
    /[\p{Cc}<>"'@?#\\]/u.test(candidate) ||
    /%0[0-9adf]|%2[36f]|%3[fdd]|%40/iu.test(candidate) ||
    ID_PATTERN.test(candidate) ||
    SECRET_PATTERN.test(candidate)
  )
    return null;
  if (field === "page.path") {
    if (
      !candidate.startsWith("/") ||
      candidate.startsWith("//") ||
      !/^\/[\p{L}\p{N}/._~%-]*$/u.test(candidate)
    )
      return null;
  } else if (field === "referrer.domain") {
    if (
      !/^(?=.{1,120}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(candidate) ||
      !candidate.includes(".")
    )
      return null;
  } else if (
    !/^[\p{L}\p{N} _./:-]+$/u.test(candidate) ||
    candidate.startsWith("/") ||
    candidate.includes("://")
  )
    return null;
  return { field: field as SafeField, value: candidate };
}
function isCurrent(record: PerceptionValue, now: number): boolean {
  return record.observedAt <= now && now - record.observedAt <= TTL_MS;
}
function validScope(scope: SearchScope): scope is Required<SearchScope> {
  return Boolean(scope.userId && scope.teamId && scope.siteId);
}
const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 compatibility: preserve valid values; add missing stores only.
      if (!db.objectStoreNames.contains("values"))
        db.createObjectStore("values", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}
export class PerceptionIndex {
  private records = new Map<string, PerceptionValue>();
  private loaded = new Set<string>();
  private dbPromise: Promise<IDBDatabase | null> | undefined;
  private onChange = new Set<() => void>();
  private revision = 0;
  private epoch = 0;
  private pending: Promise<void> = Promise.resolve();
  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.pending.then(action, action);
    this.pending = next.catch(() => undefined);
    return next;
  }
  /** Storage is best-effort; local suggestions must survive private mode / quota failures. */
  public storageMode: "indexeddb" | "memory" = "memory";

  subscribe = (listener: () => void) => {
    this.onChange.add(listener);
    return () => {
      this.onChange.delete(listener);
    };
  };
  private notify() {
    this.revision++;
    for (const listener of this.onChange) listener();
  }
  getRevision() {
    return this.revision;
  }
  private database() {
    return (this.dbPromise ??= openDatabase());
  }
  /** Account switch purges persistent records from other users; scope checks still apply on every read. */
  private async ensureOwner(db: IDBDatabase, userId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["meta", "values"], "readwrite");
      const meta = tx.objectStore("meta");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const owner = meta.get("activeUserId");
      owner.onsuccess = () => {
        if (owner.result === userId) return;
        const cursorRequest = tx.objectStore("values").openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const item = cursor.value as PerceptionValue;
          if (item.scope?.userId !== userId) cursor.delete();
          cursor.continue();
        };
        meta.put(userId, "activeUserId");
      };
    });
  }
  private trim(now: number) {
    const valid = [...this.records.values()].filter((r) => isCurrent(r, now));
    const byScope = new Map<string, number>();
    valid.sort((a, b) => b.observedAt - a.observedAt);
    this.records.clear();
    for (const item of valid) {
      const key = scopeKey(item.scope);
      const count = byScope.get(key) ?? 0;
      if (count >= MAX_PER_SCOPE || this.records.size >= MAX_TOTAL) continue;
      byScope.set(key, count + 1);
      this.records.set(item.id, item);
    }
  }
  async load(scope: SearchScope): Promise<void> {
    if (!validScope(scope)) return;
    const namespace = scopeKey(scope);
    if (this.loaded.has(namespace)) return;
    this.loaded.add(namespace);
    const epoch = this.epoch;
    const db = await this.database();
    if (!db || this.epoch !== epoch) return;
    try {
      await this.serialize(() => this.ensureOwner(db, scope.userId));
      if (this.epoch !== epoch) return;
      const items = (await requestResult(
        db.transaction("values", "readonly").objectStore("values").getAll(),
      )) as PerceptionValue[];
      const now = Date.now();
      if (this.epoch !== epoch) return;
      for (const record of items) {
        // Validate all persisted data again: stale DB versions are not trusted.
        if (
          !record ||
          !record.scope ||
          scopeKey(record.scope) !== namespace ||
          !isCurrent(record, now)
        )
          continue;
        const safe = safeCandidate(record.field, record.value);
        if (
          !safe ||
          record.id !== valueId(record.scope, safe.field, safe.value) ||
          record.kind !== fieldKind(safe.field)
        )
          continue;
        if (!this.records.has(record.id)) this.records.set(record.id, record);
      }
      this.trim(now);
      this.storageMode = "indexeddb";
      this.notify();
      // Pruning is intentionally separate from reads and capped by MAX_TOTAL.
      void this.pruneDatabase(db).catch(() => {
        this.storageMode = "memory";
      });
    } catch {
      this.storageMode = "memory";
    }
  }
  observe(scope: SearchScope, candidates: readonly ObservedCandidate[]): void {
    if (!validScope(scope)) return;
    const now = Date.now();
    const accepted = candidates
      .slice(0, 100)
      .map((item) => safeCandidate(item.field, item.value))
      .filter((item): item is ObservedCandidate => Boolean(item));
    if (!accepted.length) return;
    for (const candidate of accepted) {
      const id = valueId(scope, candidate.field, candidate.value);
      const old = this.records.get(id);
      this.records.set(id, {
        ...candidate,
        id,
        kind: fieldKind(candidate.field),
        scope,
        observedAt: now,
        observeCount: Math.min(65535, (old?.observeCount ?? 0) + 1),
      });
    }
    this.trim(now);
    this.notify();
    void this.serialize(() => this.persist(scope, accepted, now));
  }
  private async persist(
    scope: Required<SearchScope>,
    accepted: readonly ObservedCandidate[],
    now: number,
  ) {
    const db = await this.database();
    if (!db) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("values", "readwrite");
        const store = tx.objectStore("values");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
        for (const item of accepted) {
          const id = valueId(scope, item.field, item.value);
          const get = store.get(id);
          get.onsuccess = () => {
            const old = get.result as PerceptionValue | undefined;
            store.put({
              ...item,
              id,
              kind: fieldKind(item.field),
              scope,
              observedAt: now,
              observeCount: Math.min(65535, (old?.observeCount ?? 0) + 1),
            } satisfies PerceptionValue);
          };
        }
      });
      this.storageMode = "indexeddb";
      await this.pruneDatabase(db);
    } catch {
      this.storageMode = "memory";
    }
  }
  private async pruneDatabase(db: IDBDatabase) {
    const records = (await requestResult(
      db.transaction("values", "readonly").objectStore("values").getAll(),
    )) as PerceptionValue[];
    const seen = new Map<string, number>();
    const now = Date.now();
    const doomed: string[] = [];
    records.sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0));
    for (let i = 0; i < records.length; i++) {
      const item = records[i];
      const ns = item.scope ? scopeKey(item.scope) : "";
      const count = seen.get(ns) ?? 0;
      if (
        !item.scope ||
        !safeCandidate(item.field, item.value) ||
        !isCurrent(item, now) ||
        count >= MAX_PER_SCOPE ||
        i >= MAX_TOTAL
      )
        doomed.push(item.id);
      else seen.set(ns, count + 1);
    }
    if (!doomed.length) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("values", "readwrite");
      for (const id of doomed) tx.objectStore("values").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  search(
    scope: SearchScope,
    query: string,
    field?: string,
    limit = 12,
  ): PerceptionValue[] {
    if (!validScope(scope)) return [];
    const now = Date.now();
    const result = [...this.records.values()].filter(
      (r) =>
        r.scope.userId === scope.userId &&
        r.scope.teamId === scope.teamId &&
        r.scope.siteId === scope.siteId &&
        (!field || r.field === field) &&
        isCurrent(r, now) &&
        matchScore(r.value, query) > 0,
    );
    return result
      .sort(
        (a, b) =>
          matchScore(b.value, query) - matchScore(a.value, query) ||
          b.observedAt - a.observedAt ||
          a.id.localeCompare(b.id),
      )
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }
  async clearUser(userId: string): Promise<void> {
    for (const [key, value] of this.records)
      if (value.scope.userId === userId) this.records.delete(key);
    this.loaded.clear();
    this.epoch++;
    this.notify();
    return this.serialize(async () => {
      const db = await this.database();
      if (!db) return;
      try {
        const all = (await requestResult(
          db.transaction("values", "readonly").objectStore("values").getAll(),
        )) as PerceptionValue[];
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("values", "readwrite");
          for (const item of all)
            if (item.scope?.userId === userId)
              tx.objectStore("values").delete(item.id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        this.storageMode = "memory";
      }
    });
  }
  async clearScope(scope: Required<SearchScope>): Promise<void> {
    for (const [key, value] of this.records)
      if (scopeKey(value.scope) === scopeKey(scope)) this.records.delete(key);
    this.loaded.delete(scopeKey(scope));
    this.epoch++;
    this.notify();
    return this.serialize(async () => {
      const db = await this.database();
      if (!db) return;
      try {
        const all = (await requestResult(
          db.transaction("values", "readonly").objectStore("values").getAll(),
        )) as PerceptionValue[];
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("values", "readwrite");
          for (const item of all)
            if (item.scope && scopeKey(item.scope) === scopeKey(scope))
              tx.objectStore("values").delete(item.id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {
        this.storageMode = "memory";
      }
    });
  }
  /** Drop decrypted in-memory view immediately on account/navigation change. */
  resetMemory() {
    this.epoch++;
    this.records.clear();
    this.loaded.clear();
    this.notify();
  }
}
export const perceptionIndex = new PerceptionIndex();
