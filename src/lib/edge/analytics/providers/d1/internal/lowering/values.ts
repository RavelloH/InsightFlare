import { and, isNotNull, or, param, project } from "@/lib/db";
import type {
  AnyExpression,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type {
  LogicalSlot,
  LogicalValueType,
} from "@/lib/edge/analytics/engine/logical/slots";
import type { AnalyticsEntityKind } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  type AnalyticsEventDistinctIdentityLayout,
  type AnalyticsEventDistinctIdentitySeed,
  assertAnalyticsEventDistinctIdentitySeed,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-event-identity-proof";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

import { reject } from "./errors";

export type SlotLayout =
  | {
      readonly kind: "scalar";
      readonly type: LogicalValueType;
      readonly nullable: boolean;
      readonly valueColumn: string;
      readonly candidateBounded: boolean;
    }
  | {
      readonly kind: "entity";
      readonly type: Extract<LogicalValueType, { readonly kind: "entity" }>;
      readonly nullable: boolean;
      readonly keyColumns: readonly string[];
      readonly presentColumn?: string;
      readonly candidateBounded: boolean;
      readonly providerDistinctIdentity?: AnalyticsEventDistinctIdentityLayout;
    };

export interface LoweredRelation {
  readonly relation: AnalyticsDbRelation;
  readonly slots: ReadonlyMap<SlotId, SlotLayout>;
  /** Provider-owned columns survive only projections that explicitly carry them. */
  readonly providerColumns?: ReadonlyMap<string, string>;
  readonly candidateActivity?: "page" | "event" | "observation";
  readonly candidateActivitySessionRelation?: RelationId;
  readonly candidateActivitySessionRestricted: boolean;
}

export interface ProviderProjectionValue {
  readonly id: string;
  readonly expression: AnyExpression;
  readonly additionalValues?: readonly {
    readonly id: string;
    readonly expression: AnyExpression;
  }[];
  /** Reuse a live scalar slot when it already projects this same expression. */
  readonly reuseSlot?: SlotId;
  readonly identitySlot?: SlotId;
  readonly identitySeed?: AnalyticsEventDistinctIdentitySeed;
}

export type LoweredValue =
  | {
      readonly kind: "scalar";
      readonly expression: AnyExpression;
      readonly type: LogicalValueType;
      readonly nullable: boolean;
      readonly candidateBounded: boolean;
    }
  | {
      readonly kind: "entity";
      readonly entity: AnalyticsEntityKind;
      readonly keys: readonly AnyExpression[];
      readonly present: Predicate;
      readonly nullable: boolean;
      readonly candidateBounded: boolean;
      readonly providerDistinctIdentity?: AnalyticsEventDistinctIdentityLayout;
    };

export function slotColumn(index: number, role: string): string {
  return `s${index}_${role}`;
}

export function relationColumn(
  relation: AnalyticsDbRelation,
  name: string,
  path: string,
): AnyExpression {
  const value = relation.columns[name];
  if (!value)
    reject(path, `Missing lowered DB column ${JSON.stringify(name)}.`);
  return value;
}

export function asPredicate(
  expression: AnyExpression,
  path: string,
): Predicate {
  if (expression.resultType.affinity !== "integer")
    reject(path, "A relational predicate must lower to an integer expression.");
  return expression as Predicate;
}

export function logicalSlot(
  slots: ReadonlyMap<SlotId, LogicalSlot>,
  id: SlotId,
  path: string,
): LogicalSlot {
  const slot = slots.get(id);
  if (!slot) reject(path, `Missing validated Logical slot ${String(id)}.`);
  return slot;
}

function layoutValue(
  relation: AnalyticsDbRelation,
  slot: SlotLayout,
  path: string,
): LoweredValue {
  if (slot.kind === "scalar") {
    return {
      kind: "scalar",
      expression: relationColumn(relation, slot.valueColumn, path),
      type: slot.type,
      nullable: slot.nullable,
      candidateBounded: slot.candidateBounded,
    };
  }
  return {
    kind: "entity",
    entity: slot.type.entity,
    keys: slot.keyColumns.map((name) => relationColumn(relation, name, path)),
    present: slot.presentColumn
      ? asPredicate(relationColumn(relation, slot.presentColumn, path), path)
      : isNotNull(relationColumn(relation, slot.keyColumns[0]!, path)),
    nullable: slot.nullable,
    candidateBounded: slot.candidateBounded,
    ...(slot.providerDistinctIdentity
      ? { providerDistinctIdentity: slot.providerDistinctIdentity }
      : {}),
  };
}

export function slotLayout(
  value: LoweredValue,
  slot: LogicalSlot,
  index: number,
  path: string,
): {
  readonly layout: SlotLayout;
  readonly projections: Record<string, AnyExpression>;
} {
  const projections: Record<string, AnyExpression> = {};
  if (value.kind === "scalar") {
    if (slot.type.kind === "entity")
      reject(path, "An entity slot cannot be mapped from a scalar expression.");
    if (value.expression.resultType.nullable && !slot.nullable)
      reject(
        path,
        "The lowered scalar can be NULL but the Logical slot cannot.",
      );
    const valueColumn = slotColumn(index, "v");
    projections[valueColumn] = value.expression;
    return {
      layout: {
        kind: "scalar",
        type: slot.type,
        nullable: slot.nullable,
        valueColumn,
        candidateBounded: value.candidateBounded,
      },
      projections,
    };
  }

  if (
    slot.type.kind !== "entity" ||
    slot.type.entity !== value.entity ||
    value.nullable !== slot.nullable
  )
    reject(path, "The lowered entity key does not match its Logical slot.");
  if (value.keys.length === 0)
    reject(path, "Entity identity requires at least one physical key column.");
  const keyColumns = value.keys.map((expression, keyIndex) => {
    const name = slotColumn(index, `k${keyIndex}`);
    projections[name] = expression;
    return name;
  });
  const presentColumn = slot.nullable
    ? slotColumn(index, "present")
    : undefined;
  if (presentColumn) projections[presentColumn] = value.present;
  return {
    layout: {
      kind: "entity",
      type: slot.type,
      nullable: slot.nullable,
      keyColumns,
      ...(presentColumn ? { presentColumn } : {}),
      candidateBounded: value.candidateBounded,
    },
    projections,
  };
}

export function projectedValues(
  input: AnalyticsDbRelation,
  values: readonly { readonly slot: SlotId; readonly value: LoweredValue }[],
  logicalSlots: ReadonlyMap<SlotId, LogicalSlot>,
  path: string,
  providerValues: readonly ProviderProjectionValue[] = [],
): LoweredRelation {
  const projections: Record<string, AnyExpression> = {};
  const layouts = new Map<SlotId, SlotLayout>();
  const providerColumns = new Map<string, string>();
  let providerColumnIndex = 0;
  const identitySeeds: {
    readonly providerValue: ProviderProjectionValue;
    readonly identitySlot: SlotId;
    readonly identitySeed: AnalyticsEventDistinctIdentitySeed;
  }[] = [];
  values.forEach(({ slot, value }, index) => {
    const meta = logicalSlot(logicalSlots, slot, `${path}.${String(slot)}`);
    const projected = slotLayout(value, meta, index, `${path}.${String(slot)}`);
    Object.assign(projections, projected.projections);
    layouts.set(slot, projected.layout);
  });
  providerValues.forEach((providerValue) => {
    if (!providerValue.id || providerColumns.has(providerValue.id))
      reject(
        path,
        "Provider projection identifiers must be non-empty and unique.",
      );
    if (
      (providerValue.identitySlot === undefined) !==
      (providerValue.identitySeed === undefined)
    )
      reject(
        path,
        "A Provider distinct identity projection requires its slot and source proof.",
      );
    if (providerValue.reuseSlot !== undefined) {
      const layout = layouts.get(providerValue.reuseSlot);
      const value = values.find(({ slot }) => slot === providerValue.reuseSlot);
      if (
        !layout ||
        layout.kind !== "scalar" ||
        value?.value.kind !== "scalar" ||
        value.value.expression !== providerValue.expression
      )
        reject(
          path,
          "A reused Provider projection must name the same live scalar expression.",
        );
      if (providerValue.identitySlot !== undefined)
        reject(
          path,
          "A Provider identity discriminator cannot reuse a Logical scalar slot.",
        );
      providerColumns.set(providerValue.id, layout.valueColumn);
    } else {
      const column = `p${providerColumnIndex++}_v`;
      if (Object.hasOwn(projections, column))
        reject(
          path,
          `Provider projection column ${column} collides with a Logical slot.`,
        );
      projections[column] = providerValue.expression;
      providerColumns.set(providerValue.id, column);
    }
    for (const additional of providerValue.additionalValues ?? []) {
      if (!additional.id || providerColumns.has(additional.id))
        reject(
          path,
          "Provider projection identifiers must be non-empty and unique.",
        );
      const column = `p${providerColumnIndex++}_v`;
      if (Object.hasOwn(projections, column))
        reject(
          path,
          `Provider projection column ${column} collides with a Logical slot.`,
        );
      projections[column] = additional.expression;
      providerColumns.set(additional.id, column);
    }
    if (
      providerValue.identitySlot !== undefined &&
      providerValue.identitySeed !== undefined
    ) {
      const identityValue = values.find(
        ({ slot }) => slot === providerValue.identitySlot,
      )?.value;
      const identityLayout = layouts.get(providerValue.identitySlot);
      if (
        !identityValue ||
        identityValue.kind !== "entity" ||
        identityValue.entity !== "event" ||
        identityValue.nullable ||
        identityLayout?.kind !== "entity" ||
        identityLayout.type.entity !== "event" ||
        identityLayout.nullable ||
        identityLayout.keyColumns.length !== 2
      )
        reject(
          path,
          "A Provider distinct identity requires a non-null Event Entity slot.",
        );
      assertAnalyticsEventDistinctIdentitySeed(
        providerValue.identitySeed,
        providerValue.id,
        providerValue.identitySlot,
        providerValue.identitySeed.scopeRelation,
        input,
        {
          kind: "entity",
          entity: identityValue.entity,
          keys: identityValue.keys,
          present: identityValue.present,
          nullable: identityValue.nullable,
          candidateBounded: identityValue.candidateBounded,
        },
        providerValue.expression,
        path,
      );
      identitySeeds.push({
        providerValue,
        identitySlot: providerValue.identitySlot,
        identitySeed: providerValue.identitySeed,
      });
    }
  });
  const attachDistinctIdentityProofs = (
    relation: AnalyticsDbRelation,
  ): void => {
    for (const { providerValue, identitySlot, identitySeed } of identitySeeds) {
      const identityLayout = layouts.get(identitySlot);
      const discriminatorColumn = providerColumns.get(providerValue.id);
      if (
        identityLayout?.kind !== "entity" ||
        !discriminatorColumn ||
        identityLayout.keyColumns.length !== 2
      )
        reject(path, "A Provider distinct identity lost its projected layout.");
      layouts.set(identitySlot, {
        ...identityLayout,
        providerDistinctIdentity: {
          sourceBinding: identitySeed.sourceBinding,
          sourceSignature: identitySeed.sourceSignature,
          sourceId: identitySeed.sourceId,
          eventKeySlot: identitySeed.eventKeySlot,
          identitySlot,
          scopeRelation: identitySeed.scopeRelation,
          carrierRelation: relation,
          identityColumns: [
            identityLayout.keyColumns[0]!,
            identityLayout.keyColumns[1]!,
          ],
          discriminatorColumn,
        },
      });
    }
  };
  if (values.length === 0) {
    const rowProjection: Record<string, AnyExpression> = {
      __analytics_row: param(1),
      ...projections,
    };
    const relation: AnalyticsDbRelation = project(input, rowProjection);
    attachDistinctIdentityProofs(relation);
    return {
      relation,
      slots: layouts,
      ...(providerColumns.size > 0 ? { providerColumns } : {}),
      candidateActivitySessionRestricted: false,
    };
  }
  const relation: AnalyticsDbRelation = project(input, projections);
  attachDistinctIdentityProofs(relation);
  return {
    relation,
    slots: layouts,
    ...(providerColumns.size > 0 ? { providerColumns } : {}),
    candidateActivitySessionRestricted: false,
  };
}

export function readValue(
  relation: AnalyticsDbRelation,
  slots: ReadonlyMap<SlotId, SlotLayout>,
  id: SlotId,
  path: string,
): LoweredValue {
  const layout = slots.get(id);
  if (!layout)
    reject(path, `Slot ${String(id)} is not visible in this relation.`);
  return layoutValue(relation, layout, path);
}

export function combinePredicates(
  operator: "and" | "or",
  predicates: readonly Predicate[],
  path: string,
): Predicate {
  const [first, ...rest] = predicates;
  if (!first) reject(path, "A Boolean expression must contain a term.");
  if (rest.length === 0) return first;
  return operator === "and" ? and(first, ...rest) : or(first, ...rest);
}

export function scalarValue(value: LoweredValue, path: string): AnyExpression {
  if (value.kind !== "scalar")
    reject(path, "This expression requires a scalar Logical value.");
  return value.expression;
}

export function scalarAggregateValue(
  value: LoweredValue,
  path: string,
): Extract<LoweredValue, { readonly kind: "scalar" }> & {
  readonly type: Extract<
    LogicalValueType,
    { readonly kind: "scalar" | "bucket" }
  >;
} {
  if (
    value.kind !== "scalar" ||
    (value.type.kind !== "scalar" && value.type.kind !== "bucket")
  )
    reject(path, "Scalar aggregation requires a scalar Logical value.");
  return { ...value, type: value.type };
}

export function numericAggregateExpression(
  value: LoweredValue,
  path: string,
): SqlExpression<number | null> {
  const scalar = scalarAggregateValue(value, path);
  if (scalar.type.kind !== "scalar" || scalar.type.scalar !== "number")
    reject(path, "SUM and AVG require numeric scalar values.");
  return scalar.expression as SqlExpression<number | null>;
}

export function comparableAggregateValue(
  value: LoweredValue,
  path: string,
): Extract<LoweredValue, { readonly kind: "scalar" }> & {
  readonly type: Extract<LogicalValueType, { readonly kind: "scalar" }>;
} {
  const scalar = scalarAggregateValue(value, path);
  if (scalar.type.kind !== "scalar")
    reject(path, "MIN and MAX require a comparable scalar value.");
  if (
    !["string", "number", "boolean", "date", "datetime"].includes(
      scalar.type.scalar,
    )
  )
    reject(path, "MIN and MAX require a comparable scalar value.");
  return {
    ...scalar,
    type: scalar.type as Extract<LogicalValueType, { readonly kind: "scalar" }>,
  };
}
