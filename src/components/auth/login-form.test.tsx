import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { navigateWithTransition } from "@/lib/page-transition";

import { LoginForm } from "./login-form";
import { verifyTurnstile } from "./turnstile-client";

vi.mock("@/lib/router", () => ({ useRouter: () => ({}) }));
vi.mock("@/lib/page-transition", () => ({ navigateWithTransition: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("./turnstile-client", () => ({ verifyTurnstile: vi.fn() }));
vi.mock("@insightflare/ui/auto-transition", () => ({
  AutoTransition: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@insightflare/ui/responsive-dialog", () => ({
  ResponsiveDialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div>{children}</div> : null),
  ResponsiveDialogContent: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ResponsiveDialogHeader: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ResponsiveDialogTitle: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ResponsiveDialogDescription: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ResponsiveDialogFooter: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

const props = {
  locale: "en" as const,
  nextPath: "/en/app",
  usernameLabel: "Username",
  passwordLabel: "Password",
  signInLabel: "Sign in",
  signingInLabel: "Signing in",
  verifyingSecurityLabel: "Verifying",
  securityVerificationFailedLabel: "Security failed",
  securityVerificationTitleLabel: "Security",
  retrySecurityLabel: "Retry verification",
  redirectingLabel: "Redirecting",
  invalidCredentialsLabel: "Invalid credentials",
  failedLabel: "Login failed",
};

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<typeof fetch>();
const verification = vi.mocked(verifyTurnstile);
const config = (enabled = true) =>
  Response.json({ ok: true, data: { turnstile: { enabled, siteKey: "key" } } });
const invalid = () =>
  Response.json(
    { ok: false, error: { code: "invalid_credentials" } },
    { status: 401 },
  );

function formButton() {
  return container.querySelector<HTMLButtonElement>("form button")!;
}
function submit() {
  container
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
function postBodies() {
  return fetchMock.mock.calls
    .filter(([path]) => path === "/api/public/session")
    .map(([, options]) => JSON.parse(String(options?.body)));
}
async function mount() {
  await act(async () => root.render(<LoginForm {...props} />));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("login security lifecycle", () => {
  it("obtains a new token after invalid credentials, then signs in", async () => {
    fetchMock
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(invalid())
      .mockResolvedValueOnce(
        Response.json({ ok: true, data: { next: "/en/app" } }),
      );
    verification.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    await mount();
    expect(formButton().disabled).toBe(false);
    await act(async () => {
      submit();
      submit();
    });
    expect(verification).toHaveBeenCalledTimes(2);
    expect(formButton().disabled).toBe(false);
    await act(async () => submit());
    expect(postBodies().map((body) => body.turnstileToken)).toEqual([
      "first",
      "second",
    ]);
    expect(navigateWithTransition).toHaveBeenCalledTimes(1);
    expect(verification).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a token after a network failure", async () => {
    fetchMock
      .mockResolvedValueOnce(config())
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(invalid());
    verification
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second")
      .mockResolvedValueOnce("third");
    await mount();
    await act(async () => submit());
    await act(async () => submit());
    expect(postBodies().map((body) => body.turnstileToken)).toEqual([
      "first",
      "second",
    ]);
    expect(verification).toHaveBeenCalledTimes(3);
  });

  it("refreshes a stale token before the next login", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(config()).mockResolvedValueOnce(invalid());
    verification
      .mockResolvedValueOnce("expired")
      .mockResolvedValueOnce("fresh")
      .mockResolvedValueOnce("next");
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(240_000));
    expect(verification).toHaveBeenCalledTimes(2);
    await act(async () => submit());
    expect(postBodies()[0].turnstileToken).toBe("fresh");
  });

  it("offers retry after a security rejection and refetches config", async () => {
    fetchMock
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(
        Response.json(
          { ok: false, error: { code: "turnstile_failed" } },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(config());
    verification.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    await mount();
    await act(async () => submit());
    expect(formButton().textContent).toContain("Retry verification");
    expect(formButton().disabled).toBe(false);
    await act(async () => formButton().click());
    expect(verification).toHaveBeenCalledTimes(2);
    expect(formButton().textContent).toContain("Sign in");
  });

  it("does not allow a login before security config succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(config(false));
    await mount();
    expect(formButton().textContent).toContain("Retry verification");
    expect(postBodies()).toHaveLength(0);
    await act(async () => formButton().click());
    expect(formButton().textContent).toContain("Sign in");
    expect(verification).not.toHaveBeenCalled();
  });

  it("does not load Turnstile when disabled", async () => {
    fetchMock
      .mockResolvedValueOnce(config(false))
      .mockResolvedValueOnce(invalid());
    await mount();
    await act(async () => submit());
    expect(postBodies()[0]).not.toHaveProperty("turnstileToken");
    expect(verification).not.toHaveBeenCalled();
  });
});
