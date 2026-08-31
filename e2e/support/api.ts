import { expect, type Page } from "@playwright/test";

export type ApiEnvelope<T> = {
  data?: T;
  error?: string;
  meta?: unknown;
  message?: string;
  ok?: boolean;
} & (T extends object ? Partial<T> : unknown);

export type OverviewMetrics = {
  bounces: number;
  sessions: number;
  views: number;
  visitors: number;
};

export async function apiRequest<T>(
  page: Page,
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
  path: string,
  body?: Record<string, unknown>,
  cache?: RequestCache,
) {
  return page.evaluate(
    async ({ body, cache, method, path }) => {
      const response = await fetch(path, {
        cache,
        method,
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        payload: (await response.json()) as ApiEnvelope<T>,
        status: response.status,
      };
    },
    { body, cache, method, path },
  );
}

export async function apiV1Request<T>(
  page: Page,
  method: "GET" | "POST",
  path: string,
  apiKey: string,
  body?: Record<string, unknown>,
) {
  return page.evaluate(
    async ({ apiKey, body, method, path }) => {
      const response = await fetch(path, {
        body: body ? JSON.stringify(body) : undefined,
        credentials: "omit",
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        method,
      });
      return {
        payload: (await response.json()) as ApiEnvelope<T>,
        status: response.status,
      };
    },
    { apiKey, body, method, path },
  );
}

export function siteQueryPath(
  siteId: string,
  path: string,
  toMs: number,
): string {
  const params = new URLSearchParams({
    from: "0",
    siteId,
    to: String(toMs),
  });
  return `/api/private/${path}?${params.toString()}`;
}

export function siteQueryPathForWindow(
  siteId: string,
  path: string,
  from: number,
  to: number,
): string {
  const params = new URLSearchParams({
    from: String(from),
    siteId,
    to: String(to),
  });
  return `/api/private/${path}?${params.toString()}`;
}

export async function readSiteOverview(
  page: Page,
  siteId: string,
  toMs: number,
) {
  const overview = await apiRequest<OverviewMetrics>(
    page,
    "GET",
    siteQueryPath(siteId, "overview", toMs),
    undefined,
    "no-store",
  );
  expect(overview.status).toBe(200);
  expect(overview.payload.ok).toBe(true);
  expect(overview.payload.data).toBeDefined();
  return overview.payload.data as OverviewMetrics;
}
