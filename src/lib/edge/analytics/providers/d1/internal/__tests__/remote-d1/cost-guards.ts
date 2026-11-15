import type { CostStrategy } from "./referrers-cost-harness";

export interface ExplainRow {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

function distinctSubqueryAliases(sql: string) {
  const aliases = new Set<string>();
  const openings: number[] = [];
  let quote = "";
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = "";
      }
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") openings.push(index);
    else if (character === ")") {
      const opening = openings.pop();
      const alias = /^\) AS (\w+)/u.exec(sql.slice(index))?.[1];
      if (opening !== undefined && alias) {
        const body = sql.slice(opening + 1, index);
        if (
          /^SELECT DISTINCT\b/u.test(body) ||
          (body.includes(" GROUP BY ") && body.includes("SELECT DISTINCT "))
        )
          aliases.add(alias);
      }
    }
  }
  return aliases;
}

/** Follow the UNION key set itself; unrelated IN predicates cannot satisfy this. */
export function inspectEntityMembershipPlan(
  sql: string,
  plan: readonly ExplainRow[],
) {
  const byId = new Map(plan.map((row) => [row.id, row]));
  const eventAliases = new Set(
    [...sql.matchAll(/FROM "custom_events" AS (\w+)/gu)].map(
      (match) => match[1]!,
    ),
  );
  const unions = plan.filter((row) =>
    row.detail.includes("UNION USING TEMP B-TREE"),
  );
  const violations: { unionId: number; reason: string; detail: string[] }[] =
    [];
  let listProtectedUnions = 0;
  let protectedMemberships = 0;
  const ancestorsOf = (row: ExplainRow) => {
    const ancestors: ExplainRow[] = [];
    const seen = new Set<number>([row.id]);
    for (
      let parent = byId.get(row.parent);
      parent && !seen.has(parent.id);
      parent = byId.get(parent.parent)
    ) {
      ancestors.push(parent);
      seen.add(parent.id);
    }
    return ancestors;
  };
  for (const union of unions) {
    const ancestors = ancestorsOf(union);
    if (ancestors.some((row) => /\bLIST SUBQUERY\b/u.test(row.detail))) {
      listProtectedUnions += 1;
      protectedMemberships += 1;
    }
    if (ancestors.some((row) => /CORRELATED/u.test(row.detail)))
      violations.push({
        unionId: union.id,
        reason: "correlated-union-key-set",
        detail: ancestors.map((row) => row.detail),
      });
    for (const definition of ancestors) {
      const relation = /^(?:CO-ROUTINE|MATERIALIZE) (\w+)$/u.exec(
        definition.detail,
      )?.[1];
      if (!relation) continue;
      // CTE lifting moves the UNION definition outside its membership's LIST.
      // Follow its actual references, including incomplete automatic lookups.
      const references = [...sql.matchAll(/FROM (\w+) AS (\w+)/gu)]
        .filter((match) => match[1] === relation)
        .map((match) => match[2]!);
      for (const alias of [relation, ...references]) {
        for (const consumer of plan.filter((row) => {
          const scan = /^(?:SEARCH|SCAN) (\w+)\b/u.exec(row.detail);
          return (
            scan?.[1] === alias &&
            (references.includes(alias) || row.parent === definition.parent)
          );
        })) {
          if (
            ancestorsOf(consumer).some((row) =>
              /\bLIST SUBQUERY\b/u.test(row.detail),
            )
          ) {
            protectedMemberships += 1;
            continue;
          }
          const eventReaders = plan.filter(
            (row) =>
              row.parent === consumer.parent &&
              eventAliases.has(
                /^(?:SEARCH|SCAN) (\w+)\b/u.exec(row.detail)?.[1] ?? "",
              ) &&
              // Enumerating event keys and doing one unique event lookup per
              // key is linear. A range scan inside that loop is the old fault;
              // a key-set probe after an event reader repeats per event too.
              (row.id < consumer.id ||
                row.detail.startsWith("SCAN ") ||
                /occurred_at[<>]/u.test(row.detail)),
          );
          if (!eventReaders.length) continue;
          // Site alone still leaves every entity on that site to be checked.
          const terms =
            /\(([^)]+)\)$/u.exec(consumer.detail)?.[1]?.split(" AND ") ?? [];
          const completeKeyLookup =
            consumer.detail.startsWith("SEARCH ") &&
            terms.filter((term) => term.includes("=?")).length >= 2;
          if (completeKeyLookup) protectedMemberships += 1;
          else
            violations.push({
              unionId: union.id,
              reason: consumer.detail.startsWith("SCAN ")
                ? "union-key-outer-loop-repeats-event-window"
                : "union-key-partial-lookup-repeats-membership",
              detail: [
                consumer.detail,
                ...eventReaders.map((row) => row.detail),
              ],
            });
        }
      }
    }
  }
  // Overview also reuses the matching event keys through DISTINCT(Project).
  // Its UNION may already be safe while SQLite still scans this second key
  // set for every event. Recognize the compiled DISTINCT relation, not aliases
  // or a whole-query SQL hash, and permit a complete indexed tuple lookup.
  const distinctAliases = distinctSubqueryAliases(sql);
  for (const definition of plan) {
    const alias = /^MATERIALIZE (\w+)$/u.exec(definition.detail)?.[1];
    if (!alias || !distinctAliases.has(alias)) continue;
    for (const consumer of plan.filter(
      (row) =>
        row.parent === definition.parent &&
        /^(?:SEARCH|SCAN) (\w+)\b/u.exec(row.detail)?.[1] === alias,
    )) {
      const terms =
        /\(([^)]+)\)$/u.exec(consumer.detail)?.[1]?.split(" AND ") ?? [];
      if (
        consumer.detail.startsWith("SEARCH ") &&
        terms.filter((term) => term.includes("=?")).length >= 2
      ) {
        protectedMemberships += 1;
        continue;
      }
      const windows = plan.filter(
        (row) =>
          row.parent === consumer.parent &&
          eventAliases.has(
            /^(?:SEARCH|SCAN) (\w+)\b/u.exec(row.detail)?.[1] ?? "",
          ) &&
          (row.detail.startsWith("SCAN ") ||
            /occurred_at[<>]/u.test(row.detail)),
      );
      // SQLite can enumerate distinct event keys and probe the events table's
      // unique identity directly. That is also linear: the event reader must
      // be after this key consumer, in the same loop, with no full-window read.
      const uniqueEventProbes = plan.filter(
        (row) =>
          row.parent === consumer.parent &&
          row.id > consumer.id &&
          eventAliases.has(/^SEARCH (\w+)\b/u.exec(row.detail)?.[1] ?? "") &&
          /(?:USING INTEGER PRIMARY KEY \(rowid=\?\)|USING (?:COVERING )?INDEX sqlite_autoindex_custom_events_\d+ \(event_id=\?\))$/u.test(
            row.detail,
          ),
      );
      if (!windows.length && uniqueEventProbes.length) {
        protectedMemberships += 1;
        continue;
      }
      if (windows.length)
        violations.push({
          unionId: definition.id,
          reason: consumer.detail.startsWith("SCAN ")
            ? "materialized-event-key-set-repeats-event-window"
            : "materialized-event-key-set-has-incomplete-lookup",
          detail: [consumer.detail, ...windows.map((row) => row.detail)],
        });
    }
  }
  return {
    unionKeySets: unions.length,
    listProtectedUnions,
    protectedMemberships,
    violations,
  };
}

export function referrersCostBudget(visits: number, strategy: CostStrategy) {
  if (visits !== 2000 && visits !== 10000)
    return {
      status: "not-applicable" as const,
      reason: "Only the identical 2k/10k C01 fixtures have measured budgets",
    };
  return {
    status: "applicable" as const,
    maxRowsRead: (strategy === "fused" ? 20 : 12) * visits + 100,
    maxStatements: strategy === "fused" ? 2 : 3,
    maxRowsWritten: 0,
  };
}

export function errorEvidence(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "UnknownThrownValue", message: String(error) };
}

export interface StatementAttempt {
  readonly sql: string;
  readonly params: readonly unknown[];
  status: "running" | "completed" | "failed";
  elapsedMs?: number;
  error?: ReturnType<typeof errorEvidence>;
}

/** Capture failed SQL too; server costs remain unknown unless D1 returned them. */
export function observeStatementAttempts(database: D1Database) {
  const attempts: StatementAttempt[] = [];
  const inputs = new WeakMap<
    D1PreparedStatement,
    { sql: string; params: readonly unknown[]; original: D1PreparedStatement }
  >();
  async function execute<T>(
    statements: readonly { sql: string; params: readonly unknown[] }[],
    run: () => Promise<T>,
  ) {
    const started = performance.now();
    const current = statements.map((statement): StatementAttempt => ({
      ...statement,
      status: "running",
    }));
    attempts.push(...current);
    try {
      const result = await run();
      for (const attempt of current) attempt.status = "completed";
      return result;
    } catch (error) {
      for (const attempt of current) {
        attempt.status = "failed";
        attempt.error = errorEvidence(error);
      }
      throw error;
    } finally {
      for (const attempt of current)
        attempt.elapsedMs = Number((performance.now() - started).toFixed(3));
    }
  }
  function wrap(
    original: D1PreparedStatement,
    sql: string,
    params: readonly unknown[] = [],
  ): D1PreparedStatement {
    const proxy = new Proxy(original, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrap(target.bind(...values), sql, values);
        const value = Reflect.get(target, property);
        if (["first", "all", "run", "raw"].includes(String(property)))
          return (...args: unknown[]) =>
            execute([{ sql, params }], async () =>
              Reflect.apply(value, target, args),
            );
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    inputs.set(proxy, { sql, params, original });
    return proxy;
  }
  return {
    attempts,
    database: new Proxy(database, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => wrap(target.prepare(sql), sql);
        if (property === "batch")
          return (statements: D1PreparedStatement[]) => {
            const batch = statements.map((statement) => {
              const input = inputs.get(statement);
              if (!input) throw new Error("c01_untraced_batch_statement");
              return input;
            });
            return execute(batch, () =>
              target.batch(batch.map((statement) => statement.original)),
            );
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
