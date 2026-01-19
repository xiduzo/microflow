import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./sensor.schema";

export const sensorCircuit: CircuitDefinition = {
  ftype: "simple_chip",
  displayName: "SENSOR",
  size: { width: 2.0, height: 1.5 },
  direction: "input",
  ports: [
    {
      name: "signal",
      pinNumber: 1,
      hints: ["signal", "out", "analog", "pin1", "1", "sig"],
      side: "right",
      label: "SIG",
      traceType: "sig",
    },
    {
      name: "vcc",
      pinNumber: 2,
      hints: ["vcc", "power", "5v", "pin2", "2"],
      side: "left",
      label: "VCC (+)",
      traceType: "vcc",
    },
    {
      name: "gnd",
      pinNumber: 3,
      hints: ["gnd", "ground", "pin3", "3"],
      side: "left",
      label: "GND (-)",
      traceType: "gnd",
    },
  ],
  getPins: (data) => {
    const d = data as Data;
    // Return the raw pin value - circuit-json.ts will resolve "A0" to actual pin number
    return [d.pin];
  },
  getNetConnections: () => ({
    2: "VCC",
    3: "GND",
  }),
};
