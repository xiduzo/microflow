import { env } from "@microflow/env/web";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isDesktop } from "./platform";

// Public docs origin. Defaults to the production Fumadocs deployment; can be
// overridden via VITE_DOCS_URL to point at a local dev server or preview.
export const DOCS_URL = env.VITE_DOCS_URL ?? "https://docs.microflow.tech";

/**
 * Build a fully-qualified URL into the docs site.
 *
 * @param path Path under the docs origin. May start with or omit the leading slash.
 */
export function docsUrl(path = ""): string {
  if (!path) return DOCS_URL;
  return `${DOCS_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Open an external URL — via Tauri's opener in the desktop app, via a new tab
 * in the browser. Safe defaults: `noopener,noreferrer` in the browser.
 */
export function openExternal(url: string) {
  if (isDesktop()) {
    void openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Convenience: open a docs path (relative to {@link DOCS_URL}) in the
 * appropriate way for the current platform.
 */
export function openDocs(path = "") {
  openExternal(docsUrl(path));
}
