// What a node cannot do when microflow runs as a web page instead of the
// desktop app.
//
// The flow engine is the same Rust runtime in both hosts (wasm in the browser,
// native in Tauri) and it registers every node in both — see
// `crates/microflow-core/src/runtime/registry.rs`. So every gap here is a *host*
// gap: an OS capability the browser sandbox does not hand out, or hands out only
// on some browsers. Which means support is decided per browser, not per node:
// the Midi row below is silent in Chrome and speaks up in Safari.
//
// Adding a node that needs something only the desktop host can give it? Add a
// row here — the `DesktopOnlyBadge` is the only consumer, and it already sits on
// the node header and in the Add Node list.
//
// Not listed here, on purpose: Mqtt/Figma's ws(s)-only broker requirement and
// Llm's CORS requirement are per-*config*, not per-node. Those checks live with
// the config — in the node for the broker URL (see `mqtt.tsx`), in the provider
// settings for the LLM endpoint.

import { isDesktop } from "@/lib/platform";
import { REQUIRES_HARDWARE, isComponentType } from "./_base.types";
import { isWebSerialSupported } from "@/lib/firmata/web-serial";

/** Keyed by ComponentType (the xyflow node type). A row returns `undefined`
 *  when the browser at hand happens to be able to do the job after all. */
const BROWSER_LIMITATIONS: Record<string, () => string | undefined> = {
  // Web MIDI is Chromium-only and needs a permission grant; the performer
  // degrades to a no-op without it (`midi/midi-performer.ts`).
  Midi: () =>
    typeof navigator !== "undefined" && navigator.requestMIDIAccess !== undefined
      ? undefined
      : "This browser has no Web MIDI, so this node cannot reach a MIDI device. Use Chrome, Edge or Opera, or the desktop app.",
};

/**
 * Why this node type cannot work in the current host, or `undefined` when it
 * can. Always `undefined` on desktop — that host has every capability.
 */
export function browserLimitation(type: string | undefined): string | undefined {
  if (type === undefined || isDesktop()) return undefined;
  // Without Web Serial there is no way to reach a board from this browser at
  // all, so every pin-driving node is inert — that outranks anything below.
  if (!isWebSerialSupported() && isComponentType(type) && REQUIRES_HARDWARE[type]) {
    return "This browser cannot reach a board (no Web Serial), so this node has no hardware to drive. Use Chrome, Edge or Opera, or the desktop app.";
  }
  return BROWSER_LIMITATIONS[type]?.();
}

/** Browsers cannot open a raw MQTT/TCP socket — only MQTT-over-WebSocket. */
export function isBrowserReachableBroker(url: string): boolean {
  return /^wss?:\/\//i.test(url.trim());
}
