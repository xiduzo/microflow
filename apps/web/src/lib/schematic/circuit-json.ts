import type { Pin } from "@/stores/board";
import type { Node } from "@xyflow/react";

import type { Data as ButtonData } from "@microflow/runtime/button/button.types";

import type {
  SchematicArc,
  SchematicBox,
  SchematicCircle,
  SchematicComponent,
  SchematicDebugObject,
  SchematicError,
  SchematicGroup,
  SchematicLayoutError,
  SchematicLine,
  SchematicManualEditConflictWarning,
  SchematicNetLabel,
  SchematicPath,
  SchematicPort,
  SchematicRect,
  SchematicSheet,
  SchematicTable,
  SchematicTableCell,
  SchematicText,
  SchematicTrace,
  SchematicVoltageProbe,
  SourceComponentBase,
  SourcePort,
  SourceNet,
  SourceTrace,
  SourceSimpleChip,
  SourceSimplePushButton,
  SourceSimpleLed,
} from "circuit-json";
import type { BaseData } from "@microflow/runtime/base.types";
import type { Data as LedData } from "@microflow/runtime/led/led.types";

// Store port positions for trace routing
interface PortPosition {
  portId: string;
  x: number;
  y: number;
}

type SchematicElement =
  | SchematicArc
  | SchematicBox
  | SchematicCircle
  | SchematicComponent
  | SchematicDebugObject
  | SchematicError
  | SchematicGroup
  | SchematicLayoutError
  | SchematicLine
  | SchematicManualEditConflictWarning
  | SchematicNetLabel
  | SchematicPath
  | SchematicPort
  | SchematicRect
  | SchematicSheet
  | SchematicTable
  | SchematicTableCell
  | SchematicText
  | SchematicTrace
  | SchematicVoltageProbe;

type CircuitElement = SchematicElement | SourceComponentBase | SourcePort | SourceNet | SourceTrace;

// Global map to store port positions for trace routing
const portPositions = new Map<string, PortPosition>();

export function createCircuitJson(nodes: Node[], pins: Pin[]) {
  const json: CircuitElement[] = [];

  // Clear port positions from previous runs
  portPositions.clear();

  // Create board with pins
  json.push(...createCircuitJsonBoard(pins));

  // Create a map of node IDs to component indices
  const nodeToComponentIndex = new Map<string, number>();
  let componentIndex = 1;

  // Position components relative to the board
  // Board is at (4, 4), so place components to the right
  const baseX = 8; // Start components to the right of the board
  const baseY = 2; // Start near the top
  const spacing = 4; // Vertical spacing between components

  // Create components for each node and map them
  nodes.forEach((node, nodeIndex) => {
    const data = node.data as BaseData;
    const componentX = baseX;
    const componentY = baseY + nodeIndex * spacing;

    switch (data.instance?.toLowerCase()) {
      case "button":
        nodeToComponentIndex.set(node.id, componentIndex);
        json.push(...createCircuitJsonForButton(node, componentIndex, componentX, componentY));
        componentIndex++;
        break;
      case "led":
        nodeToComponentIndex.set(node.id, componentIndex);
        json.push(...createCircuitJsonForLed(node, componentIndex, componentX, componentY));
        componentIndex++;
        break;
      // TODO: implement other nodes
      default:
        console.warn(`Unsupported component type: ${data.instance}`);
        break;
    }
  });

  // Create traces/connections between pins and components
  json.push(...createCircuitJsonTraces(nodes, pins, nodeToComponentIndex));

  return json;
}

function createCircuitJsonForButton(
  node: Node,
  componentIndex: number,
  schematicX: number,
  schematicY: number,
): CircuitElement[] {
  const data = node.data as ButtonData;
  const elements: CircuitElement[] = [];

  // Create source component for button
  const sourceComponentId = `source_component_${componentIndex}`;
  const buttonComponent: SourceSimplePushButton = {
    type: "source_component",
    ftype: "simple_push_button",
    source_component_id: sourceComponentId,
    name: node.id || `SW${componentIndex}`,
  };
  elements.push(buttonComponent);

  // Port 1: connected to microcontroller pin
  const port1Id = `source_port_${componentIndex}_1`;
  const port1: SourcePort = {
    type: "source_port",
    source_port_id: port1Id,
    source_component_id: sourceComponentId,
    name: "pin1",
    pin_number: 1,
    port_hints: ["pin1", "1", "common"],
  };
  elements.push(port1);

  // Port 2: connected to GND (if pulldown) or VCC (if pullup)
  const port2Id = `source_port_${componentIndex}_2`;
  const port2: SourcePort = {
    type: "source_port",
    source_port_id: port2Id,
    source_component_id: sourceComponentId,
    name: "pin2",
    pin_number: 2,
    port_hints: ["pin2", "2", data.isPullup ? "vcc" : "gnd"],
  };
  elements.push(port2);

  // Create schematic component for button (as a box with pins, like in the EXAMPLE)
  const schematicComponentId = `schematic_component_${componentIndex}`;
  const schematicComponent: SchematicComponent = {
    type: "schematic_component",
    schematic_component_id: schematicComponentId,
    source_component_id: sourceComponentId,
    center: { x: schematicX, y: schematicY },
    size: { width: 1.5, height: 1.0 },
    is_box_with_pins: true,
    port_arrangement: {
      left_side: {
        pins: [1],
        direction: "top-to-bottom",
      },
      right_side: {
        pins: [2],
        direction: "top-to-bottom",
      },
    },
    pin_spacing: 0.5,
    port_labels: {
      "1": "1",
      "2": "2",
    },
  };
  elements.push(schematicComponent);

  // Create schematic ports (positions relative to component center)
  const port1X = schematicX - 0.75 - 0.4; // left edge - distance
  const port1Y = schematicY;
  const schematicPort1: SchematicPort = {
    type: "schematic_port",
    schematic_port_id: `schematic_port_${componentIndex}_1`,
    schematic_component_id: schematicComponentId,
    source_port_id: port1Id,
    center: { x: port1X, y: port1Y },
    facing_direction: "left",
    distance_from_component_edge: 0.4,
    side_of_component: "left",
    pin_number: 1,
    true_ccw_index: 0,
  };
  elements.push(schematicPort1);

  // Store port position for trace routing
  portPositions.set(port1Id, { portId: port1Id, x: port1X, y: port1Y });

  const port2X = schematicX + 0.75 + 0.4; // right edge + distance
  const port2Y = schematicY;
  const schematicPort2: SchematicPort = {
    type: "schematic_port",
    schematic_port_id: `schematic_port_${componentIndex}_2`,
    schematic_component_id: schematicComponentId,
    source_port_id: port2Id,
    center: { x: port2X, y: port2Y },
    facing_direction: "right",
    distance_from_component_edge: 0.4,
    side_of_component: "right",
    pin_number: 2,
    true_ccw_index: 1,
  };
  elements.push(schematicPort2);

  // Store port position for trace routing
  portPositions.set(port2Id, { portId: port2Id, x: port2X, y: port2Y });

  // Create schematic text label (position below component)
  const schematicText: SchematicText = {
    type: "schematic_text",
    schematic_text_id: `schematic_text_${componentIndex}`,
    schematic_component_id: schematicComponentId,
    text: node.id || `SW${componentIndex}`,
    anchor: "left",
    rotation: 0,
    position: { x: schematicX - 0.5, y: schematicY + 0.5 },
    font_size: 0.25,
    color: "#666",
  };
  elements.push(schematicText);

  return elements;
}

function createCircuitJsonForLed(
  node: Node,
  componentIndex: number,
  schematicX: number,
  schematicY: number,
): CircuitElement[] {
  const elements: CircuitElement[] = [];

  // Create source component for LED
  const sourceComponentId = `source_component_${componentIndex}`;
  const ledComponent: SourceSimpleLed = {
    type: "source_component",
    ftype: "simple_led",
    source_component_id: sourceComponentId,
    name: node.id || `LED${componentIndex}`,
  } as SourceSimpleLed;
  elements.push(ledComponent);

  // Port 1 (anode/positive): connected to microcontroller pin
  const port1Id = `source_port_${componentIndex}_1`;
  const port1: SourcePort = {
    type: "source_port",
    source_port_id: port1Id,
    source_component_id: sourceComponentId,
    name: "anode",
    pin_number: 1,
    port_hints: ["anode", "pos", "left", "pin1", "1"],
  };
  elements.push(port1);

  // Port 2 (cathode/negative): connected to GND
  const port2Id = `source_port_${componentIndex}_2`;
  const port2: SourcePort = {
    type: "source_port",
    source_port_id: port2Id,
    source_component_id: sourceComponentId,
    name: "cathode",
    pin_number: 2,
    port_hints: ["cathode", "neg", "right", "pin2", "2", "gnd"],
  };
  elements.push(port2);

  // Create schematic component for LED (as a box with pins since symbol doesn't render)
  const schematicComponentId = `schematic_component_${componentIndex}`;
  const schematicComponent: SchematicComponent = {
    type: "schematic_component",
    schematic_component_id: schematicComponentId,
    source_component_id: sourceComponentId,
    center: { x: schematicX, y: schematicY },
    size: { width: 1.5, height: 1.0 },
    is_box_with_pins: true,
    port_arrangement: {
      left_side: {
        pins: [1],
        direction: "top-to-bottom",
      },
      right_side: {
        pins: [2],
        direction: "top-to-bottom",
      },
    },
    pin_spacing: 0.5,
    port_labels: {
      "1": "+",
      "2": "-",
    },
  };
  elements.push(schematicComponent);

  // Create schematic ports (positions relative to component center)
  const port1X = schematicX - 0.75 - 0.4;
  const port1Y = schematicY;
  const schematicPort1: SchematicPort = {
    type: "schematic_port",
    schematic_port_id: `schematic_port_${componentIndex}_1`,
    schematic_component_id: schematicComponentId,
    source_port_id: port1Id,
    center: { x: port1X, y: port1Y },
    facing_direction: "left",
    distance_from_component_edge: 0.4,
    side_of_component: "left",
    pin_number: 1,
    display_pin_label: "+",
  };
  elements.push(schematicPort1);

  // Store port position for trace routing
  portPositions.set(port1Id, { portId: port1Id, x: port1X, y: port1Y });

  const port2X = schematicX + 0.75 + 0.4;
  const port2Y = schematicY;
  const schematicPort2: SchematicPort = {
    type: "schematic_port",
    schematic_port_id: `schematic_port_${componentIndex}_2`,
    schematic_component_id: schematicComponentId,
    source_port_id: port2Id,
    center: { x: port2X, y: port2Y },
    facing_direction: "right",
    distance_from_component_edge: 0.4,
    side_of_component: "right",
    pin_number: 2,
    display_pin_label: "-",
  };
  elements.push(schematicPort2);

  // Store port position for trace routing
  portPositions.set(port2Id, { portId: port2Id, x: port2X, y: port2Y });

  // Create schematic text label (position above component)
  const schematicText: SchematicText = {
    type: "schematic_text",
    schematic_text_id: `schematic_text_${componentIndex}`,
    schematic_component_id: schematicComponentId,
    text: node.id || `LED${componentIndex}`,
    anchor: "left",
    rotation: 0,
    position: { x: schematicX - 0.5, y: schematicY - 0.8 },
    font_size: 0.25,
    color: "#666",
  };
  elements.push(schematicText);

  return elements;
}

function createCircuitJsonBoard(pins: Pin[]): CircuitElement[] {
  const elements: CircuitElement[] = [];

  if (pins.length === 0) {
    return elements;
  }

  const boardComponentId = "source_component_0";

  // Create source component for the board (microcontroller)
  const boardComponent: SourceSimpleChip = {
    type: "source_component",
    ftype: "simple_chip",
    source_component_id: boardComponentId,
    name: "microcontroller",
  };
  elements.push(boardComponent);

  // Create source ports for each pin
  pins.forEach((pin, index) => {
    const portId = `source_port_${index}`;
    const port: SourcePort = {
      type: "source_port",
      source_port_id: portId,
      source_component_id: boardComponentId,
      name: `pin${pin.pin}`,
      pin_number: pin.pin,
      port_hints: [`pin${pin.pin}`, `${pin.pin}`, `D${pin.pin}`],
    };
    elements.push(port);
  });

  // Create common nets (GND, VCC, etc.)
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

  // Create schematic component for the board
  const schematicComponentId = "board_component";
  const pinCount = pins.length;

  // Distribute pins across left and right sides (like a real DIP chip)
  // Split pins: lower numbered pins on left, higher on right
  const sortedPins = [...pins].sort((a, b) => a.pin - b.pin);
  const halfCount = Math.ceil(pinCount / 2);
  const leftPins = sortedPins.slice(0, halfCount).map((p) => p.pin);
  const rightPins = sortedPins.slice(halfCount).map((p) => p.pin);

  const portLabels: Record<string, string> = {};
  pins.forEach((pin) => {
    portLabels[`${pin.pin}`] = `pin${pin.pin}`;
  });

  const boardHeight = Math.max(3, Math.max(leftPins.length, rightPins.length) * 1.0);
  const boardWidth = 3;
  const boardCenterX = 4;
  const boardCenterY = 4;

  const schematicComponent: SchematicComponent = {
    type: "schematic_component",
    schematic_component_id: schematicComponentId,
    source_component_id: boardComponentId,
    center: { x: boardCenterX, y: boardCenterY },
    size: {
      width: boardWidth,
      height: boardHeight,
    },
    is_box_with_pins: true,
    port_arrangement: {
      left_side: {
        pins: leftPins,
        direction: "top-to-bottom",
      },
      right_side: {
        pins: rightPins,
        direction: "top-to-bottom",
      },
    },
    pin_spacing: 0.8,
    port_labels: portLabels,
  };
  elements.push(schematicComponent);

  // Create schematic ports for each pin
  // Left side pins
  const leftPinSpacing = boardHeight / (leftPins.length + 1);
  leftPins.forEach((pinNum, idx) => {
    const pinIndex = pins.findIndex((p) => p.pin === pinNum);
    const portId = `source_port_${pinIndex}`;
    const schematicPortId = `schematic_port_${pinIndex}`;

    const portX = boardCenterX - boardWidth / 2 - 0.4;
    const portY = boardCenterY - boardHeight / 2 + leftPinSpacing * (idx + 1);

    const schematicPort: SchematicPort = {
      type: "schematic_port",
      schematic_port_id: schematicPortId,
      schematic_component_id: schematicComponentId,
      source_port_id: portId,
      center: { x: portX, y: portY },
      facing_direction: "left",
      distance_from_component_edge: 0.4,
      side_of_component: "left",
      pin_number: pinNum,
      true_ccw_index: idx,
      display_pin_label: `pin${pinNum}`,
    };
    elements.push(schematicPort);
    portPositions.set(portId, { portId, x: portX, y: portY });
  });

  // Right side pins
  const rightPinSpacing = boardHeight / (rightPins.length + 1);
  rightPins.forEach((pinNum, idx) => {
    const pinIndex = pins.findIndex((p) => p.pin === pinNum);
    const portId = `source_port_${pinIndex}`;
    const schematicPortId = `schematic_port_${pinIndex}`;

    const portX = boardCenterX + boardWidth / 2 + 0.4;
    const portY = boardCenterY - boardHeight / 2 + rightPinSpacing * (idx + 1);

    const schematicPort: SchematicPort = {
      type: "schematic_port",
      schematic_port_id: schematicPortId,
      schematic_component_id: schematicComponentId,
      source_port_id: portId,
      center: { x: portX, y: portY },
      facing_direction: "right",
      distance_from_component_edge: 0.4,
      side_of_component: "right",
      pin_number: pinNum,
      true_ccw_index: leftPins.length + idx,
      display_pin_label: `pin${pinNum}`,
    };
    elements.push(schematicPort);
    portPositions.set(portId, { portId, x: portX, y: portY });
  });

  // Create schematic text label for the board
  const boardText: SchematicText = {
    type: "schematic_text",
    schematic_text_id: "schematic_text_board",
    schematic_component_id: schematicComponentId,
    text: "microcontroller",
    anchor: "left",
    rotation: 0,
    position: { x: boardCenterX - 1, y: boardCenterY },
    font_size: 0.25,
    color: "#666",
  };
  elements.push(boardText);

  return elements;
}

function createCircuitJsonTraces(
  nodes: Node[],
  pins: Pin[],
  nodeToComponentIndex: Map<string, number>,
): CircuitElement[] {
  const elements: CircuitElement[] = [];
  let traceIndex = 0;
  const usedNetLabels = new Set<string>();

  // Helper function to create schematic trace edges between two ports
  // Board is at center (4, 4) with width 3
  // Left edge at x=2.5, right edge at x=5.5
  function createSchematicTrace(
    sourceTraceId: string,
    fromPortId: string,
    toPortId: string,
  ): SchematicTrace | null {
    const fromPos = portPositions.get(fromPortId);
    const toPos = portPositions.get(toPortId);

    if (!fromPos || !toPos) {
      console.warn(`Missing port positions for trace: ${fromPortId} -> ${toPortId}`);
      return null;
    }

    const boardCenterX = 4;
    const boardLeftEdge = boardCenterX - 1.5 - 0.4; // 2.1
    const boardRightEdge = boardCenterX + 1.5 + 0.4; // 5.9

    const edges: SchematicTrace["edges"] = [];

    // Determine if the from port is on the left or right side of the board
    const fromIsOnLeft = fromPos.x < boardCenterX;

    if (fromIsOnLeft) {
      // Port is on left side of board - route left, then around
      const routeX = boardLeftEdge - 1; // Route to the left of the board

      // Go left from the board port
      edges.push({
        from: { x: fromPos.x, y: fromPos.y },
        to: { x: routeX, y: fromPos.y },
      });
      // Go up/down to clear the board
      const clearY = Math.min(fromPos.y, toPos.y) - 1;
      edges.push({
        from: { x: routeX, y: fromPos.y },
        to: { x: routeX, y: clearY },
      });
      // Go right to past the board
      const rightRouteX = boardRightEdge + 1;
      edges.push({
        from: { x: routeX, y: clearY },
        to: { x: rightRouteX, y: clearY },
      });
      // Go down to target Y
      edges.push({
        from: { x: rightRouteX, y: clearY },
        to: { x: rightRouteX, y: toPos.y },
      });
      // Go to target
      edges.push({
        from: { x: rightRouteX, y: toPos.y },
        to: { x: toPos.x, y: toPos.y },
      });
    } else {
      // Port is on right side of board - direct route to component
      const midX = (fromPos.x + toPos.x) / 2;
      edges.push({
        from: { x: fromPos.x, y: fromPos.y },
        to: { x: midX, y: fromPos.y },
      });
      edges.push({
        from: { x: midX, y: fromPos.y },
        to: { x: midX, y: toPos.y },
      });
      edges.push({
        from: { x: midX, y: toPos.y },
        to: { x: toPos.x, y: toPos.y },
      });
    }

    return {
      type: "schematic_trace",
      schematic_trace_id: `schematic_trace_${sourceTraceId}`,
      source_trace_id: sourceTraceId,
      edges,
      junctions: [],
    };
  }

  // Create traces for connections between components and pins
  nodes.forEach((node) => {
    const data = node.data as BaseData;

    // Get component index from the map
    const componentIndex = nodeToComponentIndex.get(node.id);
    if (componentIndex === undefined) return;

    // Handle button components
    if (data.instance?.toLowerCase() === "button") {
      const buttonData = data as ButtonData;
      const pinNumber =
        typeof buttonData.pin === "number" ? buttonData.pin : parseInt(buttonData.pin);

      // Find the corresponding source port for this pin
      const pinIndex = pins.findIndex((p) => p.pin === pinNumber);
      if (pinIndex === -1) return;

      const boardPortId = `source_port_${pinIndex}`;
      const componentPortId = `source_port_${componentIndex}_1`; // Button pin 1
      const sourceTraceId = `source_trace_${traceIndex}`;

      // Create source trace from board pin to component
      const trace: SourceTrace = {
        type: "source_trace",
        source_trace_id: sourceTraceId,
        connected_source_port_ids: [boardPortId, componentPortId],
        connected_source_net_ids: [],
        display_name: `.microcontroller > .pin${pinNumber} to .${node.id} > .pin1`,
      };
      elements.push(trace);

      // Create schematic trace with routing
      const schematicTrace = createSchematicTrace(sourceTraceId, boardPortId, componentPortId);
      if (schematicTrace) {
        elements.push(schematicTrace);
      }
      traceIndex++;

      // Create trace from component pin 2 to GND (if pulldown) or VCC (if pullup)
      const componentPort2Id = `source_port_${componentIndex}_2`;
      const netId = buttonData.isPullup ? "source_net_vcc" : "source_net_gnd";
      const netName = buttonData.isPullup ? "VCC" : "GND";
      const sourceTrace2Id = `source_trace_${traceIndex}`;

      const trace2: SourceTrace = {
        type: "source_trace",
        source_trace_id: sourceTrace2Id,
        connected_source_port_ids: [componentPort2Id],
        connected_source_net_ids: [netId],
        display_name: `.${node.id} > .pin2 to net.${netName}`,
      };
      elements.push(trace2);
      traceIndex++;

      // Create net label for GND/VCC if not already created
      if (!usedNetLabels.has(netId)) {
        const port2Pos = portPositions.get(componentPort2Id);
        const netLabel: SchematicNetLabel = {
          type: "schematic_net_label",
          schematic_net_label_id: `schematic_net_label_${netId}`,
          text: netName,
          source_net_id: netId,
          anchor_position: { x: port2Pos?.x ?? 0, y: port2Pos?.y ?? 0 },
          center: { x: (port2Pos?.x ?? 0) + 0.5, y: port2Pos?.y ?? 0 },
          anchor_side: "left",
        };
        elements.push(netLabel);
        usedNetLabels.add(netId);
      }
    }
    // Handle LED components
    else if (data.instance?.toLowerCase() === "led") {
      const ledData = data as LedData;
      const pinNumber = typeof ledData.pin === "number" ? ledData.pin : parseInt(ledData.pin);

      // Find the corresponding source port for this pin
      const pinIndex = pins.findIndex((p) => p.pin === pinNumber);
      if (pinIndex === -1) return;

      const boardPortId = `source_port_${pinIndex}`;
      const componentPortId = `source_port_${componentIndex}_1`; // LED anode
      const sourceTraceId = `source_trace_${traceIndex}`;

      // Create source trace from board pin to LED anode
      const trace: SourceTrace = {
        type: "source_trace",
        source_trace_id: sourceTraceId,
        connected_source_port_ids: [boardPortId, componentPortId],
        connected_source_net_ids: [],
        display_name: `.microcontroller > .pin${pinNumber} to .${node.id} > .anode`,
      };
      elements.push(trace);

      // Create schematic trace with routing
      const schematicTrace = createSchematicTrace(sourceTraceId, boardPortId, componentPortId);
      if (schematicTrace) {
        elements.push(schematicTrace);
      }
      traceIndex++;

      // Create trace from LED cathode to GND
      const componentPort2Id = `source_port_${componentIndex}_2`;
      const netId = "source_net_gnd";
      const netName = "GND";
      const sourceTrace2Id = `source_trace_${traceIndex}`;

      const trace2: SourceTrace = {
        type: "source_trace",
        source_trace_id: sourceTrace2Id,
        connected_source_port_ids: [componentPort2Id],
        connected_source_net_ids: [netId],
        display_name: `.${node.id} > .cathode to net.${netName}`,
      };
      elements.push(trace2);
      traceIndex++;

      // Create net label for GND if not already created
      if (!usedNetLabels.has(netId)) {
        const port2Pos = portPositions.get(componentPort2Id);
        const netLabel: SchematicNetLabel = {
          type: "schematic_net_label",
          schematic_net_label_id: `schematic_net_label_${netId}`,
          text: netName,
          source_net_id: netId,
          anchor_position: { x: port2Pos?.x ?? 0, y: port2Pos?.y ?? 0 },
          center: { x: (port2Pos?.x ?? 0) + 0.5, y: port2Pos?.y ?? 0 },
          anchor_side: "left",
        };
        elements.push(netLabel);
        usedNetLabels.add(netId);
      }
    }
  });

  return elements;
}
