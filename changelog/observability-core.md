# Observability Core (feature/observability-core)

Implementation handoff for the minimal Invocation observation contract, based on
Recalloom `/Projects/InsightFlare/Plans/Observability-Core/`. This document
is a code-level integration guide, not a new product design.

## Public API and ownership

- `src/lib/edge/observability/logger.ts`: existing `InvocationLogger`,
  `createInvocationLogger`, `currentInvocationLogger`,
  `onComplete`, `snapshot`, `recordSqlSemanticObservation`.
- `src/lib/edge/observability/snapshot.ts`: `InvocationSnapshot`,
  `InvocationSqlCost`, `ObservedMetric` and safe allowlisted projection.
- `src/lib/edge/observability/semantic.ts`:
  `SqlSemanticObservationInput`, canonical-pointer validation,
  per-invocation deduplication. This is **not** an index registry.
- `src/lib/edge/observability/bindings.ts`: D1 binding-level metadata
  instrumentation. It never derives event semantics from SQL text or binds.

The Filter-SQL worktree owns its DSL, query translation, SQL qualification,
CTEs and Query execution. The Perception-Search worktree owns browser-side
search. Neither should change these observability files. Integrate with this
API **only after this branch is reviewed and merged into main**.

## Cost and completion consumers

```ts
import { currentInvocationLogger } from "@/lib/edge/observability/logger";

const logger = currentInvocationLogger();
const unsubscribe = logger?.onComplete((snapshot) => {
  const { rowsRead, cumulativeSqlDurationMs } = snapshot.sql;
  // rowsRead.coverage: "complete" | "partial" | "unavailable"
  // rowsRead.value is omitted entirely when unavailable.
  // cumulativeSqlDurationMs is summed engine time, not handler waiting time.
  if (rowsRead.coverage === "unavailable") return;
  // Optional, bounded, read-only handling; no D1 calls on normal requests.
});
// unsubscribe() removes only this invocation's listener while still open.
```

The snapshot is a deeply frozen, **allowlisted** record with coarse
`routeGroup`, safe HTTP method/status/outcome and aggregated metrics.
`snapshot()` does not include raw URL or path, SQL text, bind values,
trace ID, visitor identity, request payload, email, IP or raw log events.
Existing structured Workers Logs still contain their historical data and
are not replaced or broadened by the safe projection.

A consumer must not assume that one SQL statement or one `rows_read` sum
is attributable to a particular filter. A cache HIT is a separate observation,
**not evidence of better SQL**. Concurrent SQL durations can overlap; only a
single explicit Handler span is reported as `handlerDurationMs`.
`invocationDurationMs` can include background activity and should not
automatically be interpreted as request latency. A WebSocket connection's
`webSocketConnectionDurationMs` is never a handler duration.

`onComplete` fires once per Invocation when `emit()` is called. If the
entry uses `emitWhenComplete()`, tracked business work is awaited first,
then emission happens once. Consumers run separately and asynchronously,
outside the invocation's `AsyncLocalStorage` context; one rejection cannot
block others or alter the response/alarm failure. After emit, the logger
ignores further metrics and subscriptions to prevent recursion. Use
`createInvocationLogger({ waitUntil: (promise) => ctx.waitUntil(promise) })`
for optional lifetime extension. `waitUntil` is best effort, not a durable
queue or exactly-once delivery guarantee. There is no global event bus and
no consumer is auto-enabled.

## Optional Smart Index / SQL candidate producer

The SQL **calling site**, not the D1 binding proxy, validates the actual
executed indexable predicate and provides a structured candidate after the
execution has settled:

```ts
// Example after awaiting an actually executed, indexable scalar query.
logger?.recordSqlSemanticObservation({
  sitePk: verifiedSitePk,
  eventNameId: verifiedEventNameId,
  jsonPointer: "/checkout/amount",
  valueType: "number",
  indexKind: "range",
  execution: "succeeded",
});

// Only explicitly opted-in, trusted internal consumers receive this field.
logger?.onComplete(
  (snapshot) => {
    for (const hint of snapshot.sqlObservations ?? []) {
      // One request demand, N executions for a repeated candidate.
      // The associated snapshot.sql cost is invocation-wide.
      // A future consumer owns gating, per-candidate attribution and writes.
    }
  },
  { includeSqlSemantics: true },
);
```

Input is runtime-validated and bounded to 32 distinct candidates per
invocation, deduplicated by (sitePk, eventNameId, canonical JSON Pointer,
valueType, indexKind). Only static conservative RFC 6901 paths are permitted.
Do not pass raw event names, SQL, parameters, visitor/session IDs or arbitrary
user values. The interface refuses candidates until a D1 statement has
settled, refuses a cache HIT, and distinguishes failed from successful
execution. **Binding-level completion does not prove a specific predicate
was part of a specific statement**: this remains the trusted calling site's
responsibility. Do not report projection-only/grouping/missing-value,
array-wildcard, NOT or non-indexable predicates as candidates. No automatic
`EXPLAIN` or DDL occurs.

Normal consumers and default `logger.snapshot()` never receive candidate
metadata; the opt-in is an internal API convention, not an independent
authorization boundary for code already holding a trusted logger.
The future indexing consumer must own Registry D1 I/O, throttling, sampling,
DDL, exact plan attribution and any persistent records. It is intentionally
absent from this branch.

## Observed entry coverage

| Entry | Completion semantics | Local test evidence / boundary |
| --- | --- | --- |
| Worker Hono HTTP | One request logger, `route.handler`, `emitWhenComplete`, `executionCtx.waitUntil` | `src/__tests__/middleware.test.ts`, `observability-completion.test.ts`; no live CF ingress test |
| TanStack Start page/server function | One outer logger, one handler span; completion handed to `waitUntil` | Typechecked + code-path review, `observability-completion.test.ts`; no full production CF test |
| DO fetch/RPC | Per-fetch logger, `do.fetch.handler`, completion at fetch exit | `durable-object.test.ts` |
| DO alarm | Per-alarm logger, logs in finally, original maintenance error still rethrown | `durable-object-alarm-recovery.test.ts`; observer failure does not affect retry |
| Worker scheduled | `trigger: "scheduled"` (was historically `"alarm"`), one record after concurrent work/skip | `scheduled-tasks/{runner,dispatcher}.test.ts`, completion race tests; no live scheduler test |
| DO WebSocket upgrade | Fetch invocation returns HTTP 101, without waiting for lifetime | `durable-object.test.ts` |
| DO WebSocket close/error | Separate `trigger: "websocket"` / WEBSOCKET record; connection duration separately | `durable-object.test.ts`; message callback intentionally no-op, not an observed Invocation |

Observability additions do **zero extra normal-request D1 operations** by
default. No D1 migration, KV/R2/DO allocation, registry write, issue storage,
diagnostic UI, automated telemetry or Cloudflare remote operation is required.

## Validation

```powershell
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm run build:packages
pnpm run build:tracker-sdk
pnpm exec tsc --noEmit -p tsconfig.json --pretty false
pnpm exec vitest run src/lib/edge/__tests__/observability-logger.test.ts src/lib/edge/__tests__/observability-core.test.ts src/lib/edge/__tests__/observability-completion.test.ts src/lib/edge/__tests__/observability-semantic.test.ts src/lib/edge/__tests__/observability-consumers.test.ts --environment node
pnpm exec vitest run src/lib/edge/ingest/__tests__/durable-object.test.ts src/lib/edge/ingest/__tests__/durable-object-alarm-recovery.test.ts src/lib/edge/scheduled-tasks/__tests__/runner.test.ts src/lib/edge/scheduled-tasks/__tests__/dispatcher.test.ts src/__tests__/middleware.test.ts --environment node
```

The existing Vitest default `happy-dom` environment externalizes
`node:async_hooks` when importing the server logger on this Windows
setup. Run backend/observability tests with `--environment node`, while
browser-specific component tests retain their normal happy-dom environment.
This is a test-environment concern, not a runtime architecture change.

No changes may be pushed, merged, deployed or production-tested without
the user's explicit review and authorization.

## Local final validation notes (Windows, 2026-11-19)

- O4 focused: 10 suites / **126 tests passed**; TypeScript, ESLint,
  architecture and layer checks passed (architecture reports existing size
  warnings and three documented legacy exceptions).
- Broader Node server/API/edge/Hono suite: **2,185 passed, 3 failed** in
  233 suites. The failing assertions are two existing Hono internal-error
  message expectations (the source returns `An internal error occurred` while
  tests expect other text) and `docs/skills.json` generated JSON CRLF vs LF
  on Windows. These paths were not changed by Observability Core. Excluding
  these two unrelated files: **231 suites / 2,152 tests passed**.
- Entire repository Vitest with default happy-dom: **2,941 passed, 170
  failed, 155 suites failed to complete**. Most failing suites import Node
  built-ins in a browser test environment; some component tests report
  `act is not a function`. This aggregate is **not** a green full-suite
  result and must not be reported as such.
- `pnpm run build:cf` correctly refused to run in a local environment.
  `pnpm run build:local` stopped before bundling because the checked-in
  generated `docs/skills.json` is stale. The component/package and tracker SDK
  builds completed, and full `tsc --noEmit` completed successfully. No
  unrelated generated document was regenerated or committed.

The observations above limit release confidence; production Worker and
Cloudflare-specific runtime verification remain for the user's review path.
