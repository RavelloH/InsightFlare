import { describe, expect, it } from "vitest";

import {
  demoBadRequest,
  demoErr,
  demoNotFound,
  demoOk,
  extractErrorMessage,
  isErrorEnvelope,
} from "@/lib/realtime/mock/envelope";

const MESSAGE = "Test message";

describe("mock/envelope", () => {
  it("demoOk wraps a body with ok/requestId/timestamp", () => {
    const envelope = demoOk({ data: { views: 1 } }, "demo-req");
    expect(envelope.ok).toBe(true);
    expect(envelope.requestId).toBe("demo-req");
    expect(typeof envelope.timestamp).toBe("string");
    expect(envelope.data).toEqual({ views: 1 });
  });

  it("demoOk generates a requestId when omitted", () => {
    const envelope = demoOk({});
    expect(typeof envelope.requestId).toBe("string");
    expect(envelope.requestId.length).toBeGreaterThan(0);
  });

  it("demoErr shapes a failure with optional details and requestId", () => {
    const envelope = demoErr(
      "validation_failed",
      MESSAGE,
      { field: "name" },
      "r1",
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.requestId).toBe("r1");
    expect(envelope.error).toEqual({
      code: "validation_failed",
      message: MESSAGE,
      details: { field: "name" },
    });
  });

  it("demoErr omits details when not provided", () => {
    const envelope = demoErr("nf", MESSAGE);
    expect("details" in envelope.error).toBe(false);
  });

  it("demoNotFound defaults to Not Found and customizes message", () => {
    expect(demoNotFound()).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "Not Found" },
    });
    expect(demoNotFound("Site not found", "req-7").error).toEqual({
      code: "not_found",
      message: "Site not found",
    });
  });

  it("demoBadRequest derives the code from the message", () => {
    const envelope = demoBadRequest("Name is required");
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toEqual({
      code: "name_is_required",
      message: "Name is required",
    });
  });

  it("re-exports error helpers", () => {
    expect(isErrorEnvelope(demoNotFound())).toBe(true);
    expect(extractErrorMessage(demoBadRequest("Boom"))).toBe("Boom");
  });
});
