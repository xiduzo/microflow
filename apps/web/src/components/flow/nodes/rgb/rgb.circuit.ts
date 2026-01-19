import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./rgb.schema";

export const rgbCircuit: CircuitDefinition = {
  ftype: "simple_chip",
  displayName: "RGB",
  size: { width: 2.0, height: 2.0 },
  direction: "output",
  ports: [
    {
      name: "red",
      pinNumber: 1,
      hints: ["red", "r", "pin1", "1"],
      side: "left",
      label: "R",
      traceType: "sig",
    },
    {
      name: "green",
      pinNumber: 2,
      hints: ["green", "g", "pin2", "2"],
      side: "left",
      label: "G",
      traceType: "sig",
    },
    {
      name: "blue",
      pinNumber: 3,
      hints: ["blue", "b", "pin3", "3"],
      side: "left",
      label: "B",
      traceType: "sig",
    },
    {
      name: "common",
      pinNumber: 4,
      hints: ["common", "cathode", "anode", "pin4", "4"],
      side: "right",
      label: "COM",
      traceType: "gnd",
    },
  ],
  getPins: (data) => {
    const d = data as Data;
    return [d.pins.red, d.pins.green, d.pins.blue];
  },
  getNetConnections: (data) => {
    const d = data as Data;
    // Common anode connects to VCC, common cathode connects to GND
    return {
      4: d.isAnode ? "VCC" : "GND",
    };
  },
};
