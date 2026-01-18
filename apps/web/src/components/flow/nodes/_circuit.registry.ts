import type { CircuitRegistry } from "./_circuit.types";

// Hardware component circuits
import { buttonCircuit } from "./button/button.circuit";
import { ledCircuit } from "./led/led.circuit";
import { servoCircuit } from "./servo/servo.circuit";
import { sensorCircuit } from "./sensor/sensor.circuit";
import { rgbCircuit } from "./rgb/rgb.circuit";
import { relayCircuit } from "./relay/relay.circuit";
import { piezoCircuit } from "./piezo/piezo.circuit";
import { matrixCircuit } from "./matrix/matrix.circuit";
import { motionCircuit } from "./motion/motion.circuit";
import { proximityCircuit } from "./proximity/proximity.circuit";
import { switchCircuit } from "./switch/switch.circuit";
import { pixelCircuit } from "./pixel/pixel.circuit";

/**
 * Registry of all hardware component circuit definitions.
 * Keys are lowercase instance names matching the node data.instance field.
 */
export const circuitRegistry: CircuitRegistry = {
  button: buttonCircuit,
  led: ledCircuit,
  servo: servoCircuit,
  sensor: sensorCircuit,
  rgb: rgbCircuit,
  relay: relayCircuit,
  piezo: piezoCircuit,
  matrix: matrixCircuit,
  motion: motionCircuit,
  proximity: proximityCircuit,
  switch: switchCircuit,
  pixel: pixelCircuit,
};

/**
 * Get circuit definition for a node instance type
 */
export function getCircuitDefinition(instanceType: string) {
  return circuitRegistry[instanceType.toLowerCase()];
}

/**
 * Check if a node type has a circuit definition (is a hardware component)
 */
export function isHardwareComponent(instanceType: string): boolean {
  return instanceType.toLowerCase() in circuitRegistry;
}
