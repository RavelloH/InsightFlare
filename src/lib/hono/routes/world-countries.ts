import { Hono } from "hono";

import { handleWorldCountriesRequest } from "@/lib/edge/world-countries";
import type { AppEnv } from "@/lib/hono/types";

export const worldCountriesRoutes = new Hono<AppEnv>();

worldCountriesRoutes.get("/world-countries", (c) =>
  handleWorldCountriesRequest(c.req.raw, c.env),
);
