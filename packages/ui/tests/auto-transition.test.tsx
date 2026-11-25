import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { AutoTransition } from "../src/components/ui/auto-transition";

it("honors initial=false on SSR without hiding initial content", () => {
  expect(
    renderToStaticMarkup(
      <AutoTransition initial={false}>Visible</AutoTransition>,
    ),
  ).toContain("opacity:1");
  expect(
    renderToStaticMarkup(<AutoTransition initial>Entering</AutoTransition>),
  ).toContain("opacity:0");
});

it("does not remount unchanged children when the initial animation is disabled", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AutoTransition initial={false} transitionKey="stable">
          <span>First</span>
        </AutoTransition>,
      ),
    );
    const element = container.querySelector("span");
    expect(element).not.toBeNull();
    await act(async () =>
      root.render(
        <AutoTransition initial={false} transitionKey="stable">
          <span>Second</span>
        </AutoTransition>,
      ),
    );
    expect(container.querySelector("span")).toBe(element);
    expect(container.textContent).toBe("Second");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
