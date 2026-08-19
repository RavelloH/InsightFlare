import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  parseAndValidateBody,
  validateBody,
  validateSearchParams,
} from "@/lib/validate";

const TestSchema = z.object({
  name: z.string().min(1),
  count: z.number().int().positive(),
});

describe("validateBody", () => {
  it("returns ok with parsed data for valid input", () => {
    const result = validateBody({ name: "test", count: 5 }, TestSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ name: "test", count: 5 });
  });

  it("returns ok:false with a 400 response for invalid input", () => {
    const result = validateBody({ name: "", count: -1 }, TestSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it("formats error messages with field paths", async () => {
    const result = validateBody({ name: "", count: 5 }, TestSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = (await result.response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain("name:");
    }
  });

  it("formats errors without path prefix for root-level issues", async () => {
    const schema = z.string().min(1);
    const result = validateBody("", schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = (await result.response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toBeTruthy();
      // Root-level errors don't have "path: " prefix, just the message
      expect(body.error.message).not.toMatch(/^[a-zA-Z_.]+:/);
    }
  });

  it("joins multiple issues with semicolons", async () => {
    const result = validateBody({ name: "", count: -1 }, TestSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = (await result.response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain(";");
    }
  });
});

describe("parseAndValidateBody", () => {
  it("parses JSON body and validates against schema", async () => {
    const request = new Request("https://test.example/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", count: 3 }),
    });
    const result = await parseAndValidateBody(request, TestSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ name: "test", count: 3 });
  });

  it("returns 400 for invalid JSON body", async () => {
    const request = new Request("https://test.example/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const result = await parseAndValidateBody(request, TestSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toBe("Invalid JSON body");
    }
  });

  it("returns 400 for valid JSON but invalid schema data", async () => {
    const request = new Request("https://test.example/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", count: "not-a-number" }),
    });
    const result = await parseAndValidateBody(request, TestSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });
});

describe("validateSearchParams", () => {
  it("validates search params against schema", () => {
    const schema = z.object({ page: z.coerce.number().int().min(1) });
    const url = new URL("https://test.example/api?page=5");
    const result = validateSearchParams(url, schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.page).toBe(5);
  });

  it("returns 400 for invalid search params", async () => {
    const schema = z.object({ page: z.coerce.number().int().min(1) });
    const url = new URL("https://test.example/api?page=0");
    const result = validateSearchParams(url, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = (await result.response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).toContain("page:");
    }
  });

  it("handles empty search params", () => {
    const schema = z.object({ page: z.coerce.number().int().optional() });
    const url = new URL("https://test.example/api");
    const result = validateSearchParams(url, schema);
    expect(result.ok).toBe(true);
  });

  it("formats root-level search param issues without a path prefix", async () => {
    const schema = z.string(); // search params object is not a string -> root issue
    const url = new URL("https://test.example/api?page=1");
    const result = validateSearchParams(url, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const body = (await result.response.json()) as {
        error: { message: string };
      };
      expect(body.error.message).not.toMatch(/^[a-zA-Z_.]+:/);
    }
  });

  it("handles multiple search params", () => {
    const schema = z.object({
      from: z.coerce.number(),
      to: z.coerce.number(),
    });
    const url = new URL("https://test.example/api?from=100&to=200");
    const result = validateSearchParams(url, schema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.from).toBe(100);
      expect(result.data.to).toBe(200);
    }
  });
});
