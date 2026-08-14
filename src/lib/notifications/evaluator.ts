import type { Env } from "@/lib/edge/types";
import { clampString } from "@/lib/edge/utils";

import type {
  NotificationMessageType,
  NotificationSeverity,
} from "./message-types";
import type { NotificationInvocationCache } from "./notification-cache";
import {
  loadCumulativeMetricValue,
  loadMetricValue,
  loadPreviousMetricValue,
  loadReportData,
  loadSiteInfo,
  loadSiteLastSeenAt,
  type NotificationMetric,
  type NotificationMetricWindow,
  type NotificationReportType,
  type ReportData,
} from "./report-data";
import type { NotificationRule } from "./rule-store";

export interface NotificationMessageDraft {
  type: NotificationMessageType;
  severity: NotificationSeverity;
  requiresAttention: boolean;
  title: string;
  summary: string;
  bodyText: string;
  bodyHtml?: string;
  data?: Record<string, unknown>;
}

export type NotificationRuleEvaluationResult =
  | {
      status: "skipped";
      reason: string;
      data?: Record<string, unknown>;
    }
  | {
      status: "checked";
      triggered: false;
      summary: string;
      data?: Record<string, unknown>;
    }
  | {
      status: "triggered";
      message: NotificationMessageDraft;
      cooldownUntil?: number | null;
      state?: Record<string, unknown>;
      data?: Record<string, unknown>;
    };

type ThresholdOperator = ">" | ">=" | "<" | "<=";
type ConditionCombinator = "all" | "any";
type ChangeMode = "absolute" | "percent";

const METRICS = new Set<NotificationMetric>(["views", "visitors", "sessions"]);
const WINDOWS = new Set<NotificationMetricWindow>([
  "last_1h",
  "last_24h",
  "yesterday",
]);
const OPERATORS = new Set<ThresholdOperator>([">", ">=", "<", "<="]);
const REPORT_TYPES = new Set<NotificationReportType>([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
]);
const CHANGE_MODES = new Set<ChangeMode>(["absolute", "percent"]);

function numberWithCommas(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

function conditionString(
  condition: Record<string, unknown>,
  key: string,
): string {
  const value = condition[key];
  return typeof value === "string" ? value.trim() : "";
}

function conditionNumber(
  condition: Record<string, unknown>,
  key: string,
): number | null {
  const value = Number(condition[key]);
  if (!Number.isFinite(value)) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function reportTypeFor(condition: Record<string, unknown>) {
  const value = conditionString(condition, "reportType");
  return REPORT_TYPES.has(value as NotificationReportType)
    ? (value as NotificationReportType)
    : "daily";
}

function conditionItems(condition: Record<string, unknown>): {
  combinator: ConditionCombinator;
  items: Record<string, unknown>[];
} {
  if (Array.isArray(condition.all)) {
    return {
      combinator: "all",
      items: condition.all.filter(isRecord),
    };
  }
  if (Array.isArray(condition.any)) {
    return {
      combinator: "any",
      items: condition.any.filter(isRecord),
    };
  }
  const combinator =
    condition.combinator === "any" || condition.operator === "any"
      ? "any"
      : "all";
  const rawItems = Array.isArray(condition.conditions)
    ? condition.conditions.filter(isRecord)
    : [condition];
  return {
    combinator,
    items: rawItems,
  };
}

function cooldownUntilFor(
  condition: Record<string, unknown>,
  now: number,
): number | null {
  const minutes = conditionNumber(condition, "cooldownMinutes");
  if (!minutes || minutes <= 0) return null;
  return now + Math.trunc(minutes) * 60;
}

function siteDisplayName(input: { siteName: string; siteDomain: string }) {
  return input.siteDomain || input.siteName || "Site";
}

function testRule(): NotificationRuleEvaluationResult {
  return {
    status: "triggered",
    message: {
      type: "test",
      severity: "info",
      requiresAttention: false,
      title: "InsightFlare notification test",
      summary: "This is a test notification from InsightFlare.",
      bodyText:
        "This is a test notification from InsightFlare. If email is configured and enabled, this message also verifies Resend delivery.",
      data: {
        source: "rule_test",
      },
    },
  };
}

function reportTypeLabel(reportType: NotificationReportType) {
  if (reportType === "weekly") return "weekly";
  if (reportType === "monthly") return "monthly";
  if (reportType === "quarterly") return "quarterly";
  if (reportType === "yearly") return "yearly";
  return "daily";
}

function reportBody(input: ReportData | null) {
  if (!input) return "";
  const reportLabel = reportTypeLabel(input.reportType);
  const pageLines =
    input.topPages.length > 0
      ? input.topPages
          .map(
            (page, index) =>
              `${index + 1}. ${page.path} - ${numberWithCommas(page.views)} views`,
          )
          .join("\n")
      : "No page data.";
  const referrerLines =
    input.topReferrers.length > 0
      ? input.topReferrers
          .map(
            (referrer, index) =>
              `${index + 1}. ${referrer.referrer} - ${numberWithCommas(referrer.visits)} visits`,
          )
          .join("\n")
      : "No referrer data.";
  return `${siteDisplayName(input)} ${reportLabel} traffic report

Range: ${input.range.label}

Core metrics:
- Views: ${numberWithCommas(input.metrics.views)}
- Visitors: ${numberWithCommas(input.metrics.visitors)}
- Sessions: ${numberWithCommas(input.metrics.sessions)}

Top Pages:
${pageLines}

Top Referrers:
${referrerLines}`;
}

async function evaluateReportRule(
  env: Env,
  rule: NotificationRule,
  now: number,
  cache?: NotificationInvocationCache,
): Promise<NotificationRuleEvaluationResult> {
  if (!rule.siteId) {
    return { status: "skipped", reason: "missing_site_id" };
  }
  const reportType = reportTypeFor(rule.condition);
  const data = await loadReportData(env, {
    siteId: rule.siteId,
    now,
    reportType,
    cache,
    timezone:
      typeof rule.schedule === "object" && "timezone" in rule.schedule
        ? rule.schedule.timezone
        : undefined,
  });
  if (!data) return { status: "skipped", reason: "site_not_found" };
  const displayName = siteDisplayName(data);
  const reportLabel = reportTypeLabel(reportType);
  return {
    status: "triggered",
    message: {
      type: "report",
      severity: "info",
      requiresAttention: false,
      title: `${displayName} ${reportLabel} traffic report`,
      summary: `${data.range.label}: ${numberWithCommas(data.metrics.visitors)} visitors and ${numberWithCommas(data.metrics.views)} views.`,
      bodyText: reportBody(data),
      data: {
        ruleId: rule.id,
        siteId: rule.siteId,
        siteName: data.siteName,
        siteDomain: data.siteDomain,
        type: "report",
        reportType,
        range: data.range,
        metrics: data.metrics,
        topPages: data.topPages,
        topReferrers: data.topReferrers,
      },
    },
    data: {
      range: data.range,
      metrics: data.metrics,
    },
  };
}

export function compareThreshold(
  value: number,
  operator: ThresholdOperator,
  target: number,
): boolean {
  if (operator === ">") return value > target;
  if (operator === ">=") return value >= target;
  if (operator === "<") return value < target;
  return value <= target;
}

interface MetricConditionEvaluation {
  metric: NotificationMetric;
  window: NotificationMetricWindow;
  value: number;
  operator: ThresholdOperator;
  target: number;
  triggered: boolean;
  range: { from: number; to: number };
}

function validMetricCondition(item: Record<string, unknown>): {
  metric: NotificationMetric;
  window: NotificationMetricWindow;
  operator: ThresholdOperator;
  target: number;
} | null {
  const metric = conditionString(item, "metric") as NotificationMetric;
  const window = conditionString(item, "window") as NotificationMetricWindow;
  const operator = conditionString(item, "operator") as ThresholdOperator;
  const target = conditionNumber(item, "value");
  if (!METRICS.has(metric)) return null;
  if (!WINDOWS.has(window)) return null;
  if (!OPERATORS.has(operator)) return null;
  if (target === null) return null;
  return { metric, window, operator, target };
}

function combineTriggered(
  combinator: ConditionCombinator,
  items: Array<{ triggered: boolean }>,
) {
  if (items.length === 0) return false;
  return combinator === "any"
    ? items.some((item) => item.triggered)
    : items.every((item) => item.triggered);
}

function conditionSummary(evaluations: MetricConditionEvaluation[]) {
  return evaluations
    .map(
      (item) =>
        `${item.window.replaceAll("_", " ")} ${item.metric} ${numberWithCommas(item.value)} ${item.operator} ${numberWithCommas(item.target)}`,
    )
    .join("; ");
}

function ruleStateSection(
  state: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return isRecord(state[key]) ? (state[key] as Record<string, unknown>) : {};
}

function thresholdTriggerKey(
  combinator: ConditionCombinator,
  evaluations: MetricConditionEvaluation[],
) {
  return [
    "threshold",
    combinator,
    ...evaluations.map((item) =>
      [
        item.metric,
        item.window,
        item.operator,
        item.target,
        item.range.from,
        item.range.to,
      ].join(":"),
    ),
  ].join("|");
}

async function getSiteDisplay(
  env: Env,
  siteId: string,
  cache?: NotificationInvocationCache,
): Promise<string | null> {
  if (cache) {
    const row = await loadSiteInfo(env, siteId, cache);
    if (!row) return null;
    return row.domain || row.name || "Site";
  }
  const row = await env.DB.prepare(
    "SELECT name, domain FROM sites WHERE id = ? LIMIT 1",
  )
    .bind(siteId)
    .first<{ name: string; domain: string }>();
  if (!row) return null;
  return row.domain || row.name || "Site";
}

async function evaluateThresholdRule(
  env: Env,
  rule: NotificationRule,
  now: number,
  cache?: NotificationInvocationCache,
): Promise<NotificationRuleEvaluationResult> {
  if (!rule.siteId) return { status: "skipped", reason: "missing_site_id" };
  const site = await getSiteDisplay(env, rule.siteId, cache);
  if (!site) return { status: "skipped", reason: "site_not_found" };
  const { combinator, items } = conditionItems(rule.condition);
  const validItems = items.map(validMetricCondition);
  if (validItems.some((item) => item === null)) {
    if (items.length === 1) {
      const item = items[0] ?? {};
      const metric = conditionString(item, "metric") as NotificationMetric;
      const window = conditionString(
        item,
        "window",
      ) as NotificationMetricWindow;
      const operator = conditionString(item, "operator") as ThresholdOperator;
      if (!METRICS.has(metric))
        return { status: "skipped", reason: "invalid_metric" };
      if (!WINDOWS.has(window))
        return { status: "skipped", reason: "invalid_window" };
      if (!OPERATORS.has(operator))
        return { status: "skipped", reason: "invalid_operator" };
      return { status: "skipped", reason: "invalid_value" };
    }
    return { status: "skipped", reason: "invalid_condition" };
  }
  const evaluations: MetricConditionEvaluation[] = [];
  for (const item of validItems) {
    if (!item) continue;
    const result = await loadMetricValue(env, {
      siteId: rule.siteId,
      metric: item.metric,
      window: item.window,
      now,
      cache,
    });
    evaluations.push({
      metric: item.metric,
      window: item.window,
      value: result.value,
      operator: item.operator,
      target: item.target,
      triggered: compareThreshold(result.value, item.operator, item.target),
      range: result.range,
    });
  }
  const triggered = combineTriggered(combinator, evaluations);
  const data = {
    ruleId: rule.id,
    siteId: rule.siteId,
    siteName: site,
    siteDomain: site,
    metric: evaluations[0]?.metric,
    window: evaluations[0]?.window,
    value: evaluations[0]?.value,
    operator: evaluations[0]?.operator,
    target: evaluations[0]?.target,
    combinator,
    conditions: evaluations,
    triggered,
    range: evaluations[0]?.range,
  };
  if (!triggered) {
    return {
      status: "checked",
      triggered: false,
      summary: `Threshold conditions did not match: ${conditionSummary(evaluations)}.`,
      data,
    };
  }
  const summary = `${combinator.toUpperCase()} threshold matched: ${conditionSummary(evaluations)}.`;
  const triggerKey = thresholdTriggerKey(combinator, evaluations);
  if (ruleStateSection(rule.state, "threshold").lastTriggerKey === triggerKey) {
    return {
      status: "checked",
      triggered: false,
      summary: `Threshold conditions already triggered for this window: ${conditionSummary(evaluations)}.`,
      data: { ...data, duplicate: true, triggerKey },
    };
  }
  return {
    status: "triggered",
    cooldownUntil: cooldownUntilFor(rule.condition, now),
    state: {
      ...rule.state,
      threshold: {
        ...ruleStateSection(rule.state, "threshold"),
        lastTriggerKey: triggerKey,
        updatedAt: now,
      },
    },
    data,
    message: {
      type: "threshold",
      severity: "warning",
      requiresAttention: true,
      title: `${site} traffic threshold reached`,
      summary,
      bodyText: `${site} traffic threshold reached

${summary}`,
      data,
    },
  };
}

interface ChangeConditionEvaluation {
  metric: NotificationMetric;
  window: NotificationMetricWindow;
  current: number;
  previous: number;
  change: number;
  mode: ChangeMode;
  operator: ThresholdOperator;
  target: number;
  triggered: boolean;
  range: { from: number; to: number };
  previousRange: { from: number; to: number };
}

function validChangeCondition(item: Record<string, unknown>): {
  metric: NotificationMetric;
  window: NotificationMetricWindow;
  mode: ChangeMode;
  operator: ThresholdOperator;
  target: number;
} | null {
  const metric = conditionString(item, "metric") as NotificationMetric;
  const window = conditionString(item, "window") as NotificationMetricWindow;
  const mode = conditionString(item, "mode") as ChangeMode;
  const operator = conditionString(item, "operator") as ThresholdOperator;
  const target = conditionNumber(item, "value");
  if (!METRICS.has(metric)) return null;
  if (!WINDOWS.has(window)) return null;
  if (!CHANGE_MODES.has(mode)) return null;
  if (!OPERATORS.has(operator)) return null;
  if (target === null) return null;
  return { metric, window, mode, operator, target };
}

function changeTriggerKey(
  combinator: ConditionCombinator,
  evaluations: ChangeConditionEvaluation[],
) {
  return [
    "change",
    combinator,
    ...evaluations.map((item) =>
      [
        item.metric,
        item.window,
        item.mode,
        item.operator,
        item.target,
        item.range.from,
        item.range.to,
        item.previousRange.from,
        item.previousRange.to,
      ].join(":"),
    ),
  ].join("|");
}

async function evaluateChangeRule(
  env: Env,
  rule: NotificationRule,
  now: number,
  cache?: NotificationInvocationCache,
): Promise<NotificationRuleEvaluationResult> {
  if (!rule.siteId) return { status: "skipped", reason: "missing_site_id" };
  const site = await getSiteDisplay(env, rule.siteId, cache);
  if (!site) return { status: "skipped", reason: "site_not_found" };
  const { combinator, items } = conditionItems(rule.condition);
  const validItems = items.map(validChangeCondition);
  if (validItems.some((item) => item === null)) {
    return { status: "skipped", reason: "invalid_condition" };
  }
  const evaluations: ChangeConditionEvaluation[] = [];
  for (const item of validItems) {
    if (!item) continue;
    const [current, previous] = await Promise.all([
      loadMetricValue(env, {
        siteId: rule.siteId,
        metric: item.metric,
        window: item.window,
        now,
        cache,
      }),
      loadPreviousMetricValue(env, {
        siteId: rule.siteId,
        metric: item.metric,
        window: item.window,
        now,
        cache,
      }),
    ]);
    const absolute = current.value - previous.value;
    const percent =
      previous.value === 0
        ? current.value === 0
          ? 0
          : 100
        : (absolute / previous.value) * 100;
    const change = item.mode === "percent" ? percent : absolute;
    evaluations.push({
      metric: item.metric,
      window: item.window,
      current: current.value,
      previous: previous.value,
      change,
      mode: item.mode,
      operator: item.operator,
      target: item.target,
      triggered: compareThreshold(change, item.operator, item.target),
      range: current.range,
      previousRange: previous.range,
    });
  }
  const triggered = combineTriggered(combinator, evaluations);
  const summary = evaluations
    .map(
      (item) =>
        `${item.window.replaceAll("_", " ")} ${item.metric} changed ${numberWithCommas(item.change)}${item.mode === "percent" ? "%" : ""} (${numberWithCommas(item.previous)} to ${numberWithCommas(item.current)})`,
    )
    .join("; ");
  const data = {
    ruleId: rule.id,
    siteId: rule.siteId,
    siteName: site,
    siteDomain: site,
    combinator,
    conditions: evaluations,
    metric: evaluations[0]?.metric,
    window: evaluations[0]?.window,
    current: evaluations[0]?.current,
    previous: evaluations[0]?.previous,
    change: evaluations[0]?.change,
    mode: evaluations[0]?.mode,
    operator: evaluations[0]?.operator,
    target: evaluations[0]?.target,
    triggered,
  };
  if (!triggered) {
    return {
      status: "checked",
      triggered: false,
      summary: `Change conditions did not match: ${summary}.`,
      data,
    };
  }
  const triggerKey = changeTriggerKey(combinator, evaluations);
  if (ruleStateSection(rule.state, "change").lastTriggerKey === triggerKey) {
    return {
      status: "checked",
      triggered: false,
      summary: `Change conditions already triggered for this window: ${summary}.`,
      data: { ...data, duplicate: true, triggerKey },
    };
  }
  return {
    status: "triggered",
    cooldownUntil: cooldownUntilFor(rule.condition, now),
    state: {
      ...rule.state,
      change: {
        ...ruleStateSection(rule.state, "change"),
        lastTriggerKey: triggerKey,
        updatedAt: now,
      },
    },
    data,
    message: {
      type: "change",
      severity: "warning",
      requiresAttention: true,
      title: `${site} traffic change detected`,
      summary,
      bodyText: `${site} traffic change detected

${summary}`,
      data,
    },
  };
}

async function evaluateMilestoneRule(
  env: Env,
  rule: NotificationRule,
  now: number,
  cache?: NotificationInvocationCache,
): Promise<NotificationRuleEvaluationResult> {
  if (!rule.siteId) return { status: "skipped", reason: "missing_site_id" };
  const site = await getSiteDisplay(env, rule.siteId, cache);
  if (!site) return { status: "skipped", reason: "site_not_found" };
  const metric = conditionString(
    rule.condition,
    "metric",
  ) as NotificationMetric;
  if (!METRICS.has(metric))
    return { status: "skipped", reason: "invalid_metric" };
  const step =
    conditionNumber(rule.condition, "step") ??
    conditionNumber(rule.condition, "every") ??
    conditionNumber(rule.condition, "value");
  if (!step || step <= 0) return { status: "skipped", reason: "invalid_step" };
  const value = await loadCumulativeMetricValue(env, {
    siteId: rule.siteId,
    metric,
    now,
    cache,
  });
  const bucket = Math.floor(value / step) * step;
  const milestoneState = isRecord(rule.state.milestone)
    ? rule.state.milestone
    : {};
  const metricState = isRecord(milestoneState[metric])
    ? (milestoneState[metric] as Record<string, unknown>)
    : {};
  const lastBucket = Math.trunc(Number(metricState.lastBucket ?? 0));
  const triggered = bucket > 0 && bucket > lastBucket;
  const nextState = {
    ...rule.state,
    milestone: {
      ...milestoneState,
      [metric]: {
        lastBucket: Math.max(lastBucket, bucket),
        lastValue: value,
        updatedAt: now,
      },
    },
  };
  const data = {
    ruleId: rule.id,
    siteId: rule.siteId,
    siteName: site,
    siteDomain: site,
    metric,
    value,
    step,
    bucket,
    lastBucket,
    triggered,
  };
  if (!triggered) {
    return {
      status: "checked",
      triggered: false,
      summary: `${metric} total ${numberWithCommas(value)} has not crossed the next ${numberWithCommas(step)} milestone.`,
      data,
    };
  }
  return {
    status: "triggered",
    state: nextState,
    data,
    message: {
      type: "milestone",
      severity: "success",
      requiresAttention: false,
      title: `${site} reached ${numberWithCommas(bucket)} ${metric}`,
      summary: `${site} reached ${numberWithCommas(bucket)} total ${metric}.`,
      bodyText: `${site} reached a traffic milestone.

Metric: ${metric}
Milestone: ${numberWithCommas(bucket)}
Current value: ${numberWithCommas(value)}`,
      data,
    },
  };
}

async function evaluateHealthRule(
  env: Env,
  rule: NotificationRule,
  now: number,
  cache?: NotificationInvocationCache,
): Promise<NotificationRuleEvaluationResult> {
  if (!rule.siteId) return { status: "skipped", reason: "missing_site_id" };
  if (conditionString(rule.condition, "check") !== "no_data") {
    return { status: "skipped", reason: "unsupported_health_check" };
  }
  const hours = conditionNumber(rule.condition, "hours");
  if (!hours || hours <= 0)
    return { status: "skipped", reason: "invalid_hours" };
  const site = await getSiteDisplay(env, rule.siteId, cache);
  if (!site) return { status: "skipped", reason: "site_not_found" };
  const lastSeenAt = await loadSiteLastSeenAt(env, rule.siteId, cache);
  const thresholdSeconds = Math.trunc(hours) * 3600;
  const triggered = lastSeenAt === null || now - lastSeenAt >= thresholdSeconds;
  const data = {
    ruleId: rule.id,
    siteId: rule.siteId,
    siteName: site,
    siteDomain: site,
    check: "no_data",
    hours,
    lastSeenAt,
    triggered,
  };
  if (!triggered) {
    return {
      status: "checked",
      triggered: false,
      summary: `${site} received data recently.`,
      data,
    };
  }
  const summary =
    lastSeenAt === null
      ? "No historical traffic data was found. Check that the tracking script is installed."
      : "Please check whether the tracking script is installed correctly or whether the site still has traffic.";
  return {
    status: "triggered",
    cooldownUntil: cooldownUntilFor(rule.condition, now),
    data,
    message: {
      type: "health",
      severity: "critical",
      requiresAttention: true,
      title: `${site} has not received data for ${Math.trunc(hours)} hours`,
      summary,
      bodyText: `${site} has not received data for ${Math.trunc(hours)} hours.

${summary}

Last seen: ${lastSeenAt ? new Date(lastSeenAt * 1000).toISOString() : "never"}`,
      data,
    },
  };
}

export async function evaluateNotificationRule(
  env: Env,
  rule: NotificationRule,
  now: number,
  cache?: NotificationInvocationCache,
): Promise<NotificationRuleEvaluationResult> {
  if (rule.type === "test") return testRule();
  if (rule.type === "report") return evaluateReportRule(env, rule, now, cache);
  if (rule.type === "milestone")
    return evaluateMilestoneRule(env, rule, now, cache);
  if (rule.type === "threshold")
    return evaluateThresholdRule(env, rule, now, cache);
  if (rule.type === "change") return evaluateChangeRule(env, rule, now, cache);
  if (rule.type === "health") return evaluateHealthRule(env, rule, now, cache);
  return {
    status: "skipped",
    reason: `unsupported_rule_type:${clampString(rule.type, 60)}`,
  };
}
