import type { SqlExpression } from "@/lib/db/query/expression";
import type { PhysicalNativeNullOrderingChoice } from "@/lib/db/query/physical/contracts";
import type { WindowOrderKey } from "@/lib/db/query/plan";
import type { SqlFragment } from "@/lib/db/sql/fragment";
import { text } from "@/lib/db/sql/fragment";

import type { FinalRenderSession } from "./final-render-session";
import { concat, join, recordFinalRenderEmission } from "./fragment-provenance";

export function renderNativeOrderKey(input: {
  readonly value: SqlFragment;
  readonly direction: "ASC" | "DESC";
  readonly nullPlacement: "FIRST" | "LAST";
}): SqlFragment {
  return concat(
    input.value,
    text(` ${input.direction} NULLS ${input.nullPlacement}`),
  );
}

export function renderWindowOrderBy(input: {
  readonly keys: readonly WindowOrderKey[];
  readonly windowIndex: number;
  readonly choices: readonly PhysicalNativeNullOrderingChoice[];
  readonly renderExpression: (expression: SqlExpression) => SqlFragment;
  readonly session?: FinalRenderSession;
}): SqlFragment {
  const choices = new Map(
    input.choices
      .filter((choice) => choice.windowIndex === input.windowIndex)
      .map((choice) => [choice.pairIndex, choice] as const),
  );
  const keys: SqlFragment[] = [];
  for (let index = 0; index < input.keys.length; index += 1) {
    const key = input.keys[index]!;
    const choice = choices.get(index);
    if (!choice) {
      keys.push(
        concat(
          input.renderExpression(key.expression),
          text(` ${key.direction}`),
        ),
      );
      continue;
    }
    const valueKey = input.keys[index + 1];
    if (
      key !== choice.guardKey ||
      valueKey !== choice.valueKey ||
      key.expression.kind !== "null-check" ||
      key.expression.expression.kind !== "column" ||
      valueKey?.expression.kind !== "column"
    )
      throw new TypeError("native_null_ordering_choice_did_not_match_window");
    const rendered = renderNativeOrderKey({
      value: input.renderExpression(valueKey.expression),
      direction: choice.valueDirection,
      nullPlacement: choice.nullPlacement,
    });
    keys.push(
      recordFinalRenderEmission(input.session, rendered, {
        kind: "native-null-ordering",
        choice,
      }),
    );
    index += 1;
  }
  return join(keys);
}
