import type { Pin } from "@/stores/board";
import type { Node } from "@xyflow/react";
import type { BaseData } from "@/components/flow/nodes/_base/_base.schema";
import { formatPinValueWithPwm, findPin } from "@/lib/pin";
import {
  COMPONENT_IMPL,
  REQUIRES_HARDWARE,
  isComponentType,
} from "@/components/flow/nodes/_base/_base.types";
import type { BaseNode } from "@/components/flow/nodes/_base/_base";

/** Arduino Uno analog mapping (A0 = 14). The schematic is drawn before a board
 *  is ever connected, so an unresolvable `A<n>` still needs a pin number; the
 *  Uno layout is the one every target in the catalog shares for A0..A5. */
const UNO_ANALOG_BASE = 14;

/**
 * Resolve a pin value (number or "A0" string) to the actual pin number.
 *
 * The lookup itself is `lib/pin.ts`'s `findPin` — the one resolver that knows
 * how `A<n>` maps onto a board's analog channels. Only the no-board fallback
 * lives here, because it is this module's concern: the circuit view renders
 * with `pins: []` whenever the editor is offline, where `findPin` correctly has
 * no answer.
 */
function resolvePinNumber(pinValue: number | string, pins: Pin[]): number {
  const found = findPin(pinValue, pins);
  if (found) return found.pin;

  if (typeof pinValue === "number") return pinValue;
  const analog = pinValue.match(/^A(\d+)$/i);
  if (analog) return UNO_ANALOG_BASE + parseInt(analog[1], 10);
  const parsed = parseInt(pinValue, 10);
  return isNaN(parsed) ? -1 : parsed;
}

/**
 * Component mapping from Microflow node types to tscircuit JSX
 * Each component defines:
 * - toJsx: generates the component JSX
 * - signalPins: map from node data pin keys to component pin names (for multi-pin components)
 *               OR a single string for single-pin components
 * - powerPins: map of power pin names for VCC/GND traces
 */
interface TscircuitComponent {
  toJsx(name: string, data: BaseNode<BaseData>["data"]): string;
  signalPins: string | Record<string, string>;
  powerPins?: { vcc?: string; gnd?: string };
}

const componentMap: Record<string, TscircuitComponent> = {
  // TScircuit components
  button: {
    toJsx: (name, _data) =>
      `<pushbutton
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="pushbutton"
        pinLabels={{ pin1: "SIG", pin2: "GND" }}
      />`,
    signalPins: "pin1",
    powerPins: { gnd: "pin2" },
  },
  led: {
    toJsx: (name, _data) =>
      `<led
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="0603"
        color=""
      />`,
    signalPins: "anode",
    powerPins: { gnd: "cathode" },
  },
  switch: {
    toJsx: (name, _data) =>
      `<switch
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        type="spst"
        isNormallyClosed={${_data.type === "NC"}}
        pinLabels={{ pin1: "SIG", pin2: "GND" }}
      />`,
    signalPins: "pin1",
    powerPins: { gnd: "pin2" },
  },
  relay: {
    toJsx: (name, _data) =>
      `<switch
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        type="spdt"
        isNormallyClosed={${_data.type === "NC"}}
        pinLabels={{ pin1: "SIG", pin2: "VCC", pin3: "GND" }}
      />`,
    signalPins: "pin1",
    powerPins: { vcc: "pin2", gnd: "pin3" },
  },
  potentiometer: {
    toJsx: (name, _data) =>
      `<potentiometer
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="pinrow3"
        pinVariant="three_pin"
        maxResistance="50k"
        pinLabels={{ pin1: "VCC", pin2: "SIG", pin3: "GND" }}
      />`,
    signalPins: "pin2",
    powerPins: { vcc: "pin1", gnd: "pin3" },
  },
  piezo: {
    toJsx: (name, _data) =>
      `<resonator
      name="${name}"
      manufacturePartNumber="${_data.label ?? name}"
      displayName="${_data.label ?? name}"
      loadCapacitance="." // hack to remove it from the schematic
      frequency="${_data.frequency ?? 16000000}Hz"
    />`,
    signalPins: "pin1",
    powerPins: { gnd: "pin2" },
  },
  ldr: {
    toJsx: (name, _data) =>
      `<resistor
        name="${name}"
        resistance="100"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="0603"
      />`,
    signalPins: "pin2",
    powerPins: { vcc: "pin1" },
  },
  // Custom components
  sensor: {
    toJsx: (name, _data) =>
      `<jumper
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="pinrow3"
        pinLabels={{ pin1: "SIG", pin2: "VCC", pin3: "GND" }}
      />`,
    signalPins: "pin1",
    powerPins: { vcc: "pin2", gnd: "pin3" },
  },
  servo: {
    toJsx: (name, _data) =>
      `<jumper
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}" 
        footprint="pinrow3" 
        pinLabels={{ pin1: "SIG", pin2: "VCC", pin3: "GND" }} 
      />`,
    signalPins: "pin1",
    powerPins: { vcc: "pin2", gnd: "pin3" },
  },
  rgb: {
    toJsx: (name, _data) =>
      `<jumper
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="pinrow4"
        pinLabels={{ pin1: "SIGred", pin2: "SIGgreen", pin3: "SIGblue", pin4: "GND" }}
      />`,
    // Maps node data pin keys (red, green, blue) to component pins
    signalPins: { red: "pin1", green: "pin2", blue: "pin3" },
    powerPins: { gnd: "pin4" },
  },
  matrix: {
    toJsx: (name, _data) =>
      `<jumper
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="pinrow5"
        pinLabels={{ pin1: "DIN", pin2: "CLK", pin3: "CS", pin4: "VCC", pin5: "GND" }}
      />`,
    // Maps node data pin keys (data, clock, cs) to component pins
    signalPins: { data: "pin1", clock: "pin2", cs: "pin3" },
    powerPins: { vcc: "pin4", gnd: "pin5" },
  },
  motion: {
    toJsx: (name, _data) =>
      `<jumper
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="pinrow3"
        pinLabels={{ pin1: "DOUT", pin2: "VCC", pin3: "GND" }}
      />`,
    signalPins: "pin1",
    powerPins: { vcc: "pin2", gnd: "pin3" },
  },
  proximity: {
    toJsx: (name, _data) =>
      `<jumper
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="pinrow3"
        pinLabels={{ pin1: "SIG", pin2: "VCC", pin3: "GND" }}
      />`,
    signalPins: "pin1",
    powerPins: { vcc: "pin2", gnd: "pin3" },
  },
  pixel: {
    toJsx: (name, _data) =>
      `<jumper
        name="${name}"
        manufacturePartNumber="${_data.label ?? name}"
        displayName="${_data.label ?? name}"
        footprint="pinrow3"
        pinLabels={{ pin1: "DIN", pin2: "VCC", pin3: "GND" }}
      />`,
    signalPins: "pin1",
    powerPins: { vcc: "pin2", gnd: "pin3" },
  },
};

/**
 * Escape component name for use in JSX (remove spaces, special chars)
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Whether this node drives a pin, and so belongs on the schematic. Answered by
 * the **Component Catalog**'s `requiresHardware` (via the generated
 * `REQUIRES_HARDWARE`) — the same flag the Rust registry uses to decide on
 * `Component::initialize(board)`, so the schematic cannot disagree with the
 * runtime about what hardware is.
 */
function isHardwareComponent(instance: string): boolean {
  return isComponentType(instance) && REQUIRES_HARDWARE[instance];
}

/**
 * The part to draw for a node, in narrowing order: its `subType` (a **Variant**
 * with its own artwork, e.g. `ldr`), its own entry name, then the **impl** the
 * entry resolves to (`Force` → `Sensor`, `Vibration` → `Led`). The impl step is
 * what stops every new Variant from needing its own row here — the catalog
 * already records which runtime behaviour it reuses.
 */
function partFor(data: BaseNode<BaseData>["data"]): TscircuitComponent | undefined {
  const instance = data.instance ?? "";
  const impl = isComponentType(instance) ? COMPONENT_IMPL[instance] : instance;
  return (
    componentMap[data.subType?.toLowerCase() ?? ""] ??
    componentMap[instance.toLowerCase()] ??
    componentMap[impl.toLowerCase()]
  );
}

interface NodePinInfo {
  key: string;
  pinNumber: number;
}

function getNodePinsWithKeys(node: Node, pins: Pin[]): NodePinInfo[] {
  const data = node.data as BaseData;
  if ("pin" in data) {
    return [
      {
        key: "pin",
        pinNumber: resolvePinNumber(data.pin as string | number, pins),
      },
    ];
  }
  if ("pins" in data) {
    const pinsData = data.pins as Record<string, number | string>;
    return Object.entries(pinsData).map(([key, p]) => ({
      key,
      pinNumber: resolvePinNumber(p, pins),
    }));
  }
  return [];
}

function getNodePins(node: Node, pins: Pin[]): number[] {
  return getNodePinsWithKeys(node, pins).map((p) => p.pinNumber);
}

export interface CircuitBuildResult {
  code: string;
  componentCount: number;
  /**
   * Hardware nodes the catalog admits but this module has no part for, by
   * instance name. A gap in `componentMap`, not in the flow — reported rather
   * than dropped in silence, so a node missing from the drawing is visible.
   */
  unsupported: string[];
}

/**
 * Build tscircuit JSX code from flow nodes
 */
export function buildCircuitCode(
  nodes: Node[],
  pins: Pin[],
): CircuitBuildResult {
  const hardwareNodes = nodes.filter((node) => {
    const data = node.data as BaseData;
    return isHardwareComponent(data.instance ?? "");
  });
  const unsupported = new Set<string>();

  if (hardwareNodes.length === 0) {
    return {
      code: `circuit.add(<board width="20mm" height="20mm" />)`,
      componentCount: 0,
      unsupported: [],
    };
  }

  // Build MCU pin labels from used pins
  const usedPins = new Set<number>();
  hardwareNodes.forEach((node) => {
    const nodePins = getNodePins(node, pins);
    nodePins.forEach((p) => {
      usedPins.add(p);
    });
  });

  const mcuPinLabels: Record<string, string> = {};
  const sortedUsedPins = Array.from(usedPins).sort((a, b) => a - b);
  sortedUsedPins.forEach((pinNum, idx) => {
    const pin = pins.find((p) => p.pin === pinNum);
    let label: string;
    if (pin) {
      label = formatPinValueWithPwm(pin, pins);
    } else if (pinNum >= 14) {
      // Standard Arduino analog pin mapping
      label = `A${pinNum - 14}`;
    } else {
      label = `D${pinNum}`;
    }
    mcuPinLabels[`pin${idx + 1}`] = label;
  });

  // Generate component JSX
  const components: string[] = [];
  const traces: string[] = [];
  const powerTraces: string[] = [];
  const groundTraces: string[] = [];

  // Add MCU chip in center
  const mcuPinCount = sortedUsedPins.length;
  // Use standard SOIC footprints (must be valid: soic4, soic6, soic8, soic10, soic12, soic14, soic16, soic18, soic20)
  const validSoicSizes = [4, 6, 8, 10, 12, 14, 16, 18, 20];
  const mcuFootprintSize =
    validSoicSizes.find((size) => size >= mcuPinCount) ?? 20;
  const mcuFootprint = `soic${mcuFootprintSize}`;

  // Build pinLabels as inline object syntax
  const mcuPinLabelEntries = Object.entries(mcuPinLabels)
    .map(([key, val]) => `${key}: "${val}"`)
    .join(", ");

  components.push(`
    <chip
      name="MCU"
      manufacturerPartNumber="MCU"
      displayName="MCU"
      footprint="${mcuFootprint}"
      pinLabels={{ ${mcuPinLabelEntries} }}
    />`);

  hardwareNodes.forEach((node, index) => {
    const data = node.data as BaseNode<BaseData>["data"];
    const instance = data.instance;
    if (!instance) return;
    const component = partFor(data);
    if (!component) {
      unsupported.add(instance);
      return;
    }

    const rawName = data.label ?? `${instance.toUpperCase()}${index + 1}`;
    const componentName = sanitizeName(rawName + "_" + node.id);

    components.push(component.toJsx(componentName, data));

    // Create trace from component signal pin(s) to MCU
    const nodePinsWithKeys = getNodePinsWithKeys(node, pins);
    nodePinsWithKeys.forEach(({ key, pinNumber }) => {
      const mcuPinIdx = sortedUsedPins.indexOf(pinNumber);
      if (mcuPinIdx >= 0) {
        // Determine the component pin to use for this trace
        let componentPin: string;
        if (typeof component.signalPins === "string") {
          // Single signal pin component
          componentPin = component.signalPins;
        } else {
          // Multi-signal pin component - look up by key
          componentPin =
            component.signalPins[key] ?? Object.values(component.signalPins)[0];
        }
        traces.push(
          `<trace
              layer="signal"
              strokeColor="red"
              thickness="0.5mm"
              from=".${componentName} > .${componentPin}"
              to=".MCU > .pin${mcuPinIdx + 1}"
            />`,
        );
      }
    });

    // Add power traces for this component
    if (component.powerPins) {
      if (component.powerPins.vcc) {
        powerTraces.push(
          `<trace
            layer="power"
            strokeColor="red"
            thickness="0.5mm"
            from=".${componentName} > .${component.powerPins.vcc}"
            to="net.VCC"
          />`,
        );
      }
      if (component.powerPins.gnd) {
        groundTraces.push(
          `<trace
            layer="ground"
            strokeColor="red"
            thickness="0.5mm"
            from=".${componentName} > .${component.powerPins.gnd}"
            to="net.GND"
          />`,
        );
      }
    }
  });

  const code = `circuit.add(
  <board schAutoLayoutEnabled>
    ${components.join("\n")}
    ${traces.join("\n")}
    ${powerTraces.join("\n")}
    ${groundTraces.join("\n")}
  </board>
)`;

  return {
    code,
    // Parts actually drawn — `components` holds the MCU chip plus one entry per
    // node that resolved to a part, so an unsupported node is not counted as
    // present in a drawing it never reached.
    componentCount: components.length - 1,
    unsupported: [...unsupported].sort(),
  };
}
