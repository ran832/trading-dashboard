/// <reference types="vite/client" />

declare interface ImportMetaEnv {
  readonly VITE_POLYGON_API_KEY: string
  readonly VITE_FMP_API_KEY: string
}

declare interface ImportMeta {
  readonly env: ImportMetaEnv
}
