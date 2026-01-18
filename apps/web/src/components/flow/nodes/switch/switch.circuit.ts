import type { CircuitDefinition } from "../_circuit.types";

export const switchCircuit: CircuitDefinition = {
  ftype: "simple_chip",
  displayName: "SW",
  size: { width: 1.5, height: 1.0 },
  direction: "input",
  ports: [
    {
      name: "signal",
      pinNumber: 1,
      hints: ["pin1", "1", "common", "signal"],
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
    const pin = typeof data.pin === "number" ? data.pin : parseInt(data.pin as string);
    return [pin];
  },
  getNetConnections: () => ({
    2: "GND",
  }),
};
