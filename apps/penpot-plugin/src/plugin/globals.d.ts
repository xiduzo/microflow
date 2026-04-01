/** Replaced at build time by Vite — the plugin host URL from manifest.json */
declare const __PLUGIN_HOST__: string;

/**
 * Augment @penpot/plugin-types with the Design Tokens API.
 *
 * The TokenCatalog API is documented at https://doc.plugins.penpot.app
 * (Penpot 2.14+) but not yet published in the npm types package.
 * Remove these augmentations once @penpot/plugin-types ships token interfaces.
 */

// ── Token type interfaces ───────────────────────────────────────────

interface PenpotTokenCatalog {
  readonly themes: PenpotTokenTheme[];
  readonly sets: PenpotTokenSet[];
  addTheme(group: { group: string; name: string }): PenpotTokenTheme;
  addSet(name: { name: string }): PenpotTokenSet;
  getThemeById(id: string): PenpotTokenTheme | undefined;
  getSetById(id: string): PenpotTokenSet | undefined;
}

interface PenpotTokenTheme {
  readonly id: string;
  name: string;
  group: string;
  readonly sets: PenpotTokenSet[];
}

interface PenpotTokenSet {
  readonly id: string;
  name: string;
  active: boolean;
  readonly tokens: PenpotToken[];
  readonly tokensByType: [string, PenpotToken[]][];
  toggleActive(): void;
  getTokenById(id: string): PenpotToken | undefined;
  addToken(type: { type: string; name: string; value: string }): PenpotToken;
  duplicate(): PenpotTokenSet;
  remove(): void;
}

interface PenpotToken {
  readonly id: string;
  name: string;
  description: string;
  type: string;
  value: string;
  readonly resolvedValueString: string | undefined;
  duplicate(): PenpotToken;
  remove(): void;
}

// ── Augment the Library interface from @penpot/plugin-types ─────────

import type { Library } from "@penpot/plugin-types";

declare module "@penpot/plugin-types" {
  interface Library {
    readonly tokens: PenpotTokenCatalog;
  }
}
