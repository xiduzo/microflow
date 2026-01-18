import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./matrix.schema";

export const matrixCircuit: CircuitDefinition = {
  ftype: "simple_chip",
  displayName: "MATRIX",
  size: { width: 2.5, height: 2.0 },
  direction: "output",
  ports: [
    {
      name: "data",
      pinNumber: 1,
      hints: ["data", "din", "mosi", "pin1", "1"],
      side: "left",
      label: "DIN",
    },
    {
      name: "clock",
      pinNumber: 2,
      hints: ["clock", "clk", "sck", "pin2", "2"],
      side: "left",
      label: "CLK",
    },
    {
      name: "cs",
      pinNumber: 3,
      hints: ["cs", "load", "ss", "pin3", "3"],
      side: "left",
      label: "CS",
    },
    {
      name: "vcc",
      pinNumber: 4,
      hints: ["vcc", "power", "5v", "pin4", "4"],
      side: "right",
      label: "VCC (+)",
    },
    {
      name: "gnd",
      pinNumber: 5,
      hints: ["gnd", "ground", "pin5", "5"],
      side: "right",
      label: "GND (-)",
    },
  ],
  getPins: (data) => {
    const d = data as Data;
    return [d.pins.data, d.pins.clock, d.pins.cs];
  },
  getNetConnections: () => ({
    4: "VCC",
    5: "GND",
  }),
};
