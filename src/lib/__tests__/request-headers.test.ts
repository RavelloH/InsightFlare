import { describe, expect, it, vi } from "vitest";

const { createIsomorphicFnMock, getRequestHeaderMock, runtime } = vi.hoisted(
  () => {
    const runtime = { server: false };
    const getRequestHeaderMock = vi.fn();

    const createIsomorphicFnMock = vi.fn(() => {
      let clientImplementation: (...args: any[]) => unknown = () => null;
      let serverImplementation: (...args: any[]) => unknown = () => null;
      const callable = ((...args: any[]) =>
        runtime.server
          ? serverImplementation(...args)
          : clientImplementation(...args)) as any;

      callable.client = (nextImplementation: (...args: any[]) => unknown) => {
        clientImplementation = nextImplementation;
        return callable;
      };
      callable.server = (nextImplementation: (...args: any[]) => unknown) => {
        serverImplementation = nextImplementation;
        return callable;
      };
      return callable;
    });

    return { createIsomorphicFnMock, getRequestHeaderMock, runtime };
  },
);

vi.mock("@tanstack/react-start", () => ({
  createIsomorphicFn: createIsomorphicFnMock,
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: getRequestHeaderMock,
}));

import { requestHeader } from "@/lib/request-headers";

describe("requestHeader client adapter", () => {
  it("reads browser cookie, host, and forwarded protocol headers", () => {
    document.cookie = "if_test=header-value; path=/";

    expect(requestHeader("Cookie")).toBe(document.cookie);
    expect(requestHeader("Host")).toBe(window.location.host);
    expect(requestHeader("X-Forwarded-Proto")).toBe(
      window.location.protocol.replace(/:$/, ""),
    );
  });

  it("returns null for an unknown browser header", () => {
    expect(requestHeader("X-Unknown-Header")).toBeNull();
  });

  it("reads server headers and normalizes missing values", async () => {
    runtime.server = true;
    getRequestHeaderMock.mockReturnValueOnce("server-value");
    await expect(requestHeader("Authorization")).resolves.toBe("server-value");

    getRequestHeaderMock.mockReturnValueOnce(undefined);
    await expect(requestHeader("X-Missing")).resolves.toBeNull();

    runtime.server = false;
  });
});
