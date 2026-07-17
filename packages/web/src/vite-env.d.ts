/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only fallback API base URL used by `vite dev` when there is no deployed `/config.json`. */
  readonly VITE_API_BASE_URL?: string;
}
