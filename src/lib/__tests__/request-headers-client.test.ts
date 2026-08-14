import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createIsomorphicFn: () => ({
    client(clientImpl: (name: string) => unknown) {
      const fn = ((name: string) => clientImpl(name)) as typeof clientImpl & {
        server: (serverImpl: (name: string) => unknown) => typeof clientImpl;
      };
      fn.server = () => fn;
      return fn;
    },
  }),
}));

import { requestHeader } from "@/lib/request-headers";

describe("client request headers", () => {
  it("reads browser headers and returns null for unsupported names", async () => {
    document.cookie = "if_session=request-header-test; path=/";

    expect(await requestHeader("cookie")).toBe(document.cookie);
    expect(await requestHeader("host")).toBe(window.location.host);
    expect(await requestHeader("x-forwarded-proto")).toBe(
      window.location.protocol.replace(/:$/, ""),
    );
    expect(await requestHeader("x-request-id")).toBeNull();
  });
});
