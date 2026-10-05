import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export interface SqliteD1Trace {
  readonly preparedSql: string[];
  readonly bindings: SQLInputValue[][];
  readonly batchStatements?: string[][];
  /** node:sqlite BigInt reads adapted to D1's JavaScript number rows. */
  readonly readBigIntsAsNumbers?: boolean;
}

function d1NumberValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  // BLOBs from node:sqlite are Uint8Array instances. Keep their byte view
  // intact while adapting integer values in row objects.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(d1NumberValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, d1NumberValue(entry)]),
    );
  return value;
}

function sqliteBindings(values: readonly SQLInputValue[]): SQLInputValue[] {
  // D1 treats booleans as SQLite INTEGER values, while node:sqlite rejects
  // JavaScript booleans as bind inputs. Translate only at this adapter edge.
  return values.map((value) => {
    const candidate: unknown = value;
    return typeof candidate === "boolean" ? (candidate ? 1 : 0) : value;
  });
}

export function createSqliteD1Database(
  database: DatabaseSync,
  trace?: SqliteD1Trace,
): D1Database {
  const statementSql = new WeakMap<object, string>();
  return {
    prepare(sql: string) {
      trace?.preparedSql.push(sql);
      const statement = database.prepare(sql);
      if (trace?.readBigIntsAsNumbers) statement.setReadBigInts(true);
      let bindings: SQLInputValue[] = [];
      const prepared = {
        bind(...values: SQLInputValue[]) {
          bindings = values;
          trace?.bindings.push(values);
          return prepared;
        },
        async first<Row>() {
          const row = statement.get(...sqliteBindings(bindings));
          return (
            (trace?.readBigIntsAsNumbers
              ? (d1NumberValue(row) as Row | undefined)
              : (row as Row | undefined)) ?? null
          );
        },
        async all<Row>() {
          const rows = statement.all(...sqliteBindings(bindings));
          return {
            success: true,
            results: (trace?.readBigIntsAsNumbers
              ? d1NumberValue(rows)
              : rows) as Row[],
          } as D1Result<Row>;
        },
        async run() {
          const result = statement.run(...sqliteBindings(bindings));
          return {
            success: true,
            meta: { changes: Number(result.changes) },
          } as D1Result;
        },
      };
      statementSql.set(prepared, sql);
      return prepared as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      trace?.batchStatements?.push(
        statements.map((prepared) => statementSql.get(prepared) ?? ""),
      );
      database.exec("BEGIN");
      try {
        const results: D1Result[] = [];
        for (const prepared of statements) {
          results.push(await prepared.run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as D1Database;
}
