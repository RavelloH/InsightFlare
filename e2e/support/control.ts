import { type Page } from "@playwright/test";

import type { ApiEnvelope } from "./api";

export type MockEmail = {
  authorization: string;
  body: {
    from?: string;
    html?: string;
    subject?: string;
    text?: string;
    to?: string[];
  };
  id: string;
};

export type ResendMockMode =
  "bad_request" | "rate_limited" | "server_error" | "success";

export function createE2eControlClient(input: {
  controlToken: string;
  mockControlToken: string;
  testSiteURL: string;
}) {
  async function e2eControlRequest<T>(
    page: Page,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    token = input.controlToken,
  ) {
    const response = await page.request.fetch(`/__e2e__/${path}`, {
      data: body,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        "x-insightflare-e2e-token": token,
      },
      method,
    });
    return {
      payload: (await response
        .json()
        .catch(() => null)) as ApiEnvelope<T> | null,
      status: response.status(),
    };
  }

  async function readMockMailbox(): Promise<MockEmail[]> {
    const response = await fetch(`${input.testSiteURL}/__e2e__/mailbox`, {
      headers: { "x-insightflare-e2e-token": input.mockControlToken },
    });
    if (!response.ok) {
      throw new Error(`Unable to read E2E mailbox: ${response.status}`);
    }
    const payload = (await response.json()) as { messages?: MockEmail[] };
    return payload.messages ?? [];
  }

  async function setResendMockMode(mode: ResendMockMode): Promise<void> {
    const response = await fetch(`${input.testSiteURL}/__e2e__/resend/mode`, {
      body: JSON.stringify({ mode }),
      headers: {
        "content-type": "application/json",
        "x-insightflare-e2e-token": input.mockControlToken,
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Unable to set E2E Resend mode: ${response.status}`);
    }
  }

  return { e2eControlRequest, readMockMailbox, setResendMockMode };
}
