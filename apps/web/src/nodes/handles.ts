// The Live Handle Set: which Ports and Emits a node offers for connection,
// given its type and its current settings (`data`).
//
// One answer for every reader. The canvas renders it (`_base/node-handles.tsx`)
// and checks a dragged connection against it; the session removes the edges of
// a handle that leaves it (`session/handle-pruning.ts`, which is handed
// `nodeHandles`); Ask AI's `connect`, its node catalogue and the template guard
// read it. Each node states its own handles once, in `<node>/<node>.handles.ts`.
//
// It is not the wire interface. `COMPONENT_PORTS` / `COMPONENT_EMITS` list every
// handle a Rust component declares, for any settings (ADR-0007). The live set is
// the part of that a node offers right now — plus its open ports, which are
// named by the settings themselves (a Function `{{variable}}`, a Music record)
// and appear in no generated list.
//
// React-free: importing this loads no node UI.

import {
  COMPONENT_EMITS,
  COMPONENT_PORTS,
  isComponentType,
  type ComponentType,
} from "./component-types.generated";
import { handleLayout, handleRule } from "./handle-rules";

/** A node's connectable handle ids: Ports take edges in, Emits send them out. */
export type HandleSet = {
  readonly ports: readonly string[];
  readonly emits: readonly string[];
};

/**
 * The Live Handle Set of a node of `type` configured with `data`.
 *
 * Total: it answers for any `data`, and never throws. `data` is whatever the
 * flow document holds, so it may be partial, stale, of the wrong shape or
 * written by another build; a setting that is missing or unusable reads as the
 * node's default for it. Every id is a non-empty string, unique within `ports`
 * and within `emits`; the same id may be in both (`value`).
 *
 * The set holds every handle an edge may attach to, including an open port
 * the node has no room to draw.
 */
export function liveHandles(type: ComponentType, data: unknown): HandleSet {
  const layout = handleLayout(type, data);
  return {
    ports: layout.ports.map((port) => port.id),
    emits: layout.emits.map((emit) => emit.id),
  };
}

/** The parts of a node this module reads. A `FlowNode` and a ReactFlow node both fit. */
export type HandleNode = { type?: string | null; data?: unknown };

/**
 * The Live Handle Set of a node as found in a flow, or `null` when its type is
 * not in this build's catalog and its handles are therefore unknown.
 */
export function nodeHandles(node: HandleNode): HandleSet | null {
  const type = node.type ?? "";
  return isComponentType(type) ? liveHandles(type, node.data) : null;
}

/** Every handle set a type can have, and what selects each. */
export type HandleVariants = {
  /** The set of a node with default settings. */
  readonly defaults: HandleSet;
  /**
   * One entry per settings combination that selects a handle set: the
   * settings that select it, and the set. Empty when settings never change
   * the type's handles. Open ports are not in these sets.
   */
  readonly bySettings: readonly {
    readonly settings: Readonly<Record<string, unknown>>;
    readonly handles: HandleSet;
  }[];
  /**
   * Set when the settings in `bySettings` are not chosen directly but filled
   * in from something else: what they follow, in words that complete "its
   * handles follow …". Tell a person or a model that, not to set them.
   */
  readonly follows?: string;
  /** For a type with open ports: what names them, in a few words. */
  readonly openPorts?: string;
};

/**
 * Every handle set nodes of `type` can have: with default settings, and per
 * setting that changes it. For a reader that has no node yet (the Ask AI
 * catalogue), or that asks what a type could offer with other settings.
 */
export function handleVariants(type: ComponentType): HandleVariants {
  const rule = handleRule(type);
  return {
    defaults: liveHandles(type, {}),
    bySettings: rule.variants.map((settings) => ({
      settings,
      handles: liveHandles(type, settings),
    })),
    follows: rule.variantsFollow,
    openPorts: rule.openPorts,
  };
}

/** The parts of an edge {@link checkEdge} reads. A `FlowEdge` and a ReactFlow `Connection` both fit. */
export type EdgeEnds = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

/**
 * Why an edge cannot attach, and at which end.
 *
 * The two handle reasons are different findings, and a reader may treat them
 * differently:
 *
 * - `unknown-handle`: nothing declares it. The runtime has no such Port or
 *   Emit on this node; the edge can never carry anything.
 * - `not-offered`: the Rust component declares it, so the runtime honours an
 *   edge at it, but the node does not offer it as configured. A flow may hold
 *   such an edge from before this check existed. Refusing a new one is right;
 *   dropping an existing one changes what the flow does.
 */
export type EdgeProblem = { end: "source" | "target" } & (
  | { reason: "missing-node" }
  /** The node's type is not in this build's catalog, so its handles are unknown. */
  | { reason: "unknown-type"; type: string }
  | {
      /**
       * The handle is neither live nor declared by the component: a name
       * nothing knows, an open port the settings do not name, or no handle at
       * all (`handle: null`).
       */
      reason: "unknown-handle";
      type: ComponentType;
      handle: string | null;
      /** What the node offers at that end now: its Emits for `source`, its Ports for `target`. */
      live: readonly string[];
    }
  | {
      /** The component declares the handle; the node does not offer it as configured. */
      reason: "not-offered";
      type: ComponentType;
      handle: string;
      /** What the node offers at that end now. */
      live: readonly string[];
      /**
       * `other-settings`: the node would offer it with other settings (see
       * {@link handleVariants}). `never`: no settings offer it; it is declared
       * by the component and left off the node on purpose.
       */
      offered: "other-settings" | "never";
    }
);

/**
 * Check an edge against the Live Handle Sets of the two nodes it joins: it must
 * leave a live Emit of its source and enter a live Port of its target.
 *
 * Returns the first problem, source end first, or `null` when the edge can
 * attach. `nodeOf` resolves a node id to the node as it is now. For a reader
 * that must know about both ends, see {@link checkEdgeEnds}.
 */
export function checkEdge(
  edge: EdgeEnds,
  nodeOf: (nodeId: string) => HandleNode | undefined,
): EdgeProblem | null {
  const ends = checkEdgeEnds(edge, nodeOf);
  return ends.source ?? ends.target;
}

/** What {@link checkEdgeEnds} found at each end of an edge; `null` where the end can attach. */
export type EdgeEndProblems = {
  /** The problem at the source end (`end: "source"`), if any. */
  readonly source: EdgeProblem | null;
  /** The problem at the target end (`end: "target"`), if any. */
  readonly target: EdgeProblem | null;
};

/**
 * {@link checkEdge}, for each end on its own: one end's problem does not hide
 * the other's. The edge can attach when both are `null`. For a reader that
 * decides per end, such as one that keeps an edge whose ends are at worst
 * `not-offered` and drops one with an `unknown-handle` at either.
 */
export function checkEdgeEnds(
  edge: EdgeEnds,
  nodeOf: (nodeId: string) => HandleNode | undefined,
): EdgeEndProblems {
  return {
    source: checkEnd("source", edge.sourceHandle, nodeOf(edge.source)),
    target: checkEnd("target", edge.targetHandle, nodeOf(edge.target)),
  };
}

function checkEnd(
  end: "source" | "target",
  handle: string | null | undefined,
  node: HandleNode | undefined,
): EdgeProblem | null {
  if (!node) return { end, reason: "missing-node" };
  const type = node.type ?? "";
  if (!isComponentType(type)) return { end, reason: "unknown-type", type };

  const side = end === "source" ? "emits" : "ports";
  const live = liveHandles(type, node.data)[side];
  if (typeof handle === "string" && live.includes(handle)) return null;

  const declared: readonly string[] = (end === "source" ? COMPONENT_EMITS : COMPONENT_PORTS)[type];
  if (typeof handle !== "string" || !declared.includes(handle)) {
    return { end, reason: "unknown-handle", type, handle: handle ?? null, live };
  }
  const variants = handleVariants(type);
  const elsewhere = [variants.defaults, ...variants.bySettings.map((variant) => variant.handles)];
  const offered = elsewhere.some((set) => set[side].includes(handle)) ? "other-settings" : "never";
  return { end, reason: "not-offered", type, handle, live, offered };
}
