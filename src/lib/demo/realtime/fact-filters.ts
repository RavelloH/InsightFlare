import {
  classifyTrafficChannel,
  type TrafficChannelId,
} from "@/lib/analytics/traffic-channel-rules";
import { createDemoCustomEventFacts } from "@/lib/demo/realtime/events-facts";
import { demoEventRecordPayload } from "@/lib/demo/realtime/events-payload";
import {
  buildDemoFactDataset,
  DEMO_FILTER_HISTORY_START_MS,
} from "@/lib/demo/realtime/fact-dataset";
import {
  DEMO_DIRECT_REFERRER_FILTER_VALUE,
  parseDemoGeoFilterValue,
} from "@/lib/demo/realtime/filters";
import type {
  DemoFactDataset,
  DemoFilteredFacts,
  DemoQueryFilters,
} from "@/lib/demo/realtime/types";
import { demoQueryStringForVisit } from "@/lib/demo/realtime/visit-helpers";
import {
  analyticsFilterRegistry,
  compareFilterValues,
  type FilterCondition,
  type FilterDocument,
  filterDocumentUsesAdvancedExpressions,
  type FilterExpression,
  filterPresenceMatches,
  type FilterValue,
  filterValueInSet,
  filterValuesEqual,
  isLegacyFilterTarget,
  matchFilterString,
  normalizeFilterDocument,
} from "@/lib/filter-contract";
import { evaluateFilterDocument } from "@/lib/filter-contract/filter-evaluator";
import { buildCanonicalFilterScopeFacts } from "@/lib/filter-contract/filter-facts";
interface DemoSessionFacts {
  readonly sessionId: string;
  readonly visitorId: string;
  readonly entryPath: string;
  readonly exitPath: string;
  readonly durationMs: number;
  readonly views: number;
  readonly events: number;
  readonly bounce: boolean;
}
interface DemoVisitorFacts {
  readonly visitorId: string;
  readonly sessions: number;
  readonly views: number;
  readonly events: number;
}
export interface CanonicalDemoFacts {
  readonly sessions: ReadonlyMap<string, DemoSessionFacts>;
  readonly visitors: ReadonlyMap<string, DemoVisitorFacts>;
}
export function buildCanonicalDemoFacts(
  dataset: DemoFactDataset,
): CanonicalDemoFacts {
  const pages = dataset.visits.map((visit) => ({
    kind: "page" as const,
    id: visit.visitId,
    time: visit.startedAt,
    sessionId: visit.sessionId,
    visitorId: visit.visitorId,
    fields: {
      "page.path": visit.pathname,
      "page.durationMs": visit.durationMs,
    },
  }));
  const events = createDemoCustomEventFacts(dataset.visits).map((event) => ({
    kind: "event" as const,
    id: event.eventId,
    time: event.occurredAt,
    sessionId: event.visit.sessionId,
    visitorId: event.visit.visitorId,
    fields: {},
  }));
  const canonical = buildCanonicalFilterScopeFacts([...pages, ...events]);
  const visitorBySession = new Map(
    dataset.visits.map((visit) => [visit.sessionId, visit.visitorId]),
  );
  const sessions = new Map<string, DemoSessionFacts>();
  for (const [sessionId, facts] of canonical.sessions) {
    sessions.set(sessionId, {
      sessionId,
      visitorId:
        dataset.sessions.get(sessionId)?.visitorId ??
        visitorBySession.get(sessionId) ??
        "",
      entryPath: String(facts?.["session.entryPath"] ?? ""),
      exitPath: String(facts?.["session.exitPath"] ?? ""),
      durationMs: Number(facts?.["session.durationMs"] ?? 0),
      views: Number(facts?.["session.views"] ?? 0),
      events: Number(facts?.["session.events"] ?? 0),
      bounce: facts?.["session.bounce"] === true,
    });
  }
  const visitors = new Map<string, DemoVisitorFacts>();
  for (const [visitorId, facts] of canonical.visitors) {
    visitors.set(visitorId, {
      visitorId,
      sessions: Number(facts?.["visitor.sessions"] ?? 0),
      views: Number(facts?.["visitor.views"] ?? 0),
      events: Number(facts?.["visitor.events"] ?? 0),
    });
  }
  return { sessions, visitors };
}
export function canonicalFieldValue(
  visit: DemoFactDataset["visits"][number],
  fieldId: string,
  facts: CanonicalDemoFacts,
): FilterValue | undefined {
  const session = facts.sessions.get(visit.sessionId);
  const visitor = facts.visitors.get(visit.visitorId);
  switch (fieldId) {
    case "page.path":
      return visit.pathname;
    case "page.title":
      return visit.title;
    case "page.hostname":
      return visit.hostname;
    case "page.query":
      return demoQueryStringForVisit(visit);
    case "page.hash":
      return "";
    case "session.entryPath":
      return session?.entryPath;
    case "session.exitPath":
      return session?.exitPath;
    case "referrer.domain":
      return visit.referrerHost;
    case "referrer.url":
      return visit.referrerUrl;
    case "traffic.channel":
      return classifyTrafficChannel({
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
      });
    case "utm.source":
      return visit.utmSource ?? "";
    case "utm.medium":
      return visit.utmMedium ?? "";
    case "utm.campaign":
      return visit.utmCampaign ?? "";
    case "utm.term":
      return "";
    case "utm.content":
      return "";
    case "client.browser":
      return visit.browser;
    case "client.browserVersion":
      return visit.browserVersion;
    case "client.os":
      return "";
    case "client.osVersion":
      return visit.osVersion;
    case "client.deviceType":
      return visit.deviceType;
    case "client.language":
      return visit.language;
    case "client.screenSize":
      return visit.screenSize;
    case "client.screenWidth":
      return visit.screenWidth;
    case "client.screenHeight":
      return visit.screenHeight;
    case "geo.country":
      return visit.country;
    case "geo.region":
      return visit.region;
    case "geo.city":
      return visit.city;
    case "geo.continent":
      return visit.continent;
    case "geo.timeZone":
      return visit.timezone;
    case "geo.organization":
      return visit.organization;
    case "geo.isEU":
      return visit.isEU;
    case "event.name":
      return visit.eventType.trim().toLowerCase() === "pageview"
        ? undefined
        : visit.eventType;
    case "page.durationMs":
      return visit.durationMs;
    case "session.durationMs":
      return session?.durationMs;
    case "session.views":
      return session?.views;
    case "session.events":
      return session?.events;
    case "session.bounce":
      return session?.bounce;
    case "visitor.sessions":
      return visitor?.sessions;
    case "visitor.views":
      return visitor?.views;
    case "visitor.events":
      return visitor?.events;
    case "performance.ttfbMs":
      return visit.perfTtfbMs;
    case "performance.fcpMs":
      return visit.perfFcpMs;
    case "performance.lcpMs":
      return visit.perfLcpMs;
    case "performance.cls":
      return visit.perfCls;
    case "performance.inpMs":
      return visit.perfInpMs;
    case "user.id":
      return visit.userId;
    case "user.name":
      return visit.userName;
    default:
      return undefined;
  }
}
export function demoScalarEqual(
  fieldId: string,
  actual: FilterValue | undefined,
  expected: FilterValue,
): boolean {
  return filterValuesEqual(actual, expected, fieldId, "eq");
}
export function demoConditionMatches(
  visit: DemoFactDataset["visits"][number],
  condition: FilterCondition,
  facts: CanonicalDemoFacts,
): boolean {
  // Payload conditions are evaluated by events-payload-filter.ts against the
  // event JSON. They must not remove visit rows before that event-domain pass.
  if (!isLegacyFilterTarget(condition.target)) return false;
  if (condition.target.kind === "event-payload") return true;
  const fieldId = condition.target.field;
  const actual = canonicalFieldValue(visit, fieldId, facts);
  const operator = condition.operator;
  const presence = filterPresenceMatches(
    operator,
    {
      missing: actual === undefined,
      value: actual,
      emptyCollection: false,
      legacyField: condition.target.kind === "field",
    },
    fieldId,
  );
  if (presence !== undefined) return presence;

  const rawValues = Array.isArray(condition.value)
    ? condition.value
    : [condition.value as FilterValue];
  // SQL NULL comparisons (including NOT IN) do not match. Keep the demo
  // evaluator aligned with D1 when the visit fact is missing.
  if (actual === undefined || actual === null) return false;
  if (operator === "in" || operator === "notIn") {
    const found = filterValueInSet(actual, rawValues, fieldId, operator);
    return operator === "in" ? found : !found;
  }
  if (operator === "between") {
    const [lower, upper] = rawValues;
    return (
      typeof actual === "number" &&
      typeof lower === "number" &&
      typeof upper === "number" &&
      actual >= lower &&
      actual <= upper
    );
  }
  if (
    operator === "contains" ||
    operator === "startsWith" ||
    operator === "endsWith"
  ) {
    if (typeof actual !== "string" || typeof rawValues[0] !== "string")
      return false;
    return matchFilterString(actual, rawValues[0], operator, fieldId);
  }
  if (operator === "eq" || operator === "neq") {
    const equal = filterValuesEqual(actual, rawValues[0], fieldId, operator);
    return operator === "eq" ? equal : !equal;
  }
  if (
    !["gt", "gte", "lt", "lte"].includes(operator) ||
    !["string", "number", "boolean"].includes(typeof actual) ||
    !["string", "number", "boolean"].includes(typeof rawValues[0]) ||
    typeof actual !== typeof rawValues[0]
  )
    return false;
  const order = compareFilterValues(
    actual as string | number | boolean,
    rawValues[0] as string | number | boolean,
    fieldId,
  );
  switch (operator) {
    case "gt":
      return order > 0;
    case "gte":
      return order >= 0;
    case "lt":
      return order < 0;
    case "lte":
      return order <= 0;
    default:
      return false;
  }
}
export function demoExpressionMatchesOnVisit(
  visit: DemoFactDataset["visits"][number],
  expression: FilterExpression | null,
  facts: CanonicalDemoFacts,
): boolean {
  if (!expression) return true;
  if (expression.kind === "condition")
    return demoConditionMatches(visit, expression, facts);
  if (expression.kind === "not")
    return !demoExpressionMatchesOnVisit(visit, expression.child, facts);
  return expression.kind === "and"
    ? expression.children.every((child) =>
        demoExpressionMatchesOnVisit(visit, child, facts),
      )
    : expression.children.some((child) =>
        demoExpressionMatchesOnVisit(visit, child, facts),
      );
}
export function demoExpressionMatchesForEntity(
  visits: readonly DemoFactDataset["visits"][number][],
  expression: FilterExpression | null,
  facts: CanonicalDemoFacts,
): boolean {
  if (!expression) return true;
  if (expression.kind === "condition") {
    // Fact conditions are evaluated per observation only as a convenient way
    // to look up the entity aggregate. Observation conditions are existential
    // witnesses for the entity, matching scoped-dataset set semantics.
    return visits.some((visit) =>
      demoConditionMatches(visit, expression, facts),
    );
  }
  if (expression.kind === "not")
    return !demoExpressionMatchesForEntity(visits, expression.child, facts);
  return expression.kind === "and"
    ? expression.children.every((child) =>
        demoExpressionMatchesForEntity(visits, child, facts),
      )
    : expression.children.some((child) =>
        demoExpressionMatchesForEntity(visits, child, facts),
      );
}
type DemoFilterTruth = "true" | "false" | "unknown";
function invertDemoFilterTruth(value: DemoFilterTruth): DemoFilterTruth {
  if (value === "true") return "false";
  if (value === "false") return "true";
  return "unknown";
}
/**
 * Return whether an expression may match a visit while payload conditions are
 * intentionally left unknown. Event endpoints use this as a sound candidate
 * pre-filter before evaluating the complete expression against event JSON.
 */
export function demoExpressionMayMatchOnVisit(
  visit: DemoFactDataset["visits"][number],
  expression: FilterExpression | null,
  facts: CanonicalDemoFacts,
): boolean {
  const evaluate = (item: FilterExpression | null): DemoFilterTruth => {
    if (!item) return "true";
    if (item.kind === "condition") {
      return item.target.kind === "event-payload"
        ? "unknown"
        : demoConditionMatches(visit, item, facts)
          ? "true"
          : "false";
    }
    if (item.kind === "not") return invertDemoFilterTruth(evaluate(item.child));
    const values = item.children.map(evaluate);
    if (item.kind === "and") {
      if (values.some((value) => value === "false")) return "false";
      return values.every((value) => value === "true") ? "true" : "unknown";
    }
    if (values.some((value) => value === "true")) return "true";
    return values.every((value) => value === "false") ? "false" : "unknown";
  };

  return evaluate(expression) !== "false";
}
/** Entity counterpart to demoExpressionMayMatchOnVisit for scoped candidates. */
export function demoExpressionMayMatchForEntity(
  visits: readonly DemoFactDataset["visits"][number][],
  expression: FilterExpression | null,
  facts: CanonicalDemoFacts,
): boolean {
  const evaluate = (item: FilterExpression | null): DemoFilterTruth => {
    if (!item) return "true";
    if (item.kind === "condition") {
      if (item.target.kind === "event-payload") return "unknown";
      return visits.some((visit) => demoConditionMatches(visit, item, facts))
        ? "true"
        : "false";
    }
    if (item.kind === "not") return invertDemoFilterTruth(evaluate(item.child));
    const values = item.children.map(evaluate);
    if (item.kind === "and") {
      if (values.some((value) => value === "false")) return "false";
      return values.every((value) => value === "true") ? "true" : "unknown";
    }
    if (values.some((value) => value === "true")) return "true";
    return values.every((value) => value === "false") ? "false" : "unknown";
  };

  return evaluate(expression) !== "false";
}
function finalizeDemoFilteredFacts(
  visits: DemoFactDataset["visits"],
): DemoFilteredFacts {
  const result: DemoFilteredFacts = {
    visits: [...visits],
    sessions: new Set<string>(),
    visitors: new Set<string>(),
    visitsBySession: new Map<string, number>(),
  };
  for (const visit of result.visits) {
    result.sessions.add(visit.sessionId);
    result.visitors.add(visit.visitorId);
    result.visitsBySession.set(
      visit.sessionId,
      (result.visitsBySession.get(visit.sessionId) ?? 0) + 1,
    );
  }
  return result;
}
function applyCanonicalDemoFilters(
  dataset: DemoFactDataset,
  document: FilterDocument,
  filters: DemoQueryFilters,
): DemoFilteredFacts {
  const scope = filters.scope;
  const normalized = document.root
    ? normalizeFilterDocument(document, analyticsFilterRegistry)
    : document;
  if (filterDocumentUsesAdvancedExpressions(normalized)) {
    if (dataset.to <= dataset.from) return finalizeDemoFilteredFacts([]);
    const requestedHistoryStart = filters.evaluationRange?.startMs;
    const requestedHistoryEnd = filters.evaluationRange?.endExclusiveMs;
    const needsExpandedSource =
      filters.fullHistory === true ||
      (requestedHistoryStart !== undefined &&
        requestedHistoryStart < dataset.from) ||
      (requestedHistoryEnd !== undefined && requestedHistoryEnd > dataset.to);
    const historyDataset =
      filters.historyDataset ??
      (needsExpandedSource && filters.siteId
        ? buildDemoFactDataset(
            filters.siteId,
            filters.fullHistory
              ? Math.min(dataset.from, DEMO_FILTER_HISTORY_START_MS)
              : Math.min(dataset.from, requestedHistoryStart ?? dataset.from),
            filters.fullHistory
              ? Math.max(
                  dataset.to,
                  requestedHistoryEnd ?? dataset.to,
                  (filters.capturedAtMs ?? dataset.to - 1) + 1,
                )
              : Math.max(dataset.to, requestedHistoryEnd ?? dataset.to),
          )
        : undefined);
    const evaluationDataset = historyDataset
      ? mergeFilterHistoryDataset(dataset, historyDataset)
      : dataset;
    const evaluationFacts = buildCanonicalDemoFacts(evaluationDataset);
    const candidateFacts = buildCanonicalDemoFacts(dataset);
    const fieldsFor = (
      visit: DemoFactDataset["visits"][number],
      facts: CanonicalDemoFacts,
    ) =>
      Object.fromEntries(
        [...analyticsFilterRegistry.keys()].flatMap((fieldId) => {
          const value = canonicalFieldValue(visit, fieldId, facts);
          return value === undefined ? [] : [[fieldId, value]];
        }),
      );
    const pages = evaluationDataset.visits.map((visit) => ({
      kind: "page" as const,
      id: visit.visitId,
      visitId: visit.visitId,
      sessionId: visit.sessionId,
      visitorId: visit.visitorId,
      time: visit.startedAt,
      fields: fieldsFor(visit, evaluationFacts),
      candidateFields: fieldsFor(visit, candidateFacts),
    }));
    const events = createDemoCustomEventFacts(evaluationDataset.visits).map(
      (event) => ({
        kind: "event" as const,
        id: event.eventId,
        visitId: event.visit.visitId,
        sessionId: event.visit.sessionId,
        visitorId: event.visit.visitorId,
        time: event.occurredAt,
        fields: {
          ...fieldsFor(event.visit, evaluationFacts),
          "event.name": event.eventName,
        },
        candidateFields: {
          ...fieldsFor(event.visit, candidateFacts),
          "event.name": event.eventName,
        },
        payload: demoEventRecordPayload(event),
      }),
    );
    const evaluation = evaluateFilterDocument(
      normalized,
      {
        pages,
        events,
        coverageRange: {
          startMs: evaluationDataset.from,
          endExclusiveMs: evaluationDataset.to,
        },
      },
      {
        scope: scope ?? "event",
        candidateRange: filters.candidateRange ?? {
          startMs: dataset.from,
          endExclusiveMs: dataset.to,
        },
        ...(filters.evaluationRange
          ? { evaluationRange: filters.evaluationRange }
          : {}),
        ...(filters.fullHistory ? { fullHistory: true } : {}),
        reportingTimeZone: filters.reportingTimeZone ?? "UTC",
        capturedAtMs: filters.capturedAtMs ?? dataset.to - 1,
      },
    );
    return finalizeDemoFilteredFacts(
      dataset.visits.filter((visit) =>
        evaluation.matchingVisitIds.has(visit.visitId),
      ),
    );
  }
  const facts = buildCanonicalDemoFacts(dataset);
  if (!normalized.root) return finalizeDemoFilteredFacts(dataset.visits);
  if (!scope || scope === "event") {
    return finalizeDemoFilteredFacts(
      dataset.visits.filter((visit) =>
        demoExpressionMayMatchOnVisit(visit, normalized.root, facts),
      ),
    );
  }

  const entityIds = new Set<string>();
  const entityMap = scope === "session" ? facts.sessions : facts.visitors;
  for (const entityId of entityMap.keys()) {
    const visits = dataset.visits.filter((visit) =>
      scope === "session"
        ? visit.sessionId === entityId
        : visit.visitorId === entityId,
    );
    if (demoExpressionMayMatchForEntity(visits, normalized.root, facts)) {
      entityIds.add(entityId);
    }
  }
  return finalizeDemoFilteredFacts(
    dataset.visits.filter((visit) =>
      entityIds.has(scope === "session" ? visit.sessionId : visit.visitorId),
    ),
  );
}

/**
 * Keep query-result facts on the candidate dataset while giving Core/Relation
 * evaluation the additional source rows it needs. The mock generator uses
 * stable session and visit IDs across windows, so candidate facts can replace
 * duplicate history rows without changing result identity.
 */
function mergeFilterHistoryDataset(
  candidate: DemoFactDataset,
  history: DemoFactDataset,
): DemoFactDataset {
  const visitorBySession = new Map<string, string>();
  for (const visit of candidate.visits) {
    if (!visitorBySession.has(visit.sessionId))
      visitorBySession.set(visit.sessionId, visit.visitorId);
  }
  const visits = new Map<string, DemoFactDataset["visits"][number]>();
  for (const visit of history.visits) {
    const visitorId = visitorBySession.get(visit.sessionId) ?? visit.visitorId;
    visits.set(
      visit.visitId,
      visitorId === visit.visitorId ? visit : { ...visit, visitorId },
    );
  }
  for (const visit of candidate.visits) visits.set(visit.visitId, visit);
  return {
    ...history,
    from: Math.min(candidate.from, history.from),
    to: Math.max(candidate.to, history.to),
    visits: [...visits.values()],
  };
}
export function applyDemoFilters(
  dataset: DemoFactDataset,
  filters: DemoQueryFilters,
): DemoFilteredFacts {
  if (filters.filterDocument?.root) {
    return applyCanonicalDemoFilters(dataset, filters.filterDocument, filters);
  }
  const result: DemoFilteredFacts = {
    visits: [],
    sessions: new Set<string>(),
    visitors: new Set<string>(),
    visitsBySession: new Map<string, number>(),
  };
  const parsedGeo = parseDemoGeoFilterValue(filters.geo);
  const regionTokens = new Set(
    [parsedGeo?.regionCode, parsedGeo?.regionName]
      .map((value) =>
        String(value ?? "")
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean),
  );
  const equalsTrimmed = (left: string, right: string) => left.trim() === right;
  const equalsCaseInsensitive = (left: string, right: string) =>
    left.trim().toLowerCase() === right.toLowerCase();
  const channel = filters.channel?.trim().toLowerCase() as
    TrafficChannelId | undefined;

  for (const visit of dataset.visits) {
    if (
      channel &&
      classifyTrafficChannel({
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
      }) !== channel
    )
      continue;
    if (
      filters.country &&
      !equalsCaseInsensitive(visit.country, filters.country)
    )
      continue;
    if (filters.device && !equalsTrimmed(visit.deviceType, filters.device))
      continue;
    if (filters.browser && !equalsTrimmed(visit.browser, filters.browser))
      continue;
    if (filters.path && !equalsTrimmed(visit.pathname, filters.path)) continue;
    if (
      filters.query &&
      !equalsTrimmed(demoQueryStringForVisit(visit), filters.query)
    )
      continue;
    if (filters.title && !equalsTrimmed(visit.title, filters.title)) continue;
    if (
      filters.hostname &&
      !equalsCaseInsensitive(visit.hostname, filters.hostname)
    )
      continue;

    if (filters.entry) {
      const session = dataset.sessions.get(visit.sessionId);
      if (!session || !equalsTrimmed(session.entryPath, filters.entry))
        continue;
    }
    if (filters.exit) {
      const session = dataset.sessions.get(visit.sessionId);
      if (!session || !equalsTrimmed(session.exitPath, filters.exit)) continue;
    }

    if (filters.sourceDomain) {
      if (filters.sourceDomain === DEMO_DIRECT_REFERRER_FILTER_VALUE) {
        if (visit.referrerHost.trim()) continue;
      } else if (
        !equalsCaseInsensitive(visit.referrerHost, filters.sourceDomain)
      ) {
        continue;
      }
    }
    if (filters.sourceLink) {
      if (filters.sourceLink === DEMO_DIRECT_REFERRER_FILTER_VALUE) {
        if (visit.referrerUrl.trim()) continue;
      } else {
        let sourceLinkMatch =
          equalsCaseInsensitive(visit.referrerUrl, filters.sourceLink) ||
          equalsCaseInsensitive(visit.referrerHost, filters.sourceLink);
        if (!sourceLinkMatch) {
          try {
            const hostname = new URL(filters.sourceLink).hostname;
            sourceLinkMatch = equalsCaseInsensitive(
              visit.referrerHost,
              hostname,
            );
          } catch {
            // ignore invalid URL parse and keep fallback matching result
          }
        }
        if (!sourceLinkMatch) continue;
      }
    }

    if (
      filters.clientBrowser &&
      !equalsTrimmed(visit.browser, filters.clientBrowser)
    )
      continue;
    if (
      filters.clientOsVersion &&
      !equalsTrimmed(visit.osVersion, filters.clientOsVersion)
    )
      continue;
    if (
      filters.clientDeviceType &&
      !equalsTrimmed(visit.deviceType, filters.clientDeviceType)
    )
      continue;
    if (
      filters.clientLanguage &&
      !equalsTrimmed(visit.language, filters.clientLanguage)
    )
      continue;
    if (
      filters.clientScreenSize &&
      !equalsTrimmed(visit.screenSize, filters.clientScreenSize)
    )
      continue;
    if (
      filters.geoContinent &&
      !equalsTrimmed(visit.continent, filters.geoContinent)
    )
      continue;
    if (
      filters.geoTimezone &&
      !equalsTrimmed(visit.timezone, filters.geoTimezone)
    )
      continue;
    if (
      filters.geoOrganization &&
      !equalsTrimmed(visit.organization, filters.geoOrganization)
    )
      continue;

    if (
      parsedGeo?.country &&
      !equalsCaseInsensitive(visit.country, parsedGeo.country)
    )
      continue;
    if (regionTokens.size > 0) {
      const visitRegionTokens = [visit.regionCode, visit.regionName]
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
      if (!visitRegionTokens.some((token) => regionTokens.has(token))) continue;
    }
    if (
      parsedGeo?.city &&
      !equalsCaseInsensitive(visit.cityName, parsedGeo.city)
    )
      continue;

    result.visits.push(visit);
    result.sessions.add(visit.sessionId);
    result.visitors.add(visit.visitorId);
    result.visitsBySession.set(
      visit.sessionId,
      (result.visitsBySession.get(visit.sessionId) ?? 0) + 1,
    );
  }

  // The demo dataset is intentionally visit-backed, but it still mirrors the
  // resolved scope contract for the common historical dimensions: first find
  // the matching Event observations, then expand to all in-window
  // observations belonging to the matching Session or Visitor.  The D1
  // provider performs the same expansion through its final relations.
  if (filters.scope === "session" || filters.scope === "visitor") {
    const matchingEntities = new Set(
      result.visits.map((visit) =>
        filters.scope === "session" ? visit.sessionId : visit.visitorId,
      ),
    );
    result.visits = dataset.visits.filter((visit) =>
      matchingEntities.has(
        filters.scope === "session" ? visit.sessionId : visit.visitorId,
      ),
    );
    result.sessions.clear();
    result.visitors.clear();
    result.visitsBySession.clear();
    for (const visit of result.visits) {
      result.sessions.add(visit.sessionId);
      result.visitors.add(visit.visitorId);
      result.visitsBySession.set(
        visit.sessionId,
        (result.visitsBySession.get(visit.sessionId) ?? 0) + 1,
      );
    }
  }

  return result;
}
