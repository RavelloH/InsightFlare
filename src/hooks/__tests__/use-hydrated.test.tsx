import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { useHydrated } from "@/hooks/use-hydrated";

function Probe() {
  return <span>{useHydrated() ? "hydrated" : "server"}</span>;
}

describe("useHydrated", () => {
  it("renders the server snapshot initially, then enables client updates without a hydration mismatch", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<Probe />);
    expect(container.textContent).toBe("server");
    const recoverable = vi.fn();
    let root: Root | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, <Probe />, {
          onRecoverableError: recoverable,
        });
      });
      expect(container.textContent).toBe("hydrated");
      expect(recoverable).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
    }
  });
});
