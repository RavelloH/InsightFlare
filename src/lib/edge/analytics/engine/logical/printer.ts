import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import type { LogicalGrain } from "@/lib/edge/analytics/engine/logical/grain";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { LogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type {
  LogicalSlot,
  LogicalValueType,
  SlotLineage,
} from "@/lib/edge/analytics/engine/logical/slots";

function relation(id: RelationId): string {
  return `r${id}`;
}

function slot(id: SlotId): string {
  return `s${id}`;
}

function valueType(type: LogicalValueType): string {
  switch (type.kind) {
    case "entity":
      return `Entity<${type.entity}>`;
    case "bucket":
      return `Bucket<${type.granularity},${type.reportingTimeZone}>`;
    case "duration":
      return "ElapsedDuration";
    case "calendar-period":
      return "CalendarPeriod";
    case "scalar":
      return `Scalar<${type.scalar}${type.unit ? `,${type.unit}` : ""}>`;
  }
}

function grain(value: LogicalGrain): string {
  switch (value.kind) {
    case "entity":
      return `Entity<${value.entity}>[${slot(value.key)}]`;
    case "keyed":
      return `Keyed[${value.keys.map(slot).join(",")}]`;
    case "scalar":
      return "Scalar";
    case "bag":
      return "Bag";
  }
}

function lineage(value: SlotLineage): string {
  switch (value.kind) {
    case "entity":
      return `entity:${value.entity}`;
    case "relationship":
      return `relationship:${value.relationship}`;
    case "attribute":
      return `attribute:${value.attribute}`;
    case "metric":
      return `metric:${value.metric}`;
    case "alias":
      return `alias:${slot(value.source)}`;
    case "derived":
      return `derived:${value.operation}(${value.inputs.map(slot).join(",")})`;
  }
}

function formatSlot(
  id: SlotId,
  slots: ReadonlyMap<SlotId, LogicalSlot>,
): string {
  const value = slots.get(id);
  if (!value) return `${slot(id)}:<missing>`;
  return `${slot(id)}:${valueType(value.type)}${value.nullable ? "?" : "!"}{${lineage(value.lineage)}}`;
}

function expression(value: LogicalExpr): string {
  switch (value.kind) {
    case "slot":
      return slot(value.slot);
    case "literal":
      return `${JSON.stringify(value.value)}:${valueType(value.valueType)}`;
    case "elapsed-duration-literal":
      return `ELAPSED_DURATION<${value.unit}>(${JSON.stringify(value.amount)})`;
    case "calendar-period-literal":
      return `CALENDAR_PERIOD<${value.unit}>(${JSON.stringify(value.amount)})`;
    case "comparison":
      return `(${expression(value.left)} ${value.operator} ${expression(value.right)}${value.stringNormalization ? ` normalization=${value.stringNormalization}` : ""})`;
    case "boolean":
      return `(${value.terms.map(expression).join(` ${value.operator.toUpperCase()} `)})`;
    case "not":
      return `(NOT ${expression(value.input)})`;
    case "null-test":
      return `(${expression(value.input)} IS ${value.negated ? "NOT " : ""}NULL)`;
    case "set-membership":
      return `(${expression(value.input)} ${value.negated ? "NOT " : ""}IN [${value.values.map(expression).join(", ")}]${value.stringNormalization ? ` normalization=${value.stringNormalization}` : ""})`;
    case "string-match":
      return `(${expression(value.input)} ${value.operator}${value.caseSensitive ? " case-sensitive" : " case-insensitive"}${value.stringNormalization ? ` normalization=${value.stringNormalization}` : ""} ${JSON.stringify(value.value)})`;
    case "string-normalize":
      return `NORMALIZE_STRING<${value.normalization}>(${expression(value.input)})`;
    case "number-report-text":
      return `NUMBER_REPORT_TEXT<${value.semantics}>(${expression(value.input)})`;
    case "page-dimension":
      return `PAGE_DIMENSION<${value.dimension}>(${value.dependencies.map((dependency) => `${dependency.attribute}=${expression(dependency.expression)}`).join(", ")})`;
    case "arithmetic":
      return `(${expression(value.left)} ${value.operator}${value.operator === "divide" ? " NULL_ON_ZERO" : ""} ${expression(value.right)})`;
    case "round":
      return `ROUND(${expression(value.input)}${value.decimalPlaces === undefined ? "" : `, ${value.decimalPlaces}`})`;
    case "absolute":
      return `ABS(${expression(value.input)})`;
    case "coalesce":
      return `COALESCE(${value.values.map(expression).join(", ")})`;
    case "case":
      return `CASE ${value.branches.map((branch) => `WHEN ${expression(branch.when)} THEN ${expression(branch.then)}`).join(" ")} ELSE ${expression(value.otherwise)} END`;
    case "time-bucket":
      return `TIME_BUCKET(${expression(value.input)}, ${value.granularity}, ${JSON.stringify(value.reportingTimeZone)})`;
    case "bucket-index":
      return `BUCKET_INDEX(${expression(value.input)})`;
  }
}

function aggregateMeasure(
  node: Extract<LogicalNode, { kind: "aggregate" }>,
  index: number,
): string {
  const measure = node.measures[index]!;
  const output = slot(measure.output);
  if (measure.kind === "count-rows") return `${output}=COUNT_ROWS`;
  if (measure.kind === "count-distinct")
    return `${output}=COUNT_DISTINCT(${expression(measure.input)})`;
  return `${output}=${measure.kind.toUpperCase()}(${expression(measure.input)})`;
}

function nodeHeader(node: LogicalNode): string {
  switch (node.kind) {
    case "source":
      return `${relation(node.id)} Source<${node.entity}> grain=${grain(node.grain)} domain=${node.temporalDomain}`;
    case "relationship-lookup":
      return `${relation(node.id)} RelationshipLookup<${node.relationship}> grain=${grain(node.grain)} input=${relation(node.input)} time=${node.timeSemantics}`;
    case "filter":
      return `${relation(node.id)} Filter grain=${grain(node.grain)} input=${relation(node.input)}`;
    case "event-payload-occurrences":
      return `${relation(node.id)} EventPayloadOccurrences grain=${grain(node.grain)} input=${relation(node.input)} eventKey=${slot(node.eventKey)} eventPk=${slot(node.eventPk)}`;
    case "project":
      return `${relation(node.id)} Project grain=${grain(node.grain)} input=${relation(node.input)}`;
    case "aggregate":
      return `${relation(node.id)} Aggregate grain=${grain(node.grain)} input=${relation(node.input)}`;
    case "sample-statistics":
      return `${relation(node.id)} SampleStatistics grain=${grain(node.grain)} input=${relation(node.input)}`;
    case "ordered-member":
      return `${relation(node.id)} OrderedMember grain=${grain(node.grain)} input=${relation(node.input)}`;
    case "ranked-members":
      return `${relation(node.id)} RankedMembers grain=${grain(node.grain)} input=${relation(node.input)} rank=${slot(node.rankSlot)}`;
    case "distinct":
      return `${relation(node.id)} Distinct grain=${grain(node.grain)} excludeNull=${node.excludeNull}`;
    case "set-operation":
      return `${relation(node.id)} ${node.operation[0]!.toUpperCase()}${node.operation.slice(1)} grain=${grain(node.grain)} inputs=[${node.inputs.map(relation).join(", ")}]`;
    case "row-concatenation":
      return `${relation(node.id)} AppendRows grain=${grain(node.grain)} inputs=[${node.inputs.map(relation).join(", ")}]`;
    case "semi-join":
      return `${relation(node.id)} SemiJoin grain=${grain(node.grain)}`;
    case "anti-join":
      return `${relation(node.id)} AntiJoin grain=${grain(node.grain)}`;
    case "join":
      return `${relation(node.id)} ${node.joinType === "left" ? "LeftJoin" : "InnerJoin"} grain=${grain(node.grain)}`;
    case "sort":
      return `${relation(node.id)} Sort grain=${grain(node.grain)} input=${relation(node.input)}`;
    case "limit":
      return `${relation(node.id)} Limit(${node.count}) grain=${grain(node.grain)} input=${relation(node.input)}`;
  }
}

function nodeLines(
  node: LogicalNode,
  slots: ReadonlyMap<SlotId, LogicalSlot>,
): string[] {
  const lines = [nodeHeader(node)];
  switch (node.kind) {
    case "source":
      for (const value of node.values) {
        const detail =
          value.kind === "self"
            ? "self"
            : value.kind === "related-entity"
              ? `relationship=${value.relationship}`
              : value.kind === "attribute"
                ? `attribute=${value.attribute}`
                : "occurrence-time";
        lines.push(`  VALUE ${detail} -> ${formatSlot(value.slot, slots)}`);
      }
      break;
    case "relationship-lookup":
      lines.push(
        `  LOOKUP ${node.relationship} BY ${formatSlot(node.inputKey, slots)} -> ${formatSlot(node.relatedSlot, slots)} (identity read; no activity-time filter)`,
      );
      break;
    case "filter":
      lines.push(`  WHERE ${expression(node.predicate)}`);
      break;
    case "event-payload-occurrences":
      node.fields.forEach((binding) =>
        lines.push(`  ${binding.field} -> ${formatSlot(binding.slot, slots)}`),
      );
      break;
    case "project":
      node.projections.forEach((projection) =>
        lines.push(
          `  ${formatSlot(projection.slot, slots)} := ${expression(projection.expression)}`,
        ),
      );
      break;
    case "aggregate":
      node.groups.forEach((group) =>
        lines.push(
          `  GROUP ${formatSlot(group.slot, slots)} := ${expression(group.expression)}`,
        ),
      );
      node.measures.forEach((_, index) =>
        lines.push(`  MEASURE ${aggregateMeasure(node, index)}`),
      );
      break;
    case "sample-statistics":
      node.groups.forEach((group) =>
        lines.push(
          `  GROUP ${formatSlot(group.slot, slots)} := ${expression(group.expression)}`,
        ),
      );
      lines.push(`  VALUE ${expression(node.value)}`);
      lines.push(`  SAMPLES ${formatSlot(node.samplesOutput, slots)}`);
      lines.push(`  AVG ${formatSlot(node.averageOutput, slots)}`);
      node.percentiles.forEach((item) =>
        lines.push(
          `  P${item.percentile} ${JSON.stringify(item.name)} -> ${formatSlot(item.output, slots)}`,
        ),
      );
      break;
    case "ordered-member":
      node.groups.forEach((group) =>
        lines.push(`  GROUP ${formatSlot(group, slots)}`),
      );
      node.order.forEach((key) =>
        lines.push(
          `  ORDER ${formatSlot(key.slot, slots)} ${key.direction.toUpperCase()} NULLS ${key.nulls.toUpperCase()}`,
        ),
      );
      break;
    case "ranked-members":
      node.groups.forEach((group) =>
        lines.push(`  PARTITION ${formatSlot(group, slots)}`),
      );
      node.order.forEach((key) =>
        lines.push(
          `  ORDER ${formatSlot(key.slot, slots)} ${key.direction.toUpperCase()} NULLS ${key.nulls.toUpperCase()}`,
        ),
      );
      lines.push(`  RANK ${formatSlot(node.rankSlot, slots)}`);
      break;
    case "distinct":
      node.keys.forEach((key) =>
        lines.push(
          `  KEY ${formatSlot(key.output, slots)} := ${formatSlot(key.input, slots)}`,
        ),
      );
      break;
    case "set-operation":
      node.inputs.forEach((input) => lines.push(`  INPUT ${relation(input)}`));
      break;
    case "row-concatenation":
      node.columns.forEach((column) =>
        lines.push(
          `  ${JSON.stringify(column.name)} ${formatSlot(column.output, slots)} <- [${column.inputs.map((id) => formatSlot(id, slots)).join(", ")}]`,
        ),
      );
      break;
    case "semi-join":
    case "anti-join":
      lines.push(`  LEFT ${relation(node.left)}`);
      lines.push(`  RIGHT ${relation(node.right)}`);
      node.keys.forEach((key) =>
        lines.push(
          `  ON ${formatSlot(key.left, slots)} = ${formatSlot(key.right, slots)}`,
        ),
      );
      break;
    case "join":
      lines.push(`  LEFT ${relation(node.left)}`);
      lines.push(`  RIGHT ${relation(node.right)}`);
      node.keys.forEach((key) =>
        lines.push(
          `  ON ${formatSlot(key.left, slots)} = ${formatSlot(key.right, slots)}`,
        ),
      );
      node.rightAliases.forEach((alias) =>
        lines.push(
          `  ALIAS ${formatSlot(alias.source, slots)} AS ${formatSlot(alias.alias, slots)}`,
        ),
      );
      break;
    case "sort":
      node.keys.forEach((key) =>
        lines.push(
          `  ORDER ${formatSlot(key.slot, slots)} ${key.direction.toUpperCase()} NULLS ${key.nulls.toUpperCase()}`,
        ),
      );
      break;
    case "limit":
      break;
  }
  lines.push(
    `  OUTPUT ${node.output.map((id) => formatSlot(id, slots)).join(", ")}`,
  );
  return lines;
}

export function printLogicalPlan(plan: LogicalPlan): string {
  const slots = new Map(plan.slots.map((item) => [item.id, item]));
  const lines = [
    `LogicalPlan v${plan.version}`,
    `  SUBJECT ${plan.context.subject.origin} sites=[${plan.context.subject.siteIds.join(",")}]${plan.context.subject.teamId ? ` team=${plan.context.subject.teamId}` : ""}`,
    `  SCOPE requested=${plan.context.scope.requested} contract=${plan.context.scope.contractScope ?? "auto"} logical=${plan.context.scope.logicalScope ?? "auto"}`,
    "",
  ];
  for (const [index, node] of plan.nodes.entries()) {
    if (index > 0) lines.push("");
    lines.push(...nodeLines(node, slots));
  }
  if (plan.outputs.length > 0) {
    lines.push("", "Outputs");
    for (const output of plan.outputs) {
      lines.push(
        `  ${JSON.stringify(output.id)} from ${relation(output.relation)}`,
      );
      output.fields.forEach((field) => {
        const semantic = field.semantic
          ? ` semantic=${field.semantic.kind}:${field.semantic.id}`
          : "";
        lines.push(
          `    ${JSON.stringify(field.name)} -> ${formatSlot(field.slot, slots)}${semantic}`,
        );
      });
    }
  }
  return `${lines.join("\n")}\n`;
}
