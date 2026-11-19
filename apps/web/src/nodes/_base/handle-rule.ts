// What a node's `<node>.handles.ts` is written in: the shape of one handle and
// of a node's Handle Rule. React-free, so the rules can be read by code that
// never renders a node (see `nodes/handles.ts`).

import type { ComponentType, EmitOf, PortOf } from "../component-types.generated";

/** What travels over a handle; picks its glyph on the canvas. */
export type HandleKind = "value" | "event" | "command" | "state";

/** The edge of the node a handle sits on. */
export type HandleSide = "left" | "right" | "bottom";

/** How a handle is drawn. Everything is optional; see `NodeHandles` for the defaults. */
type HandleLook = {
  kind?: HandleKind;
  /** Position along its side, in handle slots from the centre. */
  offset?: number;
  /** Label, when it should differ from the id. */
  title?: string;
  /** Tooltip, e.g. the accepted range. */
  hint?: string;
  /** Defaults to `left` for a Port and `right` for an Emit. */
  side?: HandleSide;
};

/**
 * One connectable **Port**.
 *
 * `id` must be a Port the Rust component declares (`PortOf<T>`, ADR-0007), so
 * a renamed or removed Port stops this file compiling. An **open port** is the
 * one exception: a Port named by the node's own settings (a Function
 * `{{variable}}`, a Music record), which the component accepts under any name
 * and no generated list can hold. It says so with `open: true`.
 *
 * An open port can be `hidden`: connectable, but not drawn, because the node
 * has no room for it. Whether a handle exists never depends on room.
 */
export type PortSpec<T extends ComponentType> = HandleLook &
  ({ id: PortOf<T>; open?: false } | { id: string; open: true; hidden?: boolean });

/** One connectable **Emit**. `id` must be an Emit the Rust component declares. */
export type EmitSpec<T extends ComponentType> = HandleLook & { id: EmitOf<T> };

/** A node's handles for one configuration, in render order. */
export type HandleLayout<T extends ComponentType = ComponentType> = {
  readonly ports: readonly PortSpec<T>[];
  readonly emits: readonly EmitSpec<T>[];
};

/**
 * A node's settings as a rule receives them: whatever the flow document holds.
 *
 * Nothing is known about any field. The document is shared and persisted, so
 * a field may be missing, of the wrong type, or written by another build. The
 * type makes a rule check before it uses one; a rule must answer for any
 * value and must never throw.
 */
export type Settings = Readonly<Record<string, unknown>>;

/**
 * A node's **Handle Rule**: its handles as a function of its settings.
 *
 * `Data` is the node's schema type. It only types `variants`; `layout` is
 * given {@link Settings}.
 */
export type HandleRule<T extends ComponentType, Data extends object = {}> = {
  /**
   * The node's handles for these settings. A setting that is missing or
   * unusable reads as the node's default for it, so `layout({})` is the layout
   * of a node with default settings.
   */
  layout: (data: Settings) => HandleLayout<T>;
  /**
   * The settings that change which handles the node has: one entry per
   * distinct handle set, holding just the settings that select it. Empty for a
   * node whose handles never change. Open ports are not listed; see
   * `openPorts`.
   *
   * The rule is the function; this is its index, for readers that need to
   * know every handle the node can ever offer and what turns each one on.
   * `nodes/handles.test.ts` holds the two together.
   */
  variants: readonly Partial<Data>[];
  /**
   * For a node whose variant settings are not chosen directly but filled in
   * from something else: what they follow, in words that complete "its handles
   * follow …". A design variable's `resolvedType` is one: it is the type of
   * the variable that was picked. A reader that would otherwise tell someone
   * to set the variant's settings tells them this instead.
   */
  variantsFollow?: string;
  /** For a node with open ports: what names them, in a few words. */
  openPorts?: string;
};

/** Declare a node's Handle Rule. */
export function defineHandles<T extends ComponentType, Data extends object = {}>(
  layout: (data: Settings) => HandleLayout<T>,
  options: Partial<Omit<HandleRule<T, Data>, "layout">> = {},
): HandleRule<T, Data> {
  return { layout, ...options, variants: options.variants ?? [] };
}

/**
 * Open ports for `names`, laid out along the bottom of a node. At most `room`
 * of them are drawn, centred; the rest are hidden. Shared by the nodes that
 * have open ports so they cannot lay them out differently.
 */
export function openPorts(
  names: readonly string[],
  kind: HandleKind,
  room: number,
): { id: string; open: true; kind: HandleKind; side: "bottom"; offset: number; hidden: boolean }[] {
  const drawn = Math.min(names.length, room);
  return names.map((id, index) => ({
    id,
    open: true,
    kind,
    side: "bottom",
    offset: index - (drawn - 1) / 2,
    hidden: index >= room,
  }));
}

/** The string at `data[key]`, or `""` when it holds anything else. */
export function textSetting(data: Settings, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}
