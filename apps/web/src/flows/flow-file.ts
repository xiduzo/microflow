// The Flow File codec: the JSON text a flow is exported to and imported from.
//
// `encodeFlowFile` writes it. `decodeFlowFile` is the load boundary for a file:
// it takes text nobody has checked and returns either a flow ready to land, with
// an account of everything it assumed, completed or left out, or the reason the
// file cannot be read. Nothing past this module sees an unchecked file.
//
// **What decode does with a file that is not clean.** A file is treated as a
// stored flow with the same defect is treated when it is opened, and whatever
// then differs from the file is said in a notice.
//
// - Text that cannot be a flow at all is refused: not JSON, no nodes and edges,
//   a node or an edge that is not an object or has no usable id, an edge
//   without ends, two nodes or two edges with one id (the document is keyed by
//   id, so the second would replace the first unseen), a version that is not a
//   whole number or is newer than this build writes, a file beyond the limits
//   below.
// - A node goes through the document's own read path (`FlowDocument`), so one
//   without a usable type, position or size becomes what a stored node with
//   that defect is: no type, placed at 0, unsized.
// - A node of a type this build does not know is kept. The document keeps such
//   a node too, and the runtime reports it as not running.
// - Node settings go through the Node Data Resolver, so a setting the file does
//   not have gets its default, as a template node's does. A setting the node's
//   schema does not name is kept. Settings the schema does not accept are kept
//   exactly as they are in the file: a document holds such values too (an
//   option stored under an old label), the app opens that flow, and resetting
//   them would lose what the user chose.
// - An edge is decoded into the shape the app writes one in, and nothing else:
//   its id, its two nodes, the handle it names at each, and its type
//   (`readEdge`, through the document's own `decodeEdge`). The document reads
//   a stored edge the same way, so whatever else a file has on an edge is not
//   taken over. None of it is content the app can show; it goes unremarked.
// - An edge to a node that is not in the file is left out. It attaches to
//   nothing: the canvas cannot draw it and the runtime drops it.
// - An edge that names no handle at one of its ends (none, an empty one, or
//   something that is not a name) is left out. It carries nothing, the canvas
//   cannot draw it, so the user could not remove it, and sketch generation
//   requires both handles of every edge it is given.
// - Every other edge is kept, whatever handle it names. One at a handle the
//   component declares and the node does not offer as configured (Servo
//   `rotate`, the `value` of a publishing Mqtt node) is part of how the flow
//   behaves: the runtime honours it. One at a handle nothing declares is kept
//   too: the session keeps such an edge in a stored flow
//   (`session/handle-pruning.ts` removes an edge when its handle vanishes,
//   never because the edge is there), and it may name a handle a newer build
//   has. `endVerdict` is the one place this is decided.
//
// **Decode is total.** For any text it returns a flow or a refusal, in time
// bounded by the limits below; file content only reaches a message clipped.
//
// React-free and DOM-free: importing this loads no node UI.

import {
  FlowDocument,
  decodeEdge,
  isValueEqual,
  type FlowData,
  type FlowEdge,
  type FlowMeta,
  type FlowNode,
} from "@microflow/collab";
import { isComponentType } from "@/nodes/component-types.generated";
import { checkEdgeEnds, type EdgeProblem } from "@/nodes/handles";
import { resolveNodeData } from "@/nodes/node-data-resolver";

/**
 * The format `encodeFlowFile` writes, as the file's top-level `version`.
 *
 * A change to the format raises this, and `decodeFlowFile` gains the step that
 * brings a file of the previous version forward. A file of a newer version is
 * refused.
 */
export const FLOW_FILE_VERSION = 1;

// The limits of a flow file. Each is far above any flow the app can hold, and
// together they bound what one import can cost: the file is parsed and checked
// on the main thread.

/**
 * How large a flow file may be, in bytes or characters. Almost all of a large
 * flow is audio: a Music node holds up to 6 MB of it inline, 8 MB as base64.
 * This is eight such nodes.
 */
export const MAX_FLOW_FILE_SIZE = 64 * 1024 * 1024;
/** A canvas holds some tens of nodes; with a thousand it no longer moves. */
const MAX_NODES = 5_000;
const MAX_EDGES = 20_000;
/**
 * How deep the file's JSON may nest, counted from its root. A node's settings
 * sit four levels down and nest three or four levels themselves.
 */
const MAX_DEPTH = 64;

/**
 * The longest name a flow may have. The server's `flow.create` and
 * `flow.createFromImport` refuse a longer one (`packages/api/src/routers/flow.ts`);
 * the limit is written there as a literal, so it is repeated here.
 */
export const MAX_NAME_LENGTH = 100;

/** How much of an id, a type, a label or a handle name a message shows. */
const SHOWN_NAME_LENGTH = 40;
/** How many settings a message lists by name. */
const SHOWN_FIELDS = 5;

/** The flow a file holds, checked and ready to land. */
export type DecodedFlow = {
  /** The flow's name, at most 100 characters; absent when the file has none. */
  name?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

/**
 * One thing `decodeFlowFile` did not take over from the file unchanged and
 * unremarked. `kind` says what happened to the content:
 *
 * - `name-shortened`: the flow's name was longer than a flow's name may be.
 * - `unknown-node-type`: the node is kept; it has no type, or one this build
 *   does not know, and will not run.
 * - `position-defaulted`: the node is kept; it had no usable position and is
 *   placed where the document places such a node.
 * - `settings-defaulted`: the node is kept; settings the file did not have got
 *   their defaults.
 * - `settings-unrecognised`: the node and its settings are kept as they are in
 *   the file; the node's own schema does not accept them.
 * - `edge-dropped`: the edge is not in the decoded flow; one of its nodes is
 *   not in the file, or it names no handle at one of its ends.
 * - `unknown-handle`: the edge is kept; at one end it names a handle nothing
 *   declares for its node, so it carries nothing and the canvas has nowhere to
 *   draw it.
 * - `edges-not-drawn`: once per file, for all the edges kept at a handle their
 *   node declares and does not offer as configured. They work when the flow
 *   runs; the canvas does not show them.
 */
export type FlowFileNotice = {
  kind:
    | "name-shortened"
    | "unknown-node-type"
    | "position-defaulted"
    | "settings-defaulted"
    | "settings-unrecognised"
    | "edge-dropped"
    | "unknown-handle"
    | "edges-not-drawn";
  /** The id of the node or edge this is about; absent when it is about the flow. */
  id?: string;
  /** One sentence for the user. */
  message: string;
};

export type FlowFileRefusal = {
  ok: false;
  /** One sentence for the user: why the file cannot be read. */
  problem: string;
};

export type DecodedFlowFile = { ok: true; flow: DecodedFlow; notices: FlowFileNotice[] } | FlowFileRefusal;

/**
 * The export file for a flow, as JSON text.
 *
 * `exportedAt` is the moment of the export; it also stands in for the flow's
 * `updatedAt` when `meta` has none.
 */
export function encodeFlowFile(
  meta: Pick<FlowMeta, "name"> & Partial<FlowMeta>,
  data: FlowData,
  exportedAt: Date = new Date(),
): string {
  return JSON.stringify(
    {
      meta: {
        name: meta.name ?? "flow",
        description: meta.description,
        version: meta.version ?? 1,
        updatedAt: meta.updatedAt ?? exportedAt.getTime(),
      },
      data,
      version: FLOW_FILE_VERSION,
      exportedAt: exportedAt.toISOString(),
    },
    null,
    2,
  );
}

/**
 * The refusal for a file of `size` bytes (or text of `size` characters) that is
 * too large to be a flow file, `null` when it is not. For a caller that can
 * turn a file away before reading it.
 */
export function refuseFlowFileOfSize(size: number): FlowFileRefusal | null {
  if (size <= MAX_FLOW_FILE_SIZE) return null;
  return notAFlow(`it is larger than ${MAX_FLOW_FILE_SIZE / (1024 * 1024)} MB`);
}

/**
 * Read a flow file.
 *
 * `text` is untrusted, and any text gets an answer. A file without a `version`
 * is read as version 1. For a flow this build exported and nothing has changed
 * since, the decoded nodes and edges equal the exported ones and there are no
 * notices. The decoded nodes are what the document gives back for them once
 * they have landed. A decoded edge has an id, two nodes that are in the flow,
 * a handle name at each end, and at most a type, the app's own; it has no
 * other field.
 */
export function decodeFlowFile(text: string): DecodedFlowFile {
  const tooLarge = refuseFlowFileOfSize(text.length);
  if (tooLarge) return tooLarge;

  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return notAFlow("it is not valid JSON");
  }
  if (!isRecord(file)) return notAFlow("it has no nodes and edges");

  const version = file.version === undefined ? 1 : file.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return notAFlow("its version is not a flow file version");
  }
  if (version > FLOW_FILE_VERSION) {
    return {
      ok: false,
      problem:
        `This flow was exported by a newer version of Microflow (file format ${version}; ` +
        `this version reads up to ${FLOW_FILE_VERSION}). Update Microflow to import it.`,
    };
  }

  const data = file.data;
  if (!isRecord(data) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    return notAFlow("it has no nodes and edges");
  }
  if (data.nodes.length > MAX_NODES) {
    return notAFlow(`it has ${data.nodes.length} nodes, and a flow has at most ${MAX_NODES}`);
  }
  if (data.edges.length > MAX_EDGES) {
    return notAFlow(`it has ${data.edges.length} edges, and a flow has at most ${MAX_EDGES}`);
  }
  if (nestsDeeperThan(file, MAX_DEPTH)) {
    return notAFlow(`its content is nested more than ${MAX_DEPTH} levels deep`);
  }

  const notices: FlowFileNotice[] = [];

  const name = readName(file.meta, notices);
  const nodes = readNodes(data.nodes, notices);
  if (typeof nodes === "string") return damaged(nodes);
  const edges = readEdges(data.edges, nodes, notices);
  if (typeof edges === "string") return damaged(edges);

  return {
    ok: true,
    flow: { ...(name === "" ? {} : { name }), nodes: [...nodes.values()], edges },
    notices,
  };
}

function notAFlow(why: string): FlowFileRefusal {
  return { ok: false, problem: `This file is not a Microflow flow: ${why}.` };
}

function damaged(what: string): FlowFileRefusal {
  return { ok: false, problem: `This flow file is damaged: ${what}.` };
}

/** The flow's name, trimmed and no longer than a flow's name may be; `""` when the file has none. */
function readName(meta: unknown, notices: FlowFileNotice[]): string {
  const name = isRecord(meta) && typeof meta.name === "string" ? meta.name.trim() : "";
  if (name.length <= MAX_NAME_LENGTH) return name;
  notices.push({
    kind: "name-shortened",
    message: `The flow's name was longer than ${MAX_NAME_LENGTH} characters and was shortened.`,
  });
  return clip(name, MAX_NAME_LENGTH).trimEnd();
}

// ── Nodes ────────────────────────────────────────────────────────────────────

/** The nodes of the file by id, in the file's order, or what is wrong with them. */
function readNodes(raw: unknown[], notices: FlowFileNotice[]): Map<string, FlowNode> | string {
  const given = new Map<string, Record<string, unknown>>();
  for (const [index, node] of raw.entries()) {
    if (!isRecord(node)) return `node ${index + 1} is not a node`;
    if (typeof node.id !== "string" || node.id === "") return `node ${index + 1} has no id`;
    if (given.has(node.id)) return `two nodes share the id ${shown(node.id)}`;
    given.set(node.id, node);
  }

  const nodes = new Map<string, FlowNode>();
  for (const stored of asStored([...given.values()])) {
    const node = given.get(stored.id)!;
    if (!isValueEqual(stored.position, node.position)) {
      notices.push({
        kind: "position-defaulted",
        id: stored.id,
        message:
          `Node ${shown(stored.id)} had no usable position in the file; ` +
          `it is placed at ${stored.position.x}, ${stored.position.y}.`,
      });
    }
    const had = node.data === undefined ? "none" : isRecord(node.data) ? "some" : "unusable";
    nodes.set(stored.id, { ...stored, data: readSettings(stored, had, notices) });
  }
  return nodes;
}

/**
 * The file's nodes as a document gives them back: written and read the way a
 * landing flow is, so a missing or malformed type, position or size becomes
 * what it is in a stored flow. Settings that are not an object count as none.
 */
function asStored(nodes: Record<string, unknown>[]): FlowNode[] {
  const doc = FlowDocument.createEmpty();
  try {
    doc.setFlowData(
      nodes.map((node) => ({ ...node, data: isRecord(node.data) ? node.data : {} }) as FlowNode),
      [],
    );
    return doc.getNodes().map(({ id, type, position, data, width, height }) => ({
      id,
      type,
      position,
      data,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    }));
  } finally {
    doc.destroy();
  }
}

/**
 * A node's settings through the Node Data Resolver: the file's settings, plus
 * the defaults of the settings it lacks. When the resolver would change a
 * value the file has, the file's settings stand untouched.
 *
 * `had` is what the file had for settings: an object (`some`), nothing, or
 * something that is not an object.
 */
function readSettings(
  node: FlowNode,
  had: "some" | "none" | "unusable",
  notices: FlowFileNotice[],
): Record<string, unknown> {
  const subject = describeNode(node);
  const lacked =
    had === "unusable" ? `${subject} had settings in the file that are not settings` : `${subject} had no settings in the file`;

  if (!isComponentType(node.type)) {
    notices.push({
      kind: "unknown-node-type",
      id: node.id,
      message:
        (node.type === ""
          ? `Node ${shown(node.id)} has no type in the file. `
          : `Node ${shown(node.id)} has the type ${shown(node.type)}, which this version of Microflow does not know. `) +
        `It is kept, but it will not run.`,
    });
    if (had === "unusable") {
      notices.push({ kind: "settings-defaulted", id: node.id, message: `${lacked}; it has none.` });
    }
    return node.data;
  }

  const resolved = resolveNodeData(node.type, node.data);
  const completed = resolved.ok ? complete(node.data, resolved.data, "") : null;
  if (!resolved.ok || completed === null || !isRecord(completed.value)) {
    const why = resolved.ok
      ? "it would reset some of them to its defaults"
      : clip(resolved.error.split(" — ").pop() ?? "", 200);
    notices.push({
      kind: "settings-unrecognised",
      id: node.id,
      message:
        `The settings of ${subject} are kept as they are in the file, ` +
        `but this version of Microflow does not accept them (${why}).`,
    });
    return node.data;
  }

  if (had !== "some") {
    notices.push({ kind: "settings-defaulted", id: node.id, message: `${lacked}; the defaults are used.` });
  } else if (completed.added.length > 0) {
    const fields = completed.added.slice(0, SHOWN_FIELDS).map(shown).join(", ");
    const more = completed.added.length - SHOWN_FIELDS;
    notices.push({
      kind: "settings-defaulted",
      id: node.id,
      message: `${subject} had no ${fields}${more > 0 ? ` and ${more} more` : ""} in the file; the default is used.`,
    });
  }
  return completed.value;
}

/**
 * `prev` completed with what `next` has and `prev` lacks, and the paths that
 * were added. A key only `prev` has is kept. `null` when `next` has another
 * value where `prev` has one: then `next` is not a completion of `prev`.
 *
 * Recurses as deep as `prev` nests, which `MAX_DEPTH` bounds.
 */
function complete(prev: unknown, next: unknown, path: string): { value: unknown; added: string[] } | null {
  if (Array.isArray(prev)) {
    if (!Array.isArray(next) || next.length !== prev.length) return null;
    const value: unknown[] = [];
    const added: string[] = [];
    for (const [index, item] of prev.entries()) {
      const inner = complete(item, next[index], `${path}[${index}]`);
      if (inner === null) return null;
      value.push(inner.value);
      added.push(...inner.added);
    }
    return { value, added };
  }
  if (isRecord(prev)) {
    if (!isRecord(next)) return null;
    const at = (key: string) => (path === "" ? key : `${path}.${key}`);
    const value: Record<string, unknown> = {};
    const added: string[] = [];
    for (const [key, item] of Object.entries(prev)) {
      if (item === undefined || next[key] === undefined) {
        value[key] = item;
        continue;
      }
      const inner = complete(item, next[key], at(key));
      if (inner === null) return null;
      value[key] = inner.value;
      added.push(...inner.added);
    }
    for (const [key, item] of Object.entries(next)) {
      if (item === undefined || prev[key] !== undefined) continue;
      value[key] = item;
      added.push(at(key));
    }
    return { value, added };
  }
  return Object.is(next, prev) ? { value: prev, added: [] } : null;
}

// ── Edges ────────────────────────────────────────────────────────────────────

/** The edges of the file that are kept, in the file's order, or what is wrong with them. */
function readEdges(
  raw: unknown[],
  nodes: ReadonlyMap<string, FlowNode>,
  notices: FlowFileNotice[],
): FlowEdge[] | string {
  const edges = new Map<string, FlowEdge>();
  const seen = new Set<string>();
  let notDrawn = 0;

  for (const [index, entry] of raw.entries()) {
    const edge = readEdge(entry, index);
    if (typeof edge === "string") return edge;
    if (seen.has(edge.id)) return `two edges share the id ${shown(edge.id)}`;
    seen.add(edge.id);

    const verdicts = edgeProblems(edge, nodes).map((problem) => endVerdict(edge, problem, nodes));
    const told = verdicts.flatMap((verdict) => verdict.notice ?? []);
    notices.push(...told);
    if (verdicts.some((verdict) => !verdict.keep)) continue;
    edges.set(edge.id, edge);
    if (told.length === 0 && verdicts.some((verdict) => verdict.notDrawn)) notDrawn += 1;
  }

  if (notDrawn > 0) {
    notices.push({
      kind: "edges-not-drawn",
      message:
        notDrawn === 1
          ? "1 edge is kept that the canvas does not show: it uses a handle its node hides as it is set up. " +
            "It still works when the flow runs."
          : `${notDrawn} edges are kept that the canvas does not show: they use handles their nodes hide ` +
            "as they are set up. They still work when the flow runs.",
    });
  }
  return [...edges.values()];
}

/**
 * An edge of the file in the shape the app writes one in, or what is wrong with
 * it: the document's own reading of an edge (`decodeEdge`), so a file and a
 * stored flow agree on what an edge is. The decoded edge has its id, its two
 * nodes, a handle at each end where the file names one (a non-empty string),
 * and its type where that is the app's. Whatever else the file has on the
 * edge is not in it.
 */
function readEdge(raw: unknown, index: number): FlowEdge | string {
  const edge = decodeEdge(raw);
  if (typeof edge !== "string") return edge;
  const id = isRecord(raw) ? raw.id : undefined;
  switch (edge) {
    case "not-an-edge":
      return `edge ${index + 1} is not an edge`;
    case "no-id":
      return `edge ${index + 1} has no id`;
    case "no-source":
      return `edge ${shown(String(id))} has no source node`;
    case "no-target":
      return `edge ${shown(String(id))} has no target node`;
  }
}

/**
 * What decode found in the way of an edge: an end that cannot attach
 * (`checkEdgeEnds`), or the ends at which the edge names no handle at all.
 */
type EdgeFinding = EdgeProblem | { reason: "no-handle"; ends: readonly ("source" | "target")[] };

/**
 * What stands in the way of an edge, as `readEdge` gives it: at most one
 * finding per end. A node that is not in the file is the only finding: the
 * edge has nowhere to be. Failing that, so is an end without a handle: the
 * edge is not an edge, wherever it would attach.
 */
function edgeProblems(edge: FlowEdge, nodes: ReadonlyMap<string, FlowNode>): EdgeFinding[] {
  const ends = checkEdgeEnds(edge, (id) => nodes.get(id));
  const found = [ends.source, ends.target].filter((problem) => problem !== null);
  const missing = found.find((problem) => problem.reason === "missing-node");
  if (missing) return [missing];

  const unnamed = (["source", "target"] as const).filter((end) => edge[`${end}Handle`] === undefined);
  return unnamed.length > 0 ? [{ reason: "no-handle", ends: unnamed }] : found;
}

/**
 * What decode does about one finding on an edge, by its reason. The policy for
 * edges, in one place; a reason `checkEdgeEnds` gains does not compile until it
 * has a line here. An edge is kept when every finding on it says so.
 */
function endVerdict(
  edge: FlowEdge,
  problem: EdgeFinding,
  nodes: ReadonlyMap<string, FlowNode>,
): { keep: boolean; notice?: FlowFileNotice; notDrawn?: true } {
  const nodeAt = (end: "source" | "target") => (end === "source" ? edge.source : edge.target);
  const subject = `The edge from ${shown(edge.source)} to ${shown(edge.target)}`;

  switch (problem.reason) {
    // It attaches to nothing.
    case "missing-node":
      return {
        keep: false,
        notice: {
          kind: "edge-dropped",
          id: edge.id,
          message: `${subject} was left out: there is no node ${shown(nodeAt(problem.end))} in the file.`,
        },
      };
    // It carries nothing, nothing can draw it, and sketch generation requires
    // both handles of every edge.
    case "no-handle": {
      const lacks = problem.ends.map(
        (end) => `no ${end === "source" ? "output" : "input"} of ${shown(nodeAt(end))}`,
      );
      return {
        keep: false,
        notice: {
          kind: "edge-dropped",
          id: edge.id,
          message: `${subject} was left out: it names ${lacks.join(" and ")}.`,
        },
      };
    }
    // The node is kept and has its own notice; its handles are unknown.
    case "unknown-type":
      return { keep: true };
    // The runtime honours it: content, like any other edge.
    case "not-offered":
      return { keep: true, notDrawn: true };
    case "unknown-handle": {
      const side = problem.end === "source" ? "output" : "input";
      return {
        keep: true,
        notice: {
          kind: "unknown-handle",
          id: edge.id,
          message:
            `${subject} is kept, but it carries nothing and the canvas cannot show it: ` +
            `as ${describeNode(nodes.get(nodeAt(problem.end))!)} is set up, ` +
            `it has no ${side} ${shown(problem.handle ?? "")}.`,
        },
      };
    }
    default:
      return problem satisfies never;
  }
}

// ── Shared ───────────────────────────────────────────────────────────────────

/** Whether `root` nests more than `limit` levels of objects and arrays. Does not recurse. */
function nestsDeeperThan(root: unknown, limit: number): boolean {
  const values: unknown[] = [root];
  const depths: number[] = [0];
  while (values.length > 0) {
    const value = values.pop();
    const depth = depths.pop()!;
    if (typeof value !== "object" || value === null) continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (typeof child !== "object" || child === null) continue;
      values.push(child);
      depths.push(depth + 1);
    }
  }
  return false;
}

/** `text` cut to `length` characters, on a whole character. */
function clip(text: string, length: number): string {
  if (text.length <= length) return text;
  let clipped = "";
  for (const character of text) {
    if (clipped.length + character.length > length) break;
    clipped += character;
  }
  return clipped;
}

/** A name from the file, quoted for a message and cut to a length a message can carry. */
function shown(name: string): string {
  return name.length <= SHOWN_NAME_LENGTH ? `"${name}"` : `"${clip(name, SHOWN_NAME_LENGTH)}…"`;
}

/** A node for a message: its label, else its type, else "Node"; then its id. */
function describeNode(node: FlowNode): string {
  const label = isName(node.data.label) ? node.data.label : node.type === "" ? "Node" : node.type;
  return `${clip(label, SHOWN_NAME_LENGTH)} ${shown(node.id)}`;
}

/** Whether `value` can name something: a string that is not empty. */
function isName(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
