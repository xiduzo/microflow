import { Handle, type HandleOverride } from "../../handle";
import {
  COMPONENT_EMITS,
  COMPONENT_PORTS,
  type ComponentType,
  type EmitOf,
  type PortOf,
} from "./_base.types";

/**
 * Override maps are keyed by the **generated** handle ids — `PortOf<T>` for
 * target handles, `EmitOf<T>` for source handles. Because they're object
 * literals against a `Record` of the exact id union, a key that isn't a
 * declared port/emit is an excess-property compile error at the call site. So
 * if a Rust port/emit is renamed or removed, every node that overrides the
 * stale id stops compiling — the drift the wire-interface contract is meant to
 * prevent now fails loudly instead of silently.
 */
type PortOverrides<T extends ComponentType> = Partial<Record<PortOf<T>, HandleOverride>>;
type EmitOverrides<T extends ComponentType> = Partial<Record<EmitOf<T>, HandleOverride>>;

type Props<T extends ComponentType> = {
  /** The node's ComponentType. Drives which handles are rendered. */
  instance: T;
  /** Presentational props per **target** handle, keyed by `PortOf<instance>`. */
  portOverrides?: PortOverrides<T>;
  /** Presentational props per **source** handle, keyed by `EmitOf<instance>`. */
  emitOverrides?: EmitOverrides<T>;
};

/**
 * Renders the full handle set for a node straight from the single-source
 * wire-interface contract (ADR-0007): one **target** `Handle` for every id in
 * `COMPONENT_PORTS[instance]` and one **source** `Handle` for every id in
 * `COMPONENT_EMITS[instance]`. The contract knows _which_ handles exist; the
 * node supplies only the presentational bits it can't — offsets, titles, hints,
 * conditional connectability — through `portOverrides` / `emitOverrides`.
 *
 * Defaults: target handles sit on the `left`, source handles on the `right`;
 * either can be moved per-handle via an override's `position`.
 */
export function NodeHandles<T extends ComponentType>({
  instance,
  portOverrides,
  emitOverrides,
}: Props<T>) {
  // `COMPONENT_PORTS[instance]` is a union of readonly tuples for a generic
  // `T`; widen to `readonly string[]` then narrow to the id union so `.map`'s
  // callback param is `PortOf<T>` / `EmitOf<T>` (both steps are valid `as`
  // directions — direct assertion to the id-union isn't).
  const ports = COMPONENT_PORTS[instance] as readonly string[] as readonly PortOf<T>[];
  const emits = COMPONENT_EMITS[instance] as readonly string[] as readonly EmitOf<T>[];

  return (
    <>
      {ports.map((id) => {
        const override = portOverrides?.[id];
        return (
          <Handle<T>
            key={`target-${id}`}
            {...override}
            type="target"
            id={id}
            position={override?.position ?? "left"}
          />
        );
      })}
      {emits.map((id) => {
        const override = emitOverrides?.[id];
        return (
          <Handle<T>
            key={`source-${id}`}
            {...override}
            type="source"
            id={id}
            position={override?.position ?? "right"}
          />
        );
      })}
    </>
  );
}
