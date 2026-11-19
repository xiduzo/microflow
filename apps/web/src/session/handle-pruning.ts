import * as Y from "yjs";
import { PRUNE_ORIGIN, type FlowDocument, type FlowEdge, type FlowNode } from "@microflow/collab";
import { reportError } from "@/lib/report-error";

/** A node's connectable handle ids, by side. */
type HandleSet = { readonly ports: readonly string[]; readonly emits: readonly string[] };

/** Handle ids by side, as a set. */
type Handles = { ports: Set<string>; emits: Set<string> };

/**
 * One write of a setting, as Yjs holds it: the entry the write made, and the
 * entry it displaced (what its writer saw as the current value).
 */
type SettingWrite = { readonly written: Y.ID; readonly replaced: Y.ID | null };

/**
 * An edge this client pruned, and the transition that justified it: the node
 * and the handle that vanished, whether the change was this client's own (an
 * edit, an undo or a redo), and the settings that change wrote.
 */
type Pruned = {
  readonly edge: FlowEdge;
  readonly node: string;
  readonly side: keyof Handles;
  readonly handle: string;
  readonly own: boolean;
  readonly writes: ReadonlyMap<string, SettingWrite>;
};

/**
 * What the session must be told about nodes to prune their edges: the handles
 * a node offers as it is configured now, or `null` when that is unknown (a
 * type this build does not have). The session knows documents, not nodes, so
 * this is handed to it; in the app it is `nodeHandles` from `nodes/handles.ts`.
 */
export type HandleSets = (node: FlowNode) => HandleSet | null;

/**
 * Whether a change that arrives from outside is a peer editing right now: the
 * session is in sync with its room. `subscribe` reports that it may have
 * changed.
 */
export type Liveness = {
  isLive(): boolean;
  subscribe(listener: () => void): () => void;
};

/**
 * Keep `doc` free of edges at handles that have vanished, from now on.
 *
 * **The rule.** When the settings of a node change and its handle set (as
 * `handleSets` gives it) loses a handle, the edges at that handle are removed.
 * Edges at handles the node still has are kept, as is everything on the other
 * side: a Port and an Emit may share an id (`value`) and are told apart.
 *
 * **The trigger is the document.** It watches node `data`, so it prunes an
 * edit however it was made: a settings panel, Ask AI, an MCP flow tool, undo,
 * or a collaborator. No canvas and no mounted node component is involved.
 *
 * **It reacts to a handle vanishing, never to an edge being there.** An edge
 * is removed only at the moment this client sees its handle go: a handle the
 * node offered before a change and does not offer after it. No edge is ever
 * removed for having arrived, or for sitting at a handle that is not offered.
 * So a handle a newer build offers, which this build has never heard of,
 * cannot vanish here, and an older client in the room does not keep deleting
 * a newer client's edges. Nor can a handle the node declares and never offers.
 * For the same reason, starting does not sweep the document: what is already
 * there is left alone.
 *
 * **Only an edit of an existing node is a settings change.** Content that is
 * replaced or loaded is taken as it comes, edges included; saved content may
 * hold an edge at a handle its node does not offer, and landing it must not
 * edit it. Two things tell the cases apart:
 *
 * - *Where the write lands.* An edit writes inside a node (its `data`).
 *   Replacing or loading writes the node itself: `setFlowData` (a template, an
 *   import, a fork landing in the local flow), the stored document loading,
 *   the upgrade from the old node shape, and the undo or redo of any of these.
 *   A node that is written whole is a new node, whatever id it reuses: its
 *   handle set is noted and nothing is removed. So is a node whose type
 *   changes.
 * - *Whether this client has a "before".* A change that did not originate
 *   here, arriving in a session that has never been live (the stored document
 *   loading, a cloud session's first sync on top of its seed), is content:
 *   the session never saw the node as a peer left it, so it has nothing to
 *   compare with. This client's own changes always count.
 *
 * **Catching up.** A session that has been live and then drops out sees, when
 * it reconnects, what its peers did meanwhile. Those are edits, and what it
 * held before is a real "before"; but a catch-up arrives in pieces, so it only
 * notes the handles that vanish and removes the edges at them when it is live
 * again, in one transaction. A handle that came back by then keeps its edges.
 * What was noted is forgotten there and then: no noted handle outlives the
 * reconnect it belongs to.
 *
 * **Collaboration.** Every Editor in the room runs this and may remove the
 * same edge for the same change. Deletes are idempotent in Yjs, so they
 * converge. A settings change racing a peer's new edge to the vanishing
 * handle is caught by the client that wired the edge: when the change reaches
 * it, live or in a catch-up, it sees the handle go.
 *
 * **Undo.** After the user's own edit (origin `"local"`) the removal is
 * written as `"local"` too, right behind it, so the `UndoManager` merges both
 * into one step and undo brings the edges back with the setting. Every other
 * removal is written with the prune origin, outside the undo history: one
 * that follows an undo or a redo, a peer's change, or a catch-up.
 *
 * **A prune is reverted with its cause.** A removal made while live is
 * remembered with the transition that justified it: the node, the handle that
 * vanished, whether the change was this client's own (an edit, an undo, a
 * redo), and the setting entries it wrote. The record is spent the first time
 * that handle is offered again, whatever brought it back. The edge goes back
 * then, as it was and under its own id, only if the change that brought the
 * handle back reverts the transition:
 *
 * - this client's undo or redo, of a transition that was this client's own
 *   (the undo that pruned a peer's edge, then the redo; or the other way
 *   round); or
 * - a value of one of the settings the transition wrote, written without
 *   knowing of it (it displaced the same entry the transition displaced) and
 *   winning the conflict: two users set the same setting at once, and the
 *   value that keeps the handle wins, now or in a later catch-up.
 *
 * A handle given back by a new change (a value set back by hand, here or by
 * a peer) restores nothing. A restore is checked first: no edge with that id
 * or with the same ends is in the document, both nodes are there, and each
 * end is at a handle its node offers now (an end whose node's handles are
 * unknown is taken as it was). It is written with the prune origin, outside
 * the undo history, like the removal it reverts. A record is also spent when
 * its edge, or an edge with the same ends, is in the document again, and when
 * either node is deleted or written whole; so an edge that came back and was
 * then deleted on purpose stays deleted. Every client that pruned an edge may
 * restore it; it is the same id with the same content, so they converge on
 * one edge. A restore adds an edge and pruning never reacts to an edge, so
 * two clients cannot prune and restore in turn.
 *
 * **Known properties.**
 *
 * - *Clients whose handle sets disagree.* The removal follows the handle sets
 *   of the client that makes it. When a peer on a build that does not prune
 *   (or whose rule for that node still has the handle) changes a setting, the
 *   clients that do prune remove the edges, once, with the prune origin. That
 *   peer's own undo then restores its setting but not the edges, because the
 *   removal was never on its undo stack. An edge wired at that handle
 *   afterwards is left alone by every client that is live when it arrives. A
 *   client that receives the setting change and that edge in one catch-up
 *   removes the edge too when it is live again: the catch-up rule removes the
 *   edges at a handle it noted, whenever they were wired. Wired once more, the
 *   edge stays. The same holds after any future change that narrows a node's
 *   handle set, for as long as both builds share a room. A restore follows
 *   the handle sets of the client that makes it too: it puts back only an
 *   edge its own build offers, and a peer whose build does not offer it keeps
 *   it as an invisible edge (below). Nothing is removed because of a restore,
 *   so the skew adds no deletion.
 * - *Some reverts are not recognised*, and the edge stays pruned, as it would
 *   without the record:
 *   - a concurrent value from a writer that was further behind (it displaced
 *     an older entry than the transition did), or one that wins over a
 *     transition that deleted the setting rather than wrote it;
 *   - a removal made at the end of a catch-up, which is not remembered; the
 *     client whose edit lost restores it, if it prunes (it pruned its own
 *     edit when it made it);
 *   - a revert after this session forgot its records: a reload, a lost or
 *     regained write access, a new session.
 * - *A deliberate delete racing the prune can come back.* A peer that
 *   deletes an edge by hand at the same moment as a change prunes it, before
 *   either has seen the other, deletes the same entry; nobody can tell the
 *   two apart afterwards. If the change is then reverted, the edge is
 *   restored.
 * - *An invisible edge can remain* when whoever wired it never sees the
 *   handle go as an edit: a tab still on a stale seed wires a handle that was
 *   just removed, before its first sync; an undo brings back an edge at a
 *   handle a peer removed in between; or the wirer is on a build that does
 *   not prune. That is accepted. An edge that stays at a handle nobody offers
 *   costs little; a rule that keeps deleting wiring a peer considers valid
 *   costs the peer their work.
 * - *A node still in the pre-ADR-0019 shape* (one plain object) is written
 *   whole by its first edit, so that edit is not pruned.
 *
 * **It never throws into Yjs.** It runs inside the application of every
 * update, including a remote one; an exception there would fail
 * `Y.applyUpdate` for whoever delivered it. A failure in `handleSets` or in
 * the removal is reported and that change is left unpruned.
 *
 * A mutator on purpose, like `FlowDocument.startEdgePruning`: a Viewer's
 * writes are refused by the room, so the session starts this only while it is
 * writable. Returns the stop function.
 */
export function startHandlePruning(
  doc: FlowDocument,
  handleSets: HandleSets,
  liveness: Liveness,
): () => void {
  /** Each node's handle set as last seen; `null` when it is unknown. */
  const seen = new Map<string, HandleSet | null>();
  /**
   * Per node, the handles the catch-up in progress has taken away and not
   * given back. Empty whenever the session is live.
   */
  const missed = new Map<string, Handles>();
  /**
   * The edges this client pruned while live, by id, until the transition
   * behind each is reverted or the record is spent (see `restore`).
   */
  const pruned = new Map<string, Pruned>();
  /** Whether this session has been in sync with its room at any point. */
  let everLive = liveness.isLive();
  let live = everLive;

  const read = (nodeId: string): HandleSet | null | undefined => {
    const node = doc.getNode(nodeId);
    if (!node) return undefined;
    try {
      return handleSets(node);
    } catch (error) {
      // Unknown, like a type this build does not have: never pruned.
      reportError(error, { source: "action" });
      return null;
    }
  };
  /** Take a node as it is now. Returns what it offered before, if it is still there. */
  const note = (nodeId: string): { before: HandleSet | null | undefined; after: HandleSet | null } | null => {
    const before = seen.get(nodeId);
    const after = read(nodeId);
    if (after === undefined) {
      // Deleted: its edges are the dangling-edge prune's to remove.
      seen.delete(nodeId);
      return null;
    }
    seen.set(nodeId, after);
    return { before, after };
  };
  /** The edges at one of the given handles of the given nodes. */
  const edgesAt = (handles: ReadonlyMap<string, Handles>): FlowEdge[] =>
    doc.getEdges().filter((edge) => {
      const source = handles.get(edge.source);
      const target = handles.get(edge.target);
      return (
        (!!source && !!edge.sourceHandle && source.emits.has(edge.sourceHandle)) ||
        (!!target && !!edge.targetHandle && target.ports.has(edge.targetHandle))
      );
    });
  const remove = (edges: readonly FlowEdge[], origin: string): void => {
    if (edges.length === 0) return;
    doc.doc.transact(() => {
      for (const edge of edges) doc.removeEdge(edge.id);
    }, origin);
  };

  /** The entry a setting of a node holds in the document now, if any. */
  const settingEntry = (nodeId: string, key: string): Y.Item | undefined => {
    const node: unknown = doc.nodes.get(nodeId);
    const data = node instanceof Y.Map ? node.get("data") : undefined;
    return data instanceof Y.Map ? data._map.get(key) : undefined;
  };
  /** What a transaction wrote to the given settings of a node. A setting it deleted is left out. */
  const writesOf = (nodeId: string, keys: ReadonlySet<string> | undefined): Map<string, SettingWrite> => {
    const writes = new Map<string, SettingWrite>();
    for (const key of keys ?? []) {
      const entry = settingEntry(nodeId, key);
      if (entry && !entry.deleted) writes.set(key, { written: entry.id, replaced: entry.origin });
    }
    return writes;
  };
  /**
   * Whether a setting the transition wrote now holds a value written without
   * knowing of it: one that displaced the same value the transition did, and
   * won the conflict.
   */
  const lostToConcurrentWrite = (record: Pruned, keys: ReadonlySet<string> | undefined): boolean => {
    for (const key of keys ?? []) {
      const write = record.writes.get(key);
      const entry = settingEntry(record.node, key);
      if (!write || !entry || entry.deleted) continue;
      if (!Y.compareIDs(entry.id, write.written) && Y.compareIDs(entry.origin, write.replaced)) return true;
    }
    return false;
  };

  const sameEnds = (a: FlowEdge, b: FlowEdge): boolean =>
    a.source === b.source &&
    a.target === b.target &&
    (a.sourceHandle ?? "") === (b.sourceHandle ?? "") &&
    (a.targetHandle ?? "") === (b.targetHandle ?? "");
  /**
   * Whether a pruned edge can go back: it is not in the document under its id
   * or under the same ends, both its nodes are there, and each end is at a
   * handle its node offers now (an end whose handles are unknown is taken as
   * it was).
   */
  const restorable = (edge: FlowEdge): boolean => {
    if (doc.hasEdge(edge.id) || doc.getEdges().some((other) => sameEnds(other, edge))) return false;
    const source = read(edge.source);
    const target = read(edge.target);
    if (source === undefined || target === undefined) return false;
    if (source && edge.sourceHandle && !source.emits.includes(edge.sourceHandle)) return false;
    if (target && edge.targetHandle && !target.ports.includes(edge.targetHandle)) return false;
    return true;
  };

  /** Keep what a prune removed, and why, so that it can be reverted. */
  const remember = (
    edges: readonly FlowEdge[],
    vanished: ReadonlyMap<string, Handles>,
    own: boolean,
    keys: ReadonlyMap<string, Set<string>>,
  ): void => {
    for (const edge of edges) {
      const fromSource = vanished.get(edge.source);
      const [node, side, handle] =
        fromSource && edge.sourceHandle && fromSource.emits.has(edge.sourceHandle)
          ? [edge.source, "emits" as const, edge.sourceHandle]
          : [edge.target, "ports" as const, edge.targetHandle ?? ""];
      pruned.set(edge.id, { edge, node, side, handle, own, writes: writesOf(node, keys.get(node)) });
    }
  };
  /** Forget the pruned edges at a node that is gone or is a new node now. */
  const forgetAt = (nodeId: string): void => {
    for (const [id, record] of pruned) {
      if (record.edge.source === nodeId || record.edge.target === nodeId) pruned.delete(id);
    }
  };

  /**
   * Settle the pruned edges whose handle `appeared` gave back. Each record is
   * spent here, the first time its handle is back, whatever brought it back.
   * Its edge goes back only when that change reverts the transition that
   * pruned it: this client's undo or redo, of a transition that was this
   * client's own; or a value written concurrently with the transition
   * winning over it. A handle given back by a new change (a hand-set value,
   * a peer's later edit) restores nothing. The restore is written with the
   * prune origin, outside the undo history, like the prune it undoes.
   */
  const restore = (
    appeared: ReadonlyMap<string, Handles>,
    transaction: Y.Transaction,
    keys: ReadonlyMap<string, Set<string>>,
  ): void => {
    const undoOrRedo = transaction.origin === doc.undoManager;
    const back: FlowEdge[] = [];
    for (const [id, record] of pruned) {
      if (!appeared.get(record.node)?.[record.side].has(record.handle)) continue;
      pruned.delete(id);
      const reverted =
        (undoOrRedo && record.own) ||
        (!transaction.local && lostToConcurrentWrite(record, keys.get(record.node)));
      if (reverted && restorable(record.edge) && !back.some((edge) => sameEnds(edge, record.edge))) {
        back.push(record.edge);
      }
    }
    if (back.length === 0) return;
    doc.doc.transact(() => {
      for (const edge of back) doc.addEdge(edge);
    }, PRUNE_ORIGIN);
  };

  for (const id of doc.getNodeIds()) note(id);

  // The nodes one transaction touched, gathered while it is applied and
  // worked through once it has been (`afterTransaction`).
  let written = new Set<string>();
  let edited = new Set<string>();
  let keys = new Map<string, Set<string>>();

  const onNodes = (events: Array<Y.YEvent<any>>) => {
    const changed = changedNodes(events);
    for (const id of changed.written) written.add(id);
    for (const id of changed.edited) edited.add(id);
    for (const [id, changedKeys] of changed.keys) {
      const all = keys.get(id) ?? new Set<string>();
      for (const key of changedKeys) all.add(key);
      keys.set(id, all);
    }
  };

  /**
   * An edge that is in the document again, or one wired at the same ends,
   * spends the record of its prune: from here on it is whatever its users
   * make of it, and deleting it is theirs to do.
   */
  const onEdges = (event: Y.YMapEvent<FlowEdge>) => {
    if (pruned.size === 0) return;
    for (const [id, change] of event.changes.keys) {
      if (change.action === "delete") continue;
      pruned.delete(id);
      const edge = doc.getEdge(id);
      if (!edge) continue;
      for (const [prunedId, record] of pruned) {
        if (sameEnds(record.edge, edge)) pruned.delete(prunedId);
      }
    }
  };

  const settle = (transaction: Y.Transaction) => {
    // The common case, a drag included: nothing that matters here was touched.
    if (written.size === 0 && edited.size === 0) return;
    const nodes = { written, edited, keys };
    written = new Set();
    edited = new Set();
    keys = new Map();

    // A node written whole is a new node: nothing is known to be missing from
    // it, and nothing pruned at the node it replaced belongs to it.
    for (const id of nodes.written) {
      missed.delete(id);
      forgetAt(id);
      note(id);
    }

    // Own changes always count. A peer's count once this session has a
    // "before" to compare with; until then what arrives is content.
    const isEdit = transaction.local || everLive;
    // A peer's change outside live operation is part of a catch-up: noted,
    // and acted on when the session is live again (`followLiveness`).
    const isCatchUp = !transaction.local && !live;
    const vanished = new Map<string, Handles>();
    const appeared = new Map<string, Handles>();
    for (const id of nodes.edited) {
      if (nodes.written.has(id)) continue;
      const change = note(id);
      if (change === null) forgetAt(id);
      if (!change?.after) {
        // Gone, or its handles can no longer be worked out: what was noted
        // for it rests on an answer that does not hold any more.
        missed.delete(id);
        continue;
      }
      const noted = missed.get(id);
      if (noted) {
        for (const port of change.after.ports) noted.ports.delete(port);
        for (const emit of change.after.emits) noted.emits.delete(emit);
      }
      if (!change.before) continue;
      const back = {
        ports: missingFrom(change.before.ports, change.after.ports),
        emits: missingFrom(change.before.emits, change.after.emits),
      };
      if (back.ports.size > 0 || back.emits.size > 0) appeared.set(id, back);
      if (!isEdit) continue;
      const ports = missingFrom(change.after.ports, change.before.ports);
      const emits = missingFrom(change.after.emits, change.before.emits);
      if (ports.size === 0 && emits.size === 0) continue;
      if (isCatchUp) {
        const entry = noted ?? { ports: new Set<string>(), emits: new Set<string>() };
        for (const port of ports) entry.ports.add(port);
        for (const emit of emits) entry.emits.add(emit);
        missed.set(id, entry);
      } else {
        vanished.set(id, { ports, emits });
      }
    }

    // Each runs after the transaction that changed the settings has been
    // applied, as a transaction of its own.
    if (vanished.size > 0) {
      const edges = edgesAt(vanished);
      remove(edges, transaction.origin === "local" ? "local" : PRUNE_ORIGIN);
      remember(edges, vanished, transaction.local, nodes.keys);
    }
    if (appeared.size > 0 && pruned.size > 0) restore(appeared, transaction, nodes.keys);
  };

  /**
   * On becoming live (again): remove the edges at what the catch-up took
   * away, then forget it. Nothing noted outlives the reconnect it belongs to.
   */
  const followLiveness = () => {
    const wasLive = live;
    live = liveness.isLive();
    if (!live || wasLive) return;
    everLive = true;
    if (missed.size === 0) return;
    try {
      remove(edgesAt(missed), PRUNE_ORIGIN);
    } finally {
      missed.clear();
    }
  };

  const safely =
    <Args extends unknown[]>(run: (...args: Args) => void) =>
    (...args: Args) => {
      try {
        run(...args);
      } catch (error) {
        reportError(error, { source: "action" });
      }
    };
  const observeNodes = safely(onNodes);
  const observeEdges = safely(onEdges);
  const afterTransaction = safely(settle);

  doc.nodes.observeDeep(observeNodes);
  doc.edges.observe(observeEdges);
  doc.doc.on("afterTransaction", afterTransaction);
  const unsubscribe = liveness.subscribe(safely(followLiveness));
  return () => {
    unsubscribe();
    doc.doc.off("afterTransaction", afterTransaction);
    doc.edges.unobserve(observeEdges);
    doc.nodes.unobserveDeep(observeNodes);
  };
}

/** The ids of `before` that `after` does not have. */
function missingFrom(after: readonly string[], before: readonly string[]): Set<string> {
  const still = new Set(after);
  return new Set(before.filter((id) => !still.has(id)));
}

/**
 * The nodes a transaction touched in a way that can change a handle set, by
 * where the write landed:
 *
 * - `written`: the node itself was put into, replaced in or taken out of the
 *   document, or its `type` was written. A different node from here on.
 * - `edited`: something inside the node changed (its `data`). The same node
 *   with other settings.
 *
 * A drag writes `position` only and is in neither, so moving a node costs
 * nothing here. `keys` holds, per edited node, the settings whose value
 * changed.
 */
function changedNodes(events: Array<Y.YEvent<any>>): {
  written: Set<string>;
  edited: Set<string>;
  keys: Map<string, Set<string>>;
} {
  const written = new Set<string>();
  const edited = new Set<string>();
  const keys = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.path.length === 0) {
      // The top-level map.
      for (const id of event.changes.keys.keys()) written.add(id);
    } else if (event.path.length > 1) {
      // Inside a node's nested `data` map.
      const id = String(event.path[0]);
      edited.add(id);
      const changed = keys.get(id) ?? new Set<string>();
      for (const key of event.changes.keys.keys()) changed.add(key);
      keys.set(id, changed);
    } else if (event.changes.keys.has("type")) {
      // The node's own map.
      written.add(String(event.path[0]));
    } else if (event.changes.keys.has("data")) {
      edited.add(String(event.path[0]));
    }
  }
  return { written, edited, keys };
}
