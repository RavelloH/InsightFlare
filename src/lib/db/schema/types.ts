export type SqliteAffinity = "integer" | "real" | "text" | "blob" | "numeric";

export interface SchemaColumnReference {
  readonly kind: "column";
  readonly table: string;
  readonly sqlName: string;
  readonly propertyName: string;
  readonly declaredType: string;
  readonly affinity: SqliteAffinity;
  readonly nullable: boolean;
  readonly primaryKeyPosition: number;
  readonly defaultSql: string | null;
  readonly hidden: number;
  readonly generated: boolean;
}

export interface SchemaIndexReference {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly (string | null)[];
  readonly partial: boolean;
  readonly rawExpressionSql?: string;
}

export interface SchemaForeignKeyReference {
  readonly from: string;
  readonly toTable: string;
  readonly toColumn: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
}

export interface SchemaObjectReference {
  readonly kind: "table" | "view";
  readonly name: string;
  readonly columns: Readonly<Record<string, SchemaColumnReference>>;
  readonly primaryKey: readonly string[];
  readonly indexes: readonly SchemaIndexReference[];
  readonly foreignKeys: readonly SchemaForeignKeyReference[];
}

export type SchemaTableReference = SchemaObjectReference & {
  readonly kind: "table";
};
export type SchemaCatalog = Readonly<Record<string, SchemaObjectReference>>;
export type GeneratedSchema = SchemaCatalog;

export type SqliteAffinityValue<A extends SqliteAffinity> = A extends
  "integer" | "real"
  ? number
  : A extends "text"
    ? string
    : A extends "blob"
      ? ArrayBuffer | ArrayBufferView
      : number | string;

export type SchemaColumnValue<C extends SchemaColumnReference> =
  | SqliteAffinityValue<C["affinity"]>
  | (C["nullable"] extends true ? null : never);

export type SchemaRow<T extends SchemaObjectReference> = {
  readonly [K in keyof T["columns"]]: SchemaColumnValue<T["columns"][K]>;
};
