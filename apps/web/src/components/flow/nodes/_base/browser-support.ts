// Why something cannot run in the current host — one resolver for every gated
// subject, so no two surfaces can disagree about the answer or the wording.
//
// The flow engine is the same Rust runtime in both hosts (wasm in the browser,
// native in Tauri) and it registers every node in both — see
// `crates/microflow-core/src/runtime/registry.rs`. So every gap here is a *host*
// gap: an OS capability the browser sandbox does not hand out, or hands out only
// on some browsers. Three kinds of subject are gated:
//
// - a node *type* (Web Serial, Web MIDI): per browser, not per node — the Midi
//   row below is silent in Chrome and speaks up in Safari;
// - a broker *URL* (Mqtt/Figma): a browser can only speak MQTT over a
//   WebSocket, so a `mqtt://` broker works on desktop and never connects here;
// - an LLM *provider* on a given surface: a local CLI is a subprocess no
//   browser tab can start, and on desktop it can drive Ask AI only if it takes
//   an MCP server per run — that is how the flow tools reach it (`mcp-bridge.ts`).
//   A CLI that cannot answers in prose and silently changes nothing.
//
// Callers render the answer; none of them keeps a predicate or a sentence.
// `isDesktop()` is read here rather than passed in so every caller — the node,
// the settings page, the Ask AI picker — cannot disagree about which host it is
// running on.

import { isDesktop } from "@/lib/platform";
import { REQUIRES_HARDWARE, isComponentType } from "./_base.types";
import { isWebSerialSupported } from "@/lib/firmata/web-serial";
import { cliProvider, isCliProvider, takesFlowTools } from "@/lib/ai/cli-providers";

/** A short badge label and the sentence behind it. */
export type HostLimitation = { label: string; reason: string };

/** Where an LLM provider is about to be used. The same CLI provider is fine in
 *  one place and useless in another, and the difference is worth saying out
 *  loud. */
export type ProviderSurface = "config" | "node" | "ask-ai";

/** Something that may not work in the current host. */
export type HostSubject =
  | { kind: "node"; type: string | undefined }
  | { kind: "broker"; name: string; url: string }
  | {
      kind: "provider";
      provider: { kind?: string; baseUrl?: string } | undefined;
      surface: ProviderSurface;
    };

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
 * Why `subject` cannot work in the current host, or `undefined` when it can.
 */
export function hostLimitation(subject: HostSubject): HostLimitation | undefined {
  switch (subject.kind) {
    case "node": {
      if (subject.type === undefined || isDesktop()) return undefined;
      // Without Web Serial there is no way to reach a board from this browser
      // at all, so every pin-driving node is inert — that outranks anything
      // below.
      if (
        !isWebSerialSupported() &&
        isComponentType(subject.type) &&
        REQUIRES_HARDWARE[subject.type]
      ) {
        return {
          label: "desktop only",
          reason:
            "This browser cannot reach a board (no Web Serial), so this node has no hardware to drive. Use Chrome, Edge or Opera, or the desktop app.",
        };
      }
      const reason = BROWSER_LIMITATIONS[subject.type]?.();
      return reason === undefined ? undefined : { label: "desktop only", reason };
    }

    case "broker": {
      // A blank URL is unconfigured, not unreachable — other checks own that.
      if (isDesktop() || subject.url.trim() === "") return undefined;
      if (isBrowserReachableBroker(subject.url)) return undefined;
      return {
        label: "not reachable",
        reason: `${subject.name} is not reachable from a browser — use a ws:// or wss:// broker, or the desktop app.`,
      };
    }

    case "provider": {
      if (subject.provider === undefined || !isCliProvider(subject.provider)) return undefined;

      // Host first: in a browser a CLI provider cannot run anywhere, which
      // outranks whatever else the surface would object to.
      if (!isDesktop()) {
        return {
          label: "studio only",
          reason:
            "This provider runs a command-line tool on your computer, which a browser tab cannot start. It works in Microflow Studio, the desktop app.",
        };
      }

      // On desktop the remaining gap is Ask AI's, and it is now per CLI: the
      // flow tools are published over MCP for the length of one turn, which
      // only a CLI that takes an MCP server per invocation can be pointed at.
      // One configured through a file in the user's home cannot — a grant that
      // outlives the turn is not a grant this feature is willing to make.
      const cli = subject.provider.baseUrl ? cliProvider(subject.provider.baseUrl) : undefined;
      if (subject.surface === "ask-ai" && !(cli && takesFlowTools(cli))) {
        return {
          label: "no flow tools",
          reason:
            "This CLI cannot be handed Microflow's tools for a single run, so Ask AI could describe a change but never make one. Use it from an Llm node or the LLM console instead.",
        };
      }

      return undefined;
    }
  }
}

/** Browsers cannot open a raw MQTT/TCP socket — only MQTT-over-WebSocket. */
export function isBrowserReachableBroker(url: string): boolean {
  return /^wss?:\/\//i.test(url.trim());
}
