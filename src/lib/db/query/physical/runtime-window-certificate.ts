import type { SqlExpression } from "@/lib/db/query/expression";
import {
  isMaterializationSafeAggregateExpression,
  isMaterializationSafeExpression,
  isMaterializationSafeNode,
} from "@/lib/db/query/materialization-safety";
import {
  isTextComparisonStorageClass,
  semiMembershipBinaryCollation,
  semiMembershipComparisonDomain,
} from "@/lib/db/query/physical/comparison-domains";
import type {
  PhysicalQueryPlan,
  SharedRelationDefinition,
} from "@/lib/db/query/physical/contracts";
import {
  deriveOwnerAggregateObligation,
  MAXIMUM_OWNER_ROWS,
  type OwnerAggregateObligation,
} from "@/lib/db/query/physical/owner-aggregate-obligations";
import type {
  LogicalQueryNode,
  QuerySource,
  SortNode,
  WindowNode,
} from "@/lib/db/query/plan";
import {
  analyzeRelationalKeyFacts,
  hasStableRowNumberOrdering,
} from "@/lib/db/query/relational-key-facts";

import { isConditionalGuardNodeTotal } from "./runtime-guard-totality";

/** This is a proposed condition, never a static window/materialization license.
 * The compiler must regenerate it from the current graph, emit every condition,
 * and only use the private fast query when every condition evaluates true. */
export interface RuntimeWindowKey {
  readonly index: number;
  readonly storage: "text" | "safe-integer" | "safe-integer-or-constructed";
  readonly collation: "BINARY";
  readonly constructedRealValues?: readonly number[];
}
export interface RuntimeWindowObligation {
  readonly window: WindowNode;
  readonly input: QuerySource;
  readonly keys: readonly RuntimeWindowKey[];
  readonly tuple: readonly SqlExpression[];
  readonly predecessorWindows: readonly WindowNode[];
}
export interface RuntimeWindowCertificate {
  readonly root: LogicalQueryNode;
  readonly owner: SharedRelationDefinition;
  readonly windows: readonly RuntimeWindowObligation[];
  readonly terminalSort: SortNode;
  readonly terminalPath: readonly LogicalQueryNode[];
  readonly order: readonly SqlExpression[];
  readonly maximumOwnerRows: number;
  readonly ownerAggregates: readonly OwnerAggregateObligation[];
}
export type RuntimeWindowDerivation =
  | { readonly eligible: true; readonly certificate: RuntimeWindowCertificate }
  | {
      readonly eligible: false;
      readonly reason: string;
      readonly blocker?: LogicalQueryNode;
      readonly index?: number;
    };

export function relationInputs(node: LogicalQueryNode): readonly QuerySource[] {
  switch (node.kind) {
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return [];
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return [node.left, node.right];
    case "recursive-closure":
      return [node.seed, node.candidates];
    default:
      return [node.input];
  }
}
function graph(
  root: LogicalQueryNode,
): readonly LogicalQueryNode[] | undefined {
  const seen = new Set<LogicalQueryNode>(),
    active = new Set<LogicalQueryNode>(),
    nodes: LogicalQueryNode[] = [];
  const visit = (n: LogicalQueryNode): boolean => {
    if (active.has(n)) return false;
    if (seen.has(n)) return true;
    active.add(n);
    for (const s of relationInputs(n)) if (!visit(s.node)) return false;
    active.delete(n);
    seen.add(n);
    nodes.push(n);
    return true;
  };
  return visit(root) ? nodes : undefined;
}
function totalWindow(n: WindowNode): boolean {
  const scopes = new Map([[n.input.scope, n.input.fields.length]]);
  return (
    n.windows.length > 0 &&
    n.windows.every(
      ({ specification: s }) =>
        s.kind === "row-number" &&
        s.orderBy.length > 0 &&
        [...s.partitionBy, ...s.orderBy.map((k) => k.expression)].every((e) =>
          isMaterializationSafeExpression(e, scopes),
        ),
    )
  );
}
/** Eager guard evaluation cannot introduce partial arithmetic/functions, scalar
 * subqueries, recursion, LIMIT/SORT evaluation barriers, or overflowing SUM.
 * ROW_NUMBER ties are total but not determined: they are allowed only in this
 * guard producer. Every predecessor's determination is separately required. */
export function totalRuntimeGuardProducer(
  root: LogicalQueryNode,
): LogicalQueryNode | undefined {
  const nodes = graph(root);
  if (!nodes) return root;
  for (const n of nodes) {
    if (n.kind === "window") {
      if (!totalWindow(n)) return n;
      continue;
    }
    if (
      n.kind === "aggregate" ||
      n.kind === "sort" ||
      n.kind === "limit" ||
      n.kind === "recursive-closure" ||
      !isConditionalGuardNodeTotal(n)
    )
      return n;
  }
  return undefined;
}
function keyColumns(
  e: SqlExpression,
  source: QuerySource,
  out: Set<number>,
): boolean {
  if (e.kind === "column") {
    if (
      e.scope !== source.scope ||
      !Number.isInteger(e.index) ||
      e.index < 0 ||
      e.index >= source.fields.length
    )
      return false;
    out.add(e.index);
    return true;
  }
  // Current first slice deliberately accepts no casts, calls, arithmetic, or
  // comparator-changing expressions as window determination keys.
  if (e.kind === "null-check") return keyColumns(e.expression, source, out);
  return false;
}

export function deriveRuntimeWindowCertificate(
  plan: PhysicalQueryPlan<object>,
  additionalChangedInputs: readonly LogicalQueryNode[] = [],
): RuntimeWindowDerivation {
  const nodes = graph(plan.root);
  if (!nodes) return { eligible: false, reason: "relation-cycle" };
  const ord = new Map(nodes.map((n, i) => [n, i]));
  const windows = nodes.filter((n): n is WindowNode => n.kind === "window");
  if (!windows.length) return { eligible: false, reason: "no-window" };
  // A total terminal ordering is necessary for transport ordinals. Projects
  // above the sort must be total, and a positive finite LIMIT may preserve it.
  const terminalPath: LogicalQueryNode[] = [];
  let terminal: LogicalQueryNode = plan.root;
  while (terminal.kind === "project" || terminal.kind === "limit") {
    if (!isMaterializationSafeNode(terminal))
      return {
        eligible: false,
        reason: "unsafe-terminal-path",
        blocker: terminal,
      };
    terminalPath.push(terminal);
    terminal = terminal.input.node;
  }
  if (terminal.kind !== "sort")
    return {
      eligible: false,
      reason: "missing-terminal-order",
      blocker: terminal,
    };
  if (!isMaterializationSafeNode(terminal))
    return {
      eligible: false,
      reason: "unsafe-terminal-order",
      blocker: terminal,
    };
  const incoming = new Map<LogicalQueryNode, number>();
  for (const n of nodes)
    for (const s of relationInputs(n))
      incoming.set(s.node, (incoming.get(s.node) ?? 0) + 1);
  // Generic structural benefit cut: a multiply consumed wide output with
  // upstream rank work. No operation, table, report, alias or node-id matches.
  const candidates = plan.sharedRelations.filter(
    (d) =>
      d.materialization === "auto" &&
      (incoming.get(d.node) ?? 0) >= 2 &&
      d.fields.length >= 2 &&
      graph(d.node)?.some((n) => n.kind === "window"),
  );
  const owner = candidates.sort(
    (a, b) =>
      (incoming.get(b.node) ?? 0) * b.fields.length -
      (incoming.get(a.node) ?? 0) * a.fields.length,
  )[0];
  if (!owner) return { eligible: false, reason: "no-repeated-ranked-owner" };
  // The owner itself is eagerly materialized by the private guard/probe. Its
  // complete producer must be total even when an intermediate projection lies
  // after the last upstream window and before every guarded downstream input.
  const ownerBlocker = totalRuntimeGuardProducer(owner.node);
  if (ownerBlocker)
    return {
      eligible: false,
      reason: "partial-owner-producer",
      blocker: ownerBlocker,
    };
  const obligations: RuntimeWindowObligation[] = [];
  for (const w of windows) {
    if (!totalWindow(w) || w.windows.length !== 1)
      return { eligible: false, reason: "unsupported-window", blocker: w };
    const blocker = totalRuntimeGuardProducer(w.input.node);
    if (blocker)
      return { eligible: false, reason: "partial-guard-producer", blocker };
    const spec = w.windows[0]!.specification;
    if (spec.kind !== "row-number")
      return { eligible: false, reason: "unsupported-window", blocker: w };
    const tuple = [
      ...spec.partitionBy,
      ...spec.orderBy.map((k) => k.expression),
    ];
    const indexes = new Set<number>();
    if (!tuple.every((e) => keyColumns(e, w.input, indexes)))
      return { eligible: false, reason: "non-column-window-key", blocker: w };
    const facts = analyzeRelationalKeyFacts(w.input);
    const keys: RuntimeWindowKey[] = [];
    for (const index of [...indexes].sort((a, b) => a - b)) {
      const f = w.input.fields[index]!;
      if (f.affinity === "text") {
        if (facts.fieldCollations[index] !== "BINARY")
          return {
            eligible: false,
            reason: "unproved-key-collation",
            blocker: w,
            index,
          };
        keys.push({ index, storage: "text", collation: "BINARY" });
      } else if (f.affinity === "integer" || f.affinity === "numeric") {
        keys.push({
          index,
          storage:
            constructedRealValues(w.input, index, new Set(), ord).length > 0
              ? "safe-integer-or-constructed"
              : "safe-integer",
          collation: "BINARY",
          constructedRealValues: constructedRealValues(
            w.input,
            index,
            new Set(),
            ord,
          ),
        });
      } else
        return {
          eligible: false,
          reason: "unsupported-key-affinity",
          blocker: w,
          index,
        };
    }
    obligations.push({
      window: w,
      input: w.input,
      tuple,
      keys,
      predecessorWindows: (graph(w.input.node) ?? []).filter(
        (n): n is WindowNode => n.kind === "window",
      ),
    });
  }
  const canonical = new Map<LogicalQueryNode, Set<number>>();
  for (const o of obligations) {
    const indexes = canonical.get(o.input.node) ?? new Set<number>();
    for (const k of o.keys)
      if (k.storage !== "safe-integer-or-constructed") indexes.add(k.index);
    canonical.set(o.input.node, indexes);
  }
  const ownerAggregates = nodes
    .filter(
      (n): n is Extract<LogicalQueryNode, { kind: "aggregate" }> =>
        n.kind === "aggregate",
    )
    .map((n) => deriveOwnerAggregateObligation(n, owner.node))
    .filter((o): o is OwnerAggregateObligation => o !== undefined);
  for (const o of ownerAggregates) {
    const input = canonical.get(o.input.node) ?? new Set<number>();
    for (const index of o.extremaIndexes) input.add(index);
    canonical.set(o.input.node, input);
    canonical.set(o.aggregate, new Set(o.canonicalOutputIndexes));
  }
  const safeField = (source: QuerySource, index: number) =>
    isRuntimeRepresentativeStable(source, index, canonical);
  // Every changed-input consumer is rechecked. Windows are covered by the
  // runtime obligations. Group keys and MIN/MAX representatives need canonical
  // values, not catalog INTEGER affinity. Uniform indicator SUM has no reorder.
  if (additionalChangedInputs.some((n) => !nodes.includes(n)))
    return { eligible: false, reason: "foreign-changed-input" };
  const affected = new Set<LogicalQueryNode>([
    owner.node,
    ...additionalChangedInputs,
  ]);
  for (const n of nodes) {
    if (
      !affected.has(n) &&
      !relationInputs(n).some((s) => affected.has(s.node))
    )
      continue;
    affected.add(n);
    if (n.kind === "window") continue;
    if (
      !locallyTotal(
        n,
        ownerAggregates.find((o) => o.aggregate === n),
      )
    )
      return { eligible: false, reason: "partial-owner-consumer", blocker: n };
    if (n.kind === "union" && !n.all)
      return {
        eligible: false,
        reason: "distinct-union-owner-consumer",
        blocker: n,
      };
    if (
      n.kind === "distinct" &&
      !n.fields.every((_, i) => safeField(n.input, i))
    )
      return {
        eligible: false,
        reason: "unstable-distinct-representative",
        blocker: n,
      };
    if (n.kind === "aggregate") {
      for (const g of n.groups)
        if (
          g.expression.kind !== "column" ||
          g.expression.scope !== n.input.scope ||
          !safeField(n.input, g.expression.index)
        )
          return {
            eligible: false,
            reason: "unstable-group-representative",
            blocker: n,
          };
      for (const a of n.aggregates) {
        const e = a.expression;
        if (uniformUnitSum(e) && n.input.node !== owner.node)
          return {
            eligible: false,
            reason: "unbounded-unit-sum-input",
            blocker: n,
          };
        if (
          e.kind !== "aggregate" ||
          !(
            e.name === "COUNT" ||
            ownerAggregates.some(
              (o) => o.aggregate === n && o.accepted.includes(e),
            ) ||
            uniformUnitSum(e) ||
            ((e.name === "MIN" || e.name === "MAX") &&
              e.expression?.kind === "column" &&
              e.expression.scope === n.input.scope &&
              safeField(n.input, e.expression.index))
          )
        )
          return {
            eligible: false,
            reason: "unstable-aggregate-observer",
            blocker: n,
          };
      }
    }
  }
  const terminalIndexes = new Set<number>();
  if (
    !terminal.keys.every((k) =>
      keyColumns(k.expression, terminal.input, terminalIndexes),
    )
  )
    return {
      eligible: false,
      reason: "non-column-terminal-key",
      blocker: terminal,
    };
  for (const index of terminalIndexes)
    if (!safeField(terminal.input, index))
      return {
        eligible: false,
        reason: "unstable-terminal-key",
        blocker: terminal,
        index,
      };
  // Group/one-per-partition keys are existing relational facts even when
  // choice of representative needs a runtime certificate. The terminal sort
  // must cover such a full BINARY unique key; no runtime report aggregation is
  // evaluated merely to determine ordering.
  if (
    terminal.keys.length === 0 ||
    !hasStableRowNumberOrdering(terminal.input, {
      kind: "row-number",
      partitionBy: [],
      orderBy: terminal.keys as [
        (typeof terminal.keys)[number],
        ...(typeof terminal.keys)[number][],
      ],
    })
  )
    return {
      eligible: false,
      reason: "unproved-terminal-complete-order",
      blocker: terminal,
    };
  return {
    eligible: true,
    certificate: {
      root: plan.root,
      owner,
      windows: obligations,
      terminalSort: terminal,
      terminalPath,
      order: terminal.keys.map((k) => k.expression),
      maximumOwnerRows: MAXIMUM_OWNER_ROWS,
      ownerAggregates,
    },
  };
}

/** Numeric equality does not prove equal observable representatives. This
 * conditional proof accepts numeric storage only where the same-statement
 * window guard supplies a canonical INTEGER constraint; numeric literals and
 * bound numbers alone are insufficient for GROUP/DISTINCT/MIN/MAX observers. */
export function isRuntimeRepresentativeStable(
  s: QuerySource,
  i: number,
  canonical: ReadonlyMap<LogicalQueryNode, ReadonlySet<number>> = new Map(),
  active = new Map<LogicalQueryNode, Set<number>>(),
): boolean {
  if (
    s.scope !== s.node.scope ||
    !Number.isInteger(i) ||
    i < 0 ||
    i >= s.fields.length ||
    s.fields.length !== s.node.fields.length ||
    s.fields.some((f, j) => {
      const actual = s.node.fields[j]!;
      return (
        f.name !== actual.name ||
        f.affinity !== actual.affinity ||
        f.nullable !== actual.nullable
      );
    })
  )
    return false;
  const safeField = (input: QuerySource, index: number, nested = active) =>
    isRuntimeRepresentativeStable(input, index, canonical, nested);
  if (canonical.get(s.node)?.has(i)) return true;
  const indexes = active.get(s.node) ?? new Set<number>();
  if (indexes.has(i)) return false;
  indexes.add(i);
  active.set(s.node, indexes);
  const n = s.node;
  let valid = false;
  const scalar = (e: SqlExpression, input: QuerySource): boolean => {
    if (e.kind === "column" && e.scope === input.scope)
      return safeField(input, e.index, active);
    // Numeric literals and bindings are not one representation family:
    // SQLite literals may be INTEGER while the runtime binds numbers as REAL.
    // Only the explicit runtime-canonical input map licenses numeric
    // representatives; a numeric value alone cannot cross MIN/GROUP/DISTINCT.
    if (e.kind === "constant" || e.kind === "parameter")
      return e.value === null || typeof e.value === "string";
    if (e.kind === "null-check") return true;
    return false;
  };
  const domain = semiMembershipComparisonDomain(s, i);
  if (
    domain.kind === "proven" &&
    domain.domain.storageClasses.every(isTextComparisonStorageClass) &&
    semiMembershipBinaryCollation(s, i).kind === "binary"
  )
    valid = true;
  else
    switch (n.kind) {
      case "project":
        valid = scalar(n.projections[i]!.expression, n.input);
        break;
      case "filter":
      case "distinct":
      case "sort":
      case "limit":
        valid = safeField(n.input, i, active);
        break;
      case "window":
        valid = i >= n.input.fields.length || safeField(n.input, i, active);
        break;
      case "semi-join":
      case "anti-join":
        valid = safeField(n.left, i, active);
        break;
      case "join":
        valid =
          i < n.left.fields.length
            ? safeField(n.left, i, active)
            : safeField(n.right, i - n.left.fields.length, active);
        break;
      case "union":
        valid = safeField(n.left, i, active) && safeField(n.right, i, active);
        break;
      case "aggregate": {
        if (i < n.groups.length)
          valid = scalar(n.groups[i]!.expression, n.input);
        else {
          const e = n.aggregates[i - n.groups.length]!.expression;
          valid =
            e.kind === "aggregate" &&
            (e.name === "COUNT" ||
              ((e.name === "MIN" || e.name === "MAX") &&
                !!e.expression &&
                scalar(e.expression, n.input)) ||
              uniformUnitSum(e));
        }
        break;
      }
      default:
        valid = false;
    }
  indexes.delete(i);
  return valid;
}

function uniformUnitSum(e: SqlExpression): boolean {
  if (e.kind !== "aggregate" || e.name !== "SUM" || e.distinct || !e.expression)
    return false;
  const kinds = new Set<string>();
  const values = (v: SqlExpression): boolean => {
    if (v.kind === "parameter" || v.kind === "constant") {
      kinds.add(v.kind);
      return v.value === 0 || v.value === 1;
    }
    return (
      v.kind === "case" &&
      v.branches.length > 0 &&
      v.branches.every((b) => values(b.then)) &&
      v.else !== undefined &&
      values(v.else)
    );
  };
  return values(e.expression) && kinds.size === 1;
}

function locallyTotal(
  n: LogicalQueryNode,
  obligation?: OwnerAggregateObligation,
): boolean {
  if (n.kind !== "aggregate") return isConditionalGuardNodeTotal(n);
  const scopes = new Map([[n.input.scope, n.input.fields.length]]);
  return (
    n.groups.every((g) =>
      isMaterializationSafeExpression(g.expression, scopes),
    ) &&
    n.aggregates.every(
      (a) =>
        isMaterializationSafeAggregateExpression(a.expression, n.input) ||
        (obligation?.accepted.includes(a.expression) === true &&
          a.expression.kind === "aggregate" &&
          !!a.expression.expression &&
          isMaterializationSafeExpression(a.expression.expression, scopes)) ||
        (uniformUnitSum(a.expression) &&
          a.expression.kind === "aggregate" &&
          !!a.expression.expression &&
          isMaterializationSafeExpression(a.expression.expression, scopes)),
    )
  );
}

/** Only explicit numeric parameter/constant alternatives license REAL singleton
 * values. A raw catalog INTEGER field contributes no such permission. */
function constructedRealValues(
  s: QuerySource,
  index: number,
  active: Set<string>,
  ord: Map<LogicalQueryNode, number>,
): number[] {
  const key = `${ord.get(s.node)}:${index}`;
  if (active.has(key)) return [];
  active.add(key);
  const from = (e: SqlExpression, input: QuerySource): number[] => {
    if (
      (e.kind === "parameter" || e.kind === "constant") &&
      typeof e.value === "number" &&
      Number.isSafeInteger(e.value)
    )
      return [e.value];
    if (e.kind === "column" && e.scope === input.scope)
      return constructedRealValues(input, e.index, active, ord);
    if (e.kind === "case")
      return [
        ...e.branches.flatMap((b) => from(b.then, input)),
        ...(e.else ? from(e.else, input) : []),
      ];
    return [];
  };
  const n = s.node;
  let values: number[] = [];
  switch (n.kind) {
    case "project":
      values = from(n.projections[index]!.expression, n.input);
      break;
    case "filter":
    case "distinct":
      values = constructedRealValues(n.input, index, active, ord);
      break;
    case "window":
      if (index < n.input.fields.length)
        values = constructedRealValues(n.input, index, active, ord);
      break;
    case "semi-join":
    case "anti-join":
      values = constructedRealValues(n.left, index, active, ord);
      break;
    case "join":
      values =
        index < n.left.fields.length
          ? constructedRealValues(n.left, index, active, ord)
          : constructedRealValues(
              n.right,
              index - n.left.fields.length,
              active,
              ord,
            );
      break;
    case "union":
      values = [
        ...constructedRealValues(n.left, index, active, ord),
        ...constructedRealValues(n.right, index, active, ord),
      ];
      break;
  }
  active.delete(key);
  return [...new Set(values)].sort((a, b) => a - b);
}
