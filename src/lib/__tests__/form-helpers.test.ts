import { describe, expect, it } from "vitest";

import {
  assertContentSize,
  bodyStr,
  parseFormBool,
  parseRequestBody,
  safeRedirectPath,
} from "@/lib/form-helpers";

describe("Form Validation and Parser Helpers", () => {
  describe("parseFormBool", () => {
    it("should return the fallback value for null or undefined", () => {
      expect(parseFormBool(null, true)).toBe(true);
      expect(parseFormBool(undefined, false)).toBe(false);
      expect(parseFormBool(undefined)).toBe(false); // Default fallback false
    });

    it("should return the boolean directly if input is already boolean", () => {
      expect(parseFormBool(true)).toBe(true);
      expect(parseFormBool(false)).toBe(false);
    });

    it("should parse truthy string values as true regardless of casing/spacing", () => {
      expect(parseFormBool("1")).toBe(true);
      expect(parseFormBool("true")).toBe(true);
      expect(parseFormBool("  TRUE  ")).toBe(true);
      expect(parseFormBool("on")).toBe(true);
      expect(parseFormBool("yes")).toBe(true);
      expect(parseFormBool("YES")).toBe(true);
    });

    it("should parse other string values as false", () => {
      expect(parseFormBool("0")).toBe(false);
      expect(parseFormBool("false")).toBe(false);
      expect(parseFormBool("off")).toBe(false);
      expect(parseFormBool("no")).toBe(false);
      expect(parseFormBool("hello")).toBe(false);
    });
  });

  describe("safeRedirectPath", () => {
    it("should allow relative paths that start with a single slash", () => {
      expect(safeRedirectPath("/app")).toBe("/app");
      expect(safeRedirectPath("/dashboard/settings?tab=profile")).toBe(
        "/dashboard/settings?tab=profile",
      );
    });

    it("should reject double-slashed paths to prevent protocol-relative open redirects", () => {
      expect(safeRedirectPath("//evil.com", "/app")).toBe("/app");
      expect(safeRedirectPath("///evil.com")).toBe("/app");
    });

    it("should reject absolute URLs to prevent external open redirects", () => {
      expect(safeRedirectPath("https://evil.com/app", "/fallback")).toBe(
        "/fallback",
      );
      expect(safeRedirectPath("http://evil.com")).toBe("/app");
      expect(safeRedirectPath("javascript:alert(1)")).toBe("/app");
    });

    it("should fall back for empty, whitespace, or invalid entries", () => {
      expect(safeRedirectPath("")).toBe("/app");
      expect(safeRedirectPath("   ")).toBe("/app");
      expect(safeRedirectPath(null as any)).toBe("/app");
      expect(safeRedirectPath(undefined as any)).toBe("/app");
    });
  });

  describe("parseRequestBody", () => {
    it("should parse JSON bodies if Content-Type matches application/json", async () => {
      const payload = { siteId: "456", enabled: true };
      const request = new Request("http://localhost/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const parsed = await parseRequestBody(request);
      expect(parsed).toEqual(payload);
    });

    it("should parse FormData bodies if Content-Type is multipart/form-data or urlencoded", async () => {
      const formData = new FormData();
      formData.append("siteId", "789");
      formData.append("enabled", "true");

      const request = new Request("http://localhost/api", {
        method: "POST",
        body: formData,
      });

      const parsed = await parseRequestBody(request);
      expect(parsed).toEqual({
        siteId: "789",
        enabled: "true", // FormData parses fields as strings
      });
    });
  });

  describe("bodyStr", () => {
    it("should extract string values, coerce numbers, and trim whitespace", () => {
      const body = {
        name: "  Ravelloh  ",
        port: 3000,
        empty: null,
      };

      expect(bodyStr(body, "name")).toBe("Ravelloh");
      expect(bodyStr(body, "port")).toBe("3000");
      expect(bodyStr(body, "empty")).toBe("");
      expect(bodyStr(body, "missing")).toBe("");
    });
  });

  describe("assertContentSize", () => {
    it("rejects a request whose declared body is too large", () => {
      const response = assertContentSize(
        {
          headers: new Headers({ "content-length": "1025" }),
        } as Request,
        1024,
      );

      expect(response?.status).toBe(413);
      expect(response?.headers.get("content-type")).toBe("application/json");
    });

    it("ignores a non-numeric content length", () => {
      const response = assertContentSize(
        {
          headers: new Headers({ "content-length": "not-a-number" }),
        } as Request,
        1024,
      );

      expect(response).toBeNull();
    });
  });
});
