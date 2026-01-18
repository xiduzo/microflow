import type { Pin } from "@/stores/board";
import type { Node } from "@xyflow/react";
import type { BaseData } from "@/components/flow/nodes/_base.schema";
import type { CircuitDefinition } from "@/components/flow/nodes/_circuit.types";
import { getCircuitDefinition, isHardwareComponent } from "@/components/flow/nodes/_circuit.registry";
import { formatPinValueWithPwm, getAnalogChannelBase } from "@/utils/pin";
import {
  convertSoupToScene,
  mutateSoupForScene,
  ascendingCentralLrBug1,
} from "@tscircuit/schematic-autolayout";

import type {
  SchematicComponent,
  SchematicPort,
  SchematicText,
  SchematicTrace,
  SchematicNetLabel,
  SourceComponentBase,
  SourceNet,
  SourcePort,
  SourceTrace,
  SourceSimpleChip,
  AnyCircuitElement,
} from "circuit-json";

type CircuitElement =
  | SourceComponentBase
  | SourcePort
  | SourceNet
  | SourceTrace
  | SchematicComponent
  | SchematicPort
  | SchematicText
  | SchematicTrace
  | SchematicNetLabel;

/**
 * Resolve a pin value (number or "A0" string) to the actual pin number
 */
function resolvePinNumber(pinValue: number | string, pins: Pin[]): number {
  if (typeof pinValue === "number") {
    return pinValue;
  }

  // Handle analog pin strings like "A0", "A1", etc.
  const match = pinValue.match(/^A(\d+)$/i);
  if (match) {
    const analogIndex = parseInt(match[1], 10);
    const base = getAnalogChannelBase(pins);
    // Find the pin with analogChannel = base + analogIndex
    const targetChannel = base + analogIndex;
    const pin = pins.find((p) => p.analogChannel === targetChannel);
    if (pin) {
      return pin.pin;
    }
  }

  // Try parsing as a number
  const parsed = parseInt(pinValue, 10);
  return isNaN(parsed) ? -1 : parsed;
}

/**
 * Get resolved pins from a circuit definition, handling analog pin names
 */
function getResolvedPins(circuit: CircuitDefinition, nodeData: unknown, pins: Pin[]): number[] {
  const rawPins = circuit.getPins(nodeData);
  return rawPins.map((p) => resolvePinNumber(p, pins));
}

/**
 * Get display name for a component from node data
 */
function getComponentDisplayName(node: Node, circuit: CircuitDefinition): string {
  const data = node.data as BaseData & { label?: string };
  // Use label from node data if available, otherwise use circuit displayName
  return data.label || circuit.displayName;
}

export function createCircuitJson(nodes: Node[], pins: Pin[]): AnyCircuitElement[] {
  const elements: CircuitElement[] = [];

  // Filter to only hardware nodes and get their pin assignments
  const hardwareNodes = nodes.filter((node) => {
    const data = node.data as BaseData;
    return data.instance && isHardwareComponent(data.instance);
  });

  // Sort hardware nodes by their primary pin number for better layout
  const sortedHardwareNodes = [...hardwareNodes].sort((a, b) => {
    const circuitA = getCircuitDefinition((a.data as BaseData).instance!);
    const circuitB = getCircuitDefinition((b.data as BaseData).instance!);
    if (!circuitA || !circuitB) return 0;
    const pinsA = getResolvedPins(circuitA, a.data, pins);
    const pinsB = getResolvedPins(circuitB, b.data, pins);
    return (pinsA[0] || 0) - (pinsB[0] || 0);
  });

  // Create board with pins
  elements.push(...createCircuitJsonBoard(pins, sortedHardwareNodes));

  // Create a map of node IDs to component indices
  const nodeToComponentIndex = new Map<string, number>();

  // Create components with initial positions (will be adjusted by autolayout)
  sortedHardwareNodes.forEach((node, idx) => {
    const data = node.data as BaseData;
    const circuit = getCircuitDefinition(data.instance!);
    if (!circuit) return;

    const componentIndex = idx + 1;
    nodeToComponentIndex.set(node.id, componentIndex);

    // Initial position - autolayout will adjust
    const componentX = 10;
    const componentY = idx * 3;

    elements.push(...createCircuitJsonForComponent(node, circuit, componentIndex, componentX, componentY));
  });

  // Create source traces (connections between pins and components)
  const { sourceTraces, traceConnections, netLabelConnections } = createSourceTraces(sortedHardwareNodes, pins, nodeToComponentIndex);
  elements.push(...sourceTraces);

  // Apply autolayout
  let layoutedSoup: AnyCircuitElement[];
  try {
    const scene = convertSoupToScene(elements as AnyCircuitElement[]);
    const layoutedScene = ascendingCentralLrBug1(scene);
    layoutedSoup = mutateSoupForScene(elements as AnyCircuitElement[], layoutedScene);
  } catch (e) {
    // If autolayout fails, use original elements
    console.warn("Autolayout failed, using manual layout:", e);
    layoutedSoup = elements as AnyCircuitElement[];
  }

  // Now generate schematic traces using the layouted port positions
  const schematicTraces = createSchematicTraces(layoutedSoup, traceConnections);
  layoutedSoup.push(...schematicTraces);

  // Create net labels for VCC/GND connections
  const netLabels = createNetLabels(layoutedSoup, netLabelConnections);
  layoutedSoup.push(...netLabels);

  return layoutedSoup;
}

function createCircuitJsonForComponent(
  node: Node,
  circuit: CircuitDefinition,
  componentIndex: number,
  schematicX: number,
  schematicY: number,
): CircuitElement[] {
  const elements: CircuitElement[] = [];
  const sourceComponentId = `source_component_${componentIndex}`;
  const displayName = getComponentDisplayName(node, circuit);

  // Create source component
  const sourceComponent: SourceComponentBase = {
    type: "source_component",
    ftype: circuit.ftype,
    source_component_id: sourceComponentId,
    name: displayName,
  } as SourceComponentBase;
  elements.push(sourceComponent);

  // Create source ports - use label as name for pin_name display
  for (const port of circuit.ports) {
    const portId = `source_port_${componentIndex}_${port.pinNumber}`;
    const sourcePort: SourcePort = {
      type: "source_port",
      source_port_id: portId,
      source_component_id: sourceComponentId,
      name: port.label || port.name, // Use label for pin_name display
      pin_number: port.pinNumber,
      port_hints: port.hints,
    };
    elements.push(sourcePort);
  }

  // Create schematic component
  const schematicComponentId = `schematic_component_${componentIndex}`;
  const leftPorts = circuit.ports.filter((p) => p.side === "left");
  const rightPorts = circuit.ports.filter((p) => p.side === "right");
  const leftPinNumbers = leftPorts.map((p) => p.pinNumber);
  const rightPinNumbers = rightPorts.map((p) => p.pinNumber);

  // Map pin numbers to labels for internal display
  const portLabels: Record<string, string> = {};
  for (const port of circuit.ports) {
    portLabels[`${port.pinNumber}`] = port.label || port.name;
  }

  const schematicComponent: SchematicComponent = {
    type: "schematic_component",
    schematic_component_id: schematicComponentId,
    source_component_id: sourceComponentId,
    center: { x: schematicX, y: schematicY },
    size: circuit.size,
    is_box_with_pins: true,
    port_arrangement: {
      left_side: { pins: leftPinNumbers, direction: "top-to-bottom" },
      right_side: { pins: rightPinNumbers, direction: "top-to-bottom" },
    },
    pin_spacing: 0.5,
    port_labels: portLabels,
  };
  elements.push(schematicComponent);

  // Create schematic ports
  const halfWidth = circuit.size.width / 2;
  const leftSpacing = circuit.size.height / (leftPorts.length + 1);
  const rightSpacing = circuit.size.height / (rightPorts.length + 1);

  leftPorts.forEach((port, idx) => {
    const portId = `source_port_${componentIndex}_${port.pinNumber}`;
    const portX = schematicX - halfWidth - 0.4;
    const portY = schematicY - circuit.size.height / 2 + leftSpacing * (idx + 1);

    const schematicPort: SchematicPort = {
      type: "schematic_port",
      schematic_port_id: `schematic_port_${componentIndex}_${port.pinNumber}`,
      schematic_component_id: schematicComponentId,
      source_port_id: portId,
      center: { x: portX, y: portY },
      facing_direction: "left",
      distance_from_component_edge: 0.4,
      side_of_component: "left",
      true_ccw_index: idx,
      display_pin_label: port.label || port.name,
    };
    elements.push(schematicPort);
  });

  rightPorts.forEach((port, idx) => {
    const portId = `source_port_${componentIndex}_${port.pinNumber}`;
    const portX = schematicX + halfWidth + 0.4;
    const portY = schematicY - circuit.size.height / 2 + rightSpacing * (idx + 1);

    const schematicPort: SchematicPort = {
      type: "schematic_port",
      schematic_port_id: `schematic_port_${componentIndex}_${port.pinNumber}`,
      schematic_component_id: schematicComponentId,
      source_port_id: portId,
      center: { x: portX, y: portY },
      facing_direction: "right",
      distance_from_component_edge: 0.4,
      side_of_component: "right",
      true_ccw_index: leftPorts.length + idx,
      display_pin_label:  port.label || port.name,
    };
    elements.push(schematicPort);
  });

  // Create schematic text label with display name
  const schematicText: SchematicText = {
    type: "schematic_text",
    schematic_text_id: `schematic_text_${componentIndex}`,
    schematic_component_id: schematicComponentId,
    text: displayName,
    anchor: "left",
    rotation: 0,
    position: { x: schematicX - 0.5, y: schematicY - circuit.size.height / 2 - 0.3 },
    font_size: 0.25,
    color: "#666",
  };
  elements.push(schematicText);

  return elements;
}


function createCircuitJsonBoard(pins: Pin[], hardwareNodes: Node[]): CircuitElement[] {
  const elements: CircuitElement[] = [];

  if (pins.length === 0) {
    return elements;
  }

  // Categorize pins by whether they connect to input or output components
  const inputPinNumbers = new Set<number>();
  const outputPinNumbers = new Set<number>();
  
  hardwareNodes.forEach((node) => {
    const data = node.data as BaseData;
    const circuit = getCircuitDefinition(data.instance!);
    if (circuit) {
      const resolvedPins = getResolvedPins(circuit, node.data, pins);
      resolvedPins.forEach((pin) => {
        if (pin >= 0) {
          if (circuit.direction === "input") {
            inputPinNumbers.add(pin);
          } else {
            outputPinNumbers.add(pin);
          }
        }
      });
    }
  });

  // Get the set of all used pins
  const usedPinNumbers = new Set([...inputPinNumbers, ...outputPinNumbers]);

  // Filter pins to only show used ones
  const usedPins = pins.filter((p) => usedPinNumbers.has(p.pin));

  // If no pins are used, show a minimal board
  const displayPins = usedPins.length > 0 ? usedPins : pins.slice(0, 8);

  const boardComponentId = "source_component_0";

  // Create source component for the board (microcontroller)
  const boardComponent: SourceSimpleChip = {
    type: "source_component",
    ftype: "simple_chip",
    source_component_id: boardComponentId,
    name: "microcontroller",
  };
  elements.push(boardComponent);

  // Create a map of pin number to formatted label
  const pinLabelMap = new Map<number, string>();
  pins.forEach((pin) => {
    pinLabelMap.set(pin.pin, formatPinValueWithPwm(pin, pins));
  });

  // Create source ports for each displayed pin
  displayPins.forEach((pin) => {
    const portId = `source_port_0_${pin.pin}`;
    const label = pinLabelMap.get(pin.pin) || `${pin.pin}`;
    const port: SourcePort = {
      type: "source_port",
      source_port_id: portId,
      source_component_id: boardComponentId,
      name: label,
      pin_number: pin.pin,
      port_hints: [label, `pin${pin.pin}`, `${pin.pin}`],
    };
    elements.push(port);
  });

  // Create common nets (GND, VCC)
  const gndNet: SourceNet = {
    type: "source_net",
    source_net_id: "source_net_gnd",
    name: "GND",
    member_source_group_ids: [],
    is_ground: true,
  };
  elements.push(gndNet);

  const vccNet: SourceNet = {
    type: "source_net",
    source_net_id: "source_net_vcc",
    name: "VCC",
    member_source_group_ids: [],
    is_power: true,
  };
  elements.push(vccNet);

  // Split pins into left (inputs) and right (outputs) sides
  const leftPins = displayPins.filter((p) => inputPinNumbers.has(p.pin)).sort((a, b) => a.pin - b.pin);
  const rightPins = displayPins.filter((p) => outputPinNumbers.has(p.pin)).sort((a, b) => a.pin - b.pin);

  const portLabels: Record<string, string> = {};
  displayPins.forEach((pin) => {
    portLabels[`${pin.pin}`] = pinLabelMap.get(pin.pin) || `${pin.pin}`;
  });

  const maxPins = Math.max(leftPins.length, rightPins.length, 1);
  const boardHeight = Math.max(3, maxPins * 1.2);
  const boardWidth = 2.5;
  const boardCenterX = 4;
  const boardCenterY = 4;

  // Create schematic component for the board
  const schematicComponentId = "board_component";
  const schematicComponent: SchematicComponent = {
    type: "schematic_component",
    schematic_component_id: schematicComponentId,
    source_component_id: boardComponentId,
    center: { x: boardCenterX, y: boardCenterY },
    size: { width: boardWidth, height: boardHeight },
    is_box_with_pins: true,
    port_arrangement: {
      left_side: { pins: leftPins.map((p) => p.pin), direction: "top-to-bottom" },
      right_side: { pins: rightPins.map((p) => p.pin), direction: "top-to-bottom" },
    },
    pin_spacing: 1.0,
    port_labels: portLabels,
  };
  elements.push(schematicComponent);

  // Create schematic ports for left side (input pins)
  const leftSpacing = boardHeight / (leftPins.length + 1);
  leftPins.forEach((pin, idx) => {
    const portId = `source_port_0_${pin.pin}`;
    const schematicPortId = `schematic_port_0_${pin.pin}`;
    const label = pinLabelMap.get(pin.pin) || `${pin.pin}`;

    const portX = boardCenterX - boardWidth / 2 - 0.4;
    const portY = boardCenterY - boardHeight / 2 + leftSpacing * (idx + 1);

    const schematicPort: SchematicPort = {
      type: "schematic_port",
      schematic_port_id: schematicPortId,
      schematic_component_id: schematicComponentId,
      source_port_id: portId,
      center: { x: portX, y: portY },
      facing_direction: "left",
      distance_from_component_edge: 0.4,
      side_of_component: "left",
      true_ccw_index: idx,
      display_pin_label: label,
    };
    elements.push(schematicPort);
  });

  // Create schematic ports for right side (output pins)
  const rightSpacing = boardHeight / (rightPins.length + 1);
  rightPins.forEach((pin, idx) => {
    const portId = `source_port_0_${pin.pin}`;
    const schematicPortId = `schematic_port_0_${pin.pin}`;
    const label = pinLabelMap.get(pin.pin) || `${pin.pin}`;

    const portX = boardCenterX + boardWidth / 2 + 0.4;
    const portY = boardCenterY - boardHeight / 2 + rightSpacing * (idx + 1);

    const schematicPort: SchematicPort = {
      type: "schematic_port",
      schematic_port_id: schematicPortId,
      schematic_component_id: schematicComponentId,
      source_port_id: portId,
      center: { x: portX, y: portY },
      facing_direction: "right",
      distance_from_component_edge: 0.4,
      side_of_component: "right",
      true_ccw_index: leftPins.length + idx,
      display_pin_label: label,
    };
    elements.push(schematicPort);
  });

  // Create schematic text label for the board
  const boardText: SchematicText = {
    type: "schematic_text",
    schematic_text_id: "schematic_text_board",
    schematic_component_id: schematicComponentId,
    text: "MCU",
    anchor: "center",
    rotation: 0,
    position: { x: boardCenterX, y: boardCenterY },
    font_size: 0.3,
    color: "#666",
  };
  elements.push(boardText);

  return elements;
}

interface TraceConnection {
  sourceTraceId: string;
  fromPortId: string;
  toPortId: string;
}

interface NetLabelConnection {
  portId: string;
  schematicPortId: string;
  netType: "VCC" | "GND";
  side: "left" | "right" | "top" | "bottom";
}

function createSourceTraces(
  nodes: Node[],
  pins: Pin[],
  nodeToComponentIndex: Map<string, number>,
): { sourceTraces: CircuitElement[]; traceConnections: TraceConnection[]; netLabelConnections: NetLabelConnection[] } {
  const sourceTraces: CircuitElement[] = [];
  const traceConnections: TraceConnection[] = [];
  const netLabelConnections: NetLabelConnection[] = [];
  let traceIndex = 0;

  nodes.forEach((node) => {
    const data = node.data as BaseData;
    const instanceType = data.instance;

    if (!instanceType || !isHardwareComponent(instanceType)) {
      return;
    }

    const circuit = getCircuitDefinition(instanceType);
    if (!circuit) return;

    const componentIndex = nodeToComponentIndex.get(node.id);
    if (componentIndex === undefined) return;

    // Get resolved pins used by this component
    const componentPins = getResolvedPins(circuit, node.data, pins);
    const netConnections = circuit.getNetConnections?.(node.data) || {};

    // Create traces from board pins to component signal pins
    componentPins.forEach((pinNumber, pinIdx) => {
      if (pinNumber < 0) return; // Skip invalid pins
      
      const pinIndex = pins.findIndex((p) => p.pin === pinNumber);
      if (pinIndex === -1) return;

      const boardPortId = `source_port_0_${pinNumber}`;
      // Signal pin is typically pin 1 for single-pin components, or sequential for multi-pin
      const signalPinNumber = pinIdx + 1;
      const componentPortId = `source_port_${componentIndex}_${signalPinNumber}`;
      const sourceTraceId = `source_trace_${traceIndex}`;

      const trace: SourceTrace = {
        type: "source_trace",
        source_trace_id: sourceTraceId,
        connected_source_port_ids: [boardPortId, componentPortId],
        connected_source_net_ids: [],
        display_name: `.microcontroller > .pin${pinNumber} to .${node.id} > .pin${signalPinNumber}`,
      };
      sourceTraces.push(trace);
      traceConnections.push({ sourceTraceId, fromPortId: boardPortId, toPortId: componentPortId });
      traceIndex++;
    });

    // Collect net label connections for VCC/GND (instead of traces)
    for (const [pinNum, netType] of Object.entries(netConnections)) {
      if (!netType) continue;

      const port = circuit.ports.find((p) => p.pinNumber === parseInt(pinNum));
      const side = port?.side || "right";

      netLabelConnections.push({
        portId: `source_port_${componentIndex}_${pinNum}`,
        schematicPortId: `schematic_port_${componentIndex}_${pinNum}`,
        netType: netType as "VCC" | "GND",
        side,
      });
    }
  });

  return { sourceTraces, traceConnections, netLabelConnections };
}

function createSchematicTraces(
  soup: AnyCircuitElement[],
  traceConnections: TraceConnection[],
): SchematicTrace[] {
  const traces: SchematicTrace[] = [];

  // Build a map of source_port_id to schematic port position
  const portPositions = new Map<string, { x: number; y: number }>();
  for (const element of soup) {
    if (element.type === "schematic_port") {
      const port = element as SchematicPort;
      portPositions.set(port.source_port_id, port.center);
    }
  }

  // Create schematic traces for each connection
  for (const conn of traceConnections) {
    const fromPos = portPositions.get(conn.fromPortId);
    const toPos = portPositions.get(conn.toPortId);

    if (!fromPos || !toPos) {
      console.warn(`Missing port positions for trace: ${conn.fromPortId} -> ${conn.toPortId}`);
      continue;
    }

    const edges: SchematicTrace["edges"] = [];

    // Route: horizontal from source -> vertical to align -> horizontal to target
    const midX = (fromPos.x + toPos.x) / 2;

    edges.push({ from: { x: fromPos.x, y: fromPos.y }, to: { x: midX, y: fromPos.y } });
    if (fromPos.y !== toPos.y) {
      edges.push({ from: { x: midX, y: fromPos.y }, to: { x: midX, y: toPos.y } });
    }
    edges.push({ from: { x: midX, y: toPos.y }, to: { x: toPos.x, y: toPos.y } });

    traces.push({
      type: "schematic_trace",
      schematic_trace_id: `schematic_trace_${conn.sourceTraceId}`,
      source_trace_id: conn.sourceTraceId,
      edges,
      junctions: [],
    });
  }

  return traces;
}

function createNetLabels(
  soup: AnyCircuitElement[],
  netLabelConnections: NetLabelConnection[],
): SchematicNetLabel[] {
  const labels: SchematicNetLabel[] = [];

  // Build a map of schematic_port_id to port position and facing direction
  const portInfo = new Map<string, { center: { x: number; y: number }; facing: string }>();
  for (const element of soup) {
    if (element.type === "schematic_port") {
      const port = element as SchematicPort;
      portInfo.set(port.schematic_port_id, {
        center: port.center,
        facing: port.facing_direction || "left",
      });
    }
  }

  // Create net labels positioned near each port
  netLabelConnections.forEach((conn, idx) => {
    const info = portInfo.get(conn.schematicPortId);
    if (!info) {
      console.warn(`Missing port info for net label: ${conn.schematicPortId}`);
      return;
    }

    // Position the label slightly offset from the port based on side
    let offsetX = 0;
    let offsetY = 0;
    let anchorSide: "left" | "right" | "top" | "bottom" = "right";

    switch (conn.side) {
      case "left":
        offsetX = -0.3;
        anchorSide = "right";
        break;
      case "right":
        offsetX = 0.3;
        anchorSide = "left";
        break;
      case "top":
        offsetY = -0.3;
        anchorSide = "bottom";
        break;
      case "bottom":
        offsetY = 0.3;
        anchorSide = "top";
        break;
    }

    const netLabel: SchematicNetLabel = {
      type: "schematic_net_label",
      schematic_net_label_id: `net_label_${idx}`,
      source_net_id: conn.netType === "VCC" ? "source_net_vcc" : "source_net_gnd",
      text: conn.netType,
      center: {
        x: info.center.x + offsetX,
        y: info.center.y + offsetY,
      },
      anchor_side: anchorSide,
    };
    labels.push(netLabel);
  });

  return labels;
}
