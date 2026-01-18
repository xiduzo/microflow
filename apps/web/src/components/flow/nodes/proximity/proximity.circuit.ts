import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./proximity.schema";

export const proximityCircuit: CircuitDefinition = {
  ftype: "simple_chip",
  displayName: "PROX",
  size: { width: 2.0, height: 1.5 },
  direction: "input",
  ports: [
    {
      name: "signal",
      pinNumber: 1,
      hints: ["signal", "out", "analog", "pin1", "1"],
      side: "right",
      label: "SIG",
    },
    {
      name: "vcc",
      pinNumber: 2,
      hints: ["vcc", "power", "5v", "pin2", "2"],
      side: "left",
      label: "VCC (+)",
    },
    {
      name: "gnd",
      pinNumber: 3,
      hints: ["gnd", "ground", "pin3", "3"],
      side: "left",
      label: "GND (-)",
    },
  ],
  getPins: (data) => {
    const d = data as Data;
    // Handle analog pins like "A0"
    const pin = typeof d.pin === "number" ? d.pin : parseInt(d.pin.replace("A", "14"));
    return [pin];
  },
  getNetConnections: () => ({
    2: "VCC",
    3: "GND",
  }),
};
