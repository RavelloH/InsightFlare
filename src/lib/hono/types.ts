import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { EdgeSessionClaims } from "@/lib/edge/session-auth";
import type { Env as EdgeEnv } from "@/lib/edge/types";

export type HonoBindings = EdgeEnv;

export interface HonoSite {
  id: string;
  name?: string;
  domain?: string;
}

export interface HonoPublicSite extends HonoSite {
  slug?: string;
}

export interface HonoApiSite {
  id: string;
  teamId: string;
  name: string;
  domain: string;
  publicEnabled: number;
  publicSlug: string | null;
  createdAt: number;
  updatedAt: number;
}

export type HonoVariables = {
  requestId: string;
  session?: EdgeSessionClaims;
  privateSite?: HonoSite;
  site?: HonoSite;
  publicSite?: HonoPublicSite;
  apiPrincipal?: ApiKeyPrincipal;
  apiSite?: HonoApiSite;
};

export type AppEnv = {
  Bindings: HonoBindings;
  Variables: HonoVariables;
};
