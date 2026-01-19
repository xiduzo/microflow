import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./led.schema";

export const ledCircuit: CircuitDefinition = {
  ftype: "simple_led",
  displayName: "LED",
  size: { width: 1.5, height: 1.0 },
  direction: "output",
  ports: [
    {
      name: "anode",
      pinNumber: 1,
      hints: ["anode", "pos", "left", "pin1", "1", "din"],
      side: "left",
      label: "DIN",
      traceType: "sig",
    },
    {
      name: "cathode",
      pinNumber: 2,
      hints: ["cathode", "neg", "right", "pin2", "2", "gnd"],
      side: "right",
      label: "GND (-)",
      traceType: "gnd",
    },
  ],
  getPins: (data) => {
    const d = data as Data;
    const pin = typeof d.pin === "number" ? d.pin : parseInt(d.pin);
    return [pin];
  },
  getNetConnections: () => ({
    2: "GND", // Cathode always connects to GND
  }),
};
