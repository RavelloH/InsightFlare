import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAdvancedFilterCondition,
  createDefaultFilterTarget,
} from "@/components/dashboard/filters/filter-editor/advanced-editor-model";
import { ADVANCED_FILTER_TARGET_KINDS } from "@/components/dashboard/filters/filter-editor/model";
import {
  changeReducerKind,
  FilterTargetExpressionEditor,
} from "@/components/dashboard/filters/filter-editor/target-expression-editor";
import {
  analyticsFilterRegistry,
  type FilterTargetExpression,
  inferFilterTargetType,
  parseFilterDsl,
} from "@/lib/filter-contract";
import { getMessages } from "@/lib/i18n/messages";

const messages = getMessages("en");
let host: HTMLDivElement;
let root: Root;

function Editor({
  initial,
  onUpdate,
}: {
  initial: FilterTargetExpression;
  onUpdate?: (target: FilterTargetExpression) => void;
}) {
  const [target, setTarget] = useState(initial);
  return (
    <FilterTargetExpressionEditor
      target={target}
      audience="private-dashboard"
      messages={messages}
      renderPredicate={(predicate, change) => (
        <button
          type="button"
          aria-label="Edit nested predicate"
          onClick={() =>
            change({
              kind: "not",
              child: predicate,
            })
          }
        >
          {predicate.kind}
        </button>
      )}
      onChange={(next) => {
        setTarget(next);
        onUpdate?.(next);
      }}
    />
  );
}
async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function mount(
  target: FilterTargetExpression,
  onUpdate?: (target: FilterTargetExpression) => void,
) {
  await act(async () => {
    root.render(
      <LayerManagerProvider>
        <Editor initial={target} onUpdate={onUpdate} />
      </LayerManagerProvider>,
    );
  });
}

describe("recursive visual filter targets", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("constructs a valid numeric projection when converting a collection count to sum", () => {
    const count = createDefaultFilterTarget("reducer", "private-dashboard");
    if (count.kind !== "reducer") throw Error("missing reducer");
    const sum = changeReducerKind(count, "sum");
    expect(sum.input.kind).toBe("projection");
    if (sum.input.kind === "projection") {
      expect(sum.input.member).toBe("payload");
      expect(sum.input.path).toBe("/amount");
    }
    expect(inferFilterTargetType(sum, analyticsFilterRegistry)).toEqual({
      kind: "scalar",
      scalar: "number",
    });
  });

  it("renders an editable component for every advanced target constructor", async () => {
    for (const kind of ADVANCED_FILTER_TARGET_KINDS) {
      const initial = createAdvancedFilterCondition(
        kind,
        "private-dashboard",
      ).target;
      await mount(initial);
      expect(
        host.querySelectorAll("button, input").length,
        kind,
      ).toBeGreaterThan(0);
    }
  });

  it("adds, reorders, and removes sequence steps without losing the expression", async () => {
    const parsed = parseFilterDsl(
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
      analyticsFilterRegistry,
    );
    if (!parsed.root || parsed.root.kind !== "condition")
      throw Error("missing sequence");
    let current = parsed.root.target;
    await mount(current, (next) => {
      current = next;
    });
    expect(host.querySelectorAll('[aria-label="Move step up"]')).toHaveLength(
      2,
    );
    const add = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(
        messages.filterBuilder.advancedEditor.addStep,
      ),
    );
    expect(add).toBeDefined();
    await act(async () => {
      add!.click();
    });
    expect(current.kind).toBe("sequence");
    if (current.kind !== "sequence") return;
    expect(current.steps).toHaveLength(3);
    const moveUp = host.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Move step up"]',
    )[2];
    await act(async () => {
      moveUp!.click();
    });
    expect(current.steps).toHaveLength(3);
    const remove = host.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Remove step"]',
    )[2];
    await act(async () => {
      remove!.click();
    });
    expect(current.steps).toHaveLength(2);
  });

  it("provides editable nested predicates and payload paths in a numeric aggregate", async () => {
    const parsed = parseFilterDsl(
      'sum(EVENT { $.name eq "purchase" } -> payload("/amount")) gt 1000',
      analyticsFilterRegistry,
    );
    if (!parsed.root || parsed.root.kind !== "condition")
      throw Error("missing aggregate");
    let current = parsed.root.target;
    await mount(current, (next) => {
      current = next;
    });
    expect(
      host.querySelector('[aria-label="Edit nested predicate"]'),
    ).not.toBeNull();
    const pointer = host.querySelector<HTMLInputElement>(
      '[aria-label="' +
        messages.filterBuilder.advancedEditor.jsonPointer +
        '"]',
    );
    expect(pointer?.value).toBe("/amount");
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Edit nested predicate"]',
        )!
        .click();
    });
    expect(current.kind).toBe("reducer");
    if (current.kind !== "reducer" || current.input.kind !== "projection")
      return;
    expect(current.input.collection.kind).toBe("selector");
    if (current.input.collection.kind === "selector")
      expect(current.input.collection.predicate.kind).toBe("not");
  });

  it("shows independent window anchor, collection, and range controls", async () => {
    const parsed = parseFilterDsl(
      "window(EVENT, @range.start, [-1d, 7d]) exists",
      analyticsFilterRegistry,
    );
    if (!parsed.root || parsed.root.kind !== "condition")
      throw Error("missing window");
    let current = parsed.root.target;
    await mount(current, (next) => {
      current = next;
    });
    expect(
      host.querySelectorAll('input[type="number"]').length,
    ).toBeGreaterThanOrEqual(2);
    const startOffset = Array.from(
      host.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ).find((input) => input.value === "-1");
    expect(startOffset).toBeDefined();
    await changeInput(startOffset!, "-3");
    expect(current.kind).toBe("window");
    if (current.kind === "window") expect(current.startOffset.amount).toBe(-3);
    expect(host.textContent).toContain("EVENT");
  });
});
