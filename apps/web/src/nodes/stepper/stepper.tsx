/**
 * THIS COMPONENT IS IN PROGRESS
 * most likely this needs the `StandardFirmataPlus`
 * which limits the boards we can support
 */

import { CogIcon } from "lucide-react";
import { NodeHandles } from "../_base/node-handles";
import { NodeContainer, useNodeControls, type BaseNode } from "../_base/_base";
import { useNodeData } from "../_base/_base";
import { type Data, dataSchema } from "./stepper.schema";
import { pinsToOptions } from "@/board/pin-label";
import { MODES, usePins } from "@/board/board-store";
import { folder } from "leva";

export function Stepper(props: Props) {
  return (
    <NodeContainer {...props}>
      <CogIcon className="text-muted-foreground" size={48} />
      <Settings />
      <NodeHandles />
    </NodeContainer>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const pins = usePins([MODES.OUTPUT]);

  const { render } = useNodeControls(
    {
      interface: {
        value: data.interface as string,
        options: ["driver", "four_wire"],
        label: "interface",
      },
      // Driver mode: step + dir pins
      stepPin: {
        value: data.stepPin,
        options: pinsToOptions(pins),
        label: "step pin",
        render: (get) => get("interface") === "driver",
      },
      dirPin: {
        value: data.dirPin,
        options: pinsToOptions(pins),
        label: "dir pin",
        render: (get) => get("interface") === "driver",
      },
      // Four-wire mode: IN1–IN4
      motorPin1: {
        value: data.motorPin1,
        options: pinsToOptions(pins),
        label: "IN1",
        render: (get) => get("interface") === "four_wire",
      },
      motorPin2: {
        value: data.motorPin2,
        options: pinsToOptions(pins),
        label: "IN2",
        render: (get) => get("interface") === "four_wire",
      },
      motorPin3: {
        value: data.motorPin3,
        options: pinsToOptions(pins),
        label: "IN3",
        render: (get) => get("interface") === "four_wire",
      },
      motorPin4: {
        value: data.motorPin4,
        options: pinsToOptions(pins),
        label: "IN4",
        render: (get) => get("interface") === "four_wire",
      },
      stepsPerRev: {
        value: data.stepsPerRev,
        min: 1,
        max: 6400,
        step: 1,
        label: "steps/rev",
      },
      motion: folder(
        {
          speed: {
            value: data.speed,
            min: 1,
            max: 10000,
            step: 1,
            label: "speed (steps/s)",
          },
          acceleration: {
            value: data.acceleration,
            min: 0,
            max: 10000,
            step: 1,
            label: "accel (steps/s²)",
          },
        },
        { collapsed: true },
      ),
    },
    [pins],
  );

  return <>{render()}</>;
}

type Props = BaseNode<Data>;
Stepper.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    // Keep in sync with stepper.schema.ts — hidden until firmware supports AccelStepper.
    group: "internal",
    tags: ["action", "value"],
    label: "Stepper",
    icon: "CogIcon",
    description:
      "Control a stepper motor with precise positioning via a driver board (A4988, DRV8825, etc.)",
  } satisfies Props["data"],
};
