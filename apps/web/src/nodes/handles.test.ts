import { describe, expect, test } from "bun:test";
import { NODE_CATALOG } from "./catalog.generated";
import {
  COMPONENT_EMITS,
  COMPONENT_PORTS,
  COMPONENT_TYPES,
  type ComponentType,
} from "./component-types.generated";
import {
  checkEdge,
  checkEdgeEnds,
  handleVariants,
  liveHandles,
  nodeHandles,
  type HandleNode,
  type HandleSet,
} from "./handles";

const ports = (type: ComponentType, data: unknown) => liveHandles(type, data).ports;
const emits = (type: ComponentType, data: unknown) => liveHandles(type, data).emits;

describe("liveHandles: a node whose handles follow its settings", () => {
  test("Servo: a standard servo is positioned, a continuous one is driven and stopped", () => {
    expect(liveHandles("Servo", { type: "standard" })).toEqual({
      ports: ["min", "value", "max"],
      emits: ["value"],
    });
    expect(liveHandles("Servo", { type: "continuous" })).toEqual({
      ports: ["value", "stop"],
      emits: ["value"],
    });
  });

  test("Mqtt: a publishing node only takes, a subscribing node only gives", () => {
    expect(liveHandles("Mqtt", { direction: "publish" })).toEqual({ ports: ["trigger"], emits: [] });
    expect(liveHandles("Mqtt", { direction: "subscribe" })).toEqual({ ports: [], emits: ["value"] });
  });

  test("Midi: out sends; in emits notes or a control change", () => {
    for (const mode of ["note", "cc", "song"]) {
      expect(liveHandles("Midi", { direction: "out", mode })).toEqual({ ports: ["send"], emits: [] });
    }
    expect(liveHandles("Midi", { direction: "in", mode: "note" })).toEqual({
      ports: [],
      emits: ["note", "velocity", "on", "off"],
    });
    expect(liveHandles("Midi", { direction: "in", mode: "cc" })).toEqual({
      ports: [],
      emits: ["value"],
    });
    // Song is an out-only mode.
    expect(liveHandles("Midi", { direction: "in", mode: "song" })).toEqual({ ports: [], emits: [] });
  });

  test("Piezo: both types have the same two ports, and pass on whether they sound", () => {
    for (const type of ["buzz", "song"]) {
      expect(liveHandles("Piezo", { type })).toEqual({ ports: ["trigger", "stop"], emits: ["value"] });
    }
  });

  test("Figma: the ports follow the stored type of the design variable", () => {
    expect(ports("Figma", { resolvedType: "BOOLEAN" })).toEqual(["true", "toggle", "false"]);
    expect(ports("Figma", { resolvedType: "COLOR" })).toEqual(["red", "green", "blue", "opacity"]);
    expect(ports("Figma", { resolvedType: "FLOAT" })).toEqual([
      "increment",
      "set",
      "decrement",
      "reset",
    ]);
    expect(ports("Figma", { resolvedType: "STRING" })).toEqual(["set"]);
    expect(emits("Figma", { resolvedType: "COLOR" })).toEqual(["change"]);
  });
});

describe("liveHandles: open ports, named by the node's own settings", () => {
  test("Function: one port per {{variable}} in the code, after `trigger`", () => {
    expect(ports("Function", { code: "return {{speed}} * {{gain}} + {{speed}};" })).toEqual([
      "trigger",
      "speed",
      "gain",
    ]);
  });

  test("Function: a variable that is only mentioned in a comment is not a port", () => {
    const code = "// scale by {{factor}}\n/* or {{other}} */\nreturn {{speed}};";
    expect(ports("Function", { code })).toEqual(["trigger", "speed"]);
  });

  test("Llm: one port per {{variable}} in the prompt, after `trigger`", () => {
    expect(ports("Llm", { prompt: "Greet {{name}} in {{language}}" })).toEqual([
      "trigger",
      "name",
      "language",
    ]);
  });

  test("every variable and every record is live, however many the node has room to draw", () => {
    const names = Array.from({ length: 12 }, (_, i) => `v${i}`);
    const text = names.map((name) => `{{${name}}}`).join(" ");
    expect(ports("Function", { code: text })).toEqual(["trigger", ...names]);
    expect(ports("Llm", { prompt: text })).toEqual(["trigger", ...names]);
    expect(ports("Music", { tracks: names.map((name) => ({ name, src: "" })) })).toEqual([
      "play",
      "stop",
      "set",
      ...names,
    ]);
  });

  test("a setting cannot shadow a fixed port: the id stays unique", () => {
    expect(ports("Function", { code: "return {{trigger}};" })).toEqual(["trigger"]);
    expect(ports("Llm", { prompt: "{{trigger}}" })).toEqual(["trigger"]);
    expect(ports("Music", { tracks: [{ name: "play", src: "" }] })).toEqual(["play", "stop", "set"]);
  });
});

describe("liveHandles: reading the variables out of a text is one pass", () => {
  // What the extraction is defined by: the patterns it was first written as.
  // They are exact but backtrack, which is why the rules do not use them.
  const llmReference = (prompt: string): string[] => {
    const matches = prompt.match(/{{(.*?)}}/g) ?? [];
    return Array.from(
      new Set(matches.map((match) => match.replace("{{", "").replace("}}", ""))),
    ).filter(Boolean);
  };
  const functionReference = (code: string): string[] => {
    const stripped = code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const matches = stripped.match(/\{\{(\w+)\}\}/g) ?? [];
    return Array.from(new Set(matches.map((m) => m.replace(/\{|\}/g, "")))).filter(Boolean);
  };
  const expected = (names: string[]) => ["trigger", ...names.filter((name) => name !== "trigger")];

  /** A repeatable stream of texts built from the pieces the patterns care about. */
  function* texts(count: number): Generator<string> {
    const pieces = [
      "{{", "}}", "{", "}", "//", "/*", "*/", "/", "*", "a", "Bc", "_", "1", " ", "\n", "\r",
      "\r\n", "\u2028", "-", "é", "{{trigger}}", "{{ a }}", "{{x}}", "return ",
    ];
    let seed = 20261119;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let n = 0; n < count; n++) {
      let text = "";
      for (let length = next() % 40; length > 0; length--) text += pieces[next() % pieces.length];
      yield text;
    }
  }

  test("Llm: the same variables as the pattern, on any text", () => {
    for (const prompt of texts(20_000)) {
      const actual = ports("Llm", { prompt });
      if (!Bun.deepEquals(actual, expected(llmReference(prompt)))) {
        expect({ prompt, ports: actual }).toEqual({ prompt, ports: expected(llmReference(prompt)) });
      }
    }
  });

  test("Function: the same variables as the patterns, on any text", () => {
    for (const code of texts(20_000)) {
      const actual = ports("Function", { code });
      if (!Bun.deepEquals(actual, expected(functionReference(code)))) {
        expect({ code, ports: actual }).toEqual({ code, ports: expected(functionReference(code)) });
      }
    }
  });

  test("the cases worth naming", () => {
    // The name is what stands between the braces, spaces and extra braces included.
    expect(ports("Llm", { prompt: "{{ a }} {{{b}} {{c}}} {{}} {{d\n}} {{e" })).toEqual([
      "trigger",
      " a ",
      "{b",
      "c",
    ]);
    // A Function variable is a word; an open block comment is not a comment.
    expect(ports("Function", { code: "{{ a }} {{{b}} /* {{c}} */ // {{d}}\n/* {{e}}" })).toEqual([
      "trigger",
      "b",
      "e",
    ]);
  });

  // One pass means the time follows the length of the text: four times the
  // text takes about four times as long. A scan that looks ahead again from
  // every opening, or a pattern that backtracks, takes sixteen times as long
  // or more (the Llm pattern above: thirty times and up). So the test measures
  // how the time grows, not how long it is. A slow or busy machine is slow for
  // both texts alike, and no number here is a duration.
  //
  // It is measured on the clock and not counted, because the work a pattern
  // does inside the regex engine can only be seen on the clock.

  /** Milliseconds one evaluation takes. */
  const timed = (run: () => unknown): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  /**
   * How many times longer `large` takes than `small`. Each is timed a few
   * times, in turns, and its least time counts: a pause or a first, slower run
   * of the code is in some timings and not in the least of them.
   */
  const growth = (small: () => unknown, large: () => unknown): number => {
    let leastSmall = Infinity;
    let leastLarge = Infinity;
    for (let round = 0; round < 9; round++) {
      leastSmall = Math.min(leastSmall, timed(small));
      leastLarge = Math.min(leastLarge, timed(large));
    }
    return leastLarge / leastSmall;
  };

  // Each text is the worst case for one way of reading it more than once. The
  // count gives 40 to 84 KB, and a quarter of that to compare with.
  test.each([
    ["Llm", "prompt", "`{{` that never closes", (count: number) => "{{".repeat(count), 20_000],
    ["Llm", "prompt", "an opening on every line, one close at the very end", (count: number) => `${"{{\n".repeat(count)}}}`, 15_000],
    // With the space: `/*/*` closes at its `*/`.
    ["Function", "code", "`/*` that never closes", (count: number) => "/* ".repeat(count), 26_000],
    ["Function", "code", "nothing but `{{`", (count: number) => "{{".repeat(count), 39_000],
    ["Function", "code", "an unclosed variable before every long word", (count: number) => `{{${"a".repeat(40)}`.repeat(count), 2_000],
  ] as const)("%s: %s (%s) takes time in proportion to its length", (type, field, _what, text, count) => {
    const quarter = text(count / 4);
    const whole = text(count);
    const reading = (value: string) => () => liveHandles(type, { [field]: value });

    // Linear is 4 and quadratic is 16. The line is drawn between them.
    expect(growth(reading(quarter), reading(whole))).toBeLessThan(8);
  });
});

describe("liveHandles: any data gets an answer", () => {
  test("a missing setting reads as the node's default for it", () => {
    for (const type of COMPONENT_TYPES) {
      const withDefaults = liveHandles(type, NODE_CATALOG[type].defaults);
      for (const data of [{}, [], null, undefined, "not an object", 7, true]) {
        expect({ type, set: liveHandles(type, data) }).toEqual({ type, set: withDefaults });
      }
    }
  });

  test("a Variant has its parent's handles", () => {
    for (const variant of ["Force", "HallEffect", "Ldr", "Potentiometer", "Tilt"] as const) {
      expect(liveHandles(variant, NODE_CATALOG[variant].defaults)).toEqual(
        liveHandles("Sensor", NODE_CATALOG.Sensor.defaults),
      );
    }
    expect(liveHandles("Vibration", NODE_CATALOG.Vibration.defaults)).toEqual(
      liveHandles("Led", NODE_CATALOG.Led.defaults),
    );
  });

  test("the cases that used to throw or yield a broken id", () => {
    expect(ports("Llm", { prompt: 123 })).toEqual(["trigger"]);
    expect(ports("Function", { code: 5 })).toEqual(["trigger"]);
    expect(ports("Music", { tracks: {} })).toEqual(["play", "stop", "set"]);
    expect(ports("Music", { tracks: [null] })).toEqual(["play", "stop", "set"]);
    expect(ports("Music", { tracks: [{}] })).toEqual(["play", "stop", "set"]);
    expect(ports("Music", { tracks: [{ name: "" }, { name: 4 }, { name: "ok" }] })).toEqual([
      "play",
      "stop",
      "set",
      "ok",
    ]);
    // A key every object inherits is not a variable type.
    for (const resolvedType of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(ports("Figma", { resolvedType })).toEqual(["set"]);
    }
  });

  /** Values a shared, persisted, multi-version document can hold in any field. */
  const JUNK: unknown[] = [
    null,
    undefined,
    0,
    1,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    false,
    "",
    " ",
    "x",
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "{{a}} {{}} {{ }} {{__proto__}} {{toString}} {{a}}",
    "x".repeat(200_000),
    Array.from({ length: 20_000 }, (_, i) => `{{v${i}}}`).join(""),
    [],
    [null],
    [undefined],
    [[]],
    [{}],
    [0, "a", null, {}],
    [{ name: null }, { name: "" }, { name: 7 }, { name: {} }, { name: "ok" }, { name: "ok" }],
    [{ name: "__proto__" }, { name: "toString" }, { name: "play" }],
    Array.from({ length: 50_000 }, (_, i) => ({ name: `track ${i}`, src: "" })),
    Array.from({ length: 50_000 }, () => ({ name: "same", src: "" })),
    {},
    { length: 3 },
    { name: "x" },
    { __proto__: null },
    JSON.parse('{"__proto__": {"direction": "publish"}}'),
  ];

  /** The handles a type can offer without open ports, over all its settings. */
  function everOffered(type: ComponentType) {
    const variants = handleVariants(type);
    const sets = [variants.defaults, ...variants.bySettings.map((variant) => variant.handles)];
    return {
      ports: new Set(sets.flatMap((set) => set.ports)),
      emits: new Set(sets.flatMap((set) => set.emits)),
    };
  }

  /** What every answer must satisfy, whatever went in. */
  function expectSound(type: ComponentType, data: unknown, label: string) {
    let set: HandleSet;
    try {
      set = liveHandles(type, data);
    } catch (error) {
      throw new Error(`liveHandles("${type}", ${label}) threw: ${String(error)}`);
    }
    const known = everOffered(type);
    const openPorts = handleVariants(type).openPorts !== undefined;
    for (const [side, ids] of Object.entries(set) as ["ports" | "emits", readonly string[]][]) {
      const bad = ids.filter((id) => typeof id !== "string" || id === "");
      if (bad.length > 0) throw new Error(`${type} ${label}: ${side} holds a non-id ${String(bad[0])}`);
      if (new Set(ids).size !== ids.length) throw new Error(`${type} ${label}: ${side} repeats an id`);
      // A handle that is not open is one the rule's own index knows.
      if (side === "ports" && openPorts) continue;
      const stray = ids.find((id) => !known[side].has(id));
      if (stray !== undefined) throw new Error(`${type} ${label}: ${side} has "${stray}", which no variant offers`);
    }
  }

  test("junk in any one field, in every field at once, or instead of the data", () => {
    for (const type of COMPONENT_TYPES) {
      const { defaults } = NODE_CATALOG[type];
      const fields = Object.keys(defaults);
      JUNK.forEach((junk, index) => {
        expectSound(type, junk, `data = junk #${index}`);
        expectSound(
          type,
          Object.fromEntries(fields.map((field) => [field, junk])),
          `every field = junk #${index}`,
        );
        for (const field of fields) {
          expectSound(type, { ...defaults, [field]: junk }, `${field} = junk #${index}`);
        }
      });
    }
  });
});

describe("handleVariants: every handle set a type can have", () => {
  test("a type whose settings never change its handles has no variants", () => {
    expect(handleVariants("Led")).toEqual({
      defaults: liveHandles("Led", NODE_CATALOG.Led.defaults),
      bySettings: [],
      openPorts: undefined,
    });
  });

  test("a type whose settings select its handles lists what selects which", () => {
    expect(handleVariants("Mqtt")).toEqual({
      defaults: { ports: [], emits: ["value"] },
      bySettings: [
        { settings: { direction: "publish" }, handles: { ports: ["trigger"], emits: [] } },
        { settings: { direction: "subscribe" }, handles: { ports: [], emits: ["value"] } },
      ],
      openPorts: undefined,
    });
  });

  test("a type with open ports says what names them", () => {
    expect(handleVariants("Function").openPorts).toContain("{{name}}");
    expect(handleVariants("Llm").openPorts).toContain("{{name}}");
    expect(handleVariants("Music").openPorts).toContain("record");
  });

  test("a variant's settings are valid settings of the node, and select what it says", () => {
    for (const type of COMPONENT_TYPES) {
      const { defaults, schema } = NODE_CATALOG[type];
      for (const { settings, handles } of handleVariants(type).bySettings) {
        const data = { ...defaults, ...settings };
        expect({ type, settings, valid: schema.safeParse(data).success }).toEqual({
          type,
          settings,
          valid: true,
        });
        expect({ type, settings, handles: liveHandles(type, data) }).toEqual({
          type,
          settings,
          handles,
        });
      }
    }
  });

  test("the default settings are one of the variants, when there are any", () => {
    for (const type of COMPONENT_TYPES) {
      const { defaults, bySettings } = handleVariants(type);
      if (bySettings.length === 0) continue;
      expect({ type, found: bySettings.some((variant) => Bun.deepEquals(variant.handles, defaults)) }).toEqual({
        type,
        found: true,
      });
    }
  });
});

describe("the live set and the wire interface (ADR-0007)", () => {
  /** The handles a type can offer without open ports, over all its settings. */
  function everOffered(type: ComponentType) {
    const variants = handleVariants(type);
    const sets = [variants.defaults, ...variants.bySettings.map((variant) => variant.handles)];
    return {
      ports: new Set(sets.flatMap((set) => set.ports)),
      emits: new Set(sets.flatMap((set) => set.emits)),
    };
  }

  test("without open ports, every live handle is one the Rust component declares", () => {
    // Defaults name no variable and hold no record, so nothing here is open.
    for (const type of COMPONENT_TYPES) {
      const offered = everOffered(type);
      const declaredPorts: readonly string[] = COMPONENT_PORTS[type];
      const declaredEmits: readonly string[] = COMPONENT_EMITS[type];
      expect({ type, undeclared: [...offered.ports].filter((id) => !declaredPorts.includes(id)) }).toEqual({ type, undeclared: [] });
      expect({ type, undeclared: [...offered.emits].filter((id) => !declaredEmits.includes(id)) }).toEqual({ type, undeclared: [] });
    }
  });

  // The Live Handle Set is the one truth: a handle a component declares is
  // offered by its node, so it is drawn on the canvas, and the engine honours
  // an edge at it. A Port the engine does nothing with is not declared. What
  // is declared and never offered is one of the two kinds below, and nothing
  // else: a new Rust Port or Emit fails these tests until its node's Handle
  // Rule offers it.

  /** The declared Ports no configuration offers, each with why. */
  const PORTS_NOT_OFFERED: Partial<Record<ComponentType, Record<string, string>>> = {
    Hotkey: {
      key_event: "the Runtime Host delivers a key press on it; no edge ever does",
    },
    Servo: {
      rotate:
        "a second name for `value` on a continuous servo; the engine honours it so that an " +
        "edge stored at it keeps driving the servo",
    },
  };

  /**
   * The types whose outputs are their named Emits, so their `value` Emit is
   * not offered. Every component that keeps a value emits it on `value`
   * (CONTEXT.md § Emit), which is also how the canvas shows it; a node that
   * leaves it off must draw another Emit that carries its output. `value` is
   * the only Emit that may be left off.
   */
  const NAMED_OUTPUTS: readonly ComponentType[] = [
    // `event` / `true` / `false` (and `hold`).
    "Button",
    "Hotkey",
    "Motion",
    "Switch",
    // `true` / `false`, `to`, `bang`, `change`.
    "Compare",
    "Gate",
    "RangeMap",
    "Trigger",
    "Figma",
    // `event`, which fires with the strip's colours on every change.
    "Pixel",
  ];

  /**
   * The types that declare `value`, offer no Emit at all and still leave
   * `value` off, each with why. The engine sends a value there; an edge out
   * of it cannot be drawn.
   */
  const VALUE_NOT_DRAWN: Partial<Record<ComponentType, string>> = {
    Monitor:
      "a display at the end of a flow; the engine passes on what it shows, and whether the " +
      "canvas offers that is open",
  };

  test("every declared Port is offered by some configuration, but for the listed ones", () => {
    for (const type of COMPONENT_TYPES) {
      const offered = everOffered(type);
      expect({ type, notOffered: COMPONENT_PORTS[type].filter((id) => !offered.ports.has(id)) }).toEqual({
        type,
        notOffered: Object.keys(PORTS_NOT_OFFERED[type] ?? {}),
      });
    }
    for (const reasons of Object.values(PORTS_NOT_OFFERED)) {
      for (const reason of Object.values(reasons)) expect(reason).not.toBe("");
    }
  });

  test("every declared Emit is offered by some configuration, but for the implicit `value`", () => {
    for (const type of COMPONENT_TYPES) {
      const offered = everOffered(type);
      const leftOff = NAMED_OUTPUTS.includes(type) || VALUE_NOT_DRAWN[type] !== undefined;
      expect({ type, notOffered: COMPONENT_EMITS[type].filter((id) => !offered.emits.has(id)) }).toEqual({
        type,
        notOffered: leftOff ? ["value"] : [],
      });
    }
  });

  test("a node that leaves `value` off draws another output, or is listed with why", () => {
    // A node with no drawn output at all, while the engine sends its value,
    // is a node the canvas cannot wire on from.
    for (const type of NAMED_OUTPUTS) {
      expect({ type, outputs: everOffered(type).emits.size > 0 }).toEqual({ type, outputs: true });
    }
    for (const [type, reason] of Object.entries(VALUE_NOT_DRAWN)) {
      expect({ type, outputs: everOffered(type as ComponentType).emits.size }).toEqual({ type, outputs: 0 });
      expect(reason).not.toBe("");
    }
  });
});

describe("nodeHandles", () => {
  test("is the live set of a node as found in a flow", () => {
    expect(nodeHandles({ type: "Mqtt", data: { direction: "publish" } })).toEqual({
      ports: ["trigger"],
      emits: [],
    });
  });

  test("is null for a type this build does not know", () => {
    expect(nodeHandles({ type: "NotYetInvented", data: {} })).toBeNull();
    expect(nodeHandles({ type: "toString", data: {} })).toBeNull();
    expect(nodeHandles({ type: null })).toBeNull();
    expect(nodeHandles({})).toBeNull();
  });
});

describe("checkEdge", () => {
  const nodes: Record<string, HandleNode> = {
    counter: { type: "Counter", data: {} },
    monitor: { type: "Monitor", data: {} },
    mqtt: { type: "Mqtt", data: { direction: "publish" } },
    servo: { type: "Servo", data: { type: "continuous" } },
    fn: { type: "Function", data: { code: "return {{speed}};" } },
    alien: { type: "NotYetInvented", data: {} },
  };
  const nodeOf = (id: string) => (Object.hasOwn(nodes, id) ? nodes[id] : undefined);
  const check = (source: string, sourceHandle: string | null, target: string, targetHandle: string | null) =>
    checkEdge({ source, sourceHandle, target, targetHandle }, nodeOf);

  test("accepts an edge from a live Emit to a live Port", () => {
    expect(check("counter", "value", "monitor", "value")).toBeNull();
    expect(check("counter", "value", "mqtt", "trigger")).toBeNull();
  });

  test("accepts an open port the target's settings name", () => {
    expect(check("counter", "value", "fn", "speed")).toBeNull();
  });

  test("unknown-handle: a name nothing declares, with what the node does offer", () => {
    expect(check("counter", "value", "monitor", "nonsense")).toEqual({
      end: "target",
      reason: "unknown-handle",
      type: "Monitor",
      handle: "nonsense",
      live: ["value"],
    });
  });

  test("unknown-handle: an open port the settings do not name", () => {
    expect(check("counter", "value", "fn", "gain")).toEqual({
      end: "target",
      reason: "unknown-handle",
      type: "Function",
      handle: "gain",
      live: ["trigger", "speed"],
    });
  });

  test("unknown-handle: an edge that names no handle", () => {
    expect(check("counter", null, "monitor", "value")).toEqual({
      end: "source",
      reason: "unknown-handle",
      type: "Counter",
      handle: null,
      live: ["value"],
    });
    expect(checkEdge({ source: "counter", sourceHandle: "value", target: "monitor" }, nodeOf)).toMatchObject({
      end: "target",
      reason: "unknown-handle",
      handle: null,
    });
  });

  test("not-offered, other-settings: a declared handle the node has with other settings", () => {
    // A publishing Mqtt node has no `value` output; a subscribing one does.
    expect(check("mqtt", "value", "monitor", "value")).toEqual({
      end: "source",
      reason: "not-offered",
      type: "Mqtt",
      handle: "value",
      live: [],
      offered: "other-settings",
    });
    expect(check("counter", "value", "servo", "min")).toEqual({
      end: "target",
      reason: "not-offered",
      type: "Servo",
      handle: "min",
      live: ["value", "stop"],
      offered: "other-settings",
    });
  });

  test("not-offered, never: a handle the component declares and no settings offer", () => {
    // The runtime honours an edge at either; the node never renders them.
    expect(check("counter", "value", "servo", "rotate")).toEqual({
      end: "target",
      reason: "not-offered",
      type: "Servo",
      handle: "rotate",
      live: ["value", "stop"],
      offered: "never",
    });
    // Monitor takes `value` and also declares it as its implicit Emit.
    expect(check("monitor", "value", "counter", "set")).toEqual({
      end: "source",
      reason: "not-offered",
      type: "Monitor",
      handle: "value",
      live: [],
      offered: "never",
    });
  });

  test("a Port and an Emit with the same id are different handles", () => {
    // `trigger` is a Port of Mqtt, not an Emit.
    expect(check("mqtt", "trigger", "monitor", "value")).toMatchObject({
      end: "source",
      reason: "unknown-handle",
    });
  });

  test("reports a node that is not there, source end first", () => {
    expect(check("ghost", "value", "phantom", "value")).toEqual({ end: "source", reason: "missing-node" });
    expect(check("counter", "value", "phantom", "value")).toEqual({ end: "target", reason: "missing-node" });
  });

  test("reports a type this build does not know, without guessing its handles", () => {
    expect(check("counter", "value", "alien", "in")).toEqual({
      end: "target",
      reason: "unknown-type",
      type: "NotYetInvented",
    });
  });

  describe("checkEdgeEnds: each end on its own", () => {
    const ends = (source: string, sourceHandle: string | null, target: string, targetHandle: string | null) =>
      checkEdgeEnds({ source, sourceHandle, target, targetHandle }, nodeOf);

    test("an edge that can attach has no problem at either end", () => {
      expect(ends("counter", "value", "monitor", "value")).toEqual({ source: null, target: null });
    });

    test("a problem at the source does not hide one at the target", () => {
      // Out of a publishing Mqtt node's `value` (declared, not offered now)
      // into a handle Monitor has never had.
      const edge = ["mqtt", "value", "monitor", "nonsense"] as const;
      const sourceProblem = {
        end: "source",
        reason: "not-offered",
        type: "Mqtt",
        handle: "value",
        live: [],
        offered: "other-settings",
      };

      expect(ends(...edge)).toEqual({
        source: sourceProblem,
        target: {
          end: "target",
          reason: "unknown-handle",
          type: "Monitor",
          handle: "nonsense",
          live: ["value"],
        },
      });
      // `checkEdge` answers as before: the first problem, source end first.
      expect(check(...edge)).toEqual(sourceProblem);
    });

    test("an unknown type at the source does not hide the target's finding either", () => {
      expect(ends("alien", "out", "servo", "rotate")).toEqual({
        source: { end: "source", reason: "unknown-type", type: "NotYetInvented" },
        target: {
          end: "target",
          reason: "not-offered",
          type: "Servo",
          handle: "rotate",
          live: ["value", "stop"],
          offered: "never",
        },
      });
    });

    test("only one end wrong: the other is null", () => {
      expect(ends("counter", "value", "phantom", "value")).toEqual({
        source: null,
        target: { end: "target", reason: "missing-node" },
      });
      expect(ends("ghost", "value", "monitor", "value")).toEqual({
        source: { end: "source", reason: "missing-node" },
        target: null,
      });
    });

    test("checkEdge is its first problem, for every pairing of ends", () => {
      const cases = [
        ["counter", "value"],
        ["mqtt", "value"],
        ["monitor", "nonsense"],
        ["alien", "x"],
        ["ghost", "x"],
        ["servo", "rotate"],
        ["fn", "speed"],
      ] as const;
      for (const [source, sourceHandle] of cases) {
        for (const [target, targetHandle] of cases) {
          const both = ends(source, sourceHandle, target, targetHandle);
          expect(check(source, sourceHandle, target, targetHandle)).toEqual(both.source ?? both.target);
        }
      }
    });
  });
});
