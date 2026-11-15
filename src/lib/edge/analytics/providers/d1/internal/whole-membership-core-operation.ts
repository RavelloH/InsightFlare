import { classifyTrafficChannel } from "@/lib/analytics/traffic-channel-rules";
import { browserEngineLabel } from "@/lib/browser-engine";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { WholeMembershipCoreNode } from "@/lib/edge/analytics/engine/logical/whole-membership";
import type { WholeMembershipState } from "@/lib/edge/analytics/engine/whole-membership-stage-transition";
import type { AdvancedFilterActivityRow as RawEvaluationRow } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-activity-query";
import type { AdvancedFilterPayloadNode as RawPayloadNode } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-payload-query";
import type {
  FilterEvaluationDataset,
  FilterEvaluationEntity,
} from "@/lib/filter-contract/filter-evaluator";
import { evaluateFilterDocument } from "@/lib/filter-contract/filter-evaluator";
import { buildCanonicalFilterScopeFacts } from "@/lib/filter-contract/filter-facts";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

interface QualificationMatchRow {
  readonly siteId: string;
  readonly kind: "entity" | "visit" | "event";
  readonly id: string;
}
function invalidInput(
  path: string,
  code: string,
): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [{ path, code }],
  });
}
function nodeValue(node: RawPayloadNode): unknown {
  if (node.value_type === 0) return null;
  if (node.value_type === 1) return node.string_value;
  if (node.value_type === 2) return node.number_value;
  if (node.value_type === 3) return Number(node.boolean_value) === 1;
  if (node.value_type === 5) return [];
  return {};
}

export function reconstructWholeMembershipPayloads(
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

export function entitiesForRows(
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

/** The only host operation: bounded original Core over already executed logical
 * read results. It has no Env, DB port, reader callback or old whole-executor call.
 * The private interpreter must enforce input-read caps before reaching this op. */
export function evaluateWholeMembershipCoreRows(
  state: Extract<WholeMembershipState, { kind: "core-inputs" }>,
  rows: readonly RawEvaluationRow[],
  payloads: ReadonlyMap<string, unknown>,
  node: WholeMembershipCoreNode,
  ...rawCompletionInput: [] | [Pick<ScopedFilterPlan, "scope">]
): QualificationMatchRow[] {
  const originalResultScopePlan = rawCompletionInput[0];
  if (
    originalResultScopePlan &&
    ((node.profile !== "whole-original-completion-single-site-entity-v1" &&
      node.profile !== "whole-original-completion-team-entity-v1") ||
      node.resultScopeInput !== "captured-scope-plan-after-core")
  )
    throw new Error("whole_membership_unexpected_result_scope_input");
  const coverage = state.coverage;
  const readRange = node.readRange;
  const fullHistory = node.fullHistoryAtEntry;
  const matches: QualificationMatchRow[] = [];
  const rowsBySite = new Map<unknown, RawEvaluationRow[]>();
  for (const row of rows) {
    const siteRows = rowsBySite.get(row.site_id) ?? [];
    siteRows.push(row);
    rowsBySite.set(row.site_id, siteRows);
  }
  for (const siteId of state.stage.context.subject.siteIds) {
    const createdAt = coverage.get(siteId)!;
    const siteRows = rowsBySite.get(siteId) ?? [];
    const siteReadRange = fullHistory
      ? {
          startMs: createdAt,
          endExclusiveMs: node.queryTime.capturedAtMs + 1,
        }
      : readRange;
    const siteFilterRange = node.queryTime.filterRange
      ? {
          startMs: node.queryTime.filterRange.startMs ?? createdAt,
          endExclusiveMs:
            node.queryTime.filterRange.endExclusiveMs ??
            node.queryTime.capturedAtMs + 1,
        }
      : node.queryTime.range;
    if (siteFilterRange.startMs >= siteFilterRange.endExclusiveMs) continue;
    const dataset = entitiesForRows(
      siteRows,
      payloads,
      {
        startMs: node.queryTime.range.startMs,
        endExclusiveMs: node.queryTime.range.endExclusiveMs,
      },
      siteFilterRange,
      siteReadRange,
      node.queryTime.filterRange !== undefined,
    );
    let result;
    try {
      result = evaluateFilterDocument(
        node.filters,
        {
          ...dataset,
          coverageRange: {
            startMs: createdAt,
            endExclusiveMs: node.queryTime.capturedAtMs + 1,
          },
        },
        {
          scope: node.executionScope,
          candidateRange: node.queryTime.range,
          ...(node.queryTime.filterRange
            ? { filterRange: siteFilterRange }
            : {}),
          readRange: siteReadRange,
          filterRangeEmpty: node.queryTime.filterRangeEmpty ?? false,
          reportingTimeZone: node.queryTime.reportingTimeZone,
          capturedAtMs: node.queryTime.capturedAtMs,
          ...node.bounds,
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
    // Exactly the original post-evaluate scope read, not the earlier Core2
    // option value. No callback, DB port or new admission is involved.
    const resultScope = originalResultScopePlan?.scope ?? node.executionScope;
    if (resultScope === "event") {
      for (const id of result.matchingVisitIds)
        matches.push({ siteId, kind: "visit", id });
      for (const id of result.matchingEventIds)
        matches.push({ siteId, kind: "event", id });
    } else {
      for (const id of result.matchingScopeEntityIds)
        matches.push({ siteId, kind: "entity", id });
    }
  }
  return matches.sort(
    (left, right) =>
      left.siteId.localeCompare(right.siteId) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
}
