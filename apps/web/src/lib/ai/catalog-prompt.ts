// The node vocabulary Ask AI works from.
//
// Built at module load out of the same generated sources the editor itself uses
// — `NODE_REGISTRY` for labels/descriptions/defaults, and `COMPONENT_PORTS` /
// `COMPONENT_EMITS` for handles, both of which the Catalog Parity Guard pins to
// the Rust `Component::ports()` / `emits()` (ADR-0007). So the catalogue the
// model is given cannot drift from the one the runtime enforces: add a node or
// rename a handle and this text follows on the next `bun run codegen`.
//
// Inlined into the system prompt rather than offered as a `list_node_types`
// tool. Forty nodes is a few thousand tokens once, against a tool round-trip on
// every conversation — and a model that can see the whole palette proposes
// better flows than one that has to guess what to ask for.

import type { FlowDocument } from "@microflow/collab";

import { NODE_REGISTRY } from "@/components/flow/nodes/_REGISTRY";
import {
  COMPONENT_EMITS,
  COMPONENT_PORTS,
  REQUIRES_HARDWARE,
  type ComponentType,
} from "@/components/flow/nodes/_base/_base.types";

/** Keys every node's `defaults` carries for the editor's own chrome; they are
 *  not configuration and only distract the model. */
const PRESENTATION_KEYS = new Set(["group", "label", "description", "tags", "icon"]);

/** One catalogue line per node: what it is, what it accepts, what it emits, and
 *  the config keys it takes with their default values. */
function describe(type: ComponentType): string {
  const { defaults } = NODE_REGISTRY[type];
  const ports = COMPONENT_PORTS[type];
  const emits = COMPONENT_EMITS[type];

  const config = Object.entries(defaults)
    .filter(([key]) => !PRESENTATION_KEYS.has(key) && key !== "instance")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  const parts = [
    `- ${type}: ${defaults.description ?? defaults.label ?? type}`,
    `  in: ${ports.length > 0 ? ports.join(", ") : "(none)"}`,
    `  out: ${emits.length > 0 ? emits.join(", ") : "(none)"}`,
  ];
  if (config.length > 0) parts.push(`  config: ${config.join(", ")}`);
  if (REQUIRES_HARDWARE[type]) parts.push("  needs a connected board");
  return parts.join("\n");
}

/** The catalogue, grouped the way the editor's own node picker groups it, so the
 *  model reaches for the same vocabulary a user would. */
export const NODE_CATALOG = (() => {
  const byGroup = new Map<string, ComponentType[]>();
  for (const type of Object.keys(NODE_REGISTRY) as ComponentType[]) {
    const group = (NODE_REGISTRY[type].defaults.group as string | undefined) ?? "sense";
    if (group === "internal") continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), type]);
  }
  return [...byGroup.entries()]
    .map(([group, types]) => `## ${group}\n${types.map(describe).join("\n")}`)
    .join("\n\n");
})();

/**
 * The system prompt.
 *
 * Two things it has to get across that a catalogue alone does not: a Microflow
 * edge always joins a named emit to a named port (so "connect A to B" is
 * underspecified), and the tools already validate, so a rejected call is
 * information to act on rather than a failure to apologise for.
 */
export function askAiSystemPrompt(canWrite: boolean): string {
  const capability = canWrite
    ? `You can change the flow with add_node, update_node_data, connect, delete_node and
delete_edge. Prefer the smallest change that answers the request, and read the flow
first — reusing a node the user already placed beats adding a second one beside it.`
    : `You are in read-only mode: you can inspect the flow and its diagnostics but must
not propose tool calls that change it. Describe the change you would make instead.`;

  return `You are the assistant inside Microflow, a visual editor where people wire nodes
together to program microcontrollers (Arduino and friends). You help build and debug
their flow.

A flow is nodes plus edges. Every edge runs from a named OUTPUT (an "emit") on one
node to a named INPUT (a "port") on another — never node-to-node. Use the exact handle
names from the catalogue below; a connection with a handle that does not exist is
rejected.

${capability}

Start by calling get_flow so you are working from what is actually on the canvas.
When the user reports something not working, call get_diagnostics too: the runtime
reports per-node hardware faults there (an I2C device that never answers, for
instance), which is usually the fastest route to the real cause.

Node data is validated against each node's schema before it is written. If a call is
rejected, read the error, fix the arguments and try again — do not tell the user you
were unable to do it until you have.

Pin numbers matter and boards differ. If a pin is not stated and cannot be inferred
from the existing flow, ask rather than guess.

Be brief. When you have changed the flow, say what you changed in a sentence or two —
the user can see the canvas.

# Node catalogue

${NODE_CATALOG}`;
}

/**
 * The canvas as it stands, injected on every turn.
 *
 * `get_flow` exists and the prompt asks for it, but a small local model happily
 * skips it and builds a second Button beside the one it placed a turn ago —
 * tool results are not in the transcript, so without this it is blind to its own
 * work. Handing it the state costs a few hundred tokens and removes the failure.
 *
 * A selection narrows it: with nodes highlighted the user is talking about
 * those, so those are what the model is shown (plus the edges between them),
 * and a big flow stops crowding out the question.
 */
export function currentFlowPrompt(doc: FlowDocument, selectedNodeIds: string[] = []): string {
  const all = doc.getNodes();
  if (all.length === 0) return "# Current flow\n\nThe canvas is empty.";

  const selection = new Set(selectedNodeIds.filter((id) => doc.getNode(id)));
  const scoped = selection.size > 0;
  const nodes = scoped ? all.filter((node) => selection.has(node.id)) : all;
  const edges = doc
    .getEdges()
    .filter(
      (edge) => !scoped || (selection.has(edge.source) && selection.has(edge.target)),
    );

  const describeNode = (node: (typeof nodes)[number]) => {
    const config = Object.entries(node.data ?? {})
      .filter(([key]) => !PRESENTATION_KEYS.has(key) && key !== "instance")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    return `- ${node.id}: ${node.type}${config ? ` (${config})` : ""}`;
  };

  const heading = scoped
    ? `The user has selected these ${nodes.length} of ${all.length} nodes — unless they say
otherwise, they are asking about this selection. Call get_flow if you need the rest.`
    : `These nodes are already on the canvas. Reuse and update them with
update_node_data rather than adding duplicates.`;

  return `# Current flow

${heading}

${nodes.map(describeNode).join("\n")}

Edges:
${
  edges.length > 0
    ? edges
        .map(
          (edge) =>
            `- ${edge.id}: ${edge.source}.${edge.sourceHandle} → ${edge.target}.${edge.targetHandle}`,
        )
        .join("\n")
    : "(none)"
}`;
}
