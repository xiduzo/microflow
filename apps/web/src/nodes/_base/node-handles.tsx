import { useUpdateNodeInternals } from "@xyflow/react";
import { useEffect, useMemo, type ReactElement } from "react";
import {
  isComponentType,
  type ComponentType,
  type EmitOf,
  type PortOf,
} from "../component-types.generated";
import { handleLayout } from "../handle-rules";
import { Handle, type HandleOverride, type HandleProps } from "./handle";
import type { HandleLayout } from "./handle-rule";
import { useNode } from "./node-context";

type Overrides = Partial<Record<string, HandleOverride>>;

type Props<T extends ComponentType> = {
  /** Host-dependent props per **Port**, keyed by its id. */
  portOverrides?: Partial<Record<PortOf<T>, HandleOverride>>;
  /** Host-dependent props per **Emit**, keyed by its id. */
  emitOverrides?: Partial<Record<EmitOf<T>, HandleOverride>>;
};

const NO_HANDLES: HandleLayout = { ports: [], emits: [] };

/**
 * Renders the handles of the node it is placed in: one target handle per Port
 * and one source handle per Emit of the node's Live Handle Set, laid out as its
 * Handle Rule says (`<node>.handles.ts`). The node's type and settings come
 * from the `NodeContainer` around it, so a node renders `<NodeHandles />` and
 * its handles follow its settings with no code of its own.
 *
 * This is the only place a node's handles are rendered, which is what makes
 * the canvas agree with every other reader of `nodes/handles.ts`. The one
 * handle it leaves out is an open port the rule marks `hidden`: connectable,
 * with no room to draw it.
 *
 * A Port sits on the left and an Emit on the right unless the rule gives it a
 * side. The override maps carry only what the rule cannot know because it
 * depends on the host, not on the node (see `HandleOverride`); bind the generic
 * (`<NodeHandles<"Led"> …>`) to have their keys checked against that
 * Component's Ports and Emits.
 */
export function NodeHandles<T extends ComponentType = ComponentType>({
  portOverrides,
  emitOverrides,
}: Props<T>) {
  const { id, type, data } = useNode();
  const updateNodeInternals = useUpdateNodeInternals();

  const elements = useMemo(
    () =>
      handleElements(
        type && isComponentType(type) ? handleLayout(type, data) : NO_HANDLES,
        portOverrides,
        emitOverrides,
      ),
    [type, data, portOverrides, emitOverrides],
  );

  // ReactFlow measures a node's handles once; it has to be told when they
  // change, or edges keep pointing at where a handle used to be.
  const rendered = elements
    .map(({ key, props }) => `${key}@${props.position}${props.offset ?? 0}`)
    .join("|");
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, rendered, updateNodeInternals]);

  return <>{elements}</>;
}

/**
 * The `Handle` elements for a layout: what `NodeHandles` renders, without its
 * hooks.
 */
export function handleElements(
  layout: HandleLayout,
  portOverrides: Overrides = {},
  emitOverrides: Overrides = {},
): ReactElement<HandleProps>[] {
  // Own keys only: a handle may be called `toString`.
  const override = (overrides: Overrides, handleId: string) =>
    Object.hasOwn(overrides, handleId) ? overrides[handleId] : undefined;

  const ports = layout.ports
    .filter((port) => !(port.open && port.hidden))
    .map((port) => {
      const extra = override(portOverrides, port.id);
      const side = port.side ?? "left";
      return (
        <Handle
          key={`target:${port.id}`}
          {...extra}
          type="target"
          id={port.id}
          position={side}
          handleType={port.kind}
          offset={port.offset}
          title={port.title}
          hint={extra?.hint ?? port.hint}
        />
      );
    });
  const emits = layout.emits.map((emit) => {
    const extra = override(emitOverrides, emit.id);
    const side = emit.side ?? "right";
    return (
      <Handle
        key={`source:${emit.id}`}
        {...extra}
        type="source"
        id={emit.id}
        position={side}
        handleType={emit.kind}
        offset={emit.offset}
        title={emit.title}
        hint={extra?.hint ?? emit.hint}
      />
    );
  });
  return [...ports, ...emits];
}
