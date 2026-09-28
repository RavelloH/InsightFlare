import { schema } from "./generated";

export { schema };
export type GeneratedSchemaObject = (typeof schema)[keyof typeof schema];
export type GeneratedSchemaTable = Extract<
  GeneratedSchemaObject,
  { readonly kind: "table" }
>;
export type {
  GeneratedSchema,
  SchemaCatalog,
  SchemaColumnReference,
  SchemaColumnValue,
  SchemaForeignKeyReference,
  SchemaIndexReference,
  SchemaObjectReference,
  SchemaRow,
  SchemaTableReference,
  SqliteAffinity,
  SqliteAffinityValue,
} from "./types";

export function isGeneratedSchemaObject(
  value: unknown,
): value is GeneratedSchemaObject {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(schema).some((item) => item === value)
  );
}
