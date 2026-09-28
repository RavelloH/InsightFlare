import type { DatabaseSync } from "node:sqlite";

export type SqliteAffinity = "integer" | "real" | "text" | "blob" | "numeric";

export interface SchemaColumn {
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

export interface SchemaIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly (string | null)[];
  readonly partial: boolean;
  readonly rawExpressionSql?: string;
}

export interface SchemaForeignKey {
  readonly from: string;
  readonly toTable: string;
  readonly toColumn: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
}

export interface SchemaObject {
  readonly kind: "table" | "view";
  readonly name: string;
  readonly columns: readonly SchemaColumn[];
  readonly primaryKey: readonly string[];
  readonly indexes: readonly SchemaIndex[];
  readonly foreignKeys: readonly SchemaForeignKey[];
}

interface MasterRow {
  type: "table" | "view";
  name: string;
  sql: string | null;
}

interface ColumnRow {
  cid: number;
  name: string;
  type: string | null;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexColumnRow {
  seqno: number;
  cid: number;
  name: string | null;
  key: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function quotePragmaIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function sqliteAffinity(declaredType: string): SqliteAffinity {
  const type = declaredType.toUpperCase();
  if (type.includes("INT")) return "integer";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT"))
    return "text";
  if (type.includes("BLOB") || type.length === 0) return "blob";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB"))
    return "real";
  return "numeric";
}

function tableObjects(db: DatabaseSync): MasterRow[] {
  return (
    db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as unknown as MasterRow[]
  ).sort((a, b) => compare(a.name, b.name));
}

function readColumns(db: DatabaseSync, table: string): SchemaColumn[] {
  const rows = db
    .prepare(`PRAGMA table_xinfo(${quotePragmaIdentifier(table)})`)
    .all() as unknown as ColumnRow[];
  return rows
    .sort((a, b) => a.cid - b.cid)
    .map((row) => {
      const declaredType = row.type ?? "";
      return {
        sqlName: row.name,
        propertyName: row.name,
        declaredType,
        affinity: sqliteAffinity(declaredType),
        nullable: row.notnull === 0,
        primaryKeyPosition: row.pk,
        defaultSql: row.dflt_value,
        hidden: row.hidden,
        generated: row.hidden === 2 || row.hidden === 3,
      };
    });
}

function readIndexes(db: DatabaseSync, table: string): SchemaIndex[] {
  const indexes = db
    .prepare(`PRAGMA index_list(${quotePragmaIdentifier(table)})`)
    .all() as unknown as IndexListRow[];
  return indexes
    .sort((a, b) => compare(a.name, b.name))
    .map((index) => {
      const parts = db
        .prepare(`PRAGMA index_xinfo(${quotePragmaIdentifier(index.name)})`)
        .all() as unknown as IndexColumnRow[];
      const keyParts = parts
        .filter((part) => part.key === 1)
        .sort((a, b) => a.seqno - b.seqno);
      const hasExpression = keyParts.some((part) => part.cid === -2);
      const master = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(index.name) as { sql: string | null } | undefined;
      return {
        name: index.name,
        unique: index.unique === 1,
        columns: keyParts.map((part) => (part.cid >= 0 ? part.name : null)),
        partial: index.partial === 1,
        ...(hasExpression && master?.sql
          ? { rawExpressionSql: master.sql }
          : {}),
      };
    });
}

function readForeignKeys(db: DatabaseSync, table: string): SchemaForeignKey[] {
  const rows = db
    .prepare(`PRAGMA foreign_key_list(${quotePragmaIdentifier(table)})`)
    .all() as unknown as ForeignKeyRow[];
  return rows
    .sort((a, b) => a.id - b.id || a.seq - b.seq)
    .map((row) => ({
      from: row.from,
      toTable: row.table,
      toColumn: row.to,
      onUpdate: row.on_update,
      onDelete: row.on_delete,
    }));
}

export function introspectSchema(db: DatabaseSync): SchemaObject[] {
  return tableObjects(db).map((object) => {
    const columns = readColumns(db, object.name);
    return {
      kind: object.type,
      name: object.name,
      columns,
      primaryKey: columns
        .filter((column) => column.primaryKeyPosition > 0)
        .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
        .map((column) => column.sqlName),
      indexes: object.type === "table" ? readIndexes(db, object.name) : [],
      foreignKeys:
        object.type === "table" ? readForeignKeys(db, object.name) : [],
    };
  });
}
