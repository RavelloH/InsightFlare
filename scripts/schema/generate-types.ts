import type { SchemaObject } from "./introspect";

export function generateSchemaTypes(schema: readonly SchemaObject[]): string {
  const tables: Record<string, unknown> = {};
  for (const object of schema) {
    const columns: Record<string, unknown> = {};
    for (const column of object.columns) {
      columns[column.propertyName] = {
        kind: "column",
        table: object.name,
        sqlName: column.sqlName,
        propertyName: column.propertyName,
        declaredType: column.declaredType,
        affinity: column.affinity,
        nullable: column.nullable,
        primaryKeyPosition: column.primaryKeyPosition,
        defaultSql: column.defaultSql,
        hidden: column.hidden,
        generated: column.generated,
      };
    }
    tables[object.name] = {
      kind: object.kind,
      name: object.name,
      columns,
      primaryKey: object.primaryKey,
      indexes: object.indexes,
      foreignKeys: object.foreignKeys,
    };
  }
  const json = JSON.stringify(tables, null, 2).replace(
    /"([A-Za-z_$][\w$]*)":/g,
    "$1:",
  );
  return [
    "// Generated file. Do not edit manually.",
    'import type { GeneratedSchema } from "./types";',
    "",
    `export const schema = ${json} as const satisfies GeneratedSchema;`,
    "",
    'export type { SchemaCatalog, SchemaColumnReference, SchemaObjectReference, SchemaTableReference } from "./types";',
  ].join("\n");
}
