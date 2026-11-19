import type { Connection, Edge } from "@xyflow/react";
import { checkEdge, type HandleNode } from "../handles";

/** A node-supplied rule for which connections one of its handles accepts. */
export type HandleConnectionRule = (edges: Edge[], connection: Edge | Connection) => boolean;

/**
 * Whether ReactFlow may make `connection`.
 *
 * Three rules, and all must hold: no self-loops; both ends are in the Live
 * Handle Set of their node as it is configured now (`nodes/handles.ts`, the
 * same check Ask AI's `connect` makes); and the handle's own rule, if it has
 * one.
 */
export function isValidHandleConnection(
  connection: Edge | Connection,
  edges: Edge[],
  nodeOf: (nodeId: string) => HandleNode | undefined,
  rule?: HandleConnectionRule,
): boolean {
  if (connection.source === connection.target) return false;
  if (checkEdge(connection, nodeOf) !== null) return false;
  if (rule && !rule(edges, connection)) return false;
  return true;
}
