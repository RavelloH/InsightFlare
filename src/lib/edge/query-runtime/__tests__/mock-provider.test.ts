import { describe, expect, it, vi } from "vitest";

vi.mock("../demo-query", () => ({
  executeDemoQuery: vi.fn(
    async (input: unknown) => new Response(JSON.stringify(input)),
  ),
}));

import { executeDemoQuery } from "@/lib/edge/query-runtime/demo-query";
import { executeMockQuery } from "@/lib/edge/query-runtime/mock-provider";

describe("mock query provider", () => {
  it("forwards an authorized typed operation to the demo source", async () => {
    const input = {
      operation: "overview" as const,
      request: new Request("https://example.test/api/private/overview"),
      url: new URL("https://example.test/api/private/overview"),
      siteId: "site-1",
    };
    const response = await executeMockQuery(input);
    expect(response).toBeInstanceOf(Response);
    expect(executeDemoQuery).toHaveBeenCalledWith(input);
  });
});
