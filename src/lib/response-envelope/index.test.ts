import { describe, expect, it } from "vitest";

import {
  errorEnvelope,
  extractErrorMessage,
  isErrorEnvelope,
  okEnvelope,
  toErrorCode,
} from "@/lib/response-envelope";

describe("response-envelope", () => {
  describe("toErrorCode", () => {
    it("snake-cases and slugs a message", () => {
      expect(toErrorCode("Name is required")).toBe("name_is_required");
      expect(toErrorCode("  At least 2 steps are required! ")).toBe(
        "at_least_2_steps_are_required",
      );
      expect(toErrorCode("---")).toBe("error");
      expect(toErrorCode("")).toBe("error");
    });
  });

  describe("okEnvelope", () => {
    it("wraps a body with ok/requestId/timestamp", () => {
      const envelope = okEnvelope({ data: { views: 1 } }, "req-123");
      expect(envelope.ok).toBe(true);
      expect(envelope.requestId).toBe("req-123");
      expect(typeof envelope.timestamp).toBe("string");
      expect(envelope.data).toEqual({ views: 1 });
    });

    it("generates a requestId when omitted", () => {
      const envelope = okEnvelope({});
      expect(typeof envelope.requestId).toBe("string");
      expect(envelope.requestId.length).toBeGreaterThan(0);
    });
  });

  describe("errorEnvelope", () => {
    it("shapes the standard failure envelope", () => {
      const envelope = errorEnvelope(
        "validation_failed",
        "Name is required",
        { field: "name" },
        "req-9",
      );
      expect(envelope).toEqual({
        ok: false,
        requestId: "req-9",
        timestamp: expect.any(String) as unknown as string,
        error: {
          code: "validation_failed",
          message: "Name is required",
          details: { field: "name" },
        },
      });
    });
  });

  describe("isErrorEnvelope", () => {
    it("accepts a standard failure envelope", () => {
      expect(isErrorEnvelope(errorEnvelope("nf", "Not Found"))).toBe(true);
    });
    it("rejects success envelopes and non-objects", () => {
      expect(isErrorEnvelope(okEnvelope({}))).toBe(false);
      expect(isErrorEnvelope(null)).toBe(false);
      expect(isErrorEnvelope("nope")).toBe(false);
      expect(isErrorEnvelope({ ok: true })).toBe(false);
    });
  });

  describe("extractErrorMessage", () => {
    it("reads error.message from an envelope", () => {
      expect(extractErrorMessage(errorEnvelope("nf", "Not Found"))).toBe(
        "Not Found",
      );
    });
    it("reads a string error field", () => {
      expect(extractErrorMessage({ ok: false, error: "boom" })).toBe("boom");
    });
    it("reads a message field", () => {
      expect(extractErrorMessage({ message: "oops" })).toBe("oops");
    });
    it("reads an Error instance", () => {
      expect(extractErrorMessage(new Error("real error"))).toBe("real error");
    });
    it("falls back to request_failed", () => {
      expect(extractErrorMessage({ ok: false })).toBe("request_failed");
      expect(extractErrorMessage(undefined)).toBe("request_failed");
    });
  });
});
