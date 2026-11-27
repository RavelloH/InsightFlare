import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyTurnstile } from "./turnstile-client";

type Options = Parameters<NonNullable<Window["turnstile"]>["render"]>[1];

let callbacks: Options[];
let api: NonNullable<Window["turnstile"]>;
let container: HTMLDivElement;
const signal = () => new AbortController().signal;

beforeEach(() => {
  callbacks = [];
  container = document.createElement("div");
  api = {
    render: vi.fn((_container, options) => {
      callbacks.push(options);
      return String(callbacks.length);
    }),
    execute: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;
});

afterEach(() => {
  delete window.turnstile;
  document.getElementById("cloudflare-turnstile-script")?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Turnstile verification lifecycle", () => {
  it("uses a fresh widget and callback for every attempt", async () => {
    const first = verifyTurnstile(container, "key", signal());
    await Promise.resolve();
    callbacks[0].callback("first");
    await expect(first).resolves.toBe("first");
    expect(api.remove).toHaveBeenCalledWith("1");
    const second = verifyTurnstile(container, "key", signal());
    await Promise.resolve();
    callbacks[0].callback("stale");
    callbacks[1].callback("second");
    await expect(second).resolves.toBe("second");
    expect(api.execute).toHaveBeenCalledWith("2");
    expect(api.remove).toHaveBeenCalledWith("2");
    expect(callbacks[1].execution).toBe("execute");
  });

  it.each(["error-callback", "expired-callback", "timeout-callback"] as const)(
    "rejects and cleans up on %s",
    async (event) => {
      const result = verifyTurnstile(container, "key", signal());
      const rejected = expect(result).rejects.toThrow(
        "turnstile_verification_failed",
      );
      await Promise.resolve();
      callbacks[0][event]();
      await rejected;
      expect(api.remove).toHaveBeenCalledWith("1");
    },
  );

  it("cancels a widget on unmount", async () => {
    const controller = new AbortController();
    const result = verifyTurnstile(container, "key", controller.signal);
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(api.remove).toHaveBeenCalledWith("1");
  });

  it("times out if no callback arrives", async () => {
    vi.useFakeTimers();
    const result = verifyTurnstile(container, "key", signal());
    const rejected = expect(result).rejects.toThrow(
      "turnstile_verification_failed",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(api.remove).toHaveBeenCalledWith("1");
  });

  it("can retry after the script fails to load", async () => {
    delete window.turnstile;
    // Keep the real DOM node, but simulate loading ourselves: happy-dom
    // deliberately rejects all external JavaScript requests.
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
      if (node instanceof HTMLScriptElement) node.type = "application/x-test";
      return append(node);
    });
    const first = verifyTurnstile(container, "key", signal());
    const rejected = expect(first).rejects.toThrow("turnstile_load_failed");
    const script = document.getElementById("cloudflare-turnstile-script")!;
    script.dispatchEvent(new Event("error"));
    await rejected;
    expect(script.isConnected).toBe(false);

    const second = verifyTurnstile(container, "key", signal());
    const retry = document.getElementById("cloudflare-turnstile-script")!;
    expect(retry).not.toBe(script);
    window.turnstile = api;
    retry.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    callbacks[0].callback("fresh");
    await expect(second).resolves.toBe("fresh");
  });
});
