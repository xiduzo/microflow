import type { Connection, Edge } from "@xyflow/react";

/** A node-supplied rule for which connections one of its handles accepts. */
export type HandleConnectionRule = (edges: Edge[], connection: Edge | Connection) => boolean;

/**
 * Whether ReactFlow may make `connection`.
 *
 * The canvas-wide rule (no self-loops) and the handle's own rule must *both*
 * hold. The handle's rule used to be called and its answer thrown away, so a
 * node could declare a connection invalid and still receive it.
 */
export function isValidHandleConnection(
  connection: Edge | Connection,
  edges: Edge[],
  rule?: HandleConnectionRule,
): boolean {
  if (connection.source === connection.target) return false;
  if (rule && !rule(edges, connection)) return false;
  return true;
}
