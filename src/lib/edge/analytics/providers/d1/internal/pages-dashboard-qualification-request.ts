import type {
  Interval,
  PagesDashboardMetric,
  QueryAudience,
  QueryInput,
  QueryTime,
  SortDirection,
} from "@/lib/edge/analytics/contract";

import type { DeferredEventQualification } from "./advanced-filter-execution";

const REQUEST_BRAND = Symbol("insightflare.pages-dashboard-qualification");
const brandedRequests = new WeakSet<object>();
const requestOrigins = new WeakMap<object, object>();
const INTERVALS = ["minute", "hour", "day", "week", "month"] as const;
const METRICS = [
  "views",
  "visitors",
  "sessions",
  "bounceRate",
  "pagesPerSession",
  "avgDurationMs",
] as const;

export interface PagesDashboardQualificationConfiguration {
  readonly interval: Interval;
  readonly limit: number;
  readonly cursorText: string | null;
  readonly search: string | undefined;
  readonly sort: PagesDashboardMetric;
  readonly direction: SortDirection;
  readonly audience: QueryAudience;
}

export type DeferredPagesDashboardQualificationInput =
  DeferredEventQualification & {
    readonly operation: "pages-dashboard";
    readonly requestTime: QueryTime;
    readonly pagesDashboardRequest: PagesDashboardQualificationConfiguration;
  };

export interface DeferredPagesDashboardQualification {
  readonly operation: "pages-dashboard";
  readonly configuration: PagesDashboardQualificationConfiguration;
  readonly qualification: DeferredPagesDashboardQualificationInput;
  readonly requestSnapshot: string;
}

type DataRead =
  | {
      readonly present: false;
      readonly valid: boolean;
      readonly value?: undefined;
    }
  | { readonly present: true; readonly valid: true; readonly value: unknown }
  | {
      readonly present: true;
      readonly valid: false;
      readonly value?: undefined;
    };

const INVALID = Symbol("invalid-pages-dashboard-snapshot");
const NOT_POLICY_SET = Symbol("not-pages-dashboard-policy-set");
const NOT_FILTER_DOCUMENT = Symbol("not-pages-dashboard-filter-document");

function readData(value: unknown, key: PropertyKey): DataRead {
  if (!value || typeof value !== "object")
    return { present: false, valid: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { present: false, valid: true };
    if (!descriptor.enumerable || !("value" in descriptor))
      return { present: true, valid: false };
    return { present: true, valid: true, value: descriptor.value };
  } catch {
    return { present: true, valid: false };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowedKeys.includes(key))
        return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/** Parse only the own-data request shape supported by the production path. */
export function pagesDashboardQualificationConfigurationFromQuery(
  value: unknown,
): PagesDashboardQualificationConfiguration | undefined {
  const interval = readData(value, "interval");
  const page = readData(value, "page");
  const search = readData(value, "search");
  const sort = readData(value, "sort");
  const comparison = readData(value, "comparison");
  const current = readData(value, "current");
  const reference = readData(value, "reference");
  const context = readData(value, "context");
  const time = readData(value, "time");
  const filters = readData(value, "filters");
  const scopePlan = readData(value, "scopePlan");
  if (
    !interval.valid ||
    !page.valid ||
    !search.valid ||
    !sort.valid ||
    !comparison.valid ||
    !current.valid ||
    !reference.valid ||
    !context.valid ||
    !time.valid ||
    !time.present ||
    !filters.valid ||
    !filters.present ||
    !scopePlan.valid ||
    !scopePlan.present ||
    scopePlan.value === undefined ||
    (comparison.present && comparison.value !== undefined) ||
    (current.present && current.value !== undefined) ||
    (reference.present && reference.value !== undefined) ||
    typeof interval.value !== "string" ||
    !(INTERVALS as readonly string[]).includes(interval.value) ||
    (search.present &&
      search.value !== undefined &&
      typeof search.value !== "string")
  )
    return undefined;

  const contextRecord = exactDataRecord(context.value, ["subject", "policy"]);
  const subjectRead = readData(contextRecord, "subject");
  const policyRead = readData(contextRecord, "policy");
  const subject = exactDataRecord(subjectRead.value, ["kind", "siteId"]);
  const policyAudience = readData(policyRead.value, "audience");
  const subjectKind = readData(subject, "kind");
  const subjectSiteId = readData(subject, "siteId");
  if (
    !contextRecord ||
    !subjectRead.valid ||
    !policyRead.valid ||
    !subject ||
    !subjectKind.valid ||
    !subjectSiteId.valid ||
    !policyAudience.valid ||
    subjectKind.value !== "site" ||
    typeof subjectSiteId.value !== "string" ||
    policyAudience.value !== "private-dashboard"
  )
    return undefined;

  let limit = 12;
  let cursorText: string | null = null;
  if (page.present && page.value !== undefined && page.value !== null) {
    const pageRecord = exactDataRecord(page.value, ["limit", "cursor"]);
    const pageLimit = readData(pageRecord, "limit");
    const pageCursor = readData(pageRecord, "cursor");
    if (
      !pageRecord ||
      !pageLimit.valid ||
      !pageLimit.present ||
      !pageCursor.valid ||
      !Number.isSafeInteger(pageLimit.value) ||
      (pageLimit.value as number) < 0 ||
      (pageLimit.value as number) >= Number.MAX_SAFE_INTEGER ||
      (pageCursor.present &&
        pageCursor.value !== undefined &&
        pageCursor.value !== null &&
        typeof pageCursor.value !== "string")
    )
      return undefined;
    limit = pageLimit.value as number;
    cursorText = (pageCursor.value as string | null | undefined) ?? null;
  }

  let metric: PagesDashboardMetric = "views";
  let direction: SortDirection = "desc";
  if (sort.present && sort.value !== undefined) {
    const sortRecord = exactDataRecord(sort.value, ["key", "direction"]);
    const key = readData(sortRecord, "key");
    const sortDirection = readData(sortRecord, "direction");
    if (
      !sortRecord ||
      !key.valid ||
      !key.present ||
      !sortDirection.valid ||
      !sortDirection.present ||
      typeof key.value !== "string" ||
      !(METRICS as readonly string[]).includes(key.value) ||
      (sortDirection.value !== "asc" && sortDirection.value !== "desc")
    )
      return undefined;
    metric = key.value as PagesDashboardMetric;
    direction = sortDirection.value as SortDirection;
  }

  return Object.freeze({
    interval: interval.value as Interval,
    limit,
    cursorText,
    search: search.value as string | undefined,
    sort: metric,
    direction,
    audience: "private-dashboard",
  });
}

function ownDataSnapshot(
  value: unknown,
  allowHiddenRootSymbols = false,
  initialDepth = 0,
): unknown | typeof INVALID {
  let visited = 0;
  const active = new WeakSet<object>();
  const clone = (current: unknown, depth: number): unknown | typeof INVALID => {
    if (depth > 40 || ++visited > 20_000) return INVALID;
    if (current === undefined || current === null) return current;
    if (
      typeof current === "string" ||
      typeof current === "boolean" ||
      typeof current === "number"
    )
      return typeof current === "number" && !Number.isFinite(current)
        ? INVALID
        : current;
    if (typeof current !== "object") return INVALID;
    if (active.has(current)) return INVALID;
    active.add(current);
    try {
      if (current instanceof Set) {
        if (
          Object.getPrototypeOf(current) !== Set.prototype ||
          Reflect.ownKeys(current).length !== 0
        )
          return INVALID;
        const values: string[] = [];
        Set.prototype.forEach.call(current, (entry: unknown) => {
          if (typeof entry !== "string") throw INVALID;
          values.push(entry);
        });
        return values.sort();
      }
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current);
        if (
          keys.length !== current.length + 1 ||
          !keys.includes("length") ||
          keys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)),
          )
        )
          return INVALID;
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            current,
            String(index),
          );
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
            return INVALID;
          const entry = clone(descriptor.value, depth + 1);
          if (entry === INVALID) return INVALID;
          result.push(entry);
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return INVALID;
      const result: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const key of Reflect.ownKeys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor) return INVALID;
        if (typeof key === "symbol") {
          if (depth === 0 && allowHiddenRootSymbols && !descriptor.enumerable)
            continue;
          return INVALID;
        }
        if (!descriptor.enumerable || !("value" in descriptor)) return INVALID;
        const isPolicySet =
          depth === 2 &&
          (key === "allowedOperations" ||
            key === "allowedDimensions" ||
            key === "allowedFilters" ||
            key === "allowedDetails");
        const policySet = isPolicySet
          ? snapshotPolicySet(descriptor.value)
          : NOT_POLICY_SET;
        const filterDocument =
          depth === 0 && key === "filters"
            ? snapshotFilterDocument(descriptor.value)
            : NOT_FILTER_DOCUMENT;
        const entry =
          filterDocument !== NOT_FILTER_DOCUMENT
            ? filterDocument
            : policySet !== NOT_POLICY_SET
              ? policySet
              : clone(descriptor.value, depth + 1);
        if (entry === INVALID) return INVALID;
        result[key] = entry;
      }
      return result;
    } catch {
      return INVALID;
    } finally {
      active.delete(current);
    }
  };
  return clone(value, initialDepth);
}

function snapshotPolicySet(
  value: unknown,
): unknown[] | typeof INVALID | typeof NOT_POLICY_SET {
  if (value instanceof Set) {
    try {
      if (
        Object.getPrototypeOf(value) !== Set.prototype ||
        Reflect.ownKeys(value).length !== 0
      )
        return INVALID;
      const entries: unknown[] = [];
      Set.prototype.forEach.call(value, (entry: unknown) =>
        entries.push(entry),
      );
      if (
        entries.some((entry) => typeof entry !== "string") ||
        new Set(entries).size !== entries.length
      )
        return INVALID;
      return entries.sort() as string[];
    } catch {
      return INVALID;
    }
  }
  if (!isPlainRecord(value)) return INVALID;
  const fields = ["size", "has", "entries", "keys", "values", "forEach"];
  try {
    if (!Object.isFrozen(value)) return INVALID;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length + 1 ||
      fields.some((field) => !keys.includes(field)) ||
      !keys.includes(Symbol.iterator)
    )
      return INVALID;
    const size = Object.getOwnPropertyDescriptor(value, "size");
    if (!size || !size.enumerable || typeof size.get !== "function" || size.set)
      return INVALID;
    const forEach = Object.getOwnPropertyDescriptor(value, "forEach");
    const iterator = Object.getOwnPropertyDescriptor(value, Symbol.iterator);
    if (
      !forEach ||
      !forEach.enumerable ||
      typeof forEach.value !== "function" ||
      !iterator ||
      !iterator.enumerable ||
      typeof iterator.value !== "function"
    )
      return INVALID;
    for (const field of fields.filter(
      (field) => field !== "size" && field !== "forEach",
    )) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        typeof descriptor.value !== "function"
      )
        return INVALID;
    }
    const entries: unknown[] = [];
    Reflect.apply(forEach.value, value, [
      (entry: unknown) => entries.push(entry),
    ]);
    if (
      entries.some((entry) => typeof entry !== "string") ||
      new Set(entries).size !== entries.length
    )
      return INVALID;
    return entries.sort() as string[];
  } catch {
    return INVALID;
  }
}

function snapshotFilterDocument(
  value: unknown,
): unknown | typeof INVALID | typeof NOT_FILTER_DOCUMENT {
  if (value === undefined || value === null) return value;
  if (!isPlainRecord(value)) return INVALID;
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const symbolMetadata: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const allowedSymbols = new Set([
    "insightflare.scoped-filter-metadata",
    "insightflare.filter-scope-preference",
    "insightflare.saved-filter-scope-preference",
  ]);
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return INVALID;
      if (typeof key === "string") {
        if (!descriptor.enumerable) return INVALID;
        const entry = ownDataSnapshot(descriptor.value);
        if (entry === INVALID) return INVALID;
        result[key] = entry;
        continue;
      }
      const name = key.description;
      if (
        descriptor.enumerable ||
        name === undefined ||
        !allowedSymbols.has(name) ||
        Object.hasOwn(symbolMetadata, name)
      )
        return INVALID;
      const entry = ownDataSnapshot(descriptor.value);
      if (entry === INVALID) return INVALID;
      symbolMetadata[name] = entry;
    }
  } catch {
    return INVALID;
  }
  if (Object.keys(symbolMetadata).length > 0)
    result.$internalSymbols = symbolMetadata;
  return result;
}

function stableJson(value: unknown): string | undefined {
  if (value === undefined) return "null";
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const items = value.map(stableJson);
    return items.some((item) => item === undefined)
      ? undefined
      : `[${items.join(",")}]`;
  }
  if (!value || typeof value !== "object") return undefined;
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const part = stableJson((value as Record<string, unknown>)[key]);
    if (part === undefined) return undefined;
    entries.push(`${JSON.stringify(key)}:${part}`);
  }
  return `{${entries.join(",")}}`;
}

export function qualificationRequestOwnDataSnapshot(
  value: unknown,
): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) return undefined;
      if (typeof key === "symbol") {
        if (descriptor.enumerable || !("value" in descriptor)) return undefined;
        continue;
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      const entry =
        key === "filters"
          ? snapshotFilterDocument(descriptor.value)
          : ownDataSnapshot(descriptor.value, false, 1);
      if (entry === INVALID || entry === NOT_FILTER_DOCUMENT) {
        return undefined;
      }
      snapshot[key] = entry;
    }
  } catch {
    return undefined;
  }
  return stableJson(snapshot);
}

function requestSnapshot(value: unknown): string | undefined {
  return qualificationRequestOwnDataSnapshot(value);
}

export function pagesDashboardQualificationConfigurationsEqual(
  left: PagesDashboardQualificationConfiguration,
  right: PagesDashboardQualificationConfiguration,
): boolean {
  return (
    left.interval === right.interval &&
    left.limit === right.limit &&
    left.cursorText === right.cursorText &&
    left.search === right.search &&
    left.sort === right.sort &&
    left.direction === right.direction &&
    left.audience === right.audience
  );
}

export function pagesDashboardOwnDataSnapshotsEqual(
  left: unknown,
  right: unknown,
): boolean {
  const leftSnapshot = ownDataSnapshot(left);
  const rightSnapshot = ownDataSnapshot(right);
  if (leftSnapshot === INVALID || rightSnapshot === INVALID) return false;
  const leftJson = stableJson(leftSnapshot);
  return leftJson !== undefined && leftJson === stableJson(rightSnapshot);
}

export function attachPagesDashboardQualificationToQuery(
  query: QueryInput & Record<string, unknown>,
  qualification: DeferredPagesDashboardQualificationInput,
  configuration: PagesDashboardQualificationConfiguration,
): void {
  const current = pagesDashboardQualificationConfigurationFromQuery(query);
  const snapshot = requestSnapshot(query);
  if (!current)
    throw new Error(
      "pages_dashboard_qualification_request_configuration_invalid",
    );
  if (!pagesDashboardQualificationConfigurationsEqual(current, configuration))
    throw new Error(
      "pages_dashboard_qualification_request_configuration_changed",
    );
  if (snapshot === undefined)
    throw new Error("pages_dashboard_qualification_request_snapshot_invalid");
  const request: DeferredPagesDashboardQualification = Object.freeze({
    operation: "pages-dashboard",
    configuration,
    qualification,
    requestSnapshot: snapshot,
  });
  brandedRequests.add(request);
  requestOrigins.set(request, query);
  Object.defineProperty(query, REQUEST_BRAND, {
    value: request,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

export function deferredPagesDashboardQualificationFromQuery(
  value: unknown,
): DeferredPagesDashboardQualification | undefined {
  if (!value || typeof value !== "object") return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, REQUEST_BRAND);
  } catch {
    throw new Error("pages_dashboard_qualification_request_untrusted");
  }
  if (!descriptor) return undefined;
  if (descriptor.enumerable || !("value" in descriptor))
    throw new Error("pages_dashboard_qualification_request_untrusted");
  const request: unknown = descriptor.value;
  if (
    !request ||
    typeof request !== "object" ||
    !brandedRequests.has(request) ||
    requestOrigins.get(request) !== value
  )
    throw new Error("pages_dashboard_qualification_request_untrusted");
  const branded = request as DeferredPagesDashboardQualification;
  const configuration =
    pagesDashboardQualificationConfigurationFromQuery(value);
  const snapshot = requestSnapshot(value);
  if (
    !configuration ||
    !pagesDashboardQualificationConfigurationsEqual(
      configuration,
      branded.configuration,
    ) ||
    snapshot === undefined ||
    snapshot !== branded.requestSnapshot ||
    branded.qualification.operation !== "pages-dashboard" ||
    !pagesDashboardQualificationConfigurationsEqual(
      branded.qualification.pagesDashboardRequest,
      branded.configuration,
    )
  )
    throw new Error("pages_dashboard_qualification_request_changed");
  return branded;
}
