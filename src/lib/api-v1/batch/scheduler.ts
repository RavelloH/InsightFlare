export interface BatchWorkItem<T> {
  readonly id: string;
  readonly weight: number;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

export {
  calculateQueryCost,
  defaultQueryCostPolicy,
} from "@/lib/edge/analytics/application/cost";

export type BatchItemResult<T> =
  | { readonly id: string; readonly ok: true; readonly value: T }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error:
        | "budget_exceeded"
        | "deadline_exceeded"
        | "request_cancelled"
        | "payload_too_large"
        | "internal_error";
    };

export interface BoundedBatchOptions {
  readonly maxConcurrency: number;
  readonly maxWeight: number;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly now?: () => number;
}

function stopped(
  options: BoundedBatchOptions,
): "deadline_exceeded" | "request_cancelled" | null {
  if (options.signal?.aborted) return "request_cancelled";
  if (
    typeof options.deadlineMs === "number" &&
    (options.now?.() ?? Date.now()) >= options.deadlineMs
  ) {
    return "deadline_exceeded";
  }
  return null;
}

/**
 * Executes direct operation closures in input order. Work is limited by both
 * concurrency and weighted request cost; a failure remains local to its item.
 */
export async function executeBoundedBatch<T>(
  work: readonly BatchWorkItem<T>[],
  options: BoundedBatchOptions,
): Promise<readonly BatchItemResult<T>[]> {
  const results: BatchItemResult<T>[] = new Array(work.length);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const deadlineTimer =
    typeof options.deadlineMs === "number"
      ? setTimeout(
          () => controller.abort(),
          Math.max(0, options.deadlineMs - (options.now?.() ?? Date.now())),
        )
      : undefined;
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    let next = 0;
    let consumed = 0;
    const worker = async () => {
      while (true) {
        const index = next;
        next += 1;
        const item = work[index];
        if (!item) return;
        const terminal = stopped(options);
        if (terminal) {
          results[index] = { id: item.id, ok: false, error: terminal };
          continue;
        }
        if (
          !Number.isSafeInteger(item.weight) ||
          item.weight < 1 ||
          consumed + item.weight > options.maxWeight
        ) {
          results[index] = { id: item.id, ok: false, error: "budget_exceeded" };
          continue;
        }
        consumed += item.weight;
        try {
          const value = await item.run(controller.signal);
          const after = stopped(options);
          results[index] = after
            ? { id: item.id, ok: false, error: after }
            : { id: item.id, ok: true, value };
        } catch (error) {
          const terminal = stopped(options);
          results[index] = {
            id: item.id,
            ok: false,
            error:
              terminal ??
              (error instanceof Error && error.message === "payload_too_large"
                ? "payload_too_large"
                : controller.signal.aborted || options.signal?.aborted
                  ? "request_cancelled"
                  : "internal_error"),
          };
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, options.maxConcurrency), work.length) },
        () => worker(),
      ),
    );
    return results;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}
