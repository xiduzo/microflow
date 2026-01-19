import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./pixel.schema";

export const pixelCircuit: CircuitDefinition = {
  ftype: "simple_chip",
  displayName: "PIXEL",
  size: { width: 2.0, height: 1.5 },
  direction: "output",
  ports: [
    {
      name: "data",
      pinNumber: 1,
      hints: ["data", "din", "signal", "pin1", "1"],
      side: "left",
      label: "DIN",
      traceType: "data",
    },
    {
      name: "vcc",
      pinNumber: 2,
      hints: ["vcc", "power", "5v", "pin2", "2"],
      side: "right",
      label: "VCC (+)",
      traceType: "vcc",
    },
    {
      name: "gnd",
      pinNumber: 3,
      hints: ["gnd", "ground", "pin3", "3"],
      side: "right",
      label: "GND (-)",
      traceType: "gnd",
    },
  ],
  getPins: (data) => {
    const d = data as Data;
    return [d.pin];
  },
  getNetConnections: () => ({
    2: "VCC",
    3: "GND",
  }),
};
