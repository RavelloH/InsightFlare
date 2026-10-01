import { classifyTrafficChannel } from "@/lib/analytics/traffic-channel-rules";
import { browserEngineLabel } from "@/lib/browser-engine";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import type { TypedQueryProviderMiddleware } from "@/lib/edge/analytics/application/provider-registry";
import type {
  QueryInput,
  QueryOperation,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import {
  type AdvancedFilterIdentity,
  type AdvancedFilterMatches as ScopedAdvancedFilterMatches,
  attachScopedFilterMetadata,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import type { Env } from "@/lib/edge/types";
import type {
  FilterEvaluationDataset,
  FilterEvaluationEntity,
} from "@/lib/filter-contract/filter-evaluator";
import { evaluateFilterDocument } from "@/lib/filter-contract/filter-evaluator";
import { buildCanonicalFilterScopeFacts } from "@/lib/filter-contract/filter-facts";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";
import type {
  FilterDocument,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

import type { AdvancedFilterActivityRow } from "./advanced-filter-activity-query";
import { queryAdvancedFilterActivityRange } from "./advanced-filter-activity-query";
import type { AdvancedFilterPayloadNode } from "./advanced-filter-payload-query";
import { queryAdvancedFilterPayloadNodes } from "./advanced-filter-payload-query";
import { siteCoverage } from "./advanced-filter-site-coverage";
import type { D1ReadDiagnostics } from "./diagnostics";

const MAX_ADVANCED_ACTIVITIES = 20_000;
const MAX_ADVANCED_PAYLOAD_NODES = 50_000;
const SITE_CHUNK_SIZE = 90;

type RawEvaluationRow = AdvancedFilterActivityRow;

type RawPayloadNode = AdvancedFilterPayloadNode;

function invalidInput(
  path: string,
  code: string,
): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [{ path, code }],
  });
}

function siteChunks(siteIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < siteIds.length; index += SITE_CHUNK_SIZE) {
    chunks.push(siteIds.slice(index, index + SITE_CHUNK_SIZE));
  }
  return chunks;
}

function evaluationReadRanges(
  candidate: { readonly startMs: number; readonly endExclusiveMs: number },
  read: { readonly startMs: number; readonly endExclusiveMs: number },
): Array<{ readonly startMs: number; readonly endExclusiveMs: number }> {
  const ranges = [candidate, read]
    .filter((range) => range.startMs < range.endExclusiveMs)
    .sort((left, right) => left.startMs - right.startMs);
  const merged: Array<{ startMs: number; endExclusiveMs: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.startMs > previous.endExclusiveMs) {
      merged.push({ ...range });
    } else if (range.endExclusiveMs > previous.endExclusiveMs) {
      previous.endExclusiveMs = range.endExclusiveMs;
    }
  }
  return merged;
}

function payloadPaths(expression: FilterDocument["root"]): {
  readonly paths: readonly string[];
  readonly wholePayload: boolean;
} {
  const paths = new Set<string>();
  let wholePayload = false;
  const target = (value: FilterTargetExpression): void => {
    if (value.kind === "event-payload") paths.add(value.path);
    else if (value.kind === "member") {
      target(value.object);
      if (value.member === "payload") wholePayload = true;
    } else if (value.kind === "context-intrinsic") {
      if (value.intrinsic === "same") target(value.input);
    } else if (value.kind === "occurrence-time") {
      target(value.input);
    } else if (value.kind === "selector") {
      target(value.collection);
      visit(value.predicate);
    } else if (value.kind === "projection") {
      target(value.collection);
      if (value.member === "payload") {
        if (value.path) paths.add(value.path);
        else wholePayload = true;
      }
    } else if (value.kind === "reducer") target(value.input);
    else if (value.kind === "arithmetic") {
      target(value.left);
      target(value.right);
    } else if (value.kind === "bucket") target(value.input);
    else if (value.kind === "window") {
      target(value.collection);
      target(value.anchor);
    } else if (value.kind === "periods") target(value.collection);
    else if (value.kind === "sequence") value.steps.forEach(target);
    else if (value.kind === "adjacent") target(value.sequence);
    else if (value.kind === "without") {
      target(value.sequence);
      target(value.excluded);
    }
  };
  const visit = (node: FilterDocument["root"]): void => {
    if (!node) return;
    if (node.kind === "condition") {
      target(node.target);
      if (
        node.value &&
        typeof node.value === "object" &&
        !Array.isArray(node.value) &&
        "kind" in node.value
      )
        target(node.value as FilterTargetExpression);
    } else if (node.kind === "not") visit(node.child);
    else node.children.forEach(visit);
  };
  visit(expression);
  return { paths: [...paths].sort(), wholePayload };
}

async function loadActivities(
  env: Env,
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  ranges: readonly {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  }[],
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
): Promise<RawEvaluationRow[]> {
  const activities: RawEvaluationRow[] = [];
  for (const chunk of siteChunks(siteIds)) {
    for (const range of ranges) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const rows = await queryAdvancedFilterActivityRange({
        env,
        subject,
        siteIds: chunk,
        range,
        diagnostics,
        signal,
      });
      activities.push(...rows);
      if (activities.length > MAX_ADVANCED_ACTIVITIES) {
        throw invalidInput("filters", "filter_activity_limit_exceeded");
      }
    }
  }
  return activities;
}

function nodeValue(node: RawPayloadNode): unknown {
  if (node.value_type === 0) return null;
  if (node.value_type === 1) return node.string_value;
  if (node.value_type === 2) return node.number_value;
  if (node.value_type === 3) return Number(node.boolean_value) === 1;
  if (node.value_type === 5) return [];
  return {};
}

function reconstructPayloads(
  nodes: readonly RawPayloadNode[],
): Map<string, unknown> {
  const grouped = new Map<string, RawPayloadNode[]>();
  for (const node of nodes) {
    const list = grouped.get(node.event_id) ?? [];
    list.push(node);
    grouped.set(node.event_id, list);
  }
  const payloads = new Map<string, unknown>();
  for (const [eventId, records] of grouped) {
    const values = new Map<number, unknown>();
    let root: unknown = {};
    for (const node of records) values.set(node.node_id, nodeValue(node));
    for (const node of records) {
      const value = values.get(node.node_id);
      if (node.parent_node_id === null) {
        root = value;
        continue;
      }
      const parent = values.get(node.parent_node_id);
      if (!parent || typeof parent !== "object") continue;
      if (Array.isArray(parent)) {
        if (typeof node.array_index === "number")
          parent[node.array_index] = value;
      } else if (node.key_name !== null) {
        (parent as Record<string, unknown>)[node.key_name] = value;
      }
    }
    payloads.set(eventId, root);
  }
  return payloads;
}

async function loadPayloads(
  env: Env,
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  ranges: readonly {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  }[],
  paths: ReturnType<typeof payloadPaths>,
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
): Promise<Map<string, unknown>> {
  const payloadNodes: RawPayloadNode[] = [];
  for (const chunk of siteChunks(siteIds)) {
    for (const range of ranges) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const rows = await queryAdvancedFilterPayloadNodes({
        env,
        subject,
        siteIds: chunk,
        range,
        paths: paths.paths,
        wholePayload: paths.wholePayload,
        diagnostics,
        signal,
      });
      payloadNodes.push(...rows);
      if (payloadNodes.length > MAX_ADVANCED_PAYLOAD_NODES) {
        throw invalidInput("filters", "filter_payload_node_limit_exceeded");
      }
    }
  }
  return reconstructPayloads(payloadNodes);
}

function directColumn(
  fieldId: string,
  strategy: string,
  row: RawEvaluationRow,
): unknown {
  if (strategy.startsWith("column."))
    return row[strategy.slice("column.".length)];
  if (strategy === "event.name")
    return row.kind === "event" ? row.event_name : undefined;
  if (strategy === "derived.trafficChannel") {
    return classifyTrafficChannel({
      referrerHost: String(row.referrer_host ?? ""),
      utmSource: String(row.utm_source ?? ""),
      utmMedium: String(row.utm_medium ?? ""),
      utmCampaign: String(row.utm_campaign ?? ""),
    });
  }
  if (strategy === "derived.browserEngine")
    return browserEngineLabel(String(row.browser ?? ""), String(row.os ?? ""));
  if (strategy === "derived.osVersion") {
    const os = String(row.os ?? "").trim();
    const version = String(row.os_version ?? "").trim();
    return os && version ? `${os} ${version}` : os || version;
  }
  if (strategy === "derived.screenSize") {
    return row.screen_width !== null &&
      row.screen_width !== undefined &&
      row.screen_height !== null &&
      row.screen_height !== undefined
      ? `${row.screen_width}x${row.screen_height}`
      : "";
  }
  if (
    strategy === "session.boundary.entry" ||
    strategy === "session.boundary.exit"
  )
    return undefined;
  if (strategy.startsWith("fact.")) return undefined;
  if (strategy === "event.payload") return undefined;
  void fieldId;
  return undefined;
}

function fieldsFor(row: RawEvaluationRow): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [fieldId, definition] of analyticsFilterRegistry) {
    const value = directColumn(fieldId, definition.compilerStrategy, row);
    if (value !== undefined) {
      fields[fieldId] =
        definition.compilerStrategy === "column.is_eu" && value !== null
          ? Number(value) === 1
          : value;
    }
  }
  if (row.kind === "event") fields["event.name"] = row.event_name;
  return fields;
}

function aggregateFacts(
  records: readonly FilterEvaluationEntity[],
): Map<string, Record<string, unknown>> {
  const activities = records.filter(
    (item): item is FilterEvaluationEntity & { kind: "page" | "event" } =>
      item.kind === "page" || item.kind === "event",
  );
  const canonical = buildCanonicalFilterScopeFacts(activities);
  const result = new Map<string, Record<string, unknown>>();
  for (const [id, facts] of canonical.sessions)
    result.set(`session:${id}`, { ...facts });
  for (const [id, facts] of canonical.visitors)
    result.set(`visitor:${id}`, { ...facts });
  return result;
}

function entitiesForRows(
  rows: readonly RawEvaluationRow[],
  payloads: ReadonlyMap<string, unknown>,
  candidateRange: { readonly startMs: number; readonly endExclusiveMs: number },
  filterRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  },
  readRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  },
  explicitFilterRange: boolean,
): FilterEvaluationDataset {
  const initial = rows.map((row): FilterEvaluationEntity => ({
    kind: row.kind,
    // The legacy evaluator's public type is narrower than its SQL row contract.
    // Keep nullable database values intact at runtime; this only bridges TS types.
    id: row.id as string,
    time: row.time,
    visitId: row.visit_id as string,
    sessionId: row.session_id ?? undefined,
    visitorId: row.visitor_id ?? undefined,
    fields: fieldsFor(row),
    ...(row.kind === "event"
      ? {
          payload: payloads.has(row.id as string)
            ? payloads.get(row.id as string)
            : {},
        }
      : {}),
  }));
  const candidate = initial.filter(
    (item) =>
      item.time !== undefined &&
      item.time >= candidateRange.startMs &&
      item.time < candidateRange.endExclusiveMs,
  );
  const read = initial.filter(
    (item) =>
      item.time !== undefined &&
      item.time >= readRange.startMs &&
      item.time < readRange.endExclusiveMs,
  );
  const filter = initial.filter(
    (item) =>
      item.time !== undefined &&
      item.time >= filterRange.startMs &&
      item.time < filterRange.endExclusiveMs,
  );
  const evaluationFacts = aggregateFacts(explicitFilterRange ? filter : read);
  const candidateFacts = aggregateFacts(candidate);
  const withFacts = initial.map((item) => {
    const fields = { ...item.fields };
    const candidateFields = { ...item.fields };
    if (item.sessionId) {
      Object.assign(fields, evaluationFacts.get(`session:${item.sessionId}`));
      Object.assign(
        candidateFields,
        candidateFacts.get(`session:${item.sessionId}`),
      );
    }
    if (item.visitorId) {
      Object.assign(fields, evaluationFacts.get(`visitor:${item.visitorId}`));
      Object.assign(
        candidateFields,
        candidateFacts.get(`visitor:${item.visitorId}`),
      );
    }
    return { ...item, fields, candidateFields };
  });
  const pages = withFacts.filter((item) => item.kind === "page");
  const events = withFacts.filter((item) => item.kind === "event");
  return {
    pages,
    events,
    coverageRange: {
      startMs: Number.MIN_SAFE_INTEGER,
      endExclusiveMs: Number.MAX_SAFE_INTEGER,
    },
  };
}

async function evaluateForSites(input: {
  readonly env: Env;
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly filters: FilterDocument;
  readonly plan: ScopedFilterPlan;
  readonly time: QueryTime;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<ScopedAdvancedFilterMatches> {
  if (input.time.filterRangeEmpty)
    return input.plan.scope === "event"
      ? { visitIds: [], eventIds: [] }
      : { entityIds: [] };
  const authorizedSiteIds = new Set<string>(input.subject.siteIds);
  if (input.siteIds.some((siteId) => !authorizedSiteIds.has(siteId)))
    throw invalidInput(
      "filters",
      "advanced_filter_execution_site_context_mismatch",
    );
  const fullHistory = input.time.fullHistory === true;
  const coverage = await siteCoverage(
    input.env,
    input.siteIds,
    input.diagnostics,
    input.signal,
  );
  const readRange = fullHistory
    ? {
        startMs: Math.min(
          ...input.siteIds.map(
            (siteId) => coverage.get(siteId) ?? Number.MAX_SAFE_INTEGER,
          ),
        ),
        endExclusiveMs: input.time.capturedAtMs + 1,
      }
    : (input.time.readRange ?? input.time.range);
  if (readRange.endExclusiveMs > input.time.capturedAtMs + 1) {
    throw invalidInput("readRange", "filter_evaluation_range_unavailable");
  }
  for (const siteId of input.siteIds) {
    const createdAt = coverage.get(siteId);
    if (
      createdAt === undefined ||
      (!fullHistory && readRange.startMs < createdAt)
    ) {
      throw invalidInput("readRange", "filter_evaluation_range_unavailable");
    }
  }
  const paths = payloadPaths(input.filters.root);
  const readRanges = evaluationReadRanges(input.time.range, readRange);
  const [rows, payloads] = await Promise.all([
    loadActivities(
      input.env,
      input.subject,
      input.siteIds,
      readRanges,
      input.diagnostics,
      input.signal,
    ),
    paths.paths.length || paths.wholePayload
      ? loadPayloads(
          input.env,
          input.subject,
          input.siteIds,
          readRanges,
          paths,
          input.diagnostics,
          input.signal,
        )
      : Promise.resolve(new Map<string, unknown>()),
  ]);
  const entityIds: AdvancedFilterIdentity[] = [];
  const visitIds: AdvancedFilterIdentity[] = [];
  const eventIds: AdvancedFilterIdentity[] = [];
  const rowsBySite = new Map<unknown, RawEvaluationRow[]>();
  for (const row of rows) {
    const siteRows = rowsBySite.get(row.site_id) ?? [];
    siteRows.push(row);
    rowsBySite.set(row.site_id, siteRows);
  }
  for (const siteId of input.siteIds) {
    const createdAt = coverage.get(siteId)!;
    const siteRows = rowsBySite.get(siteId) ?? [];
    const siteReadRange = fullHistory
      ? {
          startMs: createdAt,
          endExclusiveMs: input.time.capturedAtMs + 1,
        }
      : readRange;
    const siteFilterRange = input.time.filterRange
      ? {
          startMs: input.time.filterRange.startMs ?? createdAt,
          endExclusiveMs:
            input.time.filterRange.endExclusiveMs ??
            input.time.capturedAtMs + 1,
        }
      : input.time.range;
    if (siteFilterRange.startMs >= siteFilterRange.endExclusiveMs) continue;
    const dataset = entitiesForRows(
      siteRows,
      payloads,
      {
        startMs: input.time.range.startMs,
        endExclusiveMs: input.time.range.endExclusiveMs,
      },
      siteFilterRange,
      siteReadRange,
      input.time.filterRange !== undefined,
    );
    let result;
    try {
      result = evaluateFilterDocument(
        input.filters,
        {
          ...dataset,
          coverageRange: {
            startMs: createdAt,
            endExclusiveMs: input.time.capturedAtMs + 1,
          },
        },
        {
          scope: input.plan.scope,
          candidateRange: input.time.range,
          ...(input.time.filterRange ? { filterRange: siteFilterRange } : {}),
          readRange: siteReadRange,
          filterRangeEmpty: input.time.filterRangeEmpty ?? false,
          reportingTimeZone: input.time.reportingTimeZone,
          capturedAtMs: input.time.capturedAtMs,
          maxActivities: MAX_ADVANCED_ACTIVITIES,
          maxSequenceMatches: 50_000,
        },
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "filter_evaluation_range_unavailable")
        throw invalidInput("readRange", code);
      if (
        code === "filter_activity_limit_exceeded" ||
        code === "filter_sequence_match_limit_exceeded" ||
        code === "filter_sequence_work_limit_exceeded"
      )
        throw invalidInput("filters", code);
      throw error;
    }
    if (input.plan.scope === "event") {
      for (const id of result.matchingVisitIds) visitIds.push({ siteId, id });
      for (const id of result.matchingEventIds) eventIds.push({ siteId, id });
    } else {
      for (const id of result.matchingScopeEntityIds)
        entityIds.push({ siteId, id });
    }
  }
  const stable = (
    left: AdvancedFilterIdentity,
    right: AdvancedFilterIdentity,
  ) =>
    left.siteId.localeCompare(right.siteId) || left.id.localeCompare(right.id);
  return {
    ...(input.plan.scope === "event"
      ? { visitIds: visitIds.sort(stable), eventIds: eventIds.sort(stable) }
      : { entityIds: entityIds.sort(stable) }),
  };
}

interface FilterSide {
  readonly filters?: FilterDocument;
  readonly time?: QueryTime;
  readonly [key: string]: unknown;
}

interface PreparedFilterSide {
  readonly side: FilterSide;
  readonly plan: ScopedFilterPlan;
}

function prepareSide(
  env: Env,
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  side: FilterSide,
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
): Promise<PreparedFilterSide> | null {
  const filters = side.filters;
  if (!filters?.root || !filterDocumentUsesAdvancedExpressions(filters))
    return null;
  const metadata = scopedFilterMetadata(filters);
  if (!metadata)
    throw invalidInput("filters", "advanced_filter_execution_context_required");
  const time = metadata.time ?? side.time;
  if (!time)
    throw invalidInput("time", "advanced_filter_execution_context_required");
  return evaluateForSites({
    env,
    subject,
    siteIds: metadata.siteIds.length ? metadata.siteIds : siteIds,
    filters,
    plan: metadata.plan,
    time,
    diagnostics,
    signal,
  }).then((advancedMatches: ScopedAdvancedFilterMatches) => {
    const plan = { ...metadata.plan, advancedMatches };
    return {
      side: {
        ...side,
        filters: attachScopedFilterMetadata(filters, { ...metadata, plan }),
      },
      plan,
    };
  });
}

/** Resolve Core/Relation expressions once, then let every D1 operation reuse
 * the scoped dataset's selected identities. The ordinary v1 SQL fast path is
 * untouched. */
export function d1AdvancedFilterMiddleware(
  env: Env,
  diagnostics?: D1ReadDiagnostics,
): TypedQueryProviderMiddleware {
  return async (
    _operation: QueryOperation,
    input: unknown,
    next,
    execution,
  ) => {
    const query = input as QueryInput & Record<string, unknown>;
    const querySubject = query.context.subject;
    const subject = semanticSubjectFromQuerySubject(querySubject);
    const siteIds =
      querySubject.kind === "site"
        ? [querySubject.siteId]
        : [...querySubject.authorizedSiteIds];
    const output = { ...query } as Record<string, unknown>;
    let preparedPrimaryPlan: ScopedFilterPlan | undefined;
    if (query.current && query.reference) {
      for (const sideName of ["current", "reference"] as const) {
        const side = query[sideName] as FilterSide;
        const pending = prepareSide(
          env,
          subject,
          siteIds,
          side,
          diagnostics,
          execution?.signal,
        );
        if (!pending) continue;
        const prepared = await pending;
        output[sideName] = prepared.side;
        if (sideName === "current") preparedPrimaryPlan = prepared.plan;
      }
    } else {
      const side: FilterSide = {
        filters: query.filters,
        ...(query.time ? { time: query.time as QueryTime } : {}),
      };
      const pending = prepareSide(
        env,
        subject,
        siteIds,
        side,
        diagnostics,
        execution?.signal,
      );
      if (pending) {
        const prepared = await pending;
        output.filters = prepared.side.filters;
        preparedPrimaryPlan = prepared.plan;
      }
    }
    if (preparedPrimaryPlan) output.scopePlan = preparedPrimaryPlan;
    return next(output);
  };
}
