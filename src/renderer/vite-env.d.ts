/// <reference types="vite/client" />

import type { SiteMirrorApi } from "../shared/types";

declare global {
  interface Window {
    siteMirror: SiteMirrorApi;
  }
}
