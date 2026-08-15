import { Hono } from "hono";

import { handleMapTileRequest } from "@/lib/edge/map-tiles";
import { handleWikiSummaryRequest } from "@/lib/edge/wiki-summary";
import { handleWorldCountriesRequest } from "@/lib/edge/world-countries";
import type { AppEnv } from "@/lib/hono/types";

export const publicResourceRoutes = new Hono<AppEnv>();

publicResourceRoutes.get("/world-countries", (c) =>
  handleWorldCountriesRequest(c.req.raw, c.env),
);

publicResourceRoutes.get("/wiki-summary", (c) =>
  handleWikiSummaryRequest(c.req.raw, c.env),
);

publicResourceRoutes.get("/map-tiles/:z/:x/:y", (c) =>
  handleMapTileRequest(
    c.req.raw,
    {
      z: c.req.param("z"),
      x: c.req.param("x"),
      y: c.req.param("y"),
    },
    c.env,
  ),
);
