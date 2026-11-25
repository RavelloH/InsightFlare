import {
  type FilterComparisonValue,
  type FilterCondition,
  type FilterConditionValue,
  type FilterDurationTarget,
  type FilterDurationUnit,
  type FilterEntityRoot,
  type FilterExpression,
  type FilterFieldRegistry,
  type FilterTargetExpression,
  inferFilterTargetType,
  resolveEntityMember,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";

type FilterDescriptionMessages = Pick<
  AppMessages,
  "conditionDescription" | "filterBuilder"
>;
type NaturalCopy = AppMessages["filterBuilder"]["naturalDescription"];
type Context = { entity?: FilterEntityRoot; itemsEntity?: FilterEntityRoot };

const timeUnits = {
  ms: "milliseconds",
  s: "seconds",
  m: "minutes",
  h: "hours",
  d: "days",
  w: "weeks",
  mo: "months",
  y: "years",
} as const satisfies Record<FilterDurationUnit, string>;

function memberPath(target: FilterTargetExpression) {
  const members: string[] = [];
  let base = target;
  while (base.kind === "member") {
    members.unshift(base.member);
    base = base.object;
  }
  return { base, path: members.join(".") };
}

/** Describe the typed AST without re-emitting DSL syntax or assuming a query scope. */
export function describeFilterExpression(
  expression: FilterExpression | null | undefined,
  registry: FilterFieldRegistry,
  messages: FilterDescriptionMessages,
): string {
  const copy = messages.filterBuilder.naturalDescription;
  const conditions = messages.conditionDescription;
  const phrase = (
    key: Exclude<keyof NaturalCopy, "singularUnits">,
    params: Record<string, string | number> = {},
  ) => formatI18nTemplate(copy[key], params);
  const fieldLabel = (id: string) =>
    (messages.filterBuilder.fieldLabels as Record<string, string>)[id] ?? id;
  const entityOf = (
    target: FilterTargetExpression,
    context: Context,
  ): FilterEntityRoot | undefined => {
    if (target.kind === "context-root" && target.context === "current")
      return context.entity;
    if (target.kind === "context-intrinsic" && target.intrinsic === "items")
      return context.itemsEntity;
    if (
      target.kind === "selector" ||
      target.kind === "window" ||
      target.kind === "projection" ||
      target.kind === "periods"
    )
      return entityOf(target.collection, context);
    if (target.kind === "reducer") return entityOf(target.input, context);
    if (target.kind === "entity-root") return target.entity;
    return undefined;
  };
  const memberField = (entity: FilterEntityRoot | undefined, path: string) => {
    if (entity) return resolveEntityMember(entity, path, registry)?.fieldId;
    if (registry.has(path)) return path;
    const candidates = [
      ...new Set(
        (["page", "event", "session", "visitor"] as const)
          .map((root) => resolveEntityMember(root, path, registry)?.fieldId)
          .filter(Boolean),
      ),
    ];
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const targetField = (
    target: FilterTargetExpression,
    context: Context,
  ): string | undefined => {
    if (target.kind === "field") return target.field;
    if (target.kind === "member") {
      const { base, path } = memberPath(target);
      return memberField(entityOf(base, context), path);
    }
    if (target.kind === "projection")
      return memberField(entityOf(target.collection, context), target.member);
    if (
      target.kind === "reducer" &&
      ["sum", "avg", "min", "max"].includes(target.reducer)
    )
      return targetField(target.input, context);
    return undefined;
  };
  const duration = (target: FilterDurationTarget): string => {
    const unit =
      Math.abs(target.amount) === 1
        ? copy.singularUnits[target.unit]
        : messages.filterBuilder.advancedEditor.timeUnits[
            timeUnits[target.unit]
          ];
    return phrase("duration", { amount: target.amount, unit });
  };
  const value = (
    v: FilterComparisonValue,
    context: Context,
    unit?: string,
  ): string => {
    if (v === null) return copy.nullValue;
    if (v === true) return copy.trueValue;
    if (v === false) return copy.falseValue;
    if (typeof v === "object") return targetText(v, context);
    if (typeof v === "number") {
      if (unit === "ms")
        return duration({ kind: "duration", amount: v, unit: "ms" });
      if (unit === "px") return phrase("pixels", { amount: v });
      return String(v);
    }
    return JSON.stringify(v);
  };
  const targetText = (
    target: FilterTargetExpression,
    context: Context,
  ): string => {
    switch (target.kind) {
      case "field":
        return fieldLabel(target.field);
      case "event-payload":
      case "current-payload":
        return phrase("payload", { path: target.path });
      case "entity-root":
        return copy[target.entity];
      case "context-root":
        return target.context === "current"
          ? copy.current
          : target.context === "sequence"
            ? copy.sequenceContext
            : target.context === "period"
              ? copy.periodContext
              : copy.bucketContext;
      case "member": {
        const { base, path } = memberPath(target);
        const field = fieldLabel(
          memberField(entityOf(base, context), path) ?? path,
        );
        if (base.kind === "context-root" && base.context === "current")
          return field;
        return phrase("member", { object: targetText(base, context), field });
      }
      case "selector": {
        const entity = entityOf(target.collection, context);
        const nested =
          target.collection.kind === "periods"
            ? { itemsEntity: entity }
            : { entity };
        // The common named-event selector reads as a noun rather than a
        // mechanical expansion of the current-member syntax.
        const predicate = target.predicate;
        if (
          target.collection.kind === "entity-root" &&
          entity === "event" &&
          predicate.kind === "condition" &&
          predicate.target.kind === "member" &&
          memberPath(predicate.target).base.kind === "context-root" &&
          memberPath(predicate.target).path === "name" &&
          predicate.operator === "eq" &&
          typeof predicate.value === "string"
        )
          return phrase("namedEvent", {
            name: JSON.stringify(predicate.value),
          });
        if (
          target.collection.kind === "entity-root" &&
          entity === "page" &&
          predicate.kind === "condition" &&
          predicate.target.kind === "member" &&
          memberPath(predicate.target).base.kind === "context-root" &&
          memberPath(predicate.target).path === "path" &&
          predicate.operator === "eq" &&
          typeof predicate.value === "string"
        )
          return phrase("namedPage", { path: JSON.stringify(predicate.value) });
        return phrase("selector", {
          collection: targetText(target.collection, context),
          predicate: describe(predicate, nested),
        });
      }
      case "projection":
        return phrase("projection", {
          collection: targetText(target.collection, context),
          field:
            target.member === "payload" && target.path
              ? phrase("payload", { path: target.path })
              : fieldLabel(
                  memberField(
                    entityOf(target.collection, context),
                    target.member,
                  ) ?? target.member,
                ),
        });
      case "reducer": {
        const input = targetText(target.input, context);
        if (
          target.reducer === "countDistinct" &&
          target.input.kind === "projection"
        ) {
          const projection = target.input;
          return phrase("distinctProjection", {
            collection: targetText(projection.collection, context),
            field:
              projection.member === "payload" && projection.path
                ? phrase("payload", { path: projection.path })
                : fieldLabel(
                    memberField(
                      entityOf(projection.collection, context),
                      projection.member,
                    ) ?? projection.member,
                  ),
          });
        }
        if (
          target.reducer === "count" &&
          target.input.kind === "context-intrinsic" &&
          target.input.intrinsic === "items"
        )
          return copy.periodCount;
        return phrase(target.reducer, { input, index: target.index ?? 1 });
      }
      case "arithmetic":
        return phrase(target.operator, {
          left: targetText(target.left, context),
          right: targetText(target.right, context),
        });
      case "duration":
        return duration(target);
      case "time-anchor": {
        const anchor =
          target.anchor === "now"
            ? copy.now
            : target.anchor === "range.start"
              ? copy.rangeStart
              : copy.rangeEnd;
        if (!target.offset || target.offset.amount === 0) return anchor;
        const span = duration({
          ...target.offset,
          amount: Math.abs(target.offset.amount),
        });
        if (target.anchor === "now")
          return phrase(target.offset.amount < 0 ? "ago" : "fromNow", {
            duration: span,
          });
        return phrase(target.offset.amount < 0 ? "before" : "after", {
          anchor,
          duration: span,
        });
      }
      case "occurrence-time": {
        const input = target.input;
        if (
          input.kind === "reducer" &&
          (input.reducer === "first" || input.reducer === "last")
        )
          return phrase(input.reducer === "first" ? "firstTime" : "lastTime", {
            collection: targetText(input.input, context),
          });
        return phrase("occurrenceTime", { input: targetText(input, context) });
      }
      case "context-intrinsic":
        switch (target.intrinsic) {
          case "span":
            return copy.span;
          case "gap":
            return phrase("gap", { from: target.from, to: target.to });
          case "same":
            return phrase("same", { input: targetText(target.input, context) });
          case "items":
            return copy.items;
          default:
            throw new Error("Unsupported filter context intrinsic");
        }
      case "bucket":
        return phrase("bucket", {
          input: targetText(target.input, context),
          interval: duration(target.interval),
        });
      case "periods":
        return phrase("periods", {
          collection: targetText(target.collection, context),
          interval: duration(target.interval),
        });
      case "window":
        return phrase("window", {
          collection: targetText(target.collection, context),
          anchor:
            target.anchor.kind === "time-anchor"
              ? targetText(target.anchor, context)
              : targetText(
                  { kind: "occurrence-time", input: target.anchor },
                  context,
                ),
          start: duration(target.startOffset),
          end: duration(target.endOffset),
        });
      case "sequence":
        return phrase("sequence", {
          steps: target.steps
            .map((step, index) =>
              phrase("step", {
                index: index + 1,
                activity: targetText(step, context),
              }),
            )
            .join(copy.separator),
        });
      case "adjacent":
        return phrase("adjacent", {
          sequence: targetText(target.sequence, context),
        });
      case "without":
        return phrase("without", {
          sequence: targetText(target.sequence, context),
          excluded: targetText(target.excluded, context),
        });
    }
  };
  const isCollection = (target: FilterTargetExpression): boolean => {
    try {
      return inferFilterTargetType(target, registry).kind === "collection";
    } catch {
      return (
        [
          "entity-root",
          "selector",
          "projection",
          "window",
          "periods",
          "bucket",
          "sequence",
          "adjacent",
          "without",
        ].includes(target.kind) ||
        (target.kind === "context-intrinsic" && target.intrinsic === "items")
      );
    }
  };
  const relationText = (
    target: FilterTargetExpression,
    context: Context,
  ): string | null => {
    switch (target.kind) {
      case "sequence":
        return phrase("relationSequence", {
          steps: target.steps
            .map((step) => targetText(step, context))
            .join(copy.thenSeparator),
        });
      case "selector": {
        const inner = relationText(target.collection, context);
        return inner
          ? phrase("relationConstraint", {
              relation: inner,
              predicate: describe(target.predicate, context),
            })
          : null;
      }
      case "adjacent": {
        const inner = relationText(target.sequence, context);
        return inner ? phrase("relationAdjacent", { relation: inner }) : null;
      }
      case "without": {
        const inner = relationText(target.sequence, context);
        return inner
          ? phrase("relationWithout", {
              relation: inner,
              excluded: targetText(target.excluded, context),
            })
          : null;
      }
      default:
        return null;
    }
  };
  const describeCondition = (
    condition: FilterCondition,
    context: Context,
  ): string => {
    const { target, operator, value: operand } = condition;
    const field = targetText(target, context);
    if (operator === "exists" || operator === "notExists") {
      const relation = relationText(target, context);
      if (relation)
        return operator === "exists"
          ? relation
          : phrase("negate", {
              description: phrase("nested", { description: relation }),
            });
      const entity = entityOf(target, context);
      if (
        entity === "event" &&
        (target.kind === "entity-root" ||
          (target.kind === "selector" &&
            target.collection.kind === "entity-root"))
      )
        return phrase(
          operator === "exists" ? "eventOccurred" : "eventNotOccurred",
          { collection: field },
        );
      if (
        entity === "page" &&
        (target.kind === "entity-root" ||
          (target.kind === "selector" &&
            target.collection.kind === "entity-root"))
      )
        return phrase(
          operator === "exists" ? "pageOccurred" : "pageNotOccurred",
          { collection: field },
        );
    }
    if (
      target.kind === "reducer" &&
      ["count", "countDistinct"].includes(target.reducer) &&
      typeof operand === "number"
    ) {
      if (operator === "eq" && operand === 0 && target.reducer === "count")
        return phrase("collectionNotExists", {
          collection: targetText(target.input, context),
        });
      if (
        operator === "gte" ||
        operator === "lte" ||
        operator === "eq" ||
        operator === "gt" ||
        operator === "lt"
      ) {
        const key =
          operator === "gte"
            ? "atLeast"
            : operator === "lte"
              ? "atMost"
              : operator === "eq"
                ? "exactly"
                : operator === "gt"
                  ? "moreThan"
                  : "fewerThan";
        return phrase(key, { field, value: operand });
      }
    }
    const id = targetField(target, context);
    const unit = id ? registry.get(id)?.unit : undefined;
    if (
      (operator === "exists" || operator === "notExists") &&
      isCollection(target)
    )
      return phrase(
        operator === "exists" ? "collectionExists" : "collectionNotExists",
        { collection: field },
      );
    if (
      target.kind === "context-intrinsic" &&
      target.intrinsic === "same" &&
      operator === "eq" &&
      typeof operand === "boolean"
    )
      return operand
        ? field
        : phrase("negate", {
            description: phrase("nested", { description: field }),
          });
    const format = (v: FilterComparisonValue) => value(v, context, unit);
    const v = operand as FilterConditionValue | undefined;
    const list = Array.isArray(v)
      ? (v as readonly FilterComparisonValue[])
      : null;
    const scalar =
      v !== undefined && !list ? format(v as FilterComparisonValue) : "";
    const templates = {
      eq: conditions.filterEquals,
      neq: conditions.filterNotEquals,
      contains: conditions.filterContains,
      startsWith: conditions.filterStartsWith,
      endsWith: conditions.filterEndsWith,
      gt: conditions.filterGreaterThan,
      gte: conditions.filterGreaterThanOrEqual,
      lt: conditions.filterLessThan,
      lte: conditions.filterLessThanOrEqual,
      exists: conditions.filterExists,
      notExists: conditions.filterNotExists,
      isNull: conditions.filterIsNull,
      notNull: conditions.filterNotNull,
      isEmpty: conditions.filterIsEmpty,
      notEmpty: conditions.filterNotEmpty,
      in: conditions.filterAnyOf,
      notIn: conditions.filterNoneOf,
      between: conditions.filterBetween,
    };
    return formatI18nTemplate(templates[operator], {
      field,
      value: scalar,
      values: list?.map(format).join(` ${conditions.or} `) ?? "",
      from: list?.[0] !== undefined ? format(list[0]) : "",
      to: list?.[1] !== undefined ? format(list[1]) : "",
    });
  };
  const describe = (
    node: FilterExpression,
    context: Context,
    nested = false,
  ): string => {
    if (node.kind === "condition") return describeCondition(node, context);
    let text: string;
    if (node.kind === "not")
      text = phrase("negate", {
        description: describe(node.child, context, true),
      });
    else {
      if (!node.children.length) return conditions.emptyFilter;
      if (node.children.length === 1)
        return describe(node.children[0]!, context, nested);
      text = phrase(node.kind === "and" ? "all" : "any", {
        items: node.children
          .map((child) => describe(child, context, true))
          .join(copy.separator),
      });
    }
    return nested ? phrase("nested", { description: text }) : text;
  };
  return expression ? describe(expression, {}) : conditions.emptyFilter;
}
