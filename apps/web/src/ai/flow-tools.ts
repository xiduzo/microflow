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
// in `nodes/node-data-resolver.ts`, over `NODE_CATALOG`), and no edge without
// both ends being in the Live Handle Set of their node (`checkEdge` in
// `nodes/handles.ts`): the handles the node offers with the settings it has
// now, which is what the canvas renders. A rejection is returned to the model
// as a tool result rather than thrown, so it corrects itself instead of the
// turn dying.

import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import type { FlowDocument, FlowEdge, FlowNode } from "@microflow/collab";

import { NODE_CATALOG } from "@/nodes/catalog.generated";
import { isComponentType, type ComponentType } from "@/nodes/component-types.generated";
import {
  checkEdge,
  handleVariants,
  liveHandles,
  type EdgeProblem,
  type HandleSet,
} from "@/nodes/handles";
import { useNodeDiagnosticsStore } from "@/nodes/live/node-diagnostics";
import { applyAutoLayout } from "@/editor/auto-layout";
import { resolveNodeData } from "@/nodes/node-data-resolver";
import { removeNodesWithEdges } from "@/session";
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

/** What the write tools read a flow through: the document, or the document with
 *  this turn's staged changes laid over it (see `stagedFlow`). */
type FlowView = Pick<FlowDocument, "getNode" | "getNodes" | "getEdge" | "getEdges">;

/** The edits the write tools make. One description of an edit can then be
 *  performed on the document, or laid over it while it waits for approval. */
type FlowEdits = {
  addNode(node: FlowNode): void;
  updateNodeData(nodeId: string, data: Record<string, unknown>): void;
  addEdge(edge: FlowEdge): void;
  removeEdge(edgeId: string): void;
  /** The node and every edge attached to it. */
  removeNode(nodeId: string): void;
};

/**
 * The flow as it will be once what a `confirm`-mode turn has staged is
 * approved: the document, with those edits laid over it. Nothing is written to
 * the document.
 *
 * The tools validate against this, not against the document, because a turn
 * builds on its own earlier steps: it stages `direction: "publish"` and then
 * connects to the `trigger` input that only a publishing node has, or stages a
 * node and then wires it. Checked against the document, the second step would
 * be refused for a flow the user is about to get.
 *
 * It covers one turn, the life of one tool set. Changes an earlier turn staged
 * and the user has not answered yet are not in it: a staged change is an
 * opaque thunk to everything outside the turn that made it. So a setting
 * staged in a later turn that takes away the handle of a connection staged in
 * an earlier one gets no "removed connection" line; on approval the session
 * removes that edge.
 */
function stagedFlow(doc: FlowDocument): FlowView & FlowEdits {
  // `null` is "staged for removal".
  const nodes = new Map<string, FlowNode | null>();
  const edges = new Map<string, FlowEdge | null>();
  const overlay = <T extends { id: string }>(base: T[], staged: Map<string, T | null>): T[] => [
    ...base.filter((item) => !staged.has(item.id)),
    ...[...staged.values()].filter((item): item is T => item !== null),
  ];
  const view: FlowView & FlowEdits = {
    getNode: (id) => (nodes.has(id) ? (nodes.get(id) ?? undefined) : doc.getNode(id)),
    getNodes: () => overlay(doc.getNodes(), nodes),
    getEdge: (id) => (edges.has(id) ? (edges.get(id) ?? undefined) : doc.getEdge(id)),
    getEdges: () => overlay(doc.getEdges(), edges),
    addNode: (node) => void nodes.set(node.id, node),
    updateNodeData(nodeId, data) {
      const node = view.getNode(nodeId);
      if (node) nodes.set(nodeId, { ...node, data: { ...node.data, ...data } });
    },
    addEdge: (edge) => void edges.set(edge.id, edge),
    removeEdge: (edgeId) => void edges.set(edgeId, null),
    removeNode(nodeId) {
      for (const edge of view.getEdges()) {
        if (edge.source === nodeId || edge.target === nodeId) edges.set(edge.id, null);
      }
      nodes.set(nodeId, null);
    },
  };
  return view;
}

/** Resolve a node id to its component type, or `undefined` if it is gone or
 *  carries a type the catalogue does not know. */
function typeOf(doc: FlowView, nodeId: string): ComponentType | undefined {
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
function resolveNode(doc: FlowView, ref: string): { ok: true; id: string } | { ok: false; error: string } {
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

/**
 * Say why an edge was refused, in the terms the model used, with the handles
 * it can use instead: without them it cannot correct itself.
 *
 * A handle the node would offer with other settings gets "with its current
 * settings": the fix is then another handle or an `update_node_data` first,
 * not another node. A handle the component declares but the node never offers
 * reads like one that does not exist, because for wiring it does not.
 */
function describeRefusedHandle(
  problem: Extract<EdgeProblem, { reason: "unknown-handle" | "not-offered" }>,
): string {
  const output = problem.end === "source";
  const settings =
    problem.reason === "not-offered" && problem.offered === "other-settings"
      ? " with its current settings"
      : "";
  const offered = problem.live.join(", ") || "(nothing)";
  // Where the deciding setting is not one to set (a design variable's type),
  // say what it follows, or the model sets it to get the handle.
  const follows = settings ? handleVariants(problem.type).follows : undefined;
  const notYours = follows ? `. Its handles follow ${follows}; that is not a setting to change` : "";
  return `${problem.type} has no ${output ? "output" : "input"} '${problem.handle ?? ""}'${settings} — it ${output ? "emits" : "accepts"}: ${offered}${notYours}`;
}

/** The edges at a handle that `nodeId` offers in `before` and no longer in `after`. */
function edgesAtVanishedHandles(
  edges: readonly FlowEdge[],
  nodeId: string,
  before: HandleSet,
  after: HandleSet,
): FlowEdge[] {
  const gone = (was: readonly string[], is: readonly string[], handle: string | null | undefined) =>
    !!handle && was.includes(handle) && !is.includes(handle);
  return edges.filter(
    (edge) =>
      (edge.source === nodeId && gone(before.emits, after.emits, edge.sourceHandle)) ||
      (edge.target === nodeId && gone(before.ports, after.ports, edge.targetHandle)),
  );
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
  // No `data` at all: `add_node` may leave it out, and the node then has its
  // defaults. Only `undefined` gets here in a turn. A `null` is turned down
  // before the tool runs, by its own schema and by the MCP gate
  // (`mcp-bridge.ts`); it reads as no data too.
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

  /** Edits performed on the document. */
  const onDocument: FlowEdits = {
    addNode: (node) => doc.addNode(node),
    updateNodeData: (nodeId, data) => doc.updateNodeData(nodeId, data),
    addEdge: (edge) => doc.addEdge(edge),
    removeEdge: (edgeId) => doc.removeEdge(edgeId),
    // Through the shared edit, not `doc.deleteNode`: that removes the node only
    // and left its edges pointing at nothing in the document.
    removeNode: (nodeId) => void removeNodesWithEdges(doc, [nodeId]),
  };
  /**
   * What the write tools validate against. In `confirm` mode that is the flow
   * with this turn's staged edits applied; in `auto` mode nothing is ever
   * staged, so it is the document.
   */
  const flow = stagedFlow(doc);

  /**
   * Perform or stage one mutation, depending on the mode. `edit` describes it
   * once; it is run on the document now (`auto`) or on approval (`confirm`),
   * and in `confirm` mode on the staged flow right away, so the turn's next
   * call sees it.
   *
   * `structural` mutations (anything that adds or removes a node or a wire)
   * re-run the same auto-layout the dock button uses. The model has no sense of
   * canvas geometry and should not be given one — it reasons about wiring, and
   * the layout falls out of the graph it built. A config edit that changes no
   * wire leaves positions alone, so a flow the user arranged by hand is not
   * snapped for a pin change. One that takes a handle away removes the wires at
   * it, and each of those removals is structural like any other removed wire.
   */
  const write = (
    summary: string,
    edit: (target: FlowEdits) => void,
    structural = false,
  ): ToolResult => {
    const run = () => {
      edit(onDocument);
      if (structural) applyAutoLayout(doc);
    };
    if (mode === "confirm") {
      stage({ id: uid(), summary, apply: run });
      edit(flow);
      return ok(`staged for the user to approve: ${summary}`);
    }
    run();
    return ok(summary);
  };

  const getFlow = toolDefinition({
    name: "get_flow",
    description:
      "Read the current flow: every node with its id, type and configuration, and every edge with its handles. Changes you have staged for the user's approval in this turn are included. Call this first.",
    inputSchema: z.object({}),
  }).server(() => {
    // The same flow the write tools validate against, so the model sees what
    // it has staged and is not refused for a state it cannot read.
    const nodes = flow.getNodes().map((node) => ({
      id: node.id,
      type: node.type,
      // Position is layout, not behaviour — omitting it keeps the model's
      // attention on wiring and keeps the payload small.
      data: node.data,
    }));
    return { nodes, edges: flow.getEdges() };
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
    const resolved = (Object.keys(NODE_CATALOG) as ComponentType[]).find(
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
    return write(`added ${resolved} (id ${node.id})`, (target) => target.addNode(node), true);
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
    const found = resolveNode(flow, input.nodeId);
    if (!found.ok) return fail(found.error);
    const nodeId = found.id;
    const data = input.data;
    const existing = flow.getNode(nodeId);
    if (!existing) return fail(`no node '${nodeId}' in this flow`);
    const type = typeOf(flow, nodeId);
    if (!type) return fail(`node '${nodeId}' has an unknown type '${existing.type}'`);

    const coerced = coerceData(data);
    if (!coerced.ok) return fail(coerced.error);
    const validated = resolveNodeData(type, coerced.data, existing.data);
    if (!validated.ok) return fail(validated.error);

    // A setting that takes a handle off the node takes the edges at it too,
    // and that is part of this edit, named. The session would remove them as
    // well once the change is in the document, but only when the handle is
    // still gone after the whole transaction: an approval applies a turn's
    // edits as one, and a staged connect followed by this would slip through.
    // It also keeps the user's approval honest: a line per edge it removes.
    const orphaned = edgesAtVanishedHandles(
      flow.getEdges(),
      nodeId,
      liveHandles(type, existing.data),
      liveHandles(type, validated.data),
    );
    const wire = (edge: FlowEdge) =>
      `${typeOf(flow, edge.source) ?? edge.source}.${edge.sourceHandle} → ${typeOf(flow, edge.target) ?? edge.target}.${edge.targetHandle}`;

    const changed = Object.keys(coerced.data).join(", ");
    const results = [
      write(`updated ${type} ${nodeId} (${changed})`, (target) =>
        target.updateNodeData(nodeId, validated.data),
      ),
      ...orphaned.map((edge) =>
        write(
          `removed connection ${wire(edge)} (${type} ${nodeId} no longer has that ${edge.target === nodeId ? "input" : "output"})`,
          (target) => target.removeEdge(edge.id),
          true,
        ),
      ),
    ];
    return ok(results.map((result) => (result.ok ? result.detail : result.error)).join("; "));
  });

  const connect = toolDefinition({
    name: "connect",
    description:
      "Wire one node's output to another node's input. `sourceHandle` must be one of the source node's outputs and `targetHandle` one of the target node's inputs, exactly as named in the catalogue. Some handles depend on the node's configuration; a rejection lists the ones the node has now.",
    inputSchema: z.object({
      source: z.string().describe("id of the node the value comes from"),
      sourceHandle: z.string().describe("output (emit) name on the source node"),
      target: z.string().describe("id of the node the value goes to"),
      targetHandle: z.string().describe("input (port) name on the target node"),
    }),
  }).server((input) => {
    const from = resolveNode(flow, input.source);
    if (!from.ok) return fail(from.error);
    const to = resolveNode(flow, input.target);
    if (!to.ok) return fail(to.error);
    const { sourceHandle, targetHandle } = input;
    const source = from.id;
    const target = to.id;

    const sourceType = typeOf(flow, source);
    if (!sourceType) return fail(`no node '${source}' in this flow`);
    const targetType = typeOf(flow, target);
    if (!targetType) return fail(`no node '${target}' in this flow`);

    // Only a handle the node offers as it is (or is staged to be) configured:
    // an edge anywhere else would be in the flow with nothing on the canvas to
    // show or delete it.
    const problem = checkEdge({ source, sourceHandle, target, targetHandle }, (id) =>
      flow.getNode(id),
    );
    if (problem?.reason === "unknown-handle" || problem?.reason === "not-offered") {
      return fail(describeRefusedHandle(problem));
    }
    // Both nodes exist and have a known type (checked above), so this cannot happen.
    if (problem) return fail(`cannot connect '${source}' to '${target}'`);
    const duplicate = flow
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
      (target) => target.addEdge(edge),
      true,
    );
  });

  const deleteNode = toolDefinition({
    name: "delete_node",
    description: "Remove a node and every edge attached to it.",
    inputSchema: z.object({ nodeId: z.string() }),
  }).server((input) => {
    const found = resolveNode(flow, input.nodeId);
    if (!found.ok) return fail(found.error);
    const nodeId = found.id;
    const type = flow.getNode(nodeId)?.type;
    if (!type) return fail(`no node '${nodeId}' in this flow`);
    return write(`deleted ${type} ${nodeId}`, (target) => target.removeNode(nodeId), true);
  });

  const deleteEdge = toolDefinition({
    name: "delete_edge",
    description: "Remove one connection. Get its id from get_flow.",
    inputSchema: z.object({ edgeId: z.string() }),
  }).server(({ edgeId }) => {
    if (!flow.getEdge(edgeId)) return fail(`no edge '${edgeId}' in this flow`);
    return write(`deleted edge ${edgeId}`, (target) => target.removeEdge(edgeId), true);
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
