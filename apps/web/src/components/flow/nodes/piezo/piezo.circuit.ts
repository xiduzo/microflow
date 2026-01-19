import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./piezo.schema";

export const piezoCircuit: CircuitDefinition = {
  ftype: "simple_chip",
  displayName: "PIEZO",
  size: { width: 1.5, height: 1.0 },
  direction: "output",
  ports: [
    {
      name: "signal",
      pinNumber: 1,
      hints: ["signal", "positive", "pin1", "1"],
      side: "left",
      label: "SIG",
      traceType: "sig",
    },
    {
      name: "gnd",
      pinNumber: 2,
      hints: ["gnd", "negative", "ground", "pin2", "2"],
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
    2: "GND",
  }),
};
