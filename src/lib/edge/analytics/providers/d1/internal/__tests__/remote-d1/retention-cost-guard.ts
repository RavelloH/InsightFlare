import type { ExplainRow } from "./cost-guards";

function topLevelClauses(sql: string) {
  let depth = 0;
  let quote = "";
  let from = -1;
  let group = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = "";
      }
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0) {
      if (from < 0 && /^FROM\b/u.test(sql.slice(index))) from = index;
      if (/^GROUP BY\b/u.test(sql.slice(index))) group = index;
    }
  }
  return { from, group };
}

/** Identify the actual grouped MIN/MAX RHS, independent of generated aliases. */
function cohortAliases(sql: string) {
  const aliases = new Map<string, number>();
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
      if (opening === undefined || !alias) continue;
      const body = sql.slice(opening + 1, index);
      if (!/^SELECT\b/u.test(body)) continue;
      const { from, group } = topLevelClauses(body);
      if (
        from < 0 ||
        group < from ||
        !/\b(?:MIN|MAX)\(/u.test(body.slice(0, from))
      )
        continue;
      const keys = new Set(
        [...body.slice(group + 8).matchAll(/\b\w+\.(?:_c\d+|"[^"]+")/gu)].map(
          (match) => match[0],
        ),
      );
      if (keys.size) aliases.set(alias, keys.size);
    }
  }
  return aliases;
}

/** A materialized cohort scanned per page was the measured quadratic path.
 * Inspect that RHS's complete group-key probe, not an unrelated IN or CTE. */
export function inspectRetentionCohortPlan(
  sql: string,
  plan: readonly ExplainRow[],
) {
  const aliases = cohortAliases(sql);
  const violations: {
    alias: string;
    detail: string;
    requiredKeyTerms: number;
  }[] = [];
  let cohortLookups = 0;
  for (const [alias, requiredKeyTerms] of aliases) {
    for (const row of plan) {
      if (/^(?:SEARCH|SCAN) (\w+)\b/u.exec(row.detail)?.[1] !== alias) continue;
      const terms = /\(([^)]+)\)$/u.exec(row.detail)?.[1]?.split(" AND ") ?? [];
      if (
        row.detail.startsWith("SEARCH ") &&
        terms.filter((term) => term.includes("=?")).length >= requiredKeyTerms
      )
        cohortLookups += 1;
      else violations.push({ alias, detail: row.detail, requiredKeyTerms });
    }
  }
  return { cohortRelations: aliases.size, cohortLookups, violations };
}
