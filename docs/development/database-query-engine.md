# Database Query Engine Foundation

Phase 3A adds a compiler foundation without migrating production SQL.

- `migrations/*.sql` remain the only schema source of truth. `generate:schema` replays them into one in-memory SQLite database; both `docs/schema.sql` and `src/lib/db/schema/generated.ts` come from that final database.
- The generated catalog contains SQLite introspection metadata only. It records declared type, affinity, nullability, defaults, keys, indexes, and foreign keys. It does not infer application semantics from names.
- Read plans use relational nodes. Mutation plans have a separate representation. `lowerLogicalPlan()` currently preserves the logical structure; no optimizer runs.
- `compileD1Query()` and `compileD1Mutation()` produce parameterized statements and do not execute them. Values become bindings and identifiers are quoted by the SQL fragment layer.
- `DatabaseRuntime` remains the D1 execution boundary. `DatabaseClient` only dispatches compiled statements to it; `batch()` stays an execution operation and there is no transaction abstraction.
- `unsafeRawSql()` and `unsafeRawMutation()` are explicit escape hatches. The mutation form requires SQL, bindings, and a result contract. Neither helper executes SQL.
- The current language covers scans, filters, projections, inner/left joins, semi/anti joins, aggregates, distinct, ordering, limits, unions, and common insert/update/delete/conflict forms. CTEs, window functions, arbitrary joins, returning clauses, and optimizer rewrites are not implemented.

Production query construction and execution paths are intentionally unchanged in this phase.
