import { describe, expect, test } from "bun:test";
import { NODE_CATALOG } from "../catalog.generated";
import { COMPONENT_TYPES, type ComponentType } from "../component-types.generated";
import { handleLayout } from "../handle-rules";
import { handleVariants, liveHandles } from "../handles";
import { handleElements } from "./node-handles";

// `handleElements` is what `<NodeHandles>` renders, without its hooks. The
// tests read the props of the `Handle` elements it returns and never mount
// them, so no ReactFlow store and no DOM is involved.

/** `direction:id@side`, plus the offset when there is one, per rendered handle. */
function rendered(type: ComponentType, data: Record<string, unknown> = {}): string[] {
  return handleElements(handleLayout(type, data)).map(({ props }) => {
    const at = props.offset === undefined ? "" : `[${props.offset}]`;
    return `${props.type}:${props.id}@${props.position}${at}`;
  });
}

describe("handleElements", () => {
  test("a static node: Ports are targets on the left, Emits are sources on the right", () => {
    expect(rendered("Led")).toEqual([
      "target:true@left[-1.5]",
      "target:toggle@left[-0.5]",
      "target:value@left[0.5]",
      "target:false@left[1.5]",
      "source:value@right",
    ]);
  });

  test("a Variant renders its parent's handles", () => {
    expect(rendered("Force")).toEqual(["source:value@right"]);
    expect(rendered("Vibration")).toEqual(rendered("Led"));
  });

  test("a node whose handles follow its settings", () => {
    expect(rendered("Mqtt", { direction: "publish" })).toEqual(["target:trigger@left"]);
    expect(rendered("Mqtt", { direction: "subscribe" })).toEqual(["source:value@right"]);
  });

  test("open ports are targets along the bottom, centred", () => {
    expect(rendered("Function", { code: "return {{a}} + {{b}};" })).toEqual([
      "target:trigger@left",
      "target:a@bottom[-0.5]",
      "target:b@bottom[0.5]",
      "source:value@right",
    ]);
  });

  test("an open port there is no room for is live but not drawn", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const data = { code: names.map((name) => `{{${name}}}`).join(" ") };

    expect(liveHandles("Function", data).ports).toEqual(["trigger", ...names]);
    expect(rendered("Function", data)).toEqual([
      "target:trigger@left",
      // Seven fit, centred on the seven.
      ...names.slice(0, 7).map((name, index) => `target:${name}@bottom[${index - 3}]`),
      "source:value@right",
    ]);
  });

  test("every handle of a node that is drawn has its own key", () => {
    // `value` is both a Port and an Emit of a Led.
    const keys = handleElements(handleLayout("Led", {})).map((element) => element.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("the title and the kind come from the rule", () => {
    const [, , value] = handleElements(handleLayout("Led", { subType: "vibration" }));
    expect(value.props).toMatchObject({ id: "value", title: "intensity", handleType: "value" });
  });

  test("an override reaches the handle it names, on its own side only", () => {
    const elements = handleElements(handleLayout("Led", {}), {
      value: { hint: "requires a ~ pin", isConnectable: false },
    });
    const port = elements.find(({ props }) => props.type === "target" && props.id === "value");
    const emit = elements.find(({ props }) => props.type === "source" && props.id === "value");

    expect(port?.props).toMatchObject({ hint: "requires a ~ pin", isConnectable: false });
    expect(emit?.props.hint).toBeUndefined();
    expect(emit?.props.isConnectable).toBeUndefined();
  });

  test("a handle named like something every object inherits gets no override by accident", () => {
    const data = { code: "return {{toString}} + {{constructor}};" };
    const elements = handleElements(handleLayout("Function", data), {}, {});
    const named = elements.filter(({ props }) => props.position === "bottom");

    expect(named.map(({ props }) => props.id)).toEqual(["toString", "constructor"]);
    for (const { props } of named) expect(props.hint).toBeUndefined();
  });
});

describe("where a node's handles are drawn", () => {
  /** Settings that name open ports: a few, and more than there is room to draw. */
  const names = (count: number) => Array.from({ length: count }, (_, index) => `n${index}`);
  const OPEN_PORTS: Partial<Record<ComponentType, Record<string, unknown>[]>> = {
    Function: [3, 12].map((count) => ({ code: names(count).map((name) => `{{${name}}}`).join(" + ") })),
    Llm: [3, 12].map((count) => ({ prompt: names(count).map((name) => `{{${name}}}`).join(" ") })),
    Music: [3, 12].map((count) => ({ tracks: names(count).map((name) => ({ name, src: "" })) })),
  };

  /** Every configuration that gives a type a handle set of its own, as node data. */
  function configurations(type: ComponentType): Record<string, unknown>[] {
    const { defaults } = NODE_CATALOG[type];
    const settings = [
      {},
      ...handleVariants(type).bySettings.map((variant) => variant.settings),
      ...(OPEN_PORTS[type] ?? []),
    ];
    return settings.map((setting) => ({ ...defaults, ...setting }));
  }

  /** The slots `count` handles take on one side: one apart, centred on its middle. */
  const slots = (count: number) => Array.from({ length: count }, (_, index) => index - (count - 1) / 2);

  /** How many handles the left or the right side of the smallest node has room for. */
  const SIDE_ROOM = 5;

  test("every live handle is drawn, but for an open port there is no room for", () => {
    for (const type of COMPONENT_TYPES) {
      for (const data of configurations(type)) {
        const layout = handleLayout(type, data);
        const drawn = handleElements(layout).map(({ props }) => `${props.type}:${props.id}`);
        const expected = [
          ...layout.ports.filter((port) => !(port.open && port.hidden)).map((port) => `target:${port.id}`),
          ...liveHandles(type, data).emits.map((id) => `source:${id}`),
        ];

        expect({ type, drawn }).toEqual({ type, drawn: expected });
        // Only an open port is ever left out: every Port the component declares is drawn.
        const hidden = layout.ports.filter((port) => port.open && port.hidden).map((port) => port.id);
        expect({ type, live: liveHandles(type, data).ports.length }).toEqual({
          type,
          live: drawn.filter((handle) => handle.startsWith("target:")).length + hidden.length,
        });
      }
    }
  });

  test("the handles on a side sit one slot apart, centred, and never share a slot", () => {
    for (const type of COMPONENT_TYPES) {
      for (const data of configurations(type)) {
        const bySide = new Map<string, number[]>();
        for (const { props } of handleElements(handleLayout(type, data))) {
          bySide.set(props.position, [...(bySide.get(props.position) ?? []), props.offset ?? 0]);
        }
        for (const [side, offsets] of bySide) {
          expect({ type, side, offsets: offsets.toSorted((a, b) => a - b) }).toEqual({
            type,
            side,
            offsets: slots(offsets.length),
          });
          if (side !== "bottom") expect({ type, side, fits: offsets.length <= SIDE_ROOM }).toEqual({ type, side, fits: true });
        }
      }
    }
  });

  test("Rgb: three channels, their intensity, and off", () => {
    expect(rendered("Rgb")).toEqual([
      "target:red@left[-2]",
      "target:green@left[-1]",
      "target:blue@left[0]",
      "target:alpha@left[1]",
      "target:off@left[2]",
      "source:value@right",
    ]);
  });

  test("Stepper: `enable` is drawn below the moves", () => {
    expect(rendered("Stepper")).toEqual([
      "target:value@left[-2]",
      "target:to@left[-1]",
      "target:stop@left[0]",
      "target:zero@left[1]",
      "target:enable@left[2]",
    ]);
  });

  test("Matrix: `reinitialize` is drawn below `reset`", () => {
    expect(rendered("Matrix")).toEqual([
      "target:value@left[-1]",
      "target:reset@left[0]",
      "target:reinitialize@left[1]",
      "source:value@right",
    ]);
  });

  test("Llm: `error` is drawn below the answer", () => {
    expect(rendered("Llm")).toEqual([
      "target:trigger@left",
      "source:thinking@right[-1.5]",
      "source:done@right[-0.5]",
      "source:value@right[0.5]",
      "source:error@right[1.5]",
    ]);
  });

  test("a sensor has no input", () => {
    for (const type of ["Sensor", "Potentiometer", "Button", "Switch", "Motion", "Proximity"] as const) {
      expect(rendered(type).filter((handle) => handle.startsWith("target:"))).toEqual([]);
    }
  });
});
