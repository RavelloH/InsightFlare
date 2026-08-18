import {
  type ConditionDescriptionNode,
  describeConditionTree,
} from "@/lib/conditions/description";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";

type NotificationCopy = AppMessages["teamManagement"]["notifications"];
type DescriptionTerms = AppMessages["conditionDescription"];
type NotificationRuleType =
  | "report"
  | "milestone"
  | "threshold"
  | "change"
  | "health";

export interface NotificationMetricConditionDescriptionInput {
  readonly metric: string;
  readonly window: string;
  readonly operator: string;
  readonly value: string | number;
  readonly changeMode?: string;
}

export interface NotificationFormDescriptionInput {
  readonly type: NotificationRuleType;
  readonly combinator: "all" | "any";
  readonly conditions: readonly NotificationMetricConditionDescriptionInput[];
  readonly reportType: string;
  readonly metric: string;
  readonly milestoneStep: string | number;
  readonly hours: string | number;
}

function metricKey(value: unknown): "views" | "visitors" | "sessions" {
  return value === "views" || value === "sessions" ? value : "visitors";
}

function windowKey(value: unknown): "last_1h" | "last_24h" | "yesterday" {
  return value === "last_24h" || value === "yesterday" ? value : "last_1h";
}

function operator(value: unknown): ">" | ">=" | "<" | "<=" {
  return value === ">" || value === "<" || value === "<=" ? value : ">=";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function conditionRecords(
  condition: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const candidates = [condition.all, condition.any, condition.conditions].find(
    Array.isArray,
  );
  return Array.isArray(candidates) ? candidates.filter(isRecord) : [condition];
}

function metricConditionDescription(
  copy: NotificationCopy,
  condition: NotificationMetricConditionDescriptionInput,
  type: "threshold" | "change",
): string {
  const metric = copy.metrics[metricKey(condition.metric)];
  const window = copy.windows[windowKey(condition.window)];
  const template =
    type === "change"
      ? copy.summaryConditionChange
      : copy.summaryConditionThreshold;
  return formatI18nTemplate(template, {
    metric,
    window,
    operator: operator(condition.operator),
    value: String(condition.value),
    mode:
      condition.changeMode === "absolute"
        ? copy.changeModeAbsolute
        : copy.changeModePercent,
  });
}

function describeTextTree(
  node: ConditionDescriptionNode<string> | null,
  terms: DescriptionTerms,
): string {
  return describeConditionTree(node, {
    empty: terms.emptyConditions,
    conjunction: terms.and,
    disjunction: terms.or,
    describeCondition: (description) => description,
    negate: (description) => formatI18nTemplate(terms.not, { description }),
  });
}

function metricTree(
  copy: NotificationCopy,
  terms: DescriptionTerms,
  type: "threshold" | "change",
  combinator: "all" | "any",
  conditions: readonly NotificationMetricConditionDescriptionInput[],
): string {
  return describeTextTree(
    {
      kind: combinator === "all" ? "and" : "or",
      children: conditions.map((condition) => ({
        kind: "condition",
        condition: metricConditionDescription(copy, condition, type),
      })),
    },
    terms,
  );
}

export function describeNotificationFormConditions(
  copy: NotificationCopy,
  terms: DescriptionTerms,
  input: NotificationFormDescriptionInput,
): string {
  if (input.type === "report") {
    const period =
      input.reportType in copy.reportPeriods
        ? copy.reportPeriods[
            input.reportType as keyof typeof copy.reportPeriods
          ]
        : copy.reportPeriods.daily;
    return describeTextTree(
      {
        kind: "condition",
        condition: formatI18nTemplate(copy.conditionReport, { period }),
      },
      terms,
    );
  }
  if (input.type === "milestone") {
    return describeTextTree(
      {
        kind: "condition",
        condition: formatI18nTemplate(copy.summaryMilestoneCondition, {
          metric: copy.metrics[metricKey(input.metric)],
          step: String(input.milestoneStep || "0"),
        }),
      },
      terms,
    );
  }
  if (input.type === "health") {
    return describeTextTree(
      {
        kind: "condition",
        condition: formatI18nTemplate(copy.summaryHealthCondition, {
          hours: String(input.hours || "0"),
        }),
      },
      terms,
    );
  }
  return metricTree(
    copy,
    terms,
    input.type,
    input.combinator,
    input.conditions,
  );
}

export function describeNotificationRuleCondition(
  copy: NotificationCopy,
  terms: DescriptionTerms,
  type: string,
  condition: Record<string, unknown>,
): string {
  if (type === "report") {
    return describeNotificationFormConditions(copy, terms, {
      type,
      combinator: "all",
      conditions: [],
      reportType: String(condition.reportType ?? "daily"),
      metric: "visitors",
      milestoneStep: "0",
      hours: "0",
    });
  }
  if (type === "milestone") {
    return describeNotificationFormConditions(copy, terms, {
      type,
      combinator: "all",
      conditions: [],
      reportType: "daily",
      metric: String(condition.metric ?? "visitors"),
      milestoneStep: String(
        condition.step ?? condition.every ?? condition.value ?? "-",
      ),
      hours: "0",
    });
  }
  if (type === "health") {
    return describeNotificationFormConditions(copy, terms, {
      type,
      combinator: "all",
      conditions: [],
      reportType: "daily",
      metric: "visitors",
      milestoneStep: "0",
      hours: String(condition.hours ?? "-"),
    });
  }
  if (type !== "threshold" && type !== "change") {
    return terms.emptyConditions;
  }

  return metricTree(
    copy,
    terms,
    type,
    Array.isArray(condition.any) ? "any" : "all",
    conditionRecords(condition).map((item) => ({
      metric: String(item.metric ?? "visitors"),
      window: String(item.window ?? "last_1h"),
      operator: String(item.operator ?? ">="),
      value: String(item.value ?? "-"),
      changeMode: String(item.mode ?? "percent"),
    })),
  );
}
