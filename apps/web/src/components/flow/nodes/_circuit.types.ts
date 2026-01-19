import type { Node } from "@xyflow/react";
import type {
  SchematicComponent,
  SchematicPort,
  SchematicText,
  SourcePort,
  SourceComponentBase,
} from "circuit-json";

/** Trace type for CSS styling */
export type TraceType = "sig" | "gnd" | "vcc" | "clock" | "data";

/**
 * Port definition for a circuit component
 */
export interface CircuitPort {
  name: string;
  pinNumber: number;
  hints: string[];
  side: "left" | "right" | "top" | "bottom";
  label?: string;
  /** Trace type for coloring */
  traceType: TraceType;
}

/**
 * Circuit definition returned by each hardware component
 */
export interface CircuitDefinition {
  /** Component type for circuit-json (e.g., "simple_push_button", "simple_led") */
  ftype: string;
  /** Display name for the component */
  displayName: string;
  /** Port definitions */
  ports: CircuitPort[];
  /** Component size in schematic units */
  size: { width: number; height: number };
  /** Whether this is an input (sensor/button) or output (LED/servo) component */
  direction: "input" | "output";
  /** Pin number(s) used on the microcontroller - can return numbers or analog pin strings like "A0" */
  getPins: (data: unknown) => (number | string)[];
  /** Net connections (e.g., GND, VCC) for each port */
  getNetConnections?: (data: unknown) => Record<number, "GND" | "VCC" | null>;
}

/**
 * Context passed to circuit generators
 */
export interface CircuitContext {
  node: Node;
  componentIndex: number;
  schematicX: number;
  schematicY: number;
}

/**
 * Registry of circuit definitions by instance type
 */
export type CircuitRegistry = Record<string, CircuitDefinition>;

/**
 * Port position for trace routing
 */
export interface PortPosition {
  portId: string;
  x: number;
  y: number;
}

/**
 * Generated circuit elements
 */
export interface GeneratedCircuitElements {
  sourceComponent: SourceComponentBase;
  sourcePorts: SourcePort[];
  schematicComponent: SchematicComponent;
  schematicPorts: SchematicPort[];
  schematicText: SchematicText;
  portPositions: Map<string, PortPosition>;
}
