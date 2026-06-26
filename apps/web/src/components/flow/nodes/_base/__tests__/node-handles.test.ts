import { describe, expect, it } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { NodeHandles } from "../node-handles";
import { COMPONENT_EMITS, COMPONENT_PORTS, type ComponentType } from "../_base.types";

// `NodeHandles` uses `Handle` only as an element *type* — these tests read props
// off the produced elements without ever mounting, so @xyflow/react's render path
// (which would need a live ReactFlow context + DOM) never runs.

type RenderedHandle = { type: "target" | "source"; id: string; position?: string };

/**
 * `NodeHandles` is hookless, so we invoke it directly and flatten the returned
 * fragment's children into the flat list of `Handle` elements it emitted.
 */
function renderedHandles(instance: ComponentType): RenderedHandle[] {
  const tree = NodeHandles({ instance }) as ReactElement;
  const out: RenderedHandle[] = [];
  const flatten = (node: ReactNode) => {
    if (Array.isArray(node)) for (const child of node) flatten(child);
    else if (isValidElement(node)) out.push(node.props as RenderedHandle);
  };
  flatten((tree.props as { children?: ReactNode }).children);
  return out;
}

const sorted = (ids: readonly string[]) => [...ids].sort();

describe("NodeHandles", () => {
  // Representative instances spanning the interesting shapes: target+source,
  // four targets, source-only, an event emit, and a node whose port and emit
  // share the id "value".
  const instances = ["Led", "Counter", "Constant", "Delay", "I2cDevice"] as const;

  it.each(instances)("renders exactly one handle per declared port/emit (%s)", (instance) => {
    const handles = renderedHandles(instance);
    const targets = handles.filter((h) => h.type === "target").map((h) => h.id);
    const sources = handles.filter((h) => h.type === "source").map((h) => h.id);

    expect(sorted(targets)).toEqual(sorted(COMPONENT_PORTS[instance]));
    expect(sorted(sources)).toEqual(sorted(COMPONENT_EMITS[instance]));
    // and no id rendered twice on the same side
    expect(new Set(targets).size).toBe(targets.length);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("defaults target handles to the left edge and source handles to the right edge", () => {
    for (const handle of renderedHandles("Led")) {
      expect(handle.position).toBe(handle.type === "target" ? "left" : "right");
    }
  });

  it("leaves no declared port/emit unrendered for any catalogued component", () => {
    // Exhaustive form of the guard: a future Rust-added port/emit that
    // `NodeHandles` failed to render would trip here — the wire-interface
    // contract can no longer silently drift past the handle rendering.
    for (const instance of Object.keys(COMPONENT_PORTS) as ComponentType[]) {
      const handles = renderedHandles(instance);
      const targets = handles.filter((h) => h.type === "target").map((h) => h.id);
      const sources = handles.filter((h) => h.type === "source").map((h) => h.id);

      expect(sorted(targets)).toEqual(sorted(COMPONENT_PORTS[instance]));
      expect(sorted(sources)).toEqual(sorted(COMPONENT_EMITS[instance]));
    }
  });
});
