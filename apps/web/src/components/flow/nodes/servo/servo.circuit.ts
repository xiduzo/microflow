import type { CircuitDefinition } from "../_circuit.types";
import type { Data } from "./servo.schema";

export const servoCircuit: CircuitDefinition = {
  ftype: "simple_chip",
  displayName: "SERVO",
  size: { width: 2.0, height: 1.5 },
  direction: "output",
  ports: [
    {
      name: "signal",
      pinNumber: 1,
      hints: ["signal", "pwm", "pin1", "1", "din"],
      side: "left",
      label: "DIN",
    },
    {
      name: "vcc",
      pinNumber: 2,
      hints: ["vcc", "power", "5v", "pin2", "2"],
      side: "right",
      label: "VCC (+)",
    },
    {
      name: "gnd",
      pinNumber: 3,
      hints: ["gnd", "ground", "pin3", "3"],
      side: "right",
      label: "GND (-)",
    },
  ],
  getPins: (data) => {
    const d = data as Data;
    const pin = typeof d.pin === "number" ? d.pin : parseInt(d.pin);
    return [pin];
  },
  getNetConnections: () => ({
    2: "VCC",
    3: "GND",
  }),
};
