/**
 * THIS COMPONENT IS IN PROGRESS
 * most likely this needs the `StandardFirmataPlus`
 * which limits the boards we can support
 */

import {
  DotIcon,
  RedoDotIcon,
  UndoDotIcon,
} from "lucide-react";
import { Handle as BaseHandle } from "../../handle";

const Handle = BaseHandle<"Stepper">;
import { NodeContainer, useNodeControls, type BaseNode } from "../_base/_base";
import { useNodeData } from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { type Data, type Value, dataSchema } from "./stepper.schema";
import { pinsToOptions } from "@/components/hardware/pin";
import { MODES, usePins } from "@/stores/board";
import { folder } from "leva";
import { IconWithValue } from "../../icon-with-value";
import { useMemo } from "react";

export function Stepper(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle
        type="target"
        position="left"
        id="value"
        handleType="value"
        hint="steps (±)"
        offset={-1.5}
      />
      <Handle
        type="target"
        position="left"
        id="to"
        handleType="value"
        hint="go to position"
        offset={-0.5}
      />
      <Handle
        type="target"
        position="left"
        id="stop"
        handleType="command"
        offset={0.5}
      />
      <Handle
        type="target"
        position="left"
        id="zero"
        handleType="command"
        hint="reset position"
        offset={1.5}
      />
    </NodeContainer>
  );
}

function Value() {
  const value = useNodeValue<Value>(0);

  const icon = useMemo(() => {
    if (value === 0) return DotIcon;
    return value > 0 ? RedoDotIcon : UndoDotIcon;
  }, [value]);

  return <IconWithValue icon={icon} value={value} />;
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
