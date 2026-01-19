import type { Pin } from "@/stores/board";
import type { Node } from "@xyflow/react";
import type { BaseData } from "@/components/flow/nodes/_base.schema";
import { formatPinValueWithPwm, getAnalogChannelBase } from "@/lib/pin";

/**
 * Resolve a pin value (number or "A0" string) to the actual pin number
 * When no board is connected (pins array empty), uses standard Arduino Uno mapping
 */
function resolvePinNumber(pinValue: number | string, pins: Pin[]): number {
  if (typeof pinValue === "number") return pinValue;

  const match = pinValue.match(/^A(\d+)$/i);
  if (match) {
    const analogIndex = parseInt(match[1], 10);
    
    // If no pins available, use standard Arduino Uno mapping (A0=14, A1=15, etc.)
    if (pins.length === 0) {
      return 14 + analogIndex;
    }
    
    const base = getAnalogChannelBase(pins);
    const targetChannel = base + analogIndex;
    const pin = pins.find((p) => p.analogChannel === targetChannel);
    if (pin) return pin.pin;
    
    // Fallback to standard mapping if pin not found
    return 14 + analogIndex;
  }

  const parsed = parseInt(pinValue, 10);
  return isNaN(parsed) ? -1 : parsed;
}

/**
 * Component mapping from Microflow node types to tscircuit JSX
 * Each component defines:
 * - toJsx: generates the component JSX
 * - signalPin: the pin name to use for signal traces (must match tscircuit's port names)
 * - powerPins: map of power pin names for VCC/GND traces
 */
interface TscircuitComponent {
  toJsx<T extends BaseData>(name: string, data: T, schX: number, schY: number): string;
  signalPin: string;
  powerPins?: { vcc?: string; gnd?: string };
}

const componentMap: Record<string, TscircuitComponent> = {
  button: {
    toJsx: (name, _data, schX, schY) =>
      `<pushbutton name="${name}" footprint="pushbutton" schX={${schX}} schY={${schY}} />`,
    signalPin: "pin1",
    powerPins: { gnd: "pin2" },
  },
  led: {
    toJsx: (name, _data, schX, schY) =>
      `<led name="${name}" footprint="0603" color="" schX={${schX}} schY={${schY}} />`,
    signalPin: "anode",
    powerPins: { gnd: "cathode" },
  },
  switch: {
    toJsx: (name, _data, schX, schY) =>
      `<switch name="${name}" type="spst" schX={${schX}} schY={${schY}}  />`,
    signalPin: "pin1",
    powerPins: { gnd: "pin2" },
  },
  relay: {
    toJsx: (name, _data, schX, schY) =>
      `<switch name="${name}" type="spdt" schX={${schX}} schY={${schY}} isNormallyClosed={${_data.type === "NC"}}  />`,
    signalPin: "pin1",
    powerPins: { vcc: "pin2", gnd: "pin3" },
  },
  sensor: {
    toJsx: (name, _data, schX, schY) =>
      `<chip name="${name}" footprint="pinrow3" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "VCC", pin2: "GND", pin3: "SIG" }} />`,
    signalPin: "SIG",
    powerPins: { vcc: "VCC", gnd: "GND" },
  },
  potentiometer: {
    toJsx: (name, _data, schX, schY) =>
      `<potentiometer name="${name}" footprint="pinrow3" pinVariant="three_pin" maxResistance="50k" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "VCC", pin2: "SIG", pin3: "GND" }} />`,
    signalPin: "pin2",
    powerPins: { vcc: "pin1", gnd: "pin3" },
  },
  servo: {
    toJsx: (name, _data, schX, schY) =>
      `<chip name="${name}" footprint="pinrow3" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "SIG", pin2: "VCC", pin3: "GND" }} />`,
    signalPin: "SIG",
    powerPins: { vcc: "VCC", gnd: "GND" },
  },
  rgb: {
    toJsx: (name, _data, schX, schY) =>
      `<chip name="${name}" footprint="dip4" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "R", pin2: "G", pin3: "B", pin4: "GND" }} />`,
    signalPin: "R", // Primary signal pin
    powerPins: { gnd: "GND" },
  },
  piezo: {
    toJsx: (name, _data, schX, schY) =>
      `<chip name="${name}" footprint="0805" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "GND", pin2: "SIG" }} />`,
    signalPin: "SIG",
    powerPins: { gnd: "GND" },
  },
  matrix: {
    toJsx: (name, _data, schX, schY) =>
      `<chip name="${name}" footprint="soic5" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "DIN", pin2: "CLK", pin3: "CS", pin4: "VCC", pin5: "GND" }} />`,
    signalPin: "DIN",
    powerPins: { vcc: "VCC", gnd: "GND" },
  },
  motion: {
    toJsx: (name, _data, schX, schY) =>
      `<chip name="${name}" footprint="pinrow3" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "VCC", pin2: "GND", pin3: "DOUT" }} />`,
    signalPin: "DOUT",
    powerPins: { vcc: "VCC", gnd: "GND" },
  },
  proximity: {
    toJsx: (name, _data, schX, schY) =>
      `<chip name="${name}" footprint="pinrow3" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "VCC", pin2: "GND", pin3: "SIG" }} />`,
    signalPin: "SIG",
    powerPins: { vcc: "VCC", gnd: "GND" },
  },
  pixel: {
    toJsx: (name, _data, schX, schY) =>
      `<chip name="${name}" footprint="pinrow3" schX={${schX}} schY={${schY}} pinLabels={{ pin1: "DIN", pin2: "VCC", pin3: "GND" }} />`,
    signalPin: "DIN",
    powerPins: { vcc: "VCC", gnd: "GND" },
  },
};

/**
 * Escape component name for use in JSX (remove spaces, special chars)
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function isHardwareComponent(instanceType: string): boolean {
  const hardwareComponents = ["button", "led", "switch", "relay", "sensor", "potentiometer", "servo", "rgb", "piezo", "matrix", "motion", "proximity", "pixel"];
  return hardwareComponents.includes(instanceType.toLowerCase());
}

function isInputComponent(instanceType: string): boolean {
  const inputComponents = ["button", "switch", "sensor", "potentiometer", "motion", "proximity"];
  return inputComponents.includes(instanceType.toLowerCase());
}

function isOutputComponent(instanceType: string): boolean {
  const outputComponents = ["led", "servo", "rgb", "piezo", "matrix", "pixel"];
  return outputComponents.includes(instanceType.toLowerCase());
}

function getNodePins(node: Node, pins: Pin[]): number[] {
  const data = node.data as BaseData;
  if('pin' in data) {
    return [resolvePinNumber(data.pin as string | number, pins)];
  }
  if('pins' in data) {
    return Object.values(data.pins as Record<string, number>).map((p) => resolvePinNumber(p, pins));
  }
  return [];
}

export interface CircuitBuildResult {
  code: string;
  componentCount: number;
}

/**
 * Build tscircuit JSX code from flow nodes
 */
export function buildCircuitCode(nodes: Node[], pins: Pin[]): CircuitBuildResult {
  const hardwareNodes = nodes.filter((node) => {
    const data = node.data as BaseData;
    return data.instance && isHardwareComponent(data.instance);
  });

  if (hardwareNodes.length === 0) {
    return {
      code: `circuit.add(<board width="20mm" height="20mm" />)`,
      componentCount: 0,
    };
  }

  // Sort by pin number for consistent layout
  const sortedNodes = [...hardwareNodes].sort((a, b) => {
    const pinA = 'pin' in a.data ? a.data.pin : -1;
    const pinB = 'pin' in b.data ? b.data.pin : -1;
    return (pinA as number) - (pinB as number);
  })

  // Separate input and output components
  const inputNodes = hardwareNodes.filter((n) => {
    return isInputComponent((n.data as BaseData).instance!);
  });
  const outputNodes = hardwareNodes.filter((n) => {
    return isOutputComponent((n.data as BaseData).instance!);
  });

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

  // Calculate board size based on component count
  const totalComponents = sortedNodes.length + 1; // +1 for MCU
  const boardWidth = Math.max(30, totalComponents * 15);
  const boardHeight = Math.max(20, Math.max(inputNodes.length, outputNodes.length) * 8 + 10);

  // Generate component JSX
  const components: string[] = [];
  const traces: string[] = [];
  const powerTraces: string[] = [];

  // Add MCU chip in center
  const mcuPinCount = sortedUsedPins.length;
  // const mcuFootprint = mcuPinCount <= 8 ? "soic8" : mcuPinCount <= 16 ? "soic16" : "soic20";
  const mcuFootprint = `soic${mcuPinCount}`;
  
  // Build pinLabels as inline object syntax
  const mcuPinLabelEntries = Object.entries(mcuPinLabels)
    .map(([key, val]) => `${key}: "${val}"`)
    .join(", ");
  
  components.push(`    <chip
      name="MCU"
      footprint="${mcuFootprint}"
      schX={0}
      schY={0}
      pinLabels={{ ${mcuPinLabelEntries} }}
    />`);

  // Add input components on the left
  inputNodes.forEach((node, idx) => {
    const data = node.data as BaseData & { label?: string };
    const instanceType = data.instance?.toLowerCase();
    const subType = data.subType?.toLowerCase();
    if (!instanceType) return;
    const component = componentMap[subType ?? ""] ?? componentMap[instanceType]
    if (!component) return;

    const rawName = data.label ?? `${instanceType.toUpperCase()}${idx + 1}`;
    const componentName = sanitizeName(rawName);
    const schX = -6;
    const schY = (idx - (inputNodes.length - 1) / 2) * 3;

    components.push(`    ${component.toJsx(componentName, node.data, schX, schY)}`);

    // Create trace from component signal pin to MCU
    const nodePins = getNodePins(node, pins);
    nodePins.forEach((p) => {
      const mcuPinIdx = sortedUsedPins.indexOf(p);
      if (mcuPinIdx >= 0) {
        traces.push(`    <trace from=".${componentName} > .${component.signalPin}" to=".MCU > .pin${mcuPinIdx + 1}" />`);
      }
    });

    // Add power traces for this component
    if (component.powerPins) {
      if (component.powerPins.vcc) {
        powerTraces.push(`    <trace from=".${componentName} > .${component.powerPins.vcc}" to="net.VCC" />`);
      }
      if (component.powerPins.gnd) {
        powerTraces.push(`    <trace from=".${componentName} > .${component.powerPins.gnd}" to="net.GND" />`);
      }
    }
  });

  // Add output components on the right
  outputNodes.forEach((node, idx) => {
    const data = node.data as BaseData & { label?: string };
    const instanceType = data.instance!.toLowerCase();
    const component = componentMap[instanceType];
    if (!component) return;

    const rawName = data.label ?? `${instanceType.toUpperCase()}${idx + 1}`;
    const componentName = sanitizeName(rawName);
    const schX = 6;
    const schY = (idx - (outputNodes.length - 1) / 2) * 3;

    components.push(`    ${component.toJsx(componentName, node.data, schX, schY)}`);

    // Create trace from MCU to component signal pin
    const nodePins = getNodePins(node, pins);
    nodePins.forEach((p) => {
      const mcuPinIdx = sortedUsedPins.indexOf(p);
      if (mcuPinIdx >= 0) {
        traces.push(`    <trace from=".MCU > .pin${mcuPinIdx + 1}" to=".${componentName} > .${component.signalPin}" />`);
      }
    });

    // Add power traces for this component
    if (component.powerPins) {
      if (component.powerPins.vcc) {
        powerTraces.push(`    <trace id="${componentName}_vcc" from=".${componentName} > .${component.powerPins.vcc}" to="net.VCC" />`);
      }
      if (component.powerPins.gnd) {
        powerTraces.push(`    <trace layer="ground" id="${componentName}_gnd" from=".${componentName} > .${component.powerPins.gnd}" to="net.GND" />`);
      }
    }
  });

  const code = `circuit.add(
  <board width="${boardWidth}mm" height="${boardHeight}mm">
${components.join("\n")}
${traces.join("\n")}
${powerTraces.join("\n")}
  </board>
)`;

  return {
    code,
    componentCount: sortedNodes.length,
  };
}
