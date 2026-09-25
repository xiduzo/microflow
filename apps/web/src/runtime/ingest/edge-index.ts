/** The edge fields ingest needs; both `CoreEdge` and collab `FlowEdge` satisfy it. */
export type EdgeLike = {
  id?: string | null;
  source: string;
  sourceHandle?: string | null;
};

/**
 * `(source, sourceHandle)` -> edge ids, the UI mirror of the runtime router's
 * `EdgeMap` (`crates/microflow-core/src/runtime/router.rs:66`): an Emission
 * looks up its own wires instead of walking the flow.
 */
export type EdgeIndex = ReadonlyMap<string, readonly string[]>;

const NO_EDGES: readonly string[] = [];

/** NUL separator so `("ab", "c")` and `("a", "bc")` cannot collide. */
function key(source: string, handle: string): string {
  return `${source}\u0000${handle}`;
}

export function buildEdgeIndex(edges: ReadonlyArray<EdgeLike>): EdgeIndex {
  const index = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.id) continue;
    const bucketKey = key(edge.source, edge.sourceHandle ?? "");
    const bucket = index.get(bucketKey);
    if (bucket) bucket.push(edge.id);
    else index.set(bucketKey, [edge.id]);
  }
  return index;
}

/** Wires leaving `(source, handle)`. Empty — never `undefined` — when there are none. */
export function edgeIdsFor(index: EdgeIndex, source: string, handle: string): readonly string[] {
  return index.get(key(source, handle)) ?? NO_EDGES;
}

// Keyed on the edge array's identity: both runtimes hand ingest the array the
// current flow was built from, so a flow change is a new array and a rebuilt
// index, while a burst of events on an unchanged flow reuses one index.
const cache = new WeakMap<ReadonlyArray<EdgeLike>, EdgeIndex>();

export function edgeIndexOf(edges: ReadonlyArray<EdgeLike>): EdgeIndex {
  const cached = cache.get(edges);
  if (cached) return cached;
  const index = buildEdgeIndex(edges);
  cache.set(edges, index);
  return index;
}
