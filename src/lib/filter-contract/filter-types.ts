import { isEntityMemberNamespace, resolveEntityMember } from "./filter-members";
import type { AnalyzedFilterDocument } from "./filter-semantics";
import type { FilterFieldDefinition, FilterFieldRegistry } from "./filters";
import {
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterTargetExpression,
  FilterValidationError,
  isLegacyFilterTarget,
} from "./filters";

export type FilterScalarType =
  | "string"
  | "number"
  | "boolean"
  | "datetime"
  | "date"
  | "duration"
  | "calendar-period"
  | "json-scalar"
  | "unknown";
type ScalarType = FilterScalarType;
export type FilterSemanticValueType =
  | { readonly kind: "scalar"; readonly scalar: ScalarType }
  | {
      readonly kind: "collection";
      readonly entity: string;
      readonly item: ValueType;
    }
  | { readonly kind: "entity"; readonly entity: string }
  | {
      readonly kind: "namespace";
      readonly namespace: string;
      readonly collectionEntity?: string;
    }
  | { readonly kind: "sequence" }
  | { readonly kind: "period"; readonly item: ValueType }
  | { readonly kind: "bucket" };
type ValueType = FilterSemanticValueType;

const scalar = (value: ScalarType): ValueType => ({
  kind: "scalar",
  scalar: value,
});
const collection = (
  entity: string,
  item: ValueType = { kind: "entity", entity },
): ValueType => ({ kind: "collection", entity, item });
const fieldScalars: Readonly<Record<string, ScalarType>> = {
  string: "string",
  enum: "string",
  number: "number",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  "json-scalar": "json-scalar",
};

function isDynamicScalar(type: ScalarType): boolean {
  return type === "json-scalar" || type === "unknown";
}

function fail(code: string, path: string, message: string): never {
  throw new FilterValidationError(code, path, message);
}

function targetPath(target: FilterTargetExpression): string | null {
  if (target.kind === "field") return target.field;
  if (target.kind === "entity-root") return target.entity;
  if (target.kind === "member") {
    const parent = targetPath(target.object);
    return parent ? `${parent}.${target.member}` : target.member;
  }
  return null;
}

function registryFieldId(
  target: FilterTargetExpression,
  registry: FilterFieldRegistry,
): string | undefined {
  if (target.kind === "field")
    return registry.has(target.field) ? target.field : undefined;
  if (target.kind === "event-payload") return "event.payload";
  if (target.kind === "current-payload") return "event.payload";
  if (target.kind === "projection" && target.member === "payload")
    return "event.payload";
  if (target.kind !== "member") return undefined;

  const members: string[] = [];
  let base: FilterTargetExpression = target;
  while (base.kind === "member") {
    members.unshift(base.member);
    base = base.object;
  }
  const entityOf = (value: FilterTargetExpression): string | undefined => {
    if (value.kind === "entity-root") return value.entity;
    if (value.kind === "selector") return entityOf(value.collection);
    if (
      value.kind === "reducer" &&
      ["first", "last", "nth"].includes(value.reducer)
    )
      return entityOf(value.input);
    return undefined;
  };
  const entity = entityOf(base);
  if (!entity) return undefined;
  const suffix = members.join(".");
  const direct = `${entity}.${suffix}`;
  if (registry.has(direct)) return direct;
  if (
    ["geo", "client", "referrer", "utm", "user", "performance"].includes(
      members[0] ?? "",
    ) &&
    registry.has(suffix)
  )
    return suffix;
  return undefined;
}

function targetUnit(
  target: FilterTargetExpression,
  registry: FilterFieldRegistry,
): FilterFieldDefinition["unit"] {
  const fieldId = registryFieldId(target, registry);
  return fieldId ? registry.get(fieldId)?.unit : undefined;
}

function entityMemberType(
  entity: string,
  member: string,
  registry: FilterFieldRegistry,
): ValueType {
  if (
    isEntityMemberNamespace(member) &&
    [...registry.keys()].some((id) => id.startsWith(`${member}.`))
  )
    return { kind: "namespace", namespace: member };
  const resolved = resolveEntityMember(entity, member, registry);
  if (resolved)
    return scalar(fieldScalars[resolved.definition.valueKind] ?? "unknown");
  fail(
    "invalid_member",
    `${entity}.${member}`,
    `Unknown ${entity} member: ${member}.`,
  );
}

function entityMemberPathType(
  entity: string,
  path: string,
  registry: FilterFieldRegistry,
): ValueType {
  const resolved = resolveEntityMember(entity, path, registry);
  if (resolved)
    return scalar(fieldScalars[resolved.definition.valueKind] ?? "unknown");
  fail(
    "invalid_member",
    `${entity}.${path}`,
    `Unknown ${entity} member path: ${path}.`,
  );
}

function currentMemberType(
  member: string,
  registry: FilterFieldRegistry,
): ValueType {
  if (
    isEntityMemberNamespace(member) &&
    [...registry.keys()].some((id) => id.startsWith(`${member}.`))
  )
    return { kind: "namespace", namespace: member };

  const definitions = ["page", "event", "session", "visitor"]
    .map((entity) => registry.get(`${entity}.${member}`))
    .filter((definition): definition is FilterFieldDefinition =>
      Boolean(definition),
    );
  const namespaced = registry.get(member);
  if (namespaced) definitions.push(namespaced);
  if (definitions.length === 0)
    fail(
      "invalid_member",
      `$.${member}`,
      `Unknown current entity member: ${member}.`,
    );
  const types = new Set(
    definitions.map(
      (definition) => fieldScalars[definition.valueKind] ?? "unknown",
    ),
  );
  return scalar(types.size === 1 ? [...types][0]! : "unknown");
}

function namespaceMemberType(
  namespace: string,
  member: string,
  registry: FilterFieldRegistry,
): ValueType {
  const id = `${namespace}.${member}`;
  const definition = registry.get(id);
  if (definition)
    return scalar(fieldScalars[definition.valueKind] ?? "unknown");
  fail("invalid_member", id, `Unknown context member: ${id}.`);
}

function valueScalar(value: ValueType): ValueType {
  return value.kind === "collection" ? value.item : value;
}

function isCalendarPeriodUnit(unit: string): boolean {
  return (
    unit === "h" ||
    unit === "d" ||
    unit === "w" ||
    unit === "mo" ||
    unit === "y"
  );
}

function isElapsedDurationUnit(unit: string): boolean {
  return (
    unit === "ms" ||
    unit === "s" ||
    unit === "m" ||
    unit === "h" ||
    unit === "d" ||
    unit === "w"
  );
}

function inferTarget(
  target: FilterTargetExpression,
  registry: FilterFieldRegistry,
  path: string,
): ValueType {
  const dotted = target.kind === "field" ? target.field : null;
  const definition = dotted ? registry.get(dotted) : undefined;
  if (definition)
    return scalar(fieldScalars[definition.valueKind] ?? "unknown");
  switch (target.kind) {
    case "field":
      return scalar(
        fieldScalars[registry.get(target.field)?.valueKind ?? "json-scalar"] ??
          "unknown",
      );
    case "event-payload":
      return scalar("json-scalar");
    case "current-payload":
      return scalar("json-scalar");
    case "entity-root":
      return collection(target.entity);
    case "context-root":
      if (target.context === "sequence") return { kind: "sequence" };
      if (target.context === "period")
        return { kind: "period", item: scalar("unknown") };
      if (target.context === "bucket") return { kind: "bucket" };
      return scalar("unknown");
    case "context-intrinsic":
      if (target.intrinsic === "span" || target.intrinsic === "gap")
        return scalar("duration");
      if (target.intrinsic === "items")
        return collection("period.items", scalar("unknown"));
      {
        const input = inferTarget(target.input, registry, `${path}.input`);
        if (input.kind !== "scalar")
          fail(
            "same_value_type_mismatch",
            `${path}.input`,
            "$same requires a scalar value for each sequence occurrence.",
          );
        return scalar("boolean");
      }
    case "occurrence-time": {
      const input = inferTarget(target.input, registry, `${path}.input`);
      if (
        input.kind !== "entity" ||
        (input.entity !== "event" && input.entity !== "page")
      )
        fail(
          "occurrence_time_type_mismatch",
          `${path}.input`,
          "time() requires one Event or Page occurrence.",
        );
      return scalar("datetime");
    }
    case "member": {
      if (target.object.kind === "context-root") {
        const context = target.object.context;
        if (context === "current" && target.member === "time")
          return scalar("datetime");
        if (context === "current")
          return currentMemberType(target.member, registry);
      }
      const object = inferTarget(target.object, registry, `${path}.object`);
      if (object.kind === "collection")
        fail(
          "collection_member_requires_projection",
          path,
          "Collection members require an explicit projection target.",
        );
      if (object.kind === "entity")
        return entityMemberType(object.entity, target.member, registry);
      if (object.kind === "namespace") {
        const member = namespaceMemberType(
          object.namespace,
          target.member,
          registry,
        );
        return object.collectionEntity
          ? {
              kind: "collection",
              entity: object.collectionEntity,
              item: member,
            }
          : member;
      }
      const objectPath = targetPath(target.object);
      const memberDefinition = objectPath
        ? registry.get(`${objectPath}.${target.member}`)
        : undefined;
      if (memberDefinition)
        return scalar(fieldScalars[memberDefinition.valueKind] ?? "unknown");
      return fail(
        "invalid_member",
        `${path}.member`,
        `Unknown member: ${target.member}.`,
      );
    }
    case "selector": {
      const source = inferTarget(
        target.collection,
        registry,
        `${path}.collection`,
      );
      if (source.kind !== "collection")
        fail(
          "expected_collection",
          `${path}.collection`,
          "Selectors require a collection.",
        );
      validateBooleanExpression(
        target.predicate,
        registry,
        `${path}.predicate`,
      );
      return source;
    }
    case "projection": {
      const source = inferTarget(
        target.collection,
        registry,
        `${path}.collection`,
      );
      if (source.kind !== "collection")
        fail(
          "expected_collection",
          `${path}.collection`,
          "Projection requires a collection.",
        );
      const projected =
        target.member === "payload" && source.entity === "event" && target.path
          ? scalar("json-scalar")
          : entityMemberPathType(source.entity, target.member, registry);
      return { kind: "collection", entity: source.entity, item: projected };
    }
    case "reducer": {
      const input = inferTarget(target.input, registry, `${path}.input`);
      if (input.kind !== "collection")
        fail(
          "expected_collection",
          `${path}.input`,
          `${target.reducer} requires a collection.`,
        );
      if (target.reducer === "count") return scalar("number");
      const item = input.item;
      const itemScalar = item.kind === "scalar" ? item.scalar : "unknown";
      if (target.reducer === "countDistinct") {
        if (
          item.kind !== "scalar" &&
          item.kind !== "entity" &&
          item.kind !== "bucket"
        )
          fail(
            "reducer_type_mismatch",
            path,
            "countDistinct requires scalar or entity values.",
          );
        return scalar("number");
      }
      if (item.kind === "bucket")
        fail(
          "opaque_bucket_value",
          `${path}.input`,
          "Time buckets can only be consumed by count or countDistinct.",
        );
      if (target.reducer === "sum" || target.reducer === "avg") {
        if (itemScalar !== "number" && !isDynamicScalar(itemScalar))
          fail(
            "reducer_type_mismatch",
            path,
            `${target.reducer} requires numeric values.`,
          );
        return scalar("number");
      }
      if (target.reducer === "min" || target.reducer === "max") {
        if (
          item.kind !== "scalar" ||
          ![
            "string",
            "number",
            "boolean",
            "datetime",
            "date",
            "json-scalar",
            "unknown",
          ].includes(item.scalar)
        )
          fail(
            "reducer_type_mismatch",
            path,
            `${target.reducer} requires ordered scalar values.`,
          );
        return item;
      }
      return item;
    }
    case "arithmetic": {
      const left = inferTarget(target.left, registry, `${path}.left`);
      const right = inferTarget(target.right, registry, `${path}.right`);
      if (
        valueScalar(left).kind === "bucket" ||
        valueScalar(right).kind === "bucket"
      )
        fail(
          "opaque_bucket_value",
          path,
          "Time buckets can only be consumed by count or countDistinct.",
        );
      const l = left.kind === "scalar" ? left.scalar : "unknown";
      const r = right.kind === "scalar" ? right.scalar : "unknown";
      if (target.operator === "sub") {
        if (l === "datetime" || r === "datetime") {
          if (l === "datetime" && r === "datetime") return scalar("duration");
          fail(
            "arithmetic_type_mismatch",
            path,
            "DateTime subtraction requires two DateTime values.",
          );
        }
        if (
          (l === "number" || isDynamicScalar(l)) &&
          (r === "number" || isDynamicScalar(r))
        )
          return scalar("number");
        fail(
          "arithmetic_type_mismatch",
          path,
          "sub requires two numeric values or two time values.",
        );
      }
      if (l !== "number" && !isDynamicScalar(l))
        fail(
          "arithmetic_type_mismatch",
          `${path}.left`,
          "Arithmetic requires numeric values.",
        );
      if (r !== "number" && !isDynamicScalar(r))
        fail(
          "arithmetic_type_mismatch",
          `${path}.right`,
          "Arithmetic requires numeric values.",
        );
      return scalar("number");
    }
    case "duration":
      return scalar(
        target.unit === "mo" || target.unit === "y"
          ? "calendar-period"
          : "duration",
      );
    case "time-anchor":
      if (target.offset && !isElapsedDurationUnit(target.offset.unit))
        fail(
          "calendar_offset_not_supported",
          path,
          "Relative time offsets must be elapsed durations.",
        );
      return scalar("datetime");
    case "bucket": {
      const input = inferTarget(target.input, registry, `${path}.input`);
      if (
        input.kind !== "collection" ||
        !["event", "page"].includes(input.entity) ||
        input.item.kind !== "entity"
      )
        fail(
          "bucket_type_mismatch",
          path,
          "bucket requires a Page or Event collection.",
        );
      if (
        !Number.isSafeInteger(target.interval.amount) ||
        target.interval.amount <= 0 ||
        !isCalendarPeriodUnit(target.interval.unit)
      )
        fail(
          "bucket_period_mismatch",
          `${path}.interval`,
          "bucket requires a positive safe-integer calendar period.",
        );
      return collection("bucket", { kind: "bucket" });
    }
    case "window": {
      const source = inferTarget(
        target.collection,
        registry,
        `${path}.collection`,
      );
      if (source.kind !== "collection")
        fail(
          "expected_collection",
          `${path}.collection`,
          "window requires a collection.",
        );
      const anchor = inferTarget(target.anchor, registry, `${path}.anchor`);
      if (!(
        target.anchor.kind === "time-anchor" ||
        (anchor.kind === "entity" &&
          (anchor.entity === "page" || anchor.entity === "event"))
      ))
        fail(
          "window_anchor_type_mismatch",
          `${path}.anchor`,
          "window anchor must be a time value.",
        );
      if (
        target.startOffset.unit === "mo" ||
        target.startOffset.unit === "y" ||
        target.endOffset.unit === "mo" ||
        target.endOffset.unit === "y"
      )
        fail(
          "calendar_offset_not_supported",
          path,
          "window offsets must be elapsed durations.",
        );
      return source;
    }
    case "periods": {
      const source = inferTarget(
        target.collection,
        registry,
        `${path}.collection`,
      );
      if (source.kind !== "collection")
        fail(
          "expected_collection",
          `${path}.collection`,
          "periods requires a collection.",
        );
      if (
        !Number.isSafeInteger(target.interval.amount) ||
        target.interval.amount <= 0 ||
        !isCalendarPeriodUnit(target.interval.unit)
      )
        fail(
          "period_interval_mismatch",
          `${path}.interval`,
          "periods requires a positive safe-integer calendar period.",
        );
      return {
        kind: "collection",
        entity: "period",
        item: { kind: "period", item: source.item },
      };
    }
    case "sequence":
      if (target.steps.length < 2)
        fail(
          "invalid_sequence",
          path,
          "A sequence requires at least two steps.",
        );
      target.steps.forEach((step, index) => {
        const type = inferTarget(step, registry, `${path}.steps[${index}]`);
        if (
          type.kind !== "collection" ||
          !["event", "page"].includes(type.entity)
        )
          fail(
            "sequence_step_type_mismatch",
            `${path}.steps[${index}]`,
            "Sequence steps must select Page or Event activities.",
          );
      });
      return collection("sequence", { kind: "sequence" });
    case "adjacent": {
      const value = inferTarget(target.sequence, registry, `${path}.sequence`);
      if (value.kind !== "collection" || value.item.kind !== "sequence")
        fail("expected_sequence", path, "adjacent requires a sequence.");
      return collection("sequence", { kind: "sequence" });
    }
    case "without": {
      const sequence = inferTarget(
        target.sequence,
        registry,
        `${path}.sequence`,
      );
      const excluded = inferTarget(
        target.excluded,
        registry,
        `${path}.excluded`,
      );
      if (sequence.kind !== "collection" || sequence.item.kind !== "sequence")
        fail(
          "expected_sequence",
          `${path}.sequence`,
          "without requires a sequence.",
        );
      if (
        excluded.kind !== "collection" ||
        !["event", "page"].includes(excluded.entity)
      )
        fail(
          "without_type_mismatch",
          `${path}.excluded`,
          "without requires a Page or Event collection.",
        );
      return collection("sequence", { kind: "sequence" });
    }
  }
}

/** Public type inference primitive used by the shared semantic analysis. */
export function inferFilterTargetType(
  target: FilterTargetExpression,
  registry: FilterFieldRegistry,
): FilterSemanticValueType {
  return inferTarget(target, registry, "target");
}

function checkCompatible(
  left: ValueType,
  right: ValueType,
  path: string,
): void {
  if (left.kind !== "scalar" || right.kind !== "scalar") {
    if (
      left.kind === right.kind &&
      (left.kind === "sequence" ||
        left.kind === "period" ||
        left.kind === "bucket")
    )
      return;
    fail(
      "condition_type_mismatch",
      path,
      "A condition must compare compatible scalar values.",
    );
  }
  if (
    !isDynamicScalar(left.scalar) &&
    !isDynamicScalar(right.scalar) &&
    left.scalar !== right.scalar
  ) {
    fail(
      "condition_type_mismatch",
      path,
      `Cannot compare ${left.scalar} with ${right.scalar}.`,
    );
  }
}

function validateCondition(
  condition: FilterCondition,
  registry: FilterFieldRegistry,
  path: string,
  validateLegacyValue = false,
): void {
  if (
    (condition.operator === "eq" || condition.operator === "neq") &&
    condition.value === null &&
    !isLegacyFilterTarget(condition.target)
  )
    fail(
      "null_requires_unary_operator",
      `${path}.value`,
      "Use isNull or notNull instead of comparing to null.",
    );
  if (
    (condition.operator === "in" || condition.operator === "notIn") &&
    !isLegacyFilterTarget(condition.target)
  ) {
    const values = Array.isArray(condition.value)
      ? condition.value
      : [condition.value];
    const valueTypes = values
      .filter((value) => value !== undefined)
      .map((value) => (value === null ? "null" : typeof value));
    if (new Set(valueTypes).size > 1)
      fail(
        "heterogeneous_set_values",
        `${path}.value`,
        "Set values must all use the same JSON scalar type.",
      );
  }
  const computedValue = Boolean(
    condition.value &&
    typeof condition.value === "object" &&
    !Array.isArray(condition.value) &&
    "kind" in condition.value,
  );
  // The legacy registry normalizer remains authoritative for the original
  // field/payload contract, preserving its exact type and canonicalization.
  if (
    isLegacyFilterTarget(condition.target) &&
    !computedValue &&
    !validateLegacyValue
  )
    return;
  const left = inferTarget(condition.target, registry, `${path}.target`);
  const leftType = valueScalar(left);
  if (leftType.kind === "bucket")
    fail(
      "opaque_bucket_value",
      `${path}.target`,
      "Time buckets can only be consumed by an aggregate.",
    );
  if (
    left.kind === "collection" &&
    condition.operator !== "exists" &&
    condition.operator !== "notExists"
  )
    fail(
      "condition_type_mismatch",
      path,
      "Collection values must be consumed by an aggregate or an existence operator.",
    );
  if (
    (condition.operator === "isEmpty" || condition.operator === "notEmpty") &&
    (leftType.kind !== "scalar" ||
      (leftType.scalar !== "string" && !isDynamicScalar(leftType.scalar)))
  )
    fail(
      "operator_type_mismatch",
      path,
      `${condition.operator} requires a string value.`,
    );
  if (
    [
      "exists",
      "notExists",
      "isNull",
      "notNull",
      "isEmpty",
      "notEmpty",
    ].includes(condition.operator)
  )
    return;
  const values = Array.isArray(condition.value)
    ? condition.value
    : [condition.value];
  const operator = condition.operator;
  if (
    ["contains", "startsWith", "endsWith", "isEmpty", "notEmpty"].includes(
      operator,
    )
  ) {
    const leftType = valueScalar(left);
    if (
      leftType.kind !== "scalar" ||
      (leftType.scalar !== "string" && !isDynamicScalar(leftType.scalar))
    )
      fail(
        "operator_type_mismatch",
        path,
        `${operator} requires a string value.`,
      );
  }
  const comparableLeft = valueScalar(left);
  if (
    ["gt", "gte", "lt", "lte", "between"].includes(operator) &&
    comparableLeft.kind === "scalar" &&
    ![
      "number",
      "datetime",
      "date",
      "duration",
      "json-scalar",
      "unknown",
    ].includes(comparableLeft.scalar)
  )
    fail(
      "operator_type_mismatch",
      path,
      `${operator} requires an ordered value.`,
    );
  for (const [index, value] of values.entries()) {
    if (value === undefined) continue;
    let right =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "kind" in value
        ? inferTarget(
            value as FilterTargetExpression,
            registry,
            `${path}.value[${index}]`,
          )
        : scalar(
            value === null
              ? "unknown"
              : typeof value === "number"
                ? "number"
                : typeof value === "boolean"
                  ? "boolean"
                  : "string",
          );
    if (
      typeof value === "string" &&
      comparableLeft.kind === "scalar" &&
      (comparableLeft.scalar === "datetime" || comparableLeft.scalar === "date")
    ) {
      const validDateTime =
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        ) && Number.isFinite(Date.parse(value));
      const validDate =
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00Z`));
      if (
        (comparableLeft.scalar === "datetime" && validDateTime) ||
        (comparableLeft.scalar === "date" && validDate)
      )
        right = scalar(comparableLeft.scalar);
      else
        fail(
          "invalid_temporal_literal",
          `${path}.value[${index}]`,
          `Expected a valid ${comparableLeft.scalar} literal.`,
        );
    }
    const rightScalar = valueScalar(right);
    if (rightScalar.kind === "bucket")
      fail(
        "opaque_bucket_value",
        `${path}.value[${index}]`,
        "Time buckets can only be consumed by an aggregate.",
      );
    const durationCompatibleWithMilliseconds =
      comparableLeft.kind === "scalar" &&
      comparableLeft.scalar === "number" &&
      rightScalar.kind === "scalar" &&
      rightScalar.scalar === "duration" &&
      targetUnit(condition.target, registry) === "ms";
    if (!durationCompatibleWithMilliseconds)
      checkCompatible(left, right, `${path}.value[${index}]`);
  }
  if (operator === "between" && values.length === 2) {
    const endpointTypes = values.map((value, index) => {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "kind" in value
      )
        return inferTarget(
          value as FilterTargetExpression,
          registry,
          `${path}.value[${index}]`,
        );
      if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
          value,
        ) &&
        Number.isFinite(Date.parse(value))
      )
        return scalar("datetime");
      return scalar(
        value === null
          ? "unknown"
          : typeof value === "number"
            ? "number"
            : typeof value === "boolean"
              ? "boolean"
              : "string",
      );
    });
    checkCompatible(endpointTypes[0]!, endpointTypes[1]!, `${path}.value`);
  }
}

/** Type-check a condition after binding its current member to a registry field. */
export function validateBoundFilterConditionTypes(
  condition: FilterCondition,
  registry: FilterFieldRegistry,
  path = "condition",
): void {
  validateCondition(condition, registry, path, true);
}

function validateBooleanExpression(
  expression: FilterExpression,
  registry: FilterFieldRegistry,
  path: string,
): void {
  if (expression.kind === "condition") {
    validateCondition(expression, registry, path);
    return;
  }
  if (expression.kind === "not")
    return validateBooleanExpression(
      expression.child,
      registry,
      `${path}.child`,
    );
  expression.children.forEach((child, index) =>
    validateBooleanExpression(child, registry, `${path}.children[${index}]`),
  );
}

export function validateFilterExpressionTypes(
  document: FilterDocument,
  registry: FilterFieldRegistry,
): void {
  if (!document.root) return;
  validateBooleanExpression(document.root, registry, "root");
}

export type FilterRelationScope = "event" | "session" | "visitor";

/** Validate relation anchoring only after the query's effective Scope is known. */
export function validateFilterRelationDomains(
  document: FilterDocument,
  resolvedScope: FilterRelationScope,
  analysis?: Pick<AnalyzedFilterDocument, "relationTargets">,
): void {
  if (!document.root) return;
  const collectionEntity = (target: FilterTargetExpression): string | null => {
    if (target.kind === "entity-root") return target.entity;
    if (target.kind === "selector") return collectionEntity(target.collection);
    if (target.kind === "member") return collectionEntity(target.object);
    if (target.kind === "projection")
      return collectionEntity(target.collection);
    if (target.kind === "reducer") return collectionEntity(target.input);
    if (target.kind === "window") return collectionEntity(target.collection);
    if (target.kind === "periods") return collectionEntity(target.collection);
    return null;
  };
  const visitTarget = (
    target: FilterTargetExpression,
    domain: FilterRelationScope,
    path: string,
  ): void => {
    if (target.kind === "selector") {
      const entity = collectionEntity(target.collection);
      const predicateDomain =
        entity === "session" || entity === "visitor" ? entity : domain;
      visitExpression(target.predicate, predicateDomain, `${path}.predicate`);
      visitTarget(target.collection, domain, `${path}.collection`);
      return;
    }
    const requiresRelationDomain = analysis
      ? analysis.relationTargets.has(target)
      : target.kind === "sequence" ||
        target.kind === "adjacent" ||
        target.kind === "without";
    if (requiresRelationDomain && domain === "event")
      fail(
        "relation_requires_session_or_visitor_scope",
        path,
        "Relation expressions require visitor or session scope.",
      );
    switch (target.kind) {
      case "member":
        visitTarget(target.object, domain, `${path}.object`);
        break;
      case "projection":
        visitTarget(target.collection, domain, `${path}.collection`);
        break;
      case "reducer":
        visitTarget(target.input, domain, `${path}.input`);
        break;
      case "arithmetic":
        visitTarget(target.left, domain, `${path}.left`);
        visitTarget(target.right, domain, `${path}.right`);
        break;
      case "bucket":
        visitTarget(target.input, domain, `${path}.input`);
        break;
      case "window":
        visitTarget(target.collection, domain, `${path}.collection`);
        visitTarget(target.anchor, domain, `${path}.anchor`);
        break;
      case "periods":
        visitTarget(target.collection, domain, `${path}.collection`);
        break;
      case "sequence":
        target.steps.forEach((step, index) =>
          visitTarget(step, domain, `${path}.steps[${index}]`),
        );
        break;
      case "adjacent":
        visitTarget(target.sequence, domain, `${path}.sequence`);
        break;
      case "without":
        visitTarget(target.sequence, domain, `${path}.sequence`);
        visitTarget(target.excluded, domain, `${path}.excluded`);
        break;
    }
  };
  const visitExpression = (
    expression: FilterExpression,
    domain: FilterRelationScope,
    path: string,
  ): void => {
    if (expression.kind === "condition") {
      visitTarget(expression.target, domain, `${path}.target`);
      if (
        expression.value &&
        typeof expression.value === "object" &&
        !Array.isArray(expression.value) &&
        "kind" in expression.value
      )
        visitTarget(
          expression.value as FilterTargetExpression,
          domain,
          `${path}.value`,
        );
      return;
    }
    if (expression.kind === "not") {
      visitExpression(expression.child, domain, `${path}.child`);
      return;
    }
    expression.children.forEach((child, index) =>
      visitExpression(child, domain, `${path}.children[${index}]`),
    );
  };
  visitExpression(document.root, resolvedScope, "root");
}

export function filterUsesRequestClock(document: FilterDocument): boolean {
  let found = false;
  const targetVisit = (target: FilterTargetExpression): void => {
    if (target.kind === "time-anchor" && target.anchor === "now") found = true;
    switch (target.kind) {
      case "member":
        targetVisit(target.object);
        break;
      case "selector":
        targetVisit(target.collection);
        expressionVisit(target.predicate);
        break;
      case "projection":
        targetVisit(target.collection);
        break;
      case "reducer":
        targetVisit(target.input);
        break;
      case "arithmetic":
        targetVisit(target.left);
        targetVisit(target.right);
        break;
      case "bucket":
        targetVisit(target.input);
        break;
      case "window":
        targetVisit(target.collection);
        targetVisit(target.anchor);
        break;
      case "periods":
        targetVisit(target.collection);
        break;
      case "sequence":
        target.steps.forEach(targetVisit);
        break;
      case "adjacent":
        targetVisit(target.sequence);
        break;
      case "without":
        targetVisit(target.sequence);
        targetVisit(target.excluded);
        break;
    }
  };
  const expressionVisit = (expression: FilterExpression): void => {
    if (expression.kind === "condition") {
      targetVisit(expression.target);
      if (
        expression.value &&
        typeof expression.value === "object" &&
        !Array.isArray(expression.value) &&
        "kind" in expression.value
      )
        targetVisit(expression.value as FilterTargetExpression);
    } else if (expression.kind === "not") expressionVisit(expression.child);
    else expression.children.forEach(expressionVisit);
  };
  if (document.root) expressionVisit(document.root);
  return found;
}

/** Reports whether a document needs the Core/Relation expression executor. */
export function filterDocumentUsesAdvancedExpressions(
  document: FilterDocument,
): boolean {
  let advanced = false;
  const targetVisit = (target: FilterTargetExpression): void => {
    if (!isLegacyFilterTarget(target)) advanced = true;
    switch (target.kind) {
      case "member":
        targetVisit(target.object);
        break;
      case "selector":
        targetVisit(target.collection);
        expressionVisit(target.predicate);
        break;
      case "projection":
        targetVisit(target.collection);
        break;
      case "reducer":
        targetVisit(target.input);
        break;
      case "arithmetic":
        targetVisit(target.left);
        targetVisit(target.right);
        break;
      case "bucket":
        targetVisit(target.input);
        break;
      case "window":
        targetVisit(target.collection);
        targetVisit(target.anchor);
        break;
      case "periods":
        targetVisit(target.collection);
        break;
      case "sequence":
        target.steps.forEach(targetVisit);
        break;
      case "adjacent":
        targetVisit(target.sequence);
        break;
      case "without":
        targetVisit(target.sequence);
        targetVisit(target.excluded);
        break;
    }
  };
  const expressionVisit = (expression: FilterExpression): void => {
    if (expression.kind === "condition") {
      targetVisit(expression.target);
      if (
        expression.value &&
        typeof expression.value === "object" &&
        !Array.isArray(expression.value) &&
        "kind" in expression.value
      ) {
        targetVisit(expression.value as FilterTargetExpression);
      }
    } else if (expression.kind === "not") expressionVisit(expression.child);
    else expression.children.forEach(expressionVisit);
  };
  if (document.root) expressionVisit(document.root);
  return advanced;
}
