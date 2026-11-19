/**
 * Local SQL qualification boundary shared by the scoped D1 datasets.
 *
 * A CTE owns its SQL and its positional bindings. The array order is the
 * actual emitted SQL order, including independent comparison/funnel bundles.
 * This is intentionally NOT a general relational query IR.
 */
export interface SqlBinding {
  readonly value: string | number | null;
}

export interface BoundCteDefinition {
  readonly name: string;
  /** A complete "<name> AS (...)" CTE definition, without a leading WITH. */
  readonly sql: string;
  readonly bindings: readonly SqlBinding[];
}

export type FilterQualificationSql =
  | {
      readonly kind: "observation";
      readonly ctes: readonly BoundCteDefinition[];
      /** Two-column relation: (site_pk, visit_id). */
      readonly matchedVisitRelation: string;
      /** Two-column relation: (site_pk, event_id). */
      readonly matchedEventRelation: string;
    }
  | {
      readonly kind: "entity";
      readonly entityKind: "session" | "visitor";
      readonly ctes: readonly BoundCteDefinition[];
      /** Two-column relation: (site_pk, entity_id). */
      readonly qualifiedEntityRelation: string;
    };

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function safeQualificationIdentifier(value: string): string {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new TypeError(
      "Qualification CTE name must be an internal SQL identifier.",
    );
  }
  return value;
}

export function boundCte(
  name: string,
  sql: string,
  bindings: readonly (SqlBinding | string | number | null)[] = [],
): BoundCteDefinition {
  safeQualificationIdentifier(name);
  const header =
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*(?:NOT\s+MATERIALIZED\s*|MATERIALIZED\s*)?\(/i.exec(
      sql,
    );
  if (!header || header[1] !== name) {
    throw new TypeError(
      `Qualification CTE ${name} has a mismatched SQL definition.`,
    );
  }
  return {
    name,
    sql,
    bindings: bindings.map((binding) =>
      typeof binding === "object" && binding !== null
        ? { value: binding.value }
        : { value: binding },
    ),
  };
}

/** Emit SQL and positional parameters as one operation, never in separate AST walks. */
export function composeBoundCtes(ctes: readonly BoundCteDefinition[]): {
  readonly ctes: string;
  readonly bindings: readonly SqlBinding[];
} {
  const names = new Set<string>();
  for (const cte of ctes) {
    safeQualificationIdentifier(cte.name);
    if (names.has(cte.name)) {
      throw new TypeError(`Duplicate qualification CTE: ${cte.name}.`);
    }
    names.add(cte.name);
  }
  return {
    ctes: ctes.map((cte) => cte.sql).join(",\n"),
    bindings: ctes.flatMap((cte) => cte.bindings),
  };
}
