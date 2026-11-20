import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FilterEditor } from "@/components/dashboard/filters/filter-editor";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { getMessages } from "@/lib/i18n/messages";

vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

const messages = getMessages("en");
let host: HTMLDivElement;
let root: Root;

async function mount(source: string, onApply = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LayerManagerProvider>
          <FilterEditor
            initialFilterDsl={source}
            audience="private-dashboard"
            messages={messages}
            applyLabel={messages.filterBuilder.apply}
            onApply={onApply}
          />
        </LayerManagerProvider>
      </QueryClientProvider>,
    );
  });
  return onApply;
}
async function apply() {
  const button = Array.from(host.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === messages.filterBuilder.apply,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

describe("FilterEditor advanced visual integration", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("round-trips an aggregate with a nested selector from the visual editor", async () => {
    const source =
      'sum(EVENT { $.name eq "purchase" } -> payload("/amount")) gt 1000';
    const onApply = await mount(source);
    expect(host.querySelectorAll("select, button").length).toBeGreaterThan(0);
    expect(host.querySelector('input[value="/amount"]')).not.toBeNull();
    await apply();
    expect(onApply).toHaveBeenCalledTimes(1);
    const output = onApply.mock.calls[0]![0] as string;
    expect(parseFilterDsl(output, analyticsFilterRegistry)).toEqual(
      parseFilterDsl(source, analyticsFilterRegistry),
    );
  });

  it("places a comparison operator beside its numeric value and uses field-value type labels", async () => {
    const source = "add(page.durationMs, page.durationMs) gte 1";
    const onApply = await mount(source);
    const operator = host.querySelector<HTMLButtonElement>(
      `[aria-label="${messages.filterBuilder.match}"]`,
    );
    const row = operator?.parentElement?.parentElement;
    expect(row?.classList.contains("grid-cols-2")).toBe(true);
    expect(row?.querySelector('input[value="1"]')).not.toBeNull();

    const selected = Array.from(host.querySelectorAll('[role="combobox"]')).map(
      (element) => element.textContent?.trim(),
    );
    const fieldKind = messages.filterBuilder.advancedEditor.targetKinds.field;
    const selectedField = messages.filterBuilder.fieldLabels["page.durationMs"];
    expect(
      selected.filter((label) => label === fieldKind).length,
    ).toBeGreaterThan(0);
    expect(selected.filter((label) => label === fieldKind).length).toBe(
      selected.filter((label) => label === selectedField).length,
    );
    expect(selected).not.toContain("page.durationMs");

    await apply();
    expect(
      parseFilterDsl(
        onApply.mock.calls[0]![0] as string,
        analyticsFilterRegistry,
      ),
    ).toEqual(parseFilterDsl(source, analyticsFilterRegistry));
  });

  it("distinguishes recursive expression kinds from their selected reducer and entity", async () => {
    const source = "add(first(PAGE).durationMs, page.durationMs) gte 1";
    const onApply = await mount(source);
    const selected = Array.from(host.querySelectorAll('[role="combobox"]')).map(
      (element) => element.textContent?.trim(),
    );
    const reducerKind =
      messages.filterBuilder.advancedEditor.targetKinds.reducer;
    const entityKind =
      messages.filterBuilder.advancedEditor.targetKinds["entity-root"];
    expect(
      selected.filter((label) => label === "first(...)").length,
    ).toBeGreaterThan(0);
    expect(selected.filter((label) => label === "first(...)").length).toBe(
      selected.filter((label) => label === reducerKind).length,
    );
    expect(selected.filter((label) => label === "PAGE").length).toBe(
      selected.filter((label) => label === entityKind).length,
    );
    expect(selected).toContain(
      messages.filterBuilder.advancedEditor.targetKinds.reducer,
    );
    expect(selected).toContain(
      messages.filterBuilder.advancedEditor.targetKinds["entity-root"],
    );
    await apply();
    expect(
      parseFilterDsl(
        onApply.mock.calls[0]![0] as string,
        analyticsFilterRegistry,
      ),
    ).toEqual(parseFilterDsl(source, analyticsFilterRegistry));
  });

  it("removes the selector when its last nested condition is deleted", async () => {
    const source =
      'sum(EVENT { $.name eq "purchase" } -> payload("/amount")) gt 1000';
    const onApply = await mount(source);
    const remove = host.querySelector<HTMLButtonElement>(
      '[aria-label="' +
        messages.teamManagement.notifications.removeCondition +
        '"]',
    );
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    await apply();
    expect(onApply).toHaveBeenCalledTimes(1);
    const output = parseFilterDsl(
      onApply.mock.calls[0]![0],
      analyticsFilterRegistry,
    );
    if (
      output.root?.kind !== "condition" ||
      output.root.target.kind !== "reducer"
    )
      throw new Error("Lost aggregate");
    const input = output.root.target.input;
    if (input.kind !== "projection") throw new Error("Lost projection");
    expect(input.collection.kind).toBe("entity-root");
  });

  it("preserves stacked NOT nodes when toggling the exclusion checkbox", async () => {
    const onApply = await mount('NOT NOT page.path eq "/docs"');
    const checkbox = host.querySelector<HTMLElement>('[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox!.click());
    await apply();
    expect(onApply).toHaveBeenCalledTimes(1);
    const output = onApply.mock.calls[0]![0] as string;
    expect(output).toContain('NOT NOT NOT page.path eq "/docs"');
  });

  it("edits the occurrence selector through the recursive builder without altering its predicate", async () => {
    const source = 'time(nth(EVENT { $.name eq "signup" }, 3)) gte @now-30d';
    const onApply = await mount(source);
    const indexInput = host.querySelector<HTMLInputElement>(
      '[aria-label="' +
        messages.filterBuilder.advancedEditor.occurrenceIndex +
        '"]',
    );
    expect(indexInput?.value).toBe("3");
    expect(
      host.querySelectorAll('input[type="number"]').length,
    ).toBeGreaterThanOrEqual(1);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(indexInput, "2");
      indexInput?.dispatchEvent(new Event("input", { bubbles: true }));
      indexInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await apply();
    expect(onApply).toHaveBeenCalledTimes(1);
    const result = parseFilterDsl(
      onApply.mock.calls[0]![0],
      analyticsFilterRegistry,
    );
    if (
      result.root?.kind !== "condition" ||
      result.root.target.kind !== "occurrence-time"
    )
      throw new Error("Unexpected occurrence expression");
    const occurrence = result.root.target.input;
    if (occurrence.kind !== "reducer" || occurrence.input.kind !== "selector")
      throw new Error("Lost nested event selector");
    expect(occurrence.index).toBe(2);
    expect(occurrence.input.predicate).toEqual({
      kind: "condition",
      target: {
        kind: "member",
        object: { kind: "context-root", context: "current" },
        member: "name",
      },
      operator: "eq",
      value: "signup",
    });
  });

  it("retains a nested sequence predicate and condition after applying", async () => {
    const source =
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $gap(1, 2) lte 7d } exists';
    const onApply = await mount(source);
    expect(
      host.querySelectorAll('[aria-label="Move step up"]').length,
    ).toBeGreaterThanOrEqual(2);
    await apply();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(
      parseFilterDsl(onApply.mock.calls[0]![0], analyticsFilterRegistry),
    ).toEqual(parseFilterDsl(source, analyticsFilterRegistry));
  });
});
