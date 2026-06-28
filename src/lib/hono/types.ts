import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import type { Env as EdgeEnv } from "@/lib/edge/types";

export type HonoBindings = EdgeEnv;

export type HonoVariables = {
  requestId: string;
  session?: EdgeSessionClaims;
  site?: { id: string; name?: string; domain?: string };
  publicSite?: { id: string; name?: string; domain?: string; slug?: string };
  apiPrincipal?: unknown;
};

export type AppEnv = {
  Bindings: HonoBindings;
  Variables: HonoVariables;
};
