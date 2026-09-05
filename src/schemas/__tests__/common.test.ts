import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createEnvelopeSchema,
  createPaginatedEnvelopeSchema,
  EnvelopeSchema,
  ErrorDetailSchema,
  ErrorEnvelopeSchema,
  getAllRegisteredSchemas,
  PaginationMetaSchema,
  registerSchema,
} from "@/schemas/common";

describe("EnvelopeSchema", () => {
  it("accepts a valid envelope", () => {
    const result = EnvelopeSchema.safeParse({
      ok: true,
      requestId: "ray-123",
      timestamp: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects ok=false", () => {
    const result = EnvelopeSchema.safeParse({
      ok: false,
      requestId: "ray-123",
      timestamp: "2025-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(EnvelopeSchema.safeParse({ ok: true }).success).toBe(false);
    expect(
      EnvelopeSchema.safeParse({
        ok: true,
        requestId: "r",
      }).success,
    ).toBe(false);
  });
});

describe("ErrorDetailSchema", () => {
  it("accepts valid error detail", () => {
    const result = ErrorDetailSchema.safeParse({
      code: "not_found",
      message: "Resource not found",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing code or message", () => {
    expect(ErrorDetailSchema.safeParse({ code: "x" }).success).toBe(false);
    expect(ErrorDetailSchema.safeParse({ message: "x" }).success).toBe(false);
  });
});

describe("ErrorEnvelopeSchema", () => {
  it("accepts a valid error envelope", () => {
    const result = ErrorEnvelopeSchema.safeParse({
      ok: false,
      requestId: "ray-123",
      timestamp: "2025-01-01T00:00:00.000Z",
      error: { code: "bad_request", message: "Bad request" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects ok=true in error envelope", () => {
    const result = ErrorEnvelopeSchema.safeParse({
      ok: true,
      requestId: "ray-123",
      timestamp: "2025-01-01T00:00:00.000Z",
      error: { code: "x", message: "y" },
    });
    expect(result.success).toBe(false);
  });
});

describe("PaginationMetaSchema", () => {
  it("accepts valid pagination meta", () => {
    const result = PaginationMetaSchema.safeParse({
      limit: 20,
      returned: 20,
      hasMore: true,
      nextCursor: "cursor-2",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null nextCursor", () => {
    const result = PaginationMetaSchema.safeParse({
      limit: 10,
      returned: 5,
      hasMore: false,
      nextCursor: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-integer limit", () => {
    const result = PaginationMetaSchema.safeParse({
      limit: 1.5,
      returned: 20,
      hasMore: false,
      nextCursor: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("createEnvelopeSchema", () => {
  it("wraps a data schema inside the envelope", () => {
    const schema = createEnvelopeSchema(z.object({ name: z.string() }));
    const result = schema.safeParse({
      ok: true,
      requestId: "r",
      timestamp: "t",
      data: { name: "test" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid data inside the envelope", () => {
    const schema = createEnvelopeSchema(z.object({ name: z.string() }));
    const result = schema.safeParse({
      ok: true,
      requestId: "r",
      timestamp: "t",
      data: { name: 123 },
    });
    expect(result.success).toBe(false);
  });
});

describe("createPaginatedEnvelopeSchema", () => {
  it("wraps data and meta inside the envelope", () => {
    const schema = createPaginatedEnvelopeSchema(z.string());
    const result = schema.safeParse({
      ok: true,
      requestId: "r",
      timestamp: "t",
      data: {
        items: ["a", "b"],
        pagination: {
          limit: 20,
          returned: 2,
          hasMore: false,
          nextCursor: null,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing meta", () => {
    const schema = createPaginatedEnvelopeSchema(z.string());
    const result = schema.safeParse({
      ok: true,
      requestId: "r",
      timestamp: "t",
      data: { items: ["a"] },
    });
    expect(result.success).toBe(false);
  });
});

describe("schema registry", () => {
  it("registerSchema adds a schema to the registry", () => {
    const testSchema = z.object({ test: z.boolean() });
    registerSchema("TestSchema", testSchema);

    const all = getAllRegisteredSchemas();
    const found = all.find((s) => s.name === "TestSchema");
    expect(found).toBeDefined();
    expect(found!.schema).toBe(testSchema);
  });

  it("getAllRegisteredSchemas returns an array", () => {
    const all = getAllRegisteredSchemas();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
  });
});
