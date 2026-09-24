import { Hono } from "hono";

import { handleMapRelayRequest } from "@/lib/edge/resources/map-relay";
import { handleWikiSummaryRequest } from "@/lib/edge/resources/wiki-summary";
import { handleWorldCountriesRequest } from "@/lib/edge/resources/world-countries";
import type { AppEnv } from "@/lib/hono/types";

export const publicResourceRoutes = new Hono<AppEnv>();

publicResourceRoutes.get("/map/*", (c) =>
  handleMapRelayRequest(c.req.raw, c.env),
);

publicResourceRoutes.get("/world-countries", (c) =>
  handleWorldCountriesRequest(c.req.raw, c.env),
);

publicResourceRoutes.get("/wiki-summary", (c) =>
  handleWikiSummaryRequest(c.req.raw, c.env),
);
