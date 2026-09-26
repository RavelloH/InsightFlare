import {
  addZonedInterval,
  zonedParts,
  zonedTimeToUtcMs,
} from "@/lib/analytics/time-zone";

import { analyticsFilterRegistry } from "./filter-registry";
import {
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterTargetExpression,
  isLegacyFilterTarget,
  normalizeFilterDocument,
} from "./filters";
import type { FilterScope } from "./scope-preference";

export type FilterEvaluationEntityKind =
  "page" | "event" | "session" | "visitor";

export interface FilterEvaluationRange {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}

/** A browser-safe, storage-independent record used by Filter v1 execution. */
export interface FilterEvaluationEntity {
  readonly kind: FilterEvaluationEntityKind;
  readonly id: string;
  readonly time?: number;
  readonly visitId?: string;
  readonly sessionId?: string;
  readonly visitorId?: string;
  /** Canonical registry ids (for example `page.path`) map to typed values. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Legacy conditions continue to read values computed on candidate data. */
  readonly candidateFields?: Readonly<Record<string, unknown>>;
  /** Present only on Event records; JSON null is distinct from an absent path. */
  readonly payload?: unknown;
}

export interface FilterEvaluationDataset {
  readonly pages: readonly FilterEvaluationEntity[];
  readonly events: readonly FilterEvaluationEntity[];
  readonly sessions?: readonly FilterEvaluationEntity[];
  readonly visitors?: readonly FilterEvaluationEntity[];
  /** The source must state which time interval it can prove complete. */
  readonly coverageRange: FilterEvaluationRange;
}

export interface FilterEvaluationOptions {
  readonly scope: FilterScope;
  readonly candidateRange: FilterEvaluationRange;
  readonly evaluationRange?: FilterEvaluationRange;
  readonly reportingTimeZone: string;
  readonly capturedAtMs: number;
  readonly maxActivities?: number;
  readonly maxSequenceMatches?: number;
  readonly maxSequenceWork?: number;
}

export interface FilterEvaluationResult {
  readonly matchingScopeEntityIds: ReadonlySet<string>;
  readonly matchingVisitIds: ReadonlySet<string>;
  readonly matchingEventIds: ReadonlySet<string>;
}

const MISSING = Symbol("filter-missing");
type Missing = typeof MISSING;
const isMissing = (value: unknown): value is Missing => value === MISSING;

interface DurationValue {
  readonly kind: "duration-value";
  readonly milliseconds: number;
}
interface CalendarPeriodValue {
  readonly kind: "calendar-period-value";
  readonly amount: number;
  readonly unit: string;
}
interface TimeBucketValue {
  readonly kind: "time-bucket-value";
  readonly startMs: number;
  readonly endExclusiveMs: number;
}
interface PeriodValue {
  readonly kind: "period-value";
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly items: readonly unknown[];
}
interface SequenceMatchValue {
  readonly kind: "sequence-match-value";
  readonly steps: readonly FilterEvaluationEntity[];
  readonly startMs: number;
  readonly endMs: number;
  readonly spanMs: number;
}

type RuntimeValue =
  | unknown
  | Missing
  | DurationValue
  | CalendarPeriodValue
  | TimeBucketValue
  | PeriodValue
  | SequenceMatchValue;

interface RuntimeFrame {
  readonly current?: FilterEvaluationEntity;
  readonly anchor?: FilterEvaluationEntity;
  readonly sequence?: SequenceMatchValue;
  readonly period?: PeriodValue;
  readonly bucket?: TimeBucketValue;
  /** Top-level v1 conditions keep candidate-range membership semantics. */
  readonly topLevel: boolean;
  readonly legacyFieldEvaluation?: boolean;
}

interface RuntimeContext {
  readonly dataset: FilterEvaluationDataset;
  readonly options: Required<FilterEvaluationOptions>;
  readonly pages: readonly FilterEvaluationEntity[];
  readonly events: readonly FilterEvaluationEntity[];
  readonly sessions: readonly FilterEvaluationEntity[];
  readonly visitors: readonly FilterEvaluationEntity[];
  readonly candidatePages: readonly FilterEvaluationEntity[];
  readonly candidateEvents: readonly FilterEvaluationEntity[];
  readonly sequenceMatchesLimit: number;
  readonly sequenceWorkLimit: number;
  readonly sequenceStats: { matches: number; work: number };
}

const DEFAULT_MAX_ACTIVITIES = 20_000;
const DEFAULT_MAX_SEQUENCE_MATCHES = 50_000;
const DEFAULT_MAX_SEQUENCE_WORK = 1_000_000;
const DAY_MS = 86_400_000;

function inRange(
  time: number | undefined,
  range: FilterEvaluationRange,
): boolean {
  return (
    typeof time === "number" &&
    time >= range.startMs &&
    time < range.endExclusiveMs
  );
}

function compareActivity(
  left: FilterEvaluationEntity,
  right: FilterEvaluationEntity,
): number {
  return (
    (left.time ?? 0) - (right.time ?? 0) ||
    (left.kind === right.kind ? 0 : left.kind === "page" ? -1 : 1) ||
    left.id.localeCompare(right.id)
  );
}

function compareEntity(
  left: FilterEvaluationEntity,
  right: FilterEvaluationEntity,
): number {
  return (
    (left.time ?? 0) - (right.time ?? 0) || left.id.localeCompare(right.id)
  );
}

function buildAggregateEntities(
  records: readonly FilterEvaluationEntity[],
  entity: "session" | "visitor",
): FilterEvaluationEntity[] {
  const idKey = entity === "session" ? "sessionId" : "visitorId";
  const groups = new Map<string, FilterEvaluationEntity[]>();
  for (const record of records) {
    const id = record[idKey];
    if (!id) continue;
    const values = groups.get(id) ?? [];
    values.push(record);
    groups.set(id, values);
  }
  return [...groups]
    .map(([id, items]) => {
      const ordered = [...items].sort(compareActivity);
      const pageItems = ordered.filter((item) => item.kind === "page");
      const eventItems = ordered.filter((item) => item.kind === "event");
      const first = ordered[0];
      const last = ordered.at(-1);
      const firstPage = pageItems[0];
      const lastPage = pageItems.at(-1);
      const sessionIds = new Set(
        ordered
          .map((item) => item.sessionId)
          .filter((value): value is string => Boolean(value)),
      );
      const fields: Record<string, unknown> = {
        [`${entity}.views`]: pageItems.length,
        [`${entity}.events`]: eventItems.length,
        [`${entity}.sessions`]:
          entity === "visitor" ? sessionIds.size : undefined,
        [`${entity}.durationMs`]:
          entity === "session" && first && last
            ? Math.max(0, (last.time ?? 0) - (first.time ?? 0))
            : undefined,
        [`${entity}.entryPath`]: firstPage?.fields["page.path"],
        [`${entity}.exitPath`]: lastPage?.fields["page.path"],
        [`${entity}.bounce`]:
          entity === "session" ? pageItems.length <= 1 : undefined,
      };
      // Entity facts inherit stable context from the first activity in the range.
      for (const [key, value] of Object.entries(first?.fields ?? {})) {
        if (!(key in fields)) fields[key] = value;
      }
      return {
        kind: entity,
        id,
        time: first?.time,
        sessionId: entity === "session" ? id : undefined,
        visitorId: entity === "visitor" ? id : first?.visitorId,
        fields,
      } satisfies FilterEvaluationEntity;
    })
    .sort(compareEntity);
}

function createRuntimeContext(
  dataset: FilterEvaluationDataset,
  options: FilterEvaluationOptions,
): RuntimeContext {
  const evaluationRange = options.evaluationRange ?? options.candidateRange;
  if (
    !Number.isSafeInteger(evaluationRange.startMs) ||
    !Number.isSafeInteger(evaluationRange.endExclusiveMs) ||
    evaluationRange.endExclusiveMs <= evaluationRange.startMs
  )
    throw new TypeError("invalid_evaluation_range");
  if (
    evaluationRange.startMs < dataset.coverageRange.startMs ||
    evaluationRange.endExclusiveMs > dataset.coverageRange.endExclusiveMs
  )
    throw new TypeError("filter_evaluation_range_unavailable");
  const normalizedOptions: Required<FilterEvaluationOptions> = {
    ...options,
    evaluationRange,
    maxActivities: options.maxActivities ?? DEFAULT_MAX_ACTIVITIES,
    maxSequenceMatches:
      options.maxSequenceMatches ?? DEFAULT_MAX_SEQUENCE_MATCHES,
    maxSequenceWork: options.maxSequenceWork ?? DEFAULT_MAX_SEQUENCE_WORK,
  };
  const pages = [...dataset.pages].filter((record) =>
    inRange(record.time, evaluationRange),
  );
  const events = [...dataset.events].filter((record) =>
    inRange(record.time, evaluationRange),
  );
  if (pages.length + events.length > normalizedOptions.maxActivities)
    throw new TypeError("filter_activity_limit_exceeded");
  const candidatePages = dataset.pages.filter((record) =>
    inRange(record.time, options.candidateRange),
  );
  const candidateEvents = dataset.events.filter((record) =>
    inRange(record.time, options.candidateRange),
  );
  const evaluationRecords = [...pages, ...events].sort(compareActivity);
  return {
    dataset,
    options: normalizedOptions,
    pages,
    events,
    sessions: dataset.sessions
      ? dataset.sessions.filter((record) =>
          inRange(record.time, evaluationRange),
        )
      : buildAggregateEntities(evaluationRecords, "session"),
    visitors: dataset.visitors
      ? dataset.visitors.filter((record) =>
          inRange(record.time, evaluationRange),
        )
      : buildAggregateEntities(evaluationRecords, "visitor"),
    candidatePages,
    candidateEvents,
    sequenceMatchesLimit: normalizedOptions.maxSequenceMatches,
    sequenceWorkLimit: normalizedOptions.maxSequenceWork,
    sequenceStats: { matches: 0, work: 0 },
  };
}

function decodePointer(path: string): string[] {
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function payloadPath(payload: unknown, path: string): RuntimeValue {
  let current: unknown = payload;
  for (const segment of decodePointer(path)) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return MISSING;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function fieldValue(
  record: FilterEvaluationEntity | undefined,
  field: string,
  candidate = false,
): RuntimeValue {
  if (!record) return MISSING;
  if (field === "event.name" && record.kind !== "event") return MISSING;
  if (field === "page.time" && record.kind !== "page") return MISSING;
  if (field === "event.time" && record.kind !== "event") return MISSING;
  if (field === "page.path" && record.kind === "page")
    return record.fields[field] === undefined ? MISSING : record.fields[field];
  if (field === "event.name" && record.kind === "event")
    return record.fields[field] === undefined ? MISSING : record.fields[field];
  if (field === "event.time" && record.kind === "event")
    return record.time === undefined ? MISSING : record.time;
  if (field === "page.time" && record.kind === "page")
    return record.time === undefined ? MISSING : record.time;
  const fields = candidate
    ? (record.candidateFields ?? record.fields)
    : record.fields;
  if (Object.prototype.hasOwnProperty.call(fields, field)) {
    const value = fields[field];
    return value === undefined ? MISSING : value;
  }
  return MISSING;
}

function currentEntity(
  frame: RuntimeFrame,
): FilterEvaluationEntity | undefined {
  return frame.current ?? frame.anchor;
}

function memberValue(value: RuntimeValue, member: string): RuntimeValue {
  if (Array.isArray(value))
    return value.map((item) => memberValue(item as RuntimeValue, member));
  if (isMissing(value) || value === null || typeof value !== "object")
    return MISSING;
  if ("kind" in value) {
    const tagged = value as Record<string, unknown>;
    if (tagged.kind === "duration-value") return MISSING;
    if (tagged.kind === "time-bucket-value") {
      if (member === "start") return tagged.startMs as number;
      if (member === "end") return tagged.endExclusiveMs as number;
    }
    if (tagged.kind === "period-value") {
      if (member === "start") return tagged.startMs as number;
      if (member === "end") return tagged.endExclusiveMs as number;
      if (member === "items") return tagged.items as readonly unknown[];
    }
    if (tagged.kind === "sequence-match-value") {
      if (member === "start") return tagged.startMs as number;
      if (member === "end") return tagged.endMs as number;
      if (member === "span")
        return {
          kind: "duration-value",
          milliseconds: tagged.spanMs as number,
        };
      if (member === "steps")
        return tagged.steps as readonly FilterEvaluationEntity[];
    }
  }
  const entity = value as FilterEvaluationEntity;
  if (entity.kind && entity.fields && typeof entity.fields === "object") {
    if (member === "time")
      return entity.kind === "event" || entity.kind === "page"
        ? (entity.time ?? MISSING)
        : MISSING;
    if (member === "payload")
      return entity.kind === "event"
        ? entity.payload === undefined
          ? MISSING
          : entity.payload
        : MISSING;
    const direct = `${entity.kind}.${member}`;
    if (Object.prototype.hasOwnProperty.call(entity.fields, direct)) {
      const found = entity.fields[direct];
      return found === undefined ? MISSING : found;
    }
    for (const namespace of [
      "geo",
      "client",
      "referrer",
      "utm",
      "user",
      "performance",
    ]) {
      if (namespace === member) return { __filterNamespace: namespace, entity };
    }
    const nestedField = Object.keys(entity.fields).find((key) =>
      key.endsWith(`.${member}`),
    );
    if (nestedField) {
      const found = entity.fields[nestedField];
      return found === undefined ? MISSING : found;
    }
  }
  const namespaceValue = value as {
    __filterNamespace?: string;
    entity?: FilterEvaluationEntity;
  };
  if (namespaceValue.__filterNamespace && namespaceValue.entity) {
    const key = `${namespaceValue.__filterNamespace}.${member}`;
    const found = namespaceValue.entity.fields[key];
    return found === undefined ? MISSING : found;
  }
  if (Object.prototype.hasOwnProperty.call(value, member)) {
    const found = (value as Record<string, unknown>)[member];
    return found === undefined ? MISSING : found;
  }
  return MISSING;
}

function rootCollection(
  entity: "event" | "page" | "session" | "visitor",
  frame: RuntimeFrame,
  context: RuntimeContext,
): readonly FilterEvaluationEntity[] {
  const anchor = currentEntity(frame);
  const source =
    entity === "page"
      ? context.pages
      : entity === "event"
        ? context.events
        : entity === "session"
          ? context.sessions
          : context.visitors;
  if (!anchor) return source;
  if (anchor.kind === "visitor") {
    if (entity === "visitor")
      return source.filter((item) => item.id === anchor.id);
    return source.filter((item) => item.visitorId === anchor.id);
  }
  if (anchor.kind === "session") {
    if (entity === "visitor")
      return source.filter((item) => item.id === anchor.visitorId);
    if (entity === "session")
      return source.filter((item) => item.id === anchor.id);
    return source.filter((item) => item.sessionId === anchor.id);
  }
  // A top-level Event scope uses its Session as the natural local anchor.
  if (entity === "visitor")
    return source.filter((item) => item.id === anchor.visitorId);
  if (entity === "session")
    return source.filter((item) => item.id === anchor.sessionId);
  if (anchor.sessionId)
    return source.filter((item) => item.sessionId === anchor.sessionId);
  return source.filter((item) => item.id === anchor.id);
}

function elapsedMilliseconds(amount: number, unit: string): number {
  const factors: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: DAY_MS,
    w: 7 * DAY_MS,
  };
  const factor = factors[unit];
  if (factor === undefined)
    throw new TypeError("calendar_duration_not_elapsed");
  const value = amount * factor;
  if (!Number.isFinite(value)) throw new TypeError("invalid_duration");
  return value;
}

function calendarUnit(unit: string): "hour" | "day" | "week" | "month" {
  if (unit === "h") return "hour";
  if (unit === "d") return "day";
  if (unit === "w") return "week";
  if (unit === "mo" || unit === "y") return "month";
  throw new TypeError("calendar_period_required");
}

function periodStart(
  timestamp: number,
  amount: number,
  unit: string,
  timeZone: string,
): number {
  const interval = calendarUnit(unit);
  const parts = zonedParts(timestamp, timeZone);
  if (interval === "hour") {
    const hour = Math.floor(parts.hour / amount) * amount;
    return zonedTimeToUtcMs(timeZone, {
      ...parts,
      hour,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }
  if (interval === "month") {
    const monthWidth = amount * (unit === "y" ? 12 : 1);
    const index = parts.year * 12 + parts.month - 1;
    const startIndex = Math.floor(index / monthWidth) * monthWidth;
    const year = Math.floor(startIndex / 12);
    const month = (startIndex % 12) + 1;
    return zonedTimeToUtcMs(timeZone, {
      year,
      month,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }
  const dayOrdinal = Math.floor(
    Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS,
  );
  const width = amount * (interval === "week" ? 7 : 1);
  const weekday = new Date(dayOrdinal * DAY_MS).getUTCDay();
  const localWeekdayOffset = (weekday + 6) % 7;
  const naturalStart =
    interval === "week" ? dayOrdinal - localWeekdayOffset : dayOrdinal;
  const alignment = interval === "week" ? -3 : 0; // 1970-01-01 was Thursday; week starts Monday.
  const startOrdinal =
    Math.floor((naturalStart - alignment) / width) * width + alignment;
  const date = new Date(startOrdinal * DAY_MS);
  return zonedTimeToUtcMs(timeZone, {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

function periodEnd(
  start: number,
  amount: number,
  unit: string,
  timeZone: string,
): number {
  if (unit === "y")
    return addZonedInterval(start, "month", timeZone, amount * 12);
  return addZonedInterval(start, calendarUnit(unit), timeZone, amount);
}

function targetValue(
  target: FilterTargetExpression,
  frame: RuntimeFrame,
  context: RuntimeContext,
): RuntimeValue {
  switch (target.kind) {
    case "field":
      return fieldValue(
        currentEntity(frame),
        target.field,
        frame.legacyFieldEvaluation,
      );
    case "event-payload": {
      const entity = currentEntity(frame);
      return entity?.kind === "event"
        ? payloadPath(entity.payload, target.path)
        : MISSING;
    }
    case "entity-root":
      return rootCollection(target.entity, frame, context);
    case "context-root":
      if (target.context === "current") return currentEntity(frame) ?? MISSING;
      if (target.context === "sequence") return frame.sequence ?? MISSING;
      if (target.context === "period") return frame.period ?? MISSING;
      return frame.bucket ?? MISSING;
    case "member":
      return memberValue(
        targetValue(target.object, frame, context),
        target.member,
      );
    case "selector": {
      const source = targetValue(target.collection, frame, context);
      if (!Array.isArray(source)) throw new TypeError("expected_collection");
      const selected: unknown[] = [];
      for (const item of source) {
        const entity = item as FilterEvaluationEntity;
        const childFrame: RuntimeFrame = isRuntimeEntity(entity)
          ? { ...frame, current: entity, anchor: entity, topLevel: false }
          : isSequenceMatch(item)
            ? { ...frame, current: undefined, sequence: item, topLevel: false }
            : isPeriodValue(item)
              ? { ...frame, current: undefined, period: item, topLevel: false }
              : isTimeBucket(item)
                ? {
                    ...frame,
                    current: undefined,
                    bucket: item,
                    topLevel: false,
                  }
                : { ...frame, current: entity, topLevel: false };
        if (
          evaluateExpression(
            target.predicate,
            {
              ...childFrame,
            },
            context,
          )
        )
          selected.push(item);
      }
      return selected;
    }
    case "projection": {
      const source = targetValue(target.collection, frame, context);
      if (!Array.isArray(source)) throw new TypeError("expected_collection");
      const values = source.map((item) => {
        const entity = item as FilterEvaluationEntity;
        if (target.member === "payload")
          return target.path
            ? payloadPath(entity.payload, target.path)
            : entity.payload === undefined
              ? MISSING
              : entity.payload;
        if (target.member === "time") return entity.time ?? MISSING;
        return fieldValue(entity, `${entity.kind}.${target.member}`);
      });
      return values.filter((value) => !isMissing(value));
    }
    case "reducer": {
      const input = targetValue(target.input, frame, context);
      if (!Array.isArray(input)) throw new TypeError("expected_collection");
      const values = input as readonly RuntimeValue[];
      switch (target.reducer) {
        case "count":
          return values.length;
        case "first":
          return values.length ? values[0]! : MISSING;
        case "last":
          return values.length ? values.at(-1)! : MISSING;
        case "nth": {
          const value = values[(target.index ?? 1) - 1];
          return value === undefined ? MISSING : value;
        }
        case "sum":
          return values.reduce<number>(
            (sum, value) =>
              sum +
              (typeof value === "number" && Number.isFinite(value) ? value : 0),
            0,
          );
        case "avg": {
          const numbers = values.filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value),
          );
          return numbers.length
            ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
            : null;
        }
        case "min":
        case "max": {
          const scalars = values.filter(
            (value) =>
              value !== null &&
              !isMissing(value) &&
              ["string", "number", "boolean"].includes(typeof value),
          );
          if (!scalars.length) return null;
          const type = typeof scalars[0];
          const comparable = scalars.filter(
            (value) => typeof value === type,
          ) as Array<string | number | boolean>;
          comparable.sort(compareScalar);
          return target.reducer === "min" ? comparable[0]! : comparable.at(-1)!;
        }
        case "countDistinct": {
          const keys = new Set(
            values.filter((value) => !isMissing(value)).map(distinctKey),
          );
          return keys.size;
        }
      }
      throw new TypeError("unknown_reducer");
    }
    case "arithmetic": {
      const left = targetValue(target.left, frame, context);
      const right = targetValue(target.right, frame, context);
      if (isMissing(left) || isMissing(right)) return MISSING;
      if (left === null || right === null) return null;
      if (
        target.operator === "sub" &&
        typeof left === "number" &&
        typeof right === "number"
      )
        return {
          kind: "duration-value",
          milliseconds: left - right,
        } satisfies DurationValue;
      if (typeof left !== "number" || typeof right !== "number") return null;
      if (target.operator === "div" && right === 0) return null;
      if (target.operator === "add") return left + right;
      if (target.operator === "sub") return left - right;
      if (target.operator === "mul") return left * right;
      return left / right;
    }
    case "duration":
      if (target.unit === "mo" || target.unit === "y")
        return {
          kind: "calendar-period-value",
          amount: target.amount,
          unit: target.unit,
        } satisfies CalendarPeriodValue;
      return {
        kind: "duration-value",
        milliseconds: elapsedMilliseconds(target.amount, target.unit),
      } satisfies DurationValue;
    case "time-anchor": {
      const base =
        target.anchor === "now"
          ? context.options.capturedAtMs
          : target.anchor === "range.start"
            ? context.options.candidateRange.startMs
            : context.options.candidateRange.endExclusiveMs;
      const offset = target.offset
        ? elapsedMilliseconds(target.offset.amount, target.offset.unit)
        : 0;
      return base + offset;
    }
    case "bucket": {
      const source = targetValue(target.input, frame, context);
      if (!Array.isArray(source)) throw new TypeError("expected_collection");
      const buckets: TimeBucketValue[] = [];
      for (const timeValue of source) {
        const time = dateNumber(timeValue);
        if (time === null) continue;
        const startMs = periodStart(
          time,
          target.interval.amount,
          target.interval.unit,
          context.options.reportingTimeZone,
        );
        buckets.push({
          kind: "time-bucket-value",
          startMs,
          endExclusiveMs: periodEnd(
            startMs,
            target.interval.amount,
            target.interval.unit,
            context.options.reportingTimeZone,
          ),
        });
      }
      return buckets;
    }
    case "window": {
      const source = targetValue(target.collection, frame, context);
      if (!Array.isArray(source)) throw new TypeError("expected_collection");
      const anchor = dateNumber(targetValue(target.anchor, frame, context));
      if (anchor === null) return [];
      const start =
        anchor +
        elapsedMilliseconds(target.startOffset.amount, target.startOffset.unit);
      const end =
        anchor +
        elapsedMilliseconds(target.endOffset.amount, target.endOffset.unit);
      if (start >= end) throw new TypeError("invalid_window_range");
      return source.filter((item) => {
        const time =
          item && typeof item === "object" && "time" in item
            ? Number((item as FilterEvaluationEntity).time)
            : null;
        return time !== null && time >= start && time < end;
      });
    }
    case "periods": {
      const source = targetValue(target.collection, frame, context);
      if (!Array.isArray(source)) throw new TypeError("expected_collection");
      const grouped = new Map<number, unknown[]>();
      for (const item of source) {
        const time =
          item && typeof item === "object" && "time" in item
            ? Number((item as FilterEvaluationEntity).time)
            : null;
        if (time === null || !Number.isFinite(time)) continue;
        const start = periodStart(
          time,
          target.interval.amount,
          target.interval.unit,
          context.options.reportingTimeZone,
        );
        const items = grouped.get(start) ?? [];
        items.push(item);
        grouped.set(start, items);
      }
      return [...grouped]
        .sort(([left], [right]) => left - right)
        .map(
          ([startMs, items]) =>
            ({
              kind: "period-value",
              startMs,
              endExclusiveMs: periodEnd(
                startMs,
                target.interval.amount,
                target.interval.unit,
                context.options.reportingTimeZone,
              ),
              items,
            }) satisfies PeriodValue,
        );
    }
    case "sequence": {
      const steps = target.steps.map((step) => {
        const value = targetValue(step, frame, context);
        if (!Array.isArray(value))
          throw new TypeError("sequence_step_not_collection");
        return value as readonly FilterEvaluationEntity[];
      });
      if (steps.some((step) => step.length === 0)) return [];
      const matches: SequenceMatchValue[] = [];
      const picked: FilterEvaluationEntity[] = [];
      const enumerate = (
        stepIndex: number,
        previous?: FilterEvaluationEntity,
      ): void => {
        if (stepIndex === steps.length) {
          context.sequenceStats.matches += 1;
          if (context.sequenceStats.matches > context.sequenceMatchesLimit)
            throw new TypeError("filter_sequence_match_limit_exceeded");
          const first = picked[0]!;
          const last = picked.at(-1)!;
          matches.push({
            kind: "sequence-match-value",
            steps: [...picked],
            startMs: first.time ?? 0,
            endMs: last.time ?? 0,
            spanMs: Math.max(0, (last.time ?? 0) - (first.time ?? 0)),
          });
          return;
        }
        for (const item of steps[stepIndex]!) {
          context.sequenceStats.work += 1;
          if (context.sequenceStats.work > context.sequenceWorkLimit)
            throw new TypeError("filter_sequence_work_limit_exceeded");
          if (previous && compareActivity(item, previous) <= 0) continue;
          picked.push(item);
          enumerate(stepIndex + 1, item);
          picked.pop();
        }
      };
      enumerate(0);
      return matches;
    }
    case "adjacent": {
      const matches = targetValue(target.sequence, frame, context);
      if (!Array.isArray(matches)) throw new TypeError("expected_sequence");
      const timeline = rootCollection("page", frame, context)
        .concat(rootCollection("event", frame, context))
        .sort(compareActivity);
      const positions = new Map(
        timeline.map((item, index) => [activityKey(item), index]),
      );
      return (matches as SequenceMatchValue[]).filter((match) => {
        const indexes = match.steps.map((step) =>
          positions.get(activityKey(step)),
        );
        return indexes.every(
          (index, step) =>
            index !== undefined &&
            (step === 0 || index === indexes[step - 1]! + 1),
        );
      });
    }
    case "without": {
      const matches = targetValue(target.sequence, frame, context);
      const excluded = targetValue(target.excluded, frame, context);
      if (!Array.isArray(matches) || !Array.isArray(excluded))
        throw new TypeError("expected_collection");
      const blocked = excluded as FilterEvaluationEntity[];
      return (matches as SequenceMatchValue[]).filter((match) => {
        const first = match.steps[0]!;
        const last = match.steps.at(-1)!;
        return !blocked.some(
          (item) =>
            compareActivity(item, first) > 0 && compareActivity(item, last) < 0,
        );
      });
    }
  }
}

function dateNumber(value: RuntimeValue): number | null {
  if (isMissing(value) || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compareScalar(
  left: string | number | boolean,
  right: string | number | boolean,
): number {
  if (typeof left === "string" && typeof right === "string")
    return left.localeCompare(right);
  if (typeof left === "boolean" && typeof right === "boolean")
    return Number(left) - Number(right);
  return Number(left) - Number(right);
}

function distinctKey(value: unknown): string {
  if (value === null) return "null:";
  if (typeof value === "number")
    return `number:${Object.is(value, -0) ? 0 : value}`;
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (value && typeof value === "object" && "kind" in value) {
    const tagged = value as Record<string, unknown>;
    if (tagged.kind === "time-bucket-value")
      return `bucket:${tagged.startMs}:${tagged.endExclusiveMs}`;
    if (tagged.kind === "sequence-match-value")
      return `sequence:${(tagged.steps as FilterEvaluationEntity[]).map(activityKey).join("/")}`;
  }
  return `${typeof value}:${String(value)}`;
}

function activityKey(record: FilterEvaluationEntity): string {
  return `${record.kind}:${record.id}`;
}

function isRuntimeEntity(value: unknown): value is FilterEvaluationEntity {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    ["page", "event", "session", "visitor"].includes(
      String((value as { kind: unknown }).kind),
    ) &&
    "fields" in value,
  );
}

function isSequenceMatch(value: unknown): value is SequenceMatchValue {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "sequence-match-value",
  );
}

function isPeriodValue(value: unknown): value is PeriodValue {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "period-value",
  );
}

function isTimeBucket(value: unknown): value is TimeBucketValue {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "time-bucket-value",
  );
}

function comparable(value: RuntimeValue): string | number | boolean | null {
  if (isMissing(value)) return null;
  if (value && typeof value === "object" && "kind" in value) {
    const tagged = value as Record<string, unknown>;
    if (tagged.kind === "duration-value") return tagged.milliseconds as number;
    if (tagged.kind === "calendar-period-value") return null;
    if (tagged.kind === "time-bucket-value") return tagged.startMs as number;
    if (tagged.kind === "period-value") return tagged.startMs as number;
    if (tagged.kind === "sequence-match-value") return tagged.spanMs as number;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    // DateTime literals are canonical RFC3339 values; ordinary strings remain strings.
    return /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(parsed)
      ? parsed
      : value;
  }
  return typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : null;
}

function equalValue(left: unknown, right: unknown, fieldId?: string): boolean {
  if (left === null || right === null || isMissing(left) || isMissing(right))
    return false;
  if (typeof left === "string" && typeof right === "string") {
    const insensitive = fieldId
      ? analyticsFilterRegistry.get(fieldId)?.comparison === "case-insensitive"
      : false;
    return insensitive
      ? left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
      : left.trim() === right.trim();
  }
  if (
    typeof left === "number" &&
    typeof right === "string" &&
    /^\d{4}-\d\d-\d\dT/u.test(right)
  ) {
    const timestamp = Date.parse(right);
    return Number.isFinite(timestamp) && left === timestamp;
  }
  if (
    typeof right === "number" &&
    typeof left === "string" &&
    /^\d{4}-\d\d-\d\dT/u.test(left)
  ) {
    const timestamp = Date.parse(left);
    return Number.isFinite(timestamp) && right === timestamp;
  }
  if (left && typeof left === "object" && "kind" in left) {
    const normalizedLeft = comparable(left as RuntimeValue);
    const normalizedRight = comparable(right as RuntimeValue);
    return normalizedLeft !== null && normalizedLeft === normalizedRight;
  }
  return typeof left === typeof right && left === right;
}

function conditionMatches(
  condition: FilterCondition,
  frame: RuntimeFrame,
  context: RuntimeContext,
): boolean {
  if (frame.topLevel && isLegacyFilterTarget(condition.target)) {
    const candidates =
      context.options.scope === "event"
        ? [frame.current].filter((value): value is FilterEvaluationEntity =>
            Boolean(value),
          )
        : candidateActivitiesForAnchor(frame.current, context);
    return candidates.some((candidate) =>
      conditionMatchesOnEntity(condition, candidate, frame, context, true),
    );
  }
  // Only standalone v1 predicates keep candidate-range membership semantics.
  // A field target nested in a Core expression reads the evaluation collection.
  return conditionMatchesOnEntity(
    condition,
    currentEntity(frame),
    frame,
    context,
    false,
  );
}

function candidateActivitiesForAnchor(
  anchor: FilterEvaluationEntity | undefined,
  context: RuntimeContext,
): FilterEvaluationEntity[] {
  if (!anchor) return [];
  const records = [...context.candidatePages, ...context.candidateEvents];
  if (anchor.kind === "session")
    return records.filter((item) => item.sessionId === anchor.id);
  if (anchor.kind === "visitor")
    return records.filter((item) => item.visitorId === anchor.id);
  return records.filter(
    (item) => item.id === anchor.id || item.visitId === anchor.visitId,
  );
}

function conditionMatchesOnEntity(
  condition: FilterCondition,
  entity: FilterEvaluationEntity | undefined,
  frame: RuntimeFrame,
  context: RuntimeContext,
  legacy: boolean,
): boolean {
  const scopedFrame = entity
    ? { ...frame, current: entity, legacyFieldEvaluation: legacy }
    : frame;
  const actual = targetValue(condition.target, scopedFrame, context);
  const op = condition.operator;
  const valueItems = Array.isArray(condition.value)
    ? condition.value
    : condition.value === undefined
      ? []
      : [condition.value];
  if (op === "exists")
    return (
      !isMissing(actual) &&
      actual !== null &&
      (Array.isArray(actual) ? actual.length > 0 : true)
    );
  const legacyNullTarget = legacy && condition.target.kind === "field";
  if (op === "notExists")
    return (
      isMissing(actual) ||
      (Array.isArray(actual) && actual.length === 0) ||
      (legacyNullTarget && actual === null)
    );
  if (op === "isNull")
    return actual === null || (legacyNullTarget && isMissing(actual));
  if (op === "notNull") return !isMissing(actual) && actual !== null;
  if (op === "isEmpty") return actual === "";
  if (op === "notEmpty") return typeof actual === "string" && actual !== "";
  if (isMissing(actual) || actual === null) return false;
  if (op === "in" || op === "notIn") {
    const found = valueItems.some((expected) =>
      equalValue(actual, expected, fieldIdFor(condition.target)),
    );
    return op === "in" ? found : !found;
  }
  if (op === "between") {
    if (valueItems.length < 2) return false;
    const value = comparable(actual);
    const lower = comparable(valueItems[0] as RuntimeValue);
    const upper = comparable(valueItems[1] as RuntimeValue);
    return (
      value !== null &&
      lower !== null &&
      upper !== null &&
      compareScalar(value, lower) >= 0 &&
      compareScalar(value, upper) <= 0
    );
  }
  const expectedTarget = isTargetExpression(condition.value)
    ? targetValue(condition.value, scopedFrame, context)
    : valueItems[0];
  if (isMissing(expectedTarget) || expectedTarget === null) return false;
  if (op === "eq" || op === "neq") {
    const equal = equalValue(
      actual,
      expectedTarget,
      fieldIdFor(condition.target),
    );
    return op === "eq" ? equal : !equal;
  }
  if (["contains", "startsWith", "endsWith"].includes(op)) {
    if (typeof actual !== "string" || typeof expectedTarget !== "string")
      return false;
    const left = actual.toLocaleLowerCase();
    const right = expectedTarget.toLocaleLowerCase();
    return op === "contains"
      ? left.includes(right)
      : op === "startsWith"
        ? left.startsWith(right)
        : left.endsWith(right);
  }
  const left = comparable(actual);
  const right = comparable(expectedTarget as RuntimeValue);
  if (left === null || right === null) return false;
  const order = compareScalar(left, right);
  return op === "gt"
    ? order > 0
    : op === "gte"
      ? order >= 0
      : op === "lt"
        ? order < 0
        : op === "lte"
          ? order <= 0
          : false;
}

function fieldIdFor(target: FilterTargetExpression): string | undefined {
  return target.kind === "field" ? target.field : undefined;
}

function isTargetExpression(value: unknown): value is FilterTargetExpression {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    typeof (value as { kind?: unknown }).kind === "string",
  );
}

function evaluateExpression(
  expression: FilterExpression | null,
  frame: RuntimeFrame,
  context: RuntimeContext,
): boolean {
  if (!expression) return true;
  if (expression.kind === "condition")
    return conditionMatches(expression, frame, context);
  if (expression.kind === "not")
    return !evaluateExpression(expression.child, frame, context);
  if (expression.kind === "and")
    return expression.children.every((child) =>
      evaluateExpression(child, frame, context),
    );
  return expression.children.some((child) =>
    evaluateExpression(child, frame, context),
  );
}

function scopeCandidates(context: RuntimeContext): FilterEvaluationEntity[] {
  if (context.options.scope === "event") {
    return [...context.candidatePages, ...context.candidateEvents].sort(
      compareActivity,
    );
  }
  const records = [...context.candidatePages, ...context.candidateEvents];
  const candidates = buildAggregateEntities(records, context.options.scope);
  const evaluationEntities =
    context.options.scope === "session" ? context.sessions : context.visitors;
  const evaluationById = new Map(
    evaluationEntities.map((entity) => [entity.id, entity]),
  );
  return candidates.map(
    (candidate) => evaluationById.get(candidate.id) ?? candidate,
  );
}

/** Execute a normalized v1 FilterDocument using the shared Core/Relation semantics. */
export function evaluateFilterDocument(
  document: FilterDocument,
  dataset: FilterEvaluationDataset,
  options: FilterEvaluationOptions,
): FilterEvaluationResult {
  const normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
  const context = createRuntimeContext(dataset, options);
  const matchingScopeEntityIds = new Set<string>();
  const matchingVisitIds = new Set<string>();
  const matchingEventIds = new Set<string>();
  for (const candidate of scopeCandidates(context)) {
    const matched = evaluateExpression(
      normalized.root,
      { current: candidate, anchor: candidate, topLevel: true },
      context,
    );
    if (!matched) continue;
    if (context.options.scope === "event") {
      if (candidate.visitId) matchingVisitIds.add(candidate.visitId);
      if (candidate.kind === "event") matchingEventIds.add(candidate.id);
      continue;
    }
    matchingScopeEntityIds.add(candidate.id);
  }
  if (context.options.scope !== "event") {
    const idField =
      context.options.scope === "session" ? "sessionId" : "visitorId";
    for (const page of context.candidatePages) {
      const id = page[idField];
      if (id && matchingScopeEntityIds.has(id))
        matchingVisitIds.add(page.visitId ?? page.id);
    }
    for (const event of context.candidateEvents) {
      const id = event[idField];
      if (id && matchingScopeEntityIds.has(id)) {
        matchingEventIds.add(event.id);
        if (event.visitId) matchingVisitIds.add(event.visitId);
      }
    }
  }
  return { matchingScopeEntityIds, matchingVisitIds, matchingEventIds };
}

export const FILTER_EVALUATOR_LIMITS = Object.freeze({
  maxActivities: DEFAULT_MAX_ACTIVITIES,
  maxSequenceMatches: DEFAULT_MAX_SEQUENCE_MATCHES,
  maxSequenceWork: DEFAULT_MAX_SEQUENCE_WORK,
});
