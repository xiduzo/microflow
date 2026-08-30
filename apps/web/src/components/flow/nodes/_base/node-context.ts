import { createContext, useContext } from "react";
import type { BaseNode } from "./_base";

/**
 * The container context a node's subtree reads its id/data/selection from.
 *
 * It lives in this leaf module rather than in `_base.tsx` so the things that
 * need only `useNodeId` — chiefly `stores/node-data`, on the hot component-event
 * path — can reach it without importing the node *layout* component, which
 * transitively pulls in the board store, the hardware pin UI, and from there the
 * generated Firmata wasm glue. `_base.tsx` re-exports all of this, so every
 * existing `from "../_base/_base"` import keeps working unchanged.
 */
export type NodeContainerProps<T extends Record<string, unknown>> = BaseNode<T>;

export const NodeContainerContext = createContext<NodeContainerProps<Record<string, unknown>>>(
  {} as NodeContainerProps<Record<string, unknown>>,
);

/** Internal accessor for everything the container provides. Hook modules use this
 *  to read id/data/selected/etc. without each one re-deriving the context shape. */
export const useNode = <T extends Record<string, unknown>>() =>
  useContext(NodeContainerContext as React.Context<NodeContainerProps<T>>);

export const useNodeId = () => {
  const { id } = useNode();
  return id;
};

export const useNodeData = <T extends Record<string, any>>() => {
  const { data } = useNode<T>();
  return data;
};
