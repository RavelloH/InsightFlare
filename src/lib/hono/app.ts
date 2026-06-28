import { Hono } from "hono";

import { handleHonoError } from "./middleware/error-boundary";
import { adminWsRoutes } from "./routes/admin-ws";
import { authRoutes } from "./routes/auth";
import { collectRoutes } from "./routes/collect";
import { healthRoutes } from "./routes/health";
import { legacyAdminRoutes } from "./routes/legacy-admin";
import { legacyArchiveRoutes } from "./routes/legacy-archive";
import { mapTileRoutes } from "./routes/map-tiles";
import { privateRoutes } from "./routes/private";
import { publicRoutes } from "./routes/public";
import { scriptRoutes } from "./routes/tracker-script";
import { v1Routes } from "./routes/v1";
import { wellKnownRoutes } from "./routes/well-known";
import type { AppEnv } from "./types";

export const apiApp = new Hono<AppEnv>();

apiApp.onError(handleHonoError);

apiApp.route("/", healthRoutes);
apiApp.route("/", wellKnownRoutes);
apiApp.route("/", collectRoutes);
apiApp.route("/", scriptRoutes);
apiApp.route("/", adminWsRoutes);
apiApp.route("/api/auth", authRoutes);
apiApp.route("/api/admin", legacyAdminRoutes);
apiApp.route("/api/archive", legacyArchiveRoutes);
apiApp.route("/api/private", privateRoutes);
apiApp.route("/api/public", publicRoutes);
apiApp.route("/api/v1", v1Routes);
apiApp.route("/api/map-tiles", mapTileRoutes);

export default apiApp;
