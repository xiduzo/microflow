// The tools Ask AI drives the flow with.
//
// Every write goes through the session's `FlowDocument`, which is the same API
// the canvas itself uses. That is deliberate and it is what makes this feature
// small: an AI edit lands in Yjs exactly like a human one, so it syncs to
// collaborators, feeds the `FlowUpdateDispatcher`, reaches a connected board,
// and lands on the undo stack — none of which needed anything new.
//
// The document is a shared, persisted structure, so this is a trust boundary:
// a model can and will invent a field name, a handle, or an enum value. Nothing
// reaches the doc without passing the node's own zod schema (`resolveNodeData`
// in `lib/node-data.ts`, over `NODE_REGISTRY`) and the generated handle sets (`COMPONENT_PORTS` / `COMPONENT_EMITS`, pinned
// to the Rust `Component::ports()` / `emits()` by the Catalog Parity Guard,
// ADR-0007). A rejection is returned to the model as a tool result rather than
// thrown, so it corrects itself instead of the turn dying.

import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import type { FlowDocument, FlowEdge, FlowNode } from "@microflow/collab";

import { NODE_REGISTRY } from "@/components/flow/nodes/_REGISTRY";
import {
  COMPONENT_EMITS,
  COMPONENT_PORTS,
  isComponentType,
  type ComponentType,
} from "@/components/flow/nodes/_base/_base.types";
import { useNodeDiagnosticsStore } from "@/stores/node-diagnostics";
import { applyAutoLayout } from "@/lib/auto-layout";
import { resolveNodeData } from "@/lib/node-data";
import { uid } from "@/lib/uid";

/** How a write tool's effect is delivered. */
export type WriteMode = "auto" | "confirm" | "read-only";

/** One staged mutation in `confirm` mode: a human-readable line for the diff
 *  card plus the thunk that performs it if the user accepts. */
export type PendingChange = {
  id: string;
  summary: string;
  apply: () => void;
};

/** What a tool call reports back to the model. Kept as data (never a throw) so a
 *  rejection is something it can act on. */
type ToolResult = { ok: true; detail: string } | { ok: false; error: string };

const ok = (detail: string): ToolResult => ({ ok: true, detail });
const fail = (error: string): ToolResult => ({ ok: false, error });

/** Resolve a node id to its component type, or `undefined` if it is gone or
 *  carries a type the catalogue does not know. */
function typeOf(doc: FlowDocument, nodeId: string): ComponentType | undefined {
  const type = doc.getNode(nodeId)?.type;
  return type && isComponentType(type) ? type : undefined;
}

/**
 * Resolve what the model called a node into a real node id.
 *
 * Ids are random strings, and a model — especially a small local one — reaches
 * for the type name it just created instead ("Button"). When exactly one node of
 * that type exists there is nothing ambiguous about it, so accept it: the
 * alternative is a rejected call for a request that was perfectly clear.
 */
function resolveNode(doc: FlowDocument, ref: string): { ok: true; id: string } | { ok: false; error: string } {
  if (doc.getNode(ref)) return { ok: true, id: ref };
  const byType = doc.getNodes().filter((n) => n.type?.toLowerCase() === ref.toLowerCase());
  if (byType.length === 1) return { ok: true, id: byType[0].id };
  if (byType.length > 1) {
    return {
      ok: false,
      error: `this flow has ${byType.length} ${ref} nodes — use one of these ids: ${byType.map((n) => n.id).join(", ")}`,
    };
  }
  return { ok: false, error: `no node '${ref}' in this flow — call get_flow for the ids` };
}

/** `data` as the model may send it: the object it should be, or the string a
 *  small model often makes of a nested object. Both types stay in the JSON
 *  schema — an untyped field tells the model nothing about what to send. */
const DATA_INPUT = z.union([z.record(z.string(), z.unknown()), z.string()]);

/**
 * Accept a node's `data` in whatever shape the model managed.
 *
 * Small local models routinely send a nested object as a *string* — sometimes
 * JSON, often something JSON-ish like `{pin:2, control:PinController}`. Letting
 * the tool's own schema reject that is the worst outcome available: the
 * framework's generic "input validation failed" reaches the model instead of
 * ours, and a small model reacts by abandoning the tool API and typing its
 * calls out as prose. So `data` is taken as `unknown` and normalised here,
 * where a rejection can say what a correct call looks like.
 */
function coerceData(value: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (value == null) return { ok: true, data: {} };
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, data: value as Record<string, unknown> };
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, data: parsed as Record<string, unknown> };
      }
    } catch {
      // falls through to the same advice as any other wrong shape
    }
  }
  return {
    ok: false,
    error:
      'data must be an object of config fields, not a string — send it as an object, e.g. {"pin": 13}',
  };
}

export type FlowToolsOptions = {
  mode: WriteMode;
  /** Called in `confirm` mode instead of writing. */
  stage: (change: PendingChange) => void;
};

/**
 * Build the tool set for one conversation.
 *
 * In `read-only` mode the write tools are not returned at all rather than
 * returned-and-refusing: a tool the model cannot see is one it cannot spend a
 * turn being told off for calling.
 */
export function createFlowTools(doc: FlowDocument, options: FlowToolsOptions) {
  const { mode, stage } = options;

  /**
   * Perform or stage one mutation, depending on the mode.
   *
   * `structural` mutations (anything that adds or removes a node or a wire)
   * re-run the same auto-layout the dock button uses. The model has no sense of
   * canvas geometry and should not be given one — it reasons about wiring, and
   * the layout falls out of the graph it built. Config edits leave positions
   * alone, so a flow the user arranged by hand is not snapped for a pin change.
   */
  const write = (summary: string, apply: () => void, structural = false): ToolResult => {
    const run = structural
      ? () => {
          apply();
          applyAutoLayout(doc);
        }
      : apply;
    if (mode === "confirm") {
      stage({ id: uid(), summary, apply: run });
      return ok(`staged for the user to approve: ${summary}`);
    }
    run();
    return ok(summary);
  };

  const getFlow = toolDefinition({
    name: "get_flow",
    description:
      "Read the current flow: every node with its id, type and configuration, and every edge with its handles. Call this first.",
    inputSchema: z.object({}),
  }).server(() => {
    const nodes = doc.getNodes().map((node) => ({
      id: node.id,
      type: node.type,
      // Position is layout, not behaviour — omitting it keeps the model's
      // attention on wiring and keeps the payload small.
      data: node.data,
    }));
    return { nodes, edges: doc.getEdges() };
  });

  const getDiagnostics = toolDefinition({
    name: "get_diagnostics",
    description:
      "Read the runtime's per-node health reports (hardware faults such as an I2C device that never answers). Empty means nothing is currently reporting a fault. Use this when the user says something is not working.",
    inputSchema: z.object({}),
  }).server(() => {
    const diagnostics = useNodeDiagnosticsStore.getState().diagnostics;
    return Object.entries(diagnostics).map(([nodeId, d]) => ({
      nodeId,
      type: doc.getNode(nodeId)?.type,
      level: d.level,
      message: d.message,
    }));
  });

  const readTools = [getFlow, getDiagnostics];
  if (mode === "read-only") return readTools;

  const addNode = toolDefinition({
    name: "add_node",
    description:
      "Add a node to the flow. `type` must be one from the catalogue. `data` may set only the fields you care about; the rest take the node's defaults.",
    inputSchema: z.object({
      type: z.string().describe("Component type, e.g. 'Led' or 'Button'"),
      data: DATA_INPUT.optional().describe('Config fields as an object, e.g. {"pin": 13}'),
    }),
  }).server(({ type, data }) => {
    // Case-insensitive: the catalogue says `Led`, a model will write `led`, and
    // spending a round trip on that teaches it nothing.
    const resolved = (Object.keys(NODE_REGISTRY) as ComponentType[]).find(
      (candidate) => candidate.toLowerCase() === String(type).toLowerCase(),
    );
    if (!resolved || !isComponentType(resolved)) {
      return fail(`unknown node type '${type}' — use one from the catalogue`);
    }
    const coerced = coerceData(data);
    if (!coerced.ok) return fail(coerced.error);
    const validated = resolveNodeData(resolved, coerced.data);
    if (!validated.ok) return fail(validated.error);

    const node: FlowNode = {
      id: uid(),
      type: resolved,
      // Placeholder: the structural write below lays the whole flow out.
      position: { x: 0, y: 0 },
      data: validated.data,
    };
    return write(`added ${resolved} (id ${node.id})`, () => doc.addNode(node), true);
  });

  const updateNodeData = toolDefinition({
    name: "update_node_data",
    description:
      "Change a node's configuration. Pass only the fields you want to change; the others are left as they are.",
    inputSchema: z.object({
      nodeId: z.string(),
      data: DATA_INPUT.describe('Fields to change, as an object, e.g. {"pin": 13}'),
    }),
  }).server((input) => {
    const found = resolveNode(doc, input.nodeId);
    if (!found.ok) return fail(found.error);
    const nodeId = found.id;
    const data = input.data;
    const existing = doc.getNode(nodeId);
    if (!existing) return fail(`no node '${nodeId}' in this flow`);
    const type = typeOf(doc, nodeId);
    if (!type) return fail(`node '${nodeId}' has an unknown type '${existing.type}'`);

    const coerced = coerceData(data);
    if (!coerced.ok) return fail(coerced.error);
    const validated = resolveNodeData(type, coerced.data, existing.data);
    if (!validated.ok) return fail(validated.error);

    const changed = Object.keys(coerced.data).join(", ");
    return write(`updated ${type} ${nodeId} (${changed})`, () =>
      doc.updateNodeData(nodeId, validated.data),
    );
  });

  const connect = toolDefinition({
    name: "connect",
    description:
      "Wire one node's output to another node's input. `sourceHandle` must be one of the source type's outputs and `targetHandle` one of the target type's inputs, exactly as named in the catalogue.",
    inputSchema: z.object({
      source: z.string().describe("id of the node the value comes from"),
      sourceHandle: z.string().describe("output (emit) name on the source node"),
      target: z.string().describe("id of the node the value goes to"),
      targetHandle: z.string().describe("input (port) name on the target node"),
    }),
  }).server((input) => {
    const from = resolveNode(doc, input.source);
    if (!from.ok) return fail(from.error);
    const to = resolveNode(doc, input.target);
    if (!to.ok) return fail(to.error);
    const { sourceHandle, targetHandle } = input;
    const source = from.id;
    const target = to.id;

    const sourceType = typeOf(doc, source);
    if (!sourceType) return fail(`no node '${source}' in this flow`);
    const targetType = typeOf(doc, target);
    if (!targetType) return fail(`no node '${target}' in this flow`);

    const emits: readonly string[] = COMPONENT_EMITS[sourceType];
    if (!emits.includes(sourceHandle)) {
      return fail(
        `${sourceType} has no output '${sourceHandle}' — it emits: ${emits.join(", ") || "(nothing)"}`,
      );
    }
    const ports: readonly string[] = COMPONENT_PORTS[targetType];
    if (!ports.includes(targetHandle)) {
      return fail(
        `${targetType} has no input '${targetHandle}' — it accepts: ${ports.join(", ") || "(nothing)"}`,
      );
    }
    const duplicate = doc
      .getEdges()
      .some(
        (edge) =>
          edge.source === source &&
          edge.sourceHandle === sourceHandle &&
          edge.target === target &&
          edge.targetHandle === targetHandle,
      );
    if (duplicate) return fail("that connection already exists");

    const edge: FlowEdge = {
      id: uid(),
      source,
      sourceHandle,
      target,
      targetHandle,
      // The canvas's own edge type, so an AI-made wire animates like a hand-made
      // one rather than rendering as a plain line.
      type: "animated",
    };
    return write(
      `connected ${sourceType}.${sourceHandle} → ${targetType}.${targetHandle}`,
      () => doc.addEdge(edge),
      true,
    );
  });

  const deleteNode = toolDefinition({
    name: "delete_node",
    description: "Remove a node and every edge attached to it.",
    inputSchema: z.object({ nodeId: z.string() }),
  }).server((input) => {
    const found = resolveNode(doc, input.nodeId);
    if (!found.ok) return fail(found.error);
    const nodeId = found.id;
    const type = doc.getNode(nodeId)?.type;
    if (!type) return fail(`no node '${nodeId}' in this flow`);
    return write(`deleted ${type} ${nodeId}`, () => doc.deleteNode(nodeId), true);
  });

  const deleteEdge = toolDefinition({
    name: "delete_edge",
    description: "Remove one connection. Get its id from get_flow.",
    inputSchema: z.object({ edgeId: z.string() }),
  }).server(({ edgeId }) => {
    if (!doc.getEdge(edgeId)) return fail(`no edge '${edgeId}' in this flow`);
    return write(`deleted edge ${edgeId}`, () => doc.removeEdge(edgeId), true);
  });

  return [...readTools, addNode, updateNodeData, connect, deleteNode, deleteEdge];
}

/**
 * Apply a batch of staged changes as one document transaction, so the whole
 * approved set is a single undo step.
 *
 * `FlowDocument`'s own methods each open a transaction with the `"local"` origin
 * the `UndoManager` tracks; Yjs collapses nested transactions into the outer
 * one, so wrapping them here is all it takes.
 */
export function applyChanges(doc: FlowDocument, changes: PendingChange[]): void {
  if (changes.length === 0) return;
  doc.doc.transact(() => {
    for (const change of changes) change.apply();
  }, "local");
}
