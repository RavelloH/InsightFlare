/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
  readonly VITE_COMMIT_SHA: string;
  readonly VITE_DEMO_MODE: string;
  readonly VITE_GITHUB_API_BASE: string;
  readonly VITE_GITHUB_RELEASES_RAW_BASE: string;
  readonly VITE_INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
