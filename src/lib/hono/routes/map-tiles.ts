import { Hono } from "hono";

import { handleMapTileRequest } from "@/lib/edge/map-tiles";
import type { AppEnv } from "@/lib/hono/types";

export const mapTileRoutes = new Hono<AppEnv>();

mapTileRoutes.get("/:z/:x/:y", (c) =>
  handleMapTileRequest(c.req.raw, {
    z: c.req.param("z"),
    x: c.req.param("x"),
    y: c.req.param("y"),
  }),
);
