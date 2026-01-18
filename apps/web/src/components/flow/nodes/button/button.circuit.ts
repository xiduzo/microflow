import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./button.schema";

export const buttonCircuit: CircuitDefinition = {
  ftype: "simple_push_button",
  displayName: "BTN",
  size: { width: 1.5, height: 1.0 },
  direction: "input",
  ports: [
    {
      name: "signal",
      pinNumber: 1,
      hints: ["pin1", "1", "signal", "dout"],
      side: "right",
      label: "DOUT",
    },
    {
      name: "gnd",
      pinNumber: 2,
      hints: ["pin2", "2", "gnd", "ground"],
      side: "left",
      label: "GND (-)",
    },
  ],
  getPins: (data) => {
    const d = data as Data;
    const pin = typeof d.pin === "number" ? d.pin : parseInt(d.pin);
    return [pin];
  },
  getNetConnections: (data) => {
    const d = data as Data;
    // Pin 2 connects to VCC if pullup, GND if pulldown
    return {
      2: d.isPullup ? "VCC" : "GND",
    };
  },
};
