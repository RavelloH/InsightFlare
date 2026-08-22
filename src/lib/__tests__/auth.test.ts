import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSession, getSessionToken, isAuthenticated } from "@/lib/auth";
import { requestHeader } from "@/lib/request-headers";
import type * as SessionModule from "@/lib/session";
import { verifySessionToken } from "@/lib/session";

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return {
    ...actual,
    verifySessionToken: vi.fn(),
  };
});

vi.mock("@/lib/request-headers", () => ({ requestHeader: vi.fn() }));

const verifySessionTokenMock = vi.mocked(verifySessionToken);
const requestHeaderMock = vi.mocked(requestHeader);

describe("auth helpers", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DEMO_MODE", "");
    verifySessionTokenMock.mockReset();
    requestHeaderMock.mockReset();
    requestHeaderMock.mockResolvedValue(null);
    document.cookie = "if_session=; Max-Age=0; path=/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = "if_session=; Max-Age=0; path=/";
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads and decodes the dashboard session token from document cookies", async () => {
    document.cookie = "if_session=token%3Dwith%3Dequals; path=/";

    await expect(getSessionToken()).resolves.toBe("token=with=equals");
  });

  it("falls back to raw cookie values when decoding fails", async () => {
    document.cookie = "if_session=%E0%A4%A; path=/";

    await expect(getSessionToken()).resolves.toBe("%E0%A4%A");
  });

  it("returns an empty token when cookies omit the session key", async () => {
    document.cookie = "theme=dark; path=/";

    await expect(getSessionToken()).resolves.toBe("");
  });

  it("returns an empty token when browser cookies are present but empty", async () => {
    vi.stubGlobal("document", { cookie: "" });

    await expect(getSessionToken()).resolves.toBe("");
  });

  it("returns an empty token when browser and server cookie headers are empty", async () => {
    document.cookie = "if_session=; Max-Age=0; path=/";
    await expect(getSessionToken()).resolves.toBe("");

    vi.stubGlobal("document", undefined);
    await expect(getSessionToken()).resolves.toBe("");
  });

  it("reads server cookie headers when document is unavailable", async () => {
    vi.stubGlobal("document", undefined);
    requestHeaderMock.mockResolvedValue(
      "theme=dark; if_session=server%3Dtoken; other=value",
    );

    await expect(getSessionToken()).resolves.toBe("server=token");
  });

  it("returns an empty token when server cookies omit the session key", async () => {
    vi.stubGlobal("document", undefined);
    requestHeaderMock.mockResolvedValue("theme=dark; locale=en");

    await expect(getSessionToken()).resolves.toBe("");
  });

  it("returns an empty token when server headers cannot be read", async () => {
    vi.stubGlobal("document", undefined);
    requestHeaderMock.mockRejectedValue(new Error("outside request"));

    await expect(getSessionToken()).resolves.toBe("");
  });

  it("verifies non-demo sessions and reports authentication state", async () => {
    document.cookie = "if_session=signed-token; path=/";
    verifySessionTokenMock.mockResolvedValue({
      userId: "user-1",
      username: "admin",
      displayName: "Admin User",
      systemRole: "admin",
      exp: 9_999_999_999,
    });

    await expect(getSession()).resolves.toEqual({
      userId: "user-1",
      username: "admin",
      displayName: "Admin User",
      systemRole: "admin",
      exp: 9_999_999_999,
    });
    expect(verifySessionTokenMock).toHaveBeenCalledWith("signed-token");
    await expect(isAuthenticated()).resolves.toBe(true);
  });

  it("reports unauthenticated when token verification returns null", async () => {
    document.cookie = "if_session=expired-token; path=/";
    verifySessionTokenMock.mockResolvedValue(null);

    await expect(getSession()).resolves.toBeNull();
    await expect(isAuthenticated()).resolves.toBe(false);
  });

  it("does not synthesize client-side session data in demo mode", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    document.cookie = "if_session=demo-cookie-token; path=/";
    verifySessionTokenMock.mockResolvedValue(null);

    await expect(getSessionToken()).resolves.toBe("demo-cookie-token");
    await expect(getSession()).resolves.toBeNull();
    await expect(isAuthenticated()).resolves.toBe(false);
    expect(verifySessionTokenMock).toHaveBeenCalledWith("demo-cookie-token");
  });
});
