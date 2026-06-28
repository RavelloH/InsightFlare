# API Route Inventory Before Hono-Native Refactor

Baseline HEAD: `70b09f0f820087f61f57839a2c68d1b2644691a1`

This inventory captures the production route surface after the Hono entry
migration and before the part 2 handler refactor. It is used as a parity
checklist; it is not an OpenAPI contract.

| Method | Path pattern | Current Hono route | Current production handler | Auth / scope | Site resolution | Cache / headers | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OPTIONS | `/collect` | `routes/collect.ts` | `handleCollectOptionsRequest` | none | payload site only for POST | CORS 204 | Preflight only |
| POST | `/collect` | `routes/collect.ts` | `handleCollectRequest` | none | site settings by payload/query siteId | CORS 204, body limit, DO waitUntil | Bot/origin/path/custom event checks |
| GET | `/script.js` | `routes/tracker-script.ts` | `handleTrackerScriptRequest` | none | optional site config query | JS content/cache headers | Tracker SDK endpoint |
| GET | `/healthz` | `routes/health.ts` | inline Hono health handler | none | none | JSON | Binding status output |
| GET/HEAD | `/.well-known/openapi.json` | `routes/well-known.ts` | inline Hono handler | none | none | CORS/cache JSON | Dynamic server base URL |
| GET/HEAD | `/.well-known/skills.json` | `routes/well-known.ts` | inline Hono handler | none | none | CORS/cache JSON | Dynamic `${baseUrl}` replacement |
| GET/HEAD | `/.well-known/security.txt` | `routes/well-known.ts` | inline Hono handler | none | none | CORS/cache text | Static text |
| GET/HEAD | `/.well-known/change-password` | `routes/well-known.ts` | inline Hono handler | none | none | redirect/HEAD 200 | Redirects to `/app` |
| GET/HEAD | `/.well-known/health` | `routes/well-known.ts` | inline Hono handler | none | none | redirect/HEAD 200 | Redirects to `/healthz` |
| ALL | `/admin/ws` | `routes/admin-ws.ts` | `handleAdminWs` | dashboard session | query `siteId` membership | DO websocket forward | Preserves admin bypass |
| GET | `/api/map-tiles/:z/:x/:y(.png)` | `routes/map-tiles.ts` | `handleMapTileRequest` | same-origin | none | upstream cache headers | Supports x wrap and dark fallback |
| ALL | `/api/private/admin/:adminPath` | `routes/private/index.ts` | `handlePrivateAdmin` | admin/session in sub-handler | sub-handler dependent | JSON | Pathname router still in production |
| ALL | `/api/private/archive/manifest` | `routes/private/index.ts` | `handlePrivateArchive` | session | `siteId` membership | JSON | Pathname router still in production |
| GET/HEAD | `/api/private/archive/file` | `routes/private/index.ts` | `handlePrivateArchive` | session | archive row site membership | Range/ETag streaming | Pathname router still in production |
| GET | `/api/private/:queryPath` | `routes/private/index.ts` | `handlePrivateQuery` -> `routeQuery` | session | private site from query | private dashboard cache after auth/site | Pathname router still in production |
| POST/DELETE | `/api/private/funnels` | `routes/private/index.ts` | `handlePrivateQuery` -> `routeQuery` | session | private site from query | no read cache | Funnel mutation exception |
| ALL | `/api/private/team-dashboard` | `routes/private/index.ts` | `handlePrivateQuery` | session in handler | team context | no dashboard site cache | Special dashboard route |
| GET | `/api/public/:slug/site` | `routes/public.ts` | `handlePublicQuery` | none | public enabled slug | public cache | Public site data |
| GET | `/api/public/:slug/:queryPath` | `routes/public.ts` | `handlePublicQuery` -> `routeQuery` | none | public enabled slug | public cache | Allowlist via `PUBLIC_QUERY_PATHS` |
| POST/PATCH/DELETE | `/api/public/:slug/:queryPath` | `routes/public.ts` | `handlePublicQuery` | none | none if method rejected first | 405 JSON | Public API is GET-only |
| POST | `/api/auth/login` | `routes/auth.ts` | `handleLegacyAuthLogin` | credentials | none | Set-Cookie | Hono path avoids internal HTTP |
| POST | `/api/auth/logout` | `routes/auth.ts` | `handleLegacyAuthLogout` | none | none | Clear Set-Cookie | Legacy compatibility |
| POST | `/api/admin/user` | `routes/legacy-admin.ts` | `handleLegacyAdminUser` | same-origin + private admin auth | private admin handler | JSON | Hono path avoids internal HTTP |
| POST | `/api/admin/team` | `routes/legacy-admin.ts` | `handleLegacyAdminTeam` | same-origin + private admin auth | private admin handler | JSON | Legacy form intents |
| POST | `/api/admin/site` | `routes/legacy-admin.ts` | `handleLegacyAdminSite` | same-origin + private admin auth | private admin handler | JSON | Legacy form intents |
| POST | `/api/admin/member` | `routes/legacy-admin.ts` | `handleLegacyAdminMember` | same-origin + private admin auth | private admin handler | JSON | Legacy form intents |
| POST | `/api/admin/profile` | `routes/legacy-admin.ts` | `handleLegacyAdminProfile` | same-origin + private admin auth | private admin handler | JSON | Profile update |
| POST | `/api/admin/site-config` | `routes/legacy-admin.ts` | `handleLegacyAdminSiteConfig` | same-origin + private admin auth | private admin handler | JSON | Legacy privacy form |
| GET | `/api/archive/manifest` | `routes/legacy-archive.ts` | `handleLegacyArchiveManifest` | session via private archive | query `siteId` membership | JSON | Rewrites `fetchUrl` to legacy path |
| GET/HEAD | `/api/archive/file` | `routes/legacy-archive.ts` | `handleLegacyArchiveFile` | session via private archive | archive row site membership | Range/ETag streaming | Header passthrough |
| GET | `/api/v1` | `routes/v1/index.ts` | `handleApiV1` | none | none | JSON v1 envelope | Root docs/capabilities links |
| ALL | `/api/v1/token` | `routes/v1/index.ts` | `handleApiV1` | API key | principal team | JSON v1 envelope | Segments router still in production |
| ALL | `/api/v1/token/check` | `routes/v1/index.ts` | `handleApiV1` | API key | principal team | JSON v1 envelope | Segments router still in production |
| ALL | `/api/v1/capabilities` | `routes/v1/index.ts` | `handleApiV1` | API key | principal team | JSON v1 envelope | Segments router still in production |
| ALL | `/api/v1/team/*` | `routes/v1/index.ts` | `handleApiV1` | API key + scopes | principal team | JSON v1 envelope | Segments router still in production |
| ALL | `/api/v1/sites` | `routes/v1/index.ts` | `handleApiV1` | API key + scopes | principal team/sites | JSON v1 envelope | Segments router still in production |
| ALL | `/api/v1/sites/:siteId/*` | `routes/v1/index.ts` | `handleApiV1` | API key + scopes | `siteById`/access semantics | JSON v1 envelope | Segments router still in production |
| POST | `/api/v1/batch` | `routes/v1/index.ts` | `handleApiV1` | API key | per subrequest | JSON v1 envelope | Subrequests currently call `handleApiV1` |

Production path match is controlled by `src/lib/hono/path-match.ts`; non-API
page traffic continues to OpenNext.
