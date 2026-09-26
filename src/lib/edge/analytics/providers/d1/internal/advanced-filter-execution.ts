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

import { queryD1All } from "./core-sources";
import type { D1ReadDiagnostics } from "./diagnostics";

const MAX_ADVANCED_ACTIVITIES = 20_000;
const MAX_ADVANCED_PAYLOAD_NODES = 50_000;
const SITE_CHUNK_SIZE = 90;

const DATA_COLUMNS = [
  "started_at",
  "status",
  "last_activity_at",
  "ended_at",
  "finalized_at",
  "duration_ms",
  "duration_source",
  "exit_reason",
  "pathname",
  "query_string",
  "hash_fragment",
  "hostname",
  "title",
  "referrer_url",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "is_eu",
  "country",
  "region",
  "region_code",
  "city",
  "continent",
  "latitude",
  "longitude",
  "postal_code",
  "metro_code",
  "timezone",
  "as_organization",
  "ua_raw",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device_type",
  "screen_width",
  "screen_height",
  "language",
  "user_id",
  "user_name",
  "perf_ttfb_ms",
  "perf_fcp_ms",
  "perf_lcp_ms",
  "perf_cls",
  "perf_inp_ms",
] as const;

interface RawEvaluationRow extends Record<string, unknown> {
  kind: "page" | "event";
  id: string;
  site_id: string;
  visit_id: string;
  session_id: string | null;
  visitor_id: string | null;
  time: number;
  event_pk: number | null;
  event_name: string | null;
}

interface RawPayloadNode extends Record<string, unknown> {
  event_id: string;
  node_id: number;
  parent_node_id: number | null;
  key_name: string | null;
  array_index: number | null;
  value_type: number;
  string_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
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

function siteChunks(siteIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < siteIds.length; index += SITE_CHUNK_SIZE) {
    chunks.push(siteIds.slice(index, index + SITE_CHUNK_SIZE));
  }
  return chunks;
}

function evaluationReadRanges(
  candidate: { readonly startMs: number; readonly endExclusiveMs: number },
  evaluation: { readonly startMs: number; readonly endExclusiveMs: number },
): Array<{ readonly startMs: number; readonly endExclusiveMs: number }> {
  const ranges = [candidate, evaluation].sort(
    (left, right) => left.startMs - right.startMs,
  );
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

function sourceProjection(alias: "v" | "p"): string {
  return DATA_COLUMNS.map((column) => `${alias}.${column} AS ${column}`).join(
    ",\n",
  );
}

function sourceIdentityPredicate(
  alias: "v" | "ce" | "seed_event",
  count: number,
): string {
  return `${alias}.site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${Array.from({ length: count }, () => "?").join(", ")}))`;
}

function activitySql(siteCount: number): string {
  const visitPredicate = sourceIdentityPredicate("v", siteCount);
  const eventPredicate = sourceIdentityPredicate("ce", siteCount);
  return `
SELECT * FROM (
  SELECT
    'page' AS kind,
    v.visit_id AS id,
    v.visit_id,
    v.site_id,
    v.site_pk,
    v.visitor_id,
    v.session_id,
    v.started_at AS time,
    CAST(NULL AS INTEGER) AS event_pk,
    CAST(NULL AS TEXT) AS event_name,
    ${sourceProjection("v")}
  FROM visits v
  WHERE ${visitPredicate} AND v.started_at >= ? AND v.started_at < ?
  UNION ALL
  SELECT
    'event' AS kind,
    ce.event_id AS id,
    ce.visit_id,
    ce.site_id,
    ce.site_pk,
    v.visitor_id,
    v.session_id,
    ce.occurred_at AS time,
    ce.event_pk,
    cen.name AS event_name,
    ${DATA_COLUMNS.map((column) => `v.${column} AS ${column}`).join(",\n")}
  FROM custom_events ce
  INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id AND cen.site_pk = ce.site_pk
  INNER JOIN visits v ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
  WHERE ${eventPredicate} AND ce.occurred_at >= ? AND ce.occurred_at < ?
)
ORDER BY time ASC, CASE kind WHEN 'page' THEN 0 ELSE 1 END ASC, id ASC
LIMIT ?`;
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

async function siteCoverage(
  env: Env,
  siteIds: readonly string[],
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const coverage = new Map<string, number>();
  for (const chunk of siteChunks(siteIds)) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const rows = await queryD1All<{
      siteId: string;
      createdAtSeconds: number | null;
    }>(
      env,
      `SELECT id AS siteId, created_at AS createdAtSeconds FROM sites WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      chunk,
      diagnostics,
    );
    for (const row of rows) {
      if (typeof row.createdAtSeconds === "number") {
        coverage.set(row.siteId, Math.trunc(row.createdAtSeconds * 1_000));
      }
    }
  }
  return coverage;
}

async function loadActivities(
  env: Env,
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
      const rows = await queryD1All<RawEvaluationRow>(
        env,
        activitySql(chunk.length),
        [
          ...chunk,
          range.startMs,
          range.endExclusiveMs,
          ...chunk,
          range.startMs,
          range.endExclusiveMs,
          MAX_ADVANCED_ACTIVITIES + 1,
        ],
        diagnostics,
      );
      activities.push(...rows);
      if (activities.length > MAX_ADVANCED_ACTIVITIES) {
        throw invalidInput("filters", "filter_activity_limit_exceeded");
      }
    }
  }
  return activities;
}

function payloadSql(
  siteCount: number,
  paths: readonly string[],
  wholePayload: boolean,
): string {
  const selectedNodes =
    !wholePayload && paths.length > 0
      ? `WITH RECURSIVE selected_payload_nodes(event_pk, node_id, parent_node_id) AS (
  SELECT n.event_pk, n.node_id, n.parent_node_id
  FROM custom_event_json_nodes n
  INNER JOIN custom_event_json_paths p ON p.id = n.path_id
  INNER JOIN custom_events seed_event ON seed_event.event_pk = n.event_pk
  WHERE ${sourceIdentityPredicate("seed_event", siteCount)}
    AND seed_event.occurred_at >= ? AND seed_event.occurred_at < ?
    AND p.path IN (${paths.map(() => "?").join(", ")})
  UNION
  SELECT parent.event_pk, parent.node_id, parent.parent_node_id
  FROM custom_event_json_nodes parent
  INNER JOIN selected_payload_nodes child
    ON child.event_pk = parent.event_pk AND child.parent_node_id = parent.node_id
)`
      : "";
  const nodeSource = selectedNodes
    ? "(SELECT n.* FROM selected_payload_nodes selected INNER JOIN custom_event_json_nodes n ON n.event_pk = selected.event_pk AND n.node_id = selected.node_id) n"
    : "custom_event_json_nodes n";
  return `${selectedNodes}
SELECT
  ce.event_id,
  n.node_id,
  n.parent_node_id,
  k.key AS key_name,
  n.array_index,
  n.value_type,
  jv.string_value,
  jv.number_value,
  jv.boolean_value
FROM custom_events ce
INNER JOIN ${nodeSource} ON n.event_pk = ce.event_pk
INNER JOIN custom_event_json_paths p ON p.id = n.path_id AND p.site_pk = ce.site_pk
LEFT JOIN custom_event_json_keys k ON k.id = n.key_id AND k.site_pk = ce.site_pk
LEFT JOIN custom_event_json_values jv ON jv.event_pk = n.event_pk AND jv.node_id = n.node_id
INNER JOIN visits v ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
WHERE ${sourceIdentityPredicate("ce", siteCount)}
  AND ce.occurred_at >= ? AND ce.occurred_at < ?
ORDER BY ce.event_id, n.node_id
LIMIT ?`;
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
      const rows = await queryD1All<RawPayloadNode>(
        env,
        payloadSql(chunk.length, paths.paths, paths.wholePayload),
        [
          ...(!paths.wholePayload && paths.paths.length > 0
            ? [...chunk, range.startMs, range.endExclusiveMs, ...paths.paths]
            : []),
          ...chunk,
          range.startMs,
          range.endExclusiveMs,
          MAX_ADVANCED_PAYLOAD_NODES + 1,
        ],
        diagnostics,
      );
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
  if (typeof row.started_at === "number" && row.kind === "page")
    fields["page.time"] = row.started_at;
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
  evaluationRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  },
): FilterEvaluationDataset {
  const initial = rows.map((row): FilterEvaluationEntity => ({
    kind: row.kind,
    id: row.id,
    time: row.time,
    visitId: row.visit_id,
    sessionId: row.session_id ?? undefined,
    visitorId: row.visitor_id ?? undefined,
    fields: fieldsFor(row),
    ...(row.kind === "event"
      ? { payload: payloads.has(row.id) ? payloads.get(row.id) : {} }
      : {}),
  }));
  const candidate = initial.filter(
    (item) =>
      item.time !== undefined &&
      item.time >= candidateRange.startMs &&
      item.time < candidateRange.endExclusiveMs,
  );
  const evaluation = initial.filter(
    (item) =>
      item.time !== undefined &&
      item.time >= evaluationRange.startMs &&
      item.time < evaluationRange.endExclusiveMs,
  );
  const evaluationFacts = aggregateFacts(evaluation);
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
  readonly siteIds: readonly string[];
  readonly filters: FilterDocument;
  readonly plan: ScopedFilterPlan;
  readonly time: QueryTime;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<ScopedAdvancedFilterMatches> {
  const fullHistory = input.time.fullHistory === true;
  const configuredRange = input.time.evaluationRange ?? input.time.range;
  const coverage = await siteCoverage(
    input.env,
    input.siteIds,
    input.diagnostics,
    input.signal,
  );
  const evaluationRange = fullHistory
    ? {
        startMs: Math.min(
          ...input.siteIds.map(
            (siteId) => coverage.get(siteId) ?? Number.MAX_SAFE_INTEGER,
          ),
        ),
        endExclusiveMs: input.time.capturedAtMs + 1,
      }
    : configuredRange;
  if (evaluationRange.endExclusiveMs > input.time.capturedAtMs + 1) {
    throw invalidInput(
      "evaluationRange",
      "filter_evaluation_range_unavailable",
    );
  }
  for (const siteId of input.siteIds) {
    const createdAt = coverage.get(siteId);
    if (
      createdAt === undefined ||
      (!fullHistory && evaluationRange.startMs < createdAt)
    ) {
      throw invalidInput(
        "evaluationRange",
        "filter_evaluation_range_unavailable",
      );
    }
  }
  const paths = payloadPaths(input.filters.root);
  const readRanges = evaluationReadRanges(input.time.range, evaluationRange);
  const [rows, payloads] = await Promise.all([
    loadActivities(
      input.env,
      input.siteIds,
      readRanges,
      input.diagnostics,
      input.signal,
    ),
    paths.paths.length || paths.wholePayload
      ? loadPayloads(
          input.env,
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
  const rowsBySite = new Map<string, RawEvaluationRow[]>();
  for (const row of rows) {
    const siteRows = rowsBySite.get(row.site_id) ?? [];
    siteRows.push(row);
    rowsBySite.set(row.site_id, siteRows);
  }
  for (const siteId of input.siteIds) {
    const createdAt = coverage.get(siteId)!;
    const siteRows = rowsBySite.get(siteId) ?? [];
    const siteEvaluationRange = fullHistory
      ? {
          startMs: createdAt,
          endExclusiveMs: input.time.capturedAtMs + 1,
        }
      : evaluationRange;
    const dataset = entitiesForRows(
      siteRows,
      payloads,
      {
        startMs: input.time.range.startMs,
        endExclusiveMs: input.time.range.endExclusiveMs,
      },
      siteEvaluationRange,
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
          evaluationRange: siteEvaluationRange,
          fullHistory,
          reportingTimeZone: input.time.reportingTimeZone,
          capturedAtMs: input.time.capturedAtMs,
          maxActivities: MAX_ADVANCED_ACTIVITIES,
          maxSequenceMatches: 50_000,
        },
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "filter_evaluation_range_unavailable")
        throw invalidInput("evaluationRange", code);
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
    const subject = query.context.subject;
    const siteIds =
      subject.kind === "site"
        ? [subject.siteId]
        : [...subject.authorizedSiteIds];
    const output = { ...query } as Record<string, unknown>;
    let preparedPrimaryPlan: ScopedFilterPlan | undefined;
    if (query.current && query.reference) {
      for (const sideName of ["current", "reference"] as const) {
        const side = query[sideName] as FilterSide;
        const pending = prepareSide(
          env,
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
