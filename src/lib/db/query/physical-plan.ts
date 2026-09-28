import type { AnyExpression } from "./expression";
import type { LogicalQueryNode, QuerySource, Relation } from "./plan";
import { validateLogicalQueryPlan } from "./validator";

/** The first lowering is deliberately mechanical; optimization is a later phase. */
export interface PhysicalQueryPlan<
  Row extends object = Record<string, unknown>,
> {
  readonly kind: "physical-query";
  readonly root: LogicalQueryNode;
  readonly scope: QuerySource["scope"];
  readonly fields: QuerySource["fields"];
  readonly __rowType?: Row;
}

export function lowerLogicalPlan<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<Row, Columns>): PhysicalQueryPlan<Row> {
  validateLogicalQueryPlan(relation);
  return {
    kind: "physical-query",
    root: relation.node,
    scope: relation.scope,
    fields: relation.fields,
  };
}
