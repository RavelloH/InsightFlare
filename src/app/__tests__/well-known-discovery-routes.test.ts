import { describe, expect, it } from "vitest";

import { GET as getOpenApi } from "@/app/.well-known/openapi.json/route";
import { GET as getSkills } from "@/app/.well-known/skills.json/route";

describe(".well-known discovery routes", () => {
  it("resolves the Skills base URL from forwarded request headers", async () => {
    const response = getSkills(
      new Request("http://internal.test/.well-known/skills.json", {
        headers: {
          host: "internal.test",
          "x-forwarded-host": "analytics.example.test",
          "x-forwarded-proto": "https",
        },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      baseUrl: "https://analytics.example.test",
    });
  });

  it("resolves OpenAPI servers from forwarded request headers", async () => {
    const response = getOpenApi(
      new Request("http://internal.test/.well-known/openapi.json", {
        headers: {
          host: "internal.test",
          "x-forwarded-host": "analytics.example.test",
          "x-forwarded-proto": "https",
        },
      }),
    );
    const body = (await response.json()) as {
      servers?: Array<{ url?: string }>;
    };

    expect(body.servers).toEqual([
      expect.objectContaining({ url: "https://analytics.example.test" }),
    ]);
  });
});
